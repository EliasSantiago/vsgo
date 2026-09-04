/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';
import { createTypeScriptParser, TSNode, TSParser } from '../graphIndex/treeSitter.js';

/** One embeddable unit of source code. */
export interface ICodeChunk {
	/** Workspace-relative path. */
	readonly file: string;
	/** 1-based, inclusive. */
	readonly startLine: number;
	/** 1-based, inclusive. */
	readonly endLine: number;
	/** Breadcrumb describing where the chunk sits, e.g. `class Foo › bar`. */
	readonly breadcrumb: string;
	/** What actually gets embedded: the breadcrumb header followed by the body. */
	readonly text: string;
	/** Stable digest of {@link text}, used to skip re-embedding unchanged chunks. */
	readonly hash: string;
}

/** Declarations worth isolating as their own chunk. */
const UNIT_TYPES = new Set([
	'function_declaration',
	'generator_function_declaration',
	'class_declaration',
	'abstract_class_declaration',
	'interface_declaration',
	'type_alias_declaration',
	'enum_declaration',
	'method_definition',
	'method_signature',
	'public_field_definition',
	'lexical_declaration',
	'variable_declaration',
	'export_statement',
]);

/** Declarations that carry a body worth descending into rather than emitting whole. */
const CONTAINER_TYPES = new Set([
	'class_declaration',
	'abstract_class_declaration',
	'interface_declaration',
	'class_body',
	'interface_body',
	'object_type',
	'enum_declaration',
	'export_statement',
]);

const MAX_UNIT_LINES = 80;
const WINDOW_LINES = 60;
const WINDOW_OVERLAP = 10;
/**
 * Declaration-per-chunk alone shatters a file into dozens of one-line type
 * aliases, which costs vectors without adding meaning. Neighbouring
 * declarations are merged back together up to this size.
 */
const MERGE_MAX_LINES = 50;
/** Blank lines and comments between two declarations still count as adjacent. */
const MAX_MERGE_GAP = 4;
/** Separates the endpoints of a breadcrumb that spans several declarations. */
const RANGE_SEPARATOR = ' … ';
/**
 * Keeps a chunk inside the embedding model's context.
 *
 * The catalog models take 512 tokens and llama.cpp rejects — rather than
 * truncates — anything longer. Measured over this repository, source tokenizes
 * at 3.1 characters per token in the median but only 1.7 in the densest
 * thousandth, and it is that tail the budget has to survive; `EmbeddingServer`
 * re-embeds a shortened copy of anything that still overflows.
 */
const MAX_CHUNK_CHARS = 900;
const MIN_CHUNK_CHARS = 40;

const AST_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

/** True when the TypeScript grammar is worth trying on this path. */
export function supportsAstChunking(file: string): boolean {
	const dot = file.lastIndexOf('.');
	return dot >= 0 && AST_EXTENSIONS.has(file.slice(dot).toLowerCase());
}

let parserPromise: Promise<TSParser | undefined> | undefined;

async function sharedParser(): Promise<TSParser | undefined> {
	if (!parserPromise) {
		parserPromise = createTypeScriptParser();
	}
	return parserPromise;
}

/**
 * Splits a source file into chunks.
 *
 * TypeScript and JavaScript are cut at declaration boundaries so a chunk is a
 * whole function or method; anything else — and anything the parser cannot
 * handle — falls back to overlapping line windows. Both paths prefix every
 * chunk with its location, without which the thousands of near-identical
 * `dispose()` bodies in a codebase this size collapse onto the same vector.
 */
export async function chunkFile(file: string, source: string): Promise<ICodeChunk[]> {
	const lines = source.split(/\r?\n/);
	let spans: ISpan[] | undefined;
	if (supportsAstChunking(file)) {
		spans = await astSpans(source, lines.length);
	}
	if (!spans || spans.length === 0) {
		spans = windowSpans(1, lines.length, []);
	}
	const chunks: ICodeChunk[] = [];
	for (const span of coalesce(spans, lines)) {
		const chunk = materialize(file, lines, span);
		if (chunk) {
			chunks.push(chunk);
		}
	}
	return chunks;
}

/** A line range plus the declaration path that produced it. */
interface ISpan {
	readonly startLine: number;
	readonly endLine: number;
	readonly path: readonly string[];
}

async function astSpans(source: string, lineCount: number): Promise<ISpan[] | undefined> {
	const parser = await sharedParser();
	if (!parser) {
		return undefined;
	}
	let tree;
	try {
		tree = parser.parse(source);
	} catch {
		return undefined;
	}
	try {
		const spans: ISpan[] = [];
		collect(tree.rootNode, [], spans);
		if (spans.length === 0) {
			return undefined;
		}
		spans.sort((a, b) => a.startLine - b.startLine);
		// Imports and loose top-level statements fall outside every declaration;
		// windowing the gaps keeps them retrievable instead of dropping them.
		return [...spans, ...gapSpans(spans, lineCount)].sort((a, b) => a.startLine - b.startLine);
	} finally {
		tree.delete();
	}
}

function collect(node: TSNode, path: readonly string[], out: ISpan[]): void {
	for (const child of node.namedChildren) {
		if (!UNIT_TYPES.has(child.type)) {
			collect(child, path, out);
			continue;
		}
		const name = child.childForFieldName('name')?.text;
		const childPath = name ? [...path, `${label(child.type)}${name}`] : path;
		const startLine = child.startPosition.row + 1;
		const endLine = child.endPosition.row + 1;
		const isContainer = CONTAINER_TYPES.has(child.type);

		if (endLine - startLine + 1 <= MAX_UNIT_LINES && !isContainer) {
			out.push({ startLine, endLine, path: childPath });
			continue;
		}
		// Too big, or a container: emit the signature and descend, so a 900-line
		// class becomes one chunk per method instead of one unusable blob.
		const before = out.length;
		collect(child, childPath, out);
		if (out.length === before) {
			if (endLine - startLine + 1 <= MAX_UNIT_LINES) {
				out.push({ startLine, endLine, path: childPath });
			} else {
				out.push(...windowSpans(startLine, endLine, childPath));
			}
			continue;
		}
		const firstNested = Math.min(...out.slice(before).map(s => s.startLine));
		if (firstNested > startLine) {
			out.push({ startLine, endLine: firstNested - 1, path: childPath });
		}
	}
}

function label(type: string): string {
	switch (type) {
		case 'class_declaration':
		case 'abstract_class_declaration':
			return 'class ';
		case 'interface_declaration':
			return 'interface ';
		case 'enum_declaration':
			return 'enum ';
		case 'type_alias_declaration':
			return 'type ';
		default:
			return '';
	}
}

/** Line ranges not covered by any span, as windows. */
function gapSpans(spans: readonly ISpan[], lineCount: number): ISpan[] {
	const covered = new Array<boolean>(lineCount + 2).fill(false);
	for (const span of spans) {
		for (let line = span.startLine; line <= Math.min(span.endLine, lineCount); line++) {
			covered[line] = true;
		}
	}
	const out: ISpan[] = [];
	let start: number | undefined;
	for (let line = 1; line <= lineCount + 1; line++) {
		const isCovered = line > lineCount || covered[line];
		if (!isCovered && start === undefined) {
			start = line;
		} else if (isCovered && start !== undefined) {
			out.push(...windowSpans(start, line - 1, []));
			start = undefined;
		}
	}
	return out;
}

function windowSpans(startLine: number, endLine: number, path: readonly string[]): ISpan[] {
	const out: ISpan[] = [];
	const stride = Math.max(1, WINDOW_LINES - WINDOW_OVERLAP);
	for (let line = startLine; line <= endLine; line += stride) {
		const last = Math.min(line + WINDOW_LINES - 1, endLine);
		out.push({ startLine: line, endLine: last, path });
		if (last === endLine) {
			break;
		}
	}
	return out;
}

/**
 * Merges adjacent spans that are individually too small to be worth a vector.
 *
 * Overlapping spans — the sliding windows — are left alone: their overlap is
 * deliberate, and folding them together would undo it.
 */
function coalesce(spans: readonly ISpan[], lines: readonly string[]): ISpan[] {
	const out: ISpan[] = [];
	let current: ISpan | undefined;
	for (const span of spans) {
		if (!current) {
			current = span;
			continue;
		}
		const gap = span.startLine - current.endLine - 1;
		const mergedEnd = Math.max(current.endLine, span.endLine);
		const mergedLines = mergedEnd - current.startLine + 1;
		const fits = gap >= 0
			&& gap <= MAX_MERGE_GAP
			&& mergedLines <= MERGE_MAX_LINES
			&& charsIn(lines, current.startLine, mergedEnd) <= MAX_CHUNK_CHARS;
		if (fits) {
			current = { startLine: current.startLine, endLine: mergedEnd, path: mergePaths(current.path, span.path) };
		} else {
			out.push(current);
			current = span;
		}
	}
	if (current) {
		out.push(current);
	}
	return out;
}

function charsIn(lines: readonly string[], startLine: number, endLine: number): number {
	let total = 0;
	for (let line = startLine; line <= endLine && line <= lines.length; line++) {
		total += lines[line - 1].length + 1;
	}
	return total;
}

/**
 * Breadcrumb for a merged span: the deepest shared ancestry, or a range across
 * the two names when the members share no parent at all.
 */
function mergePaths(a: readonly string[], b: readonly string[]): string[] {
	const shared: string[] = [];
	for (let i = 0; i < Math.min(a.length, b.length); i++) {
		if (a[i] !== b[i]) {
			break;
		}
		shared.push(a[i]);
	}
	if (shared.length > 0 || a.length === 0 || b.length === 0) {
		return shared.length > 0 ? shared : [...a, ...b].slice(0, 1);
	}
	// Repeated merges must not keep appending names: a range always reads as
	// exactly its two endpoints, however many declarations it swallowed.
	const left = a[a.length - 1];
	const right = b[b.length - 1];
	const start = left.includes(RANGE_SEPARATOR) ? left.slice(0, left.indexOf(RANGE_SEPARATOR)) : left;
	const end = right.includes(RANGE_SEPARATOR) ? right.slice(right.lastIndexOf(RANGE_SEPARATOR) + RANGE_SEPARATOR.length) : right;
	return [`${start}${RANGE_SEPARATOR}${end}`];
}

function materialize(file: string, lines: readonly string[], span: ISpan): ICodeChunk | undefined {
	const body = lines.slice(span.startLine - 1, span.endLine).join('\n').trim();
	if (body.length < MIN_CHUNK_CHARS) {
		return undefined;
	}
	const breadcrumb = span.path.join(' › ');
	const header = breadcrumb ? `${file}\n${breadcrumb}` : file;
	const budget = MAX_CHUNK_CHARS - header.length - 1;
	const text = `${header}\n${body.length > budget ? `${body.slice(0, budget)}…` : body}`;
	return {
		file,
		startLine: span.startLine,
		endLine: span.endLine,
		breadcrumb,
		text,
		hash: createHash('sha256').update(text).digest('hex').slice(0, 16),
	};
}
