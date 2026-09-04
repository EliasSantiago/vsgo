/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { resolveUri } from './tools.js';

/**
 * Path-looking tokens: at least one separator and a short extension, optionally pinned to a spot
 * inside the file as `:line`, `#symbol` or `::symbol`. Anchored on a non-path character so
 * `https://host/a/b.php` does not match from the middle of a URL.
 */
const PATH_RE = /(?<![\w/:.-])((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z]\w{0,9})(?::(\d+)|(?:#|::)([A-Za-z_]\w*))?/g;

/** Fence delimiters, so paths inside code blocks stay verbatim. */
const FENCE_RE = /^\s*(```|~~~)/;

/** Opening fence with its language tag, used to spot a block that must not be shown. */
const FENCE_OPEN_RE = /^\s*(?:```|~~~)\s*([A-Za-z0-9_+#-]*)/;

/**
 * Fence tags that carry a tool call rather than anything the user should read.
 *
 * `tool_code` is Gemma's: the model was trained to request a tool by writing a
 * Python call inside such a block, which the agent loop recovers and runs. Left
 * visible it reaches the user as a stray `agent_list_dir` in the middle of the
 * answer — the call itself, printed instead of performed.
 */
const HIDDEN_FENCE_TAGS: ReadonlySet<string> = new Set(['tool_code', 'tool_call']);

/**
 * Fence tags whose payload *might* be a tool call written out instead of made.
 *
 * Unlike {@link HIDDEN_FENCE_TAGS} the tag decides nothing on its own: a ```json
 * block is just as often something the user asked to see. Such a block is held
 * back until it closes and then shown, unless its payload turns out to name a
 * tool the model was offered — the one case where showing it is wrong, because
 * the agent loop is about to recover that same text and run the call.
 */
const DEFERRED_FENCE_TAGS: ReadonlySet<string> = new Set(['', 'json']);

/**
 * The tag pair Qwen-family models wrap a call in. Normally the runtime parses it
 * and it never reaches this stream; it shows up as text exactly when parsing
 * failed and the agent loop has to recover the call itself, so the tags are
 * never part of an answer.
 */
const TOOL_TAG_OPEN = '<tool_call>';
const TOOL_TAG_CLOSE = '</tool_call>';

/**
 * Ceilings on held-back text, so a block that never closes — or a genuine JSON
 * document the user asked to see — cannot stall the answer for long.
 */
const MAX_HELD_CHARS = 4000;
const MAX_HELD_LINES = 40;

/** Above this, a file is a generated bundle or a dump — not something worth scanning for a symbol. */
const MAX_SYMBOL_SEARCH_BYTES = 2 * 1024 * 1024;

/**
 * Where a symbol is defined, most specific first. Text patterns rather than a symbol provider:
 * the answer often points into a language with no language server installed (PHP here), and a
 * definition line is regular enough to find without one.
 */
function definitionPatterns(symbol: string): RegExp[] {
	const name = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return [
		// function foo(  |  def foo(  |  fun foo(  |  func foo(
		new RegExp(`\\b(?:function|def|fun|func|sub)\\s+&?${name}\\s*[(:]`),
		// public static function foo(  and other modifier-prefixed declarations
		new RegExp(`^[^\\S\\n]*(?:(?:public|private|protected|static|final|abstract|readonly|override|async|export|declare)\\s+)+[\\w<>\\[\\]|?\\\\ ]*\\b${name}\\s*\\(`, 'm'),
		// class / interface / trait / enum / type / struct declarations
		new RegExp(`\\b(?:class|interface|trait|enum|type|struct|record)\\s+${name}\\b`),
		// foo: function(  |  foo = (…) =>  |  foo = async function
		new RegExp(`\\b${name}\\s*[:=]\\s*(?:async\\s+)?(?:function\\b|\\()`),
		// Bare method declaration inside a class body: `foo(` at the start of a line
		new RegExp(`^[^\\S\\n]*&?${name}\\s*\\(`, 'm'),
	];
}

/**
 * Streams the model's prose, turning file paths that exist in the workspace into anchors the
 * user can click.
 *
 * Paths are the whole point of an answer like "the function lives in X and is called from Y", and
 * as plain text they force the reader to go hunt for the file by hand. Anchors are used rather
 * than markdown links because the chat renders them as real file pills, with hover and
 * ctrl+click, and they survive the renderer's own escaping.
 *
 * Text is buffered per line: a path can arrive split across streamed chunks, and matching half a
 * path would produce a broken link.
 */
export class FileLinkStream {

	private buffer = '';
	private inFence = false;
	/** Set while inside a fence whose tag is in {@link HIDDEN_FENCE_TAGS}. */
	private inHiddenFence = false;
	/** Resolution is cached because the same file is usually cited several times per answer. */
	private readonly resolved = new Map<string, vscode.Uri | undefined>();
	/** File text, kept for the duration of one answer so repeated symbol lookups cost one read. */
	private readonly contents = new Map<string, string | undefined>();
	/** Lines withheld while it is still unknown whether they are a printed tool call. */
	private held: IHeldBlock | undefined;
	/** Set between a `<tool_call>` tag and its close. */
	private inToolTag = false;

	/**
	 * @param knownTools Names the model was offered. Empty disables withholding
	 * entirely: without recovery of text tool calls, a JSON block naming a tool is
	 * just text the user asked for, and hiding it would lose part of the answer.
	 */
	constructor(
		private readonly stream: vscode.ChatResponseStream,
		private readonly knownTools: ReadonlySet<string> = new Set(),
	) { }

	async write(chunk: string): Promise<void> {
		this.buffer += chunk;
		let newline = this.buffer.indexOf('\n');
		while (newline !== -1) {
			await this.emitLine(this.buffer.slice(0, newline + 1));
			this.buffer = this.buffer.slice(newline + 1);
			newline = this.buffer.indexOf('\n');
		}
	}

	/** Flushes whatever came after the last newline. Call once the model stops streaming. */
	async end(): Promise<void> {
		if (this.buffer) {
			await this.emitLine(this.buffer);
			this.buffer = '';
		}
		// A block still open when the model stopped never got its verdict. Showing
		// it is the safe way out: a withheld call costs the user nothing, but a
		// withheld answer loses their reply.
		await this.release();
	}

	private async emitLine(line: string): Promise<void> {
		if (this.held) {
			return this.hold(line);
		}
		if (this.inToolTag) {
			this.inToolTag = !line.includes(TOOL_TAG_CLOSE);
			return;
		}
		if (this.knownTools.size > 0 && line.trimStart().startsWith(TOOL_TAG_OPEN)) {
			this.inToolTag = !line.includes(TOOL_TAG_CLOSE);
			return;
		}
		if (this.knownTools.size > 0 && !this.inFence && !this.inHiddenFence && line.trimStart().startsWith('{')) {
			this.held = { kind: 'json', lines: [], text: '' };
			return this.hold(line);
		}
		if (FENCE_RE.test(line)) {
			const closing = this.inFence;
			this.inFence = !this.inFence;
			if (closing) {
				// The closing fence belongs to the hidden block, so it is swallowed
				// with it; only then does the block end.
				const hidden = this.inHiddenFence;
				this.inHiddenFence = false;
				if (hidden) {
					return;
				}
			} else {
				const tag = (FENCE_OPEN_RE.exec(line)?.[1] ?? '').toLowerCase();
				if (HIDDEN_FENCE_TAGS.has(tag)) {
					this.inHiddenFence = true;
					return;
				}
				if (this.knownTools.size > 0 && DEFERRED_FENCE_TAGS.has(tag)) {
					this.held = { kind: 'fence', lines: [line], text: '' };
					return;
				}
			}
			this.stream.markdown(line);
			return;
		}
		if (this.inHiddenFence) {
			return;
		}
		if (this.inFence) {
			this.stream.markdown(line);
			return;
		}
		return this.emitLinked(line);
	}

	/**
	 * Takes one line of a block being withheld and decides its fate: dropped when
	 * it completes a printed tool call, shown as soon as it cannot be one.
	 */
	private async hold(line: string): Promise<void> {
		const held = this.held!;
		held.lines.push(line);
		held.text += line;

		if (held.kind === 'fence') {
			if (FENCE_RE.test(line) && held.lines.length > 1) {
				const payload = held.lines.slice(1, -1).join('');
				this.held = undefined;
				this.inFence = false;
				if (!this.printedToolCall(payload)) {
					for (const pending of held.lines) {
						this.stream.markdown(pending);
					}
				}
				return;
			}
			// Anything that does not open with a brace is ordinary content, and the
			// user should watch it stream rather than wait for the block to close.
			const firstContent = held.lines.length === 2 && !line.trimStart().startsWith('{');
			if (firstContent || this.overflowed(held)) {
				return this.release();
			}
			return;
		}

		const split = firstBalancedObject(held.text);
		if (!split) {
			if (this.overflowed(held)) {
				await this.release();
			}
			return;
		}
		this.held = undefined;
		if (!this.printedToolCall(split.payload)) {
			await this.emitLinked(split.payload);
		}
		if (split.rest.trim()) {
			await this.emitLine(split.rest);
		}
	}

	/** Shows a withheld block, giving up on classifying it. */
	private async release(): Promise<void> {
		const held = this.held;
		if (!held) {
			return;
		}
		this.held = undefined;
		if (held.kind === 'fence') {
			for (const line of held.lines) {
				this.stream.markdown(line);
			}
			return;
		}
		await this.emitLinked(held.text);
	}

	private overflowed(held: IHeldBlock): boolean {
		return held.text.length > MAX_HELD_CHARS || held.lines.length > MAX_HELD_LINES;
	}

	/** True when `payload` is a call to a tool the model was offered. */
	private printedToolCall(payload: string): boolean {
		let parsed: unknown;
		try {
			parsed = JSON.parse(payload);
		} catch {
			return false;
		}
		if (!parsed || typeof parsed !== 'object') {
			return false;
		}
		const record = parsed as { name?: unknown; tool?: unknown };
		const name = typeof record.name === 'string' ? record.name : typeof record.tool === 'string' ? record.tool : undefined;
		return name !== undefined && this.knownTools.has(name);
	}

	private async emitLinked(line: string): Promise<void> {
		let lastIndex = 0;
		PATH_RE.lastIndex = 0;
		for (let match = PATH_RE.exec(line); match; match = PATH_RE.exec(line)) {
			const [matched, path, lineNumber, symbol] = match;
			const uri = await this.resolve(path);
			if (!uri) {
				continue;
			}
			this.stream.markdown(line.slice(lastIndex, match.index));
			this.stream.anchor(await this.target(uri, lineNumber, symbol), matched);
			lastIndex = match.index + matched.length;
		}
		this.stream.markdown(line.slice(lastIndex));
	}

	/**
	 * Turns a citation into what the click should reveal. A bare path opens the file at the top,
	 * which is useless when the answer is about one function in a 900-line service — so a cited
	 * symbol is resolved to the line where it is defined.
	 */
	private async target(uri: vscode.Uri, lineNumber: string | undefined, symbol: string | undefined): Promise<vscode.Uri | vscode.Location> {
		let zeroBasedLine: number | undefined;
		if (lineNumber) {
			zeroBasedLine = Math.max(0, parseInt(lineNumber, 10) - 1);
		} else if (symbol) {
			zeroBasedLine = await this.findDefinitionLine(uri, symbol);
		}
		return zeroBasedLine === undefined
			? uri
			: new vscode.Location(uri, new vscode.Position(zeroBasedLine, 0));
	}

	private async findDefinitionLine(uri: vscode.Uri, symbol: string): Promise<number | undefined> {
		const text = await this.readText(uri);
		if (!text) {
			return undefined;
		}
		for (const pattern of definitionPatterns(symbol)) {
			const match = pattern.exec(text);
			if (match) {
				// Counting newlines beats splitting the file into an array of lines we would
				// otherwise throw away.
				let line = 0;
				for (let i = 0; i < match.index; i++) {
					if (text.charCodeAt(i) === 10 /* \n */) {
						line++;
					}
				}
				return line;
			}
		}
		// The symbol is not in this file: still worth linking the file itself.
		return undefined;
	}

	private async readText(uri: vscode.Uri): Promise<string | undefined> {
		const key = uri.toString();
		if (this.contents.has(key)) {
			return this.contents.get(key);
		}
		let text: string | undefined;
		try {
			const bytes = await vscode.workspace.fs.readFile(uri);
			text = bytes.byteLength <= MAX_SYMBOL_SEARCH_BYTES ? Buffer.from(bytes).toString('utf8') : undefined;
		} catch {
			text = undefined;
		}
		this.contents.set(key, text);
		return text;
	}

	private async resolve(path: string): Promise<vscode.Uri | undefined> {
		const cached = this.resolved.get(path);
		if (cached !== undefined || this.resolved.has(path)) {
			return cached;
		}
		let uri: vscode.Uri | undefined;
		try {
			const candidate = resolveUri(path);
			const stat = await vscode.workspace.fs.stat(candidate);
			// Only files: a directory anchor cannot be opened in an editor.
			uri = stat.type === vscode.FileType.File ? candidate : undefined;
		} catch {
			// Not a path in this workspace — leave the text alone.
			uri = undefined;
		}
		this.resolved.set(path, uri);
		return uri;
	}
}

/** Streamed text withheld until it can be told apart from a printed tool call. */
interface IHeldBlock {
	readonly kind: 'fence' | 'json';
	readonly lines: string[];
	text: string;
}

/**
 * Splits `text` at the end of its first brace-balanced object.
 *
 * Needed because the bare-JSON form arrives without a fence to mark its end, and
 * the model often writes prose right after the closing brace. Quoted strings are
 * tracked so a `}` inside a value does not end the object early.
 */
function firstBalancedObject(text: string): { payload: string; rest: string } | undefined {
	const start = text.indexOf('{');
	if (start < 0) {
		return undefined;
	}
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (escaped) {
			escaped = false;
		} else if (ch === '\\') {
			escaped = true;
		} else if (ch === '"') {
			inString = !inString;
		} else if (inString) {
			continue;
		} else if (ch === '{') {
			depth++;
		} else if (ch === '}') {
			depth--;
			if (depth === 0) {
				return { payload: text.slice(0, i + 1), rest: text.slice(i + 1) };
			}
		}
	}
	return undefined;
}
