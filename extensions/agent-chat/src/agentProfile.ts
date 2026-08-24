/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { log } from './logger.js';

/**
 * How the agent loop is tuned for the model driving it.
 *
 * The `full` profile targets frontier hosted models: every tool, the long
 * system prompt, parallel tool calls and a generous turn budget. The `compact`
 * profile targets models running on the user's own machine — roughly 1.5B to
 * 14B parameters, quantized, with a 16k-32k context. Those models degrade in
 * specific, predictable ways, and each field below answers one of them.
 */
export interface IAgentProfile {
	readonly id: 'full' | 'compact';
	/** Turn budget for one request. */
	readonly maxTurns: number;
	/** Base system prompt, before workspace, rules and memories are appended. */
	readonly systemPrompt: string;
	/** Whether the planner and sub-agent tools are offered. */
	readonly allowDelegation: boolean;
	/** Whether the Integrated Browser tools are offered. */
	readonly allowBrowser: boolean;
	/** Cap applied to each tool result before it goes back into the context. */
	readonly maxToolResultChars: number;
	/** Cap on a single file attached to the prompt as a text reference. */
	readonly maxTextRefBytes: number;
	/**
	 * Whether to also look for tool calls in the assistant's plain text. Local
	 * runtimes fall back to emitting the raw call when the chat template's tool
	 * parser does not fire, and without this the agent would silently stall.
	 */
	readonly parseTextToolCalls: boolean;
}

/**
 * Short, blunt, and ordered by what a small model gets wrong most often.
 *
 * It covers the same tools as the full prompt but never its call-batching
 * guidance, which is the opposite of what these models should do. The browser
 * and command sections are cut to the steps themselves: a small model follows a
 * numbered sequence far more reliably than it follows an explanation.
 */
const COMPACT_SYSTEM_PROMPT = `
You are a coding assistant inside the VS Code editor. You are a small local model, so work in small, certain steps.

## Language
Reply in the same language the user wrote in. If they write Portuguese, answer entirely in Portuguese.

## One step at a time
Make ONE tool call per turn. Wait for its result before deciding the next step.
Never guess a file's path or contents — look first.

## A file the user attached is already read
An attached file arrives in the message inside a \`--- Arquivo: /caminho ---\` block that
holds its content. That IS the file. Answer from what is in the block: do not call
\`agent_read_file\` on it, and do not go looking for it with \`agent_search\` or
\`agent_find_files\`. Only when the block itself says the content was left out — too large,
or only a selection — do you read it.

## Tool call format
Use the exact format the Tools section shows you, \`<tool_call>\` tags included.
If you write the call as plain json instead, always put it inside a \`\`\`json fence —
never bare in the middle of your text.

## Never describe a tool call
Emit the call itself. Never write out what you are "about to" run, never show the
command in a code block, and never write "Comando executado" or "Aguarde" — a
described call does not run. Call the tool, stay silent, and speak once the
result comes back.

## Finding code
Two different tools, and picking the wrong one is the most common way to get stuck:
- \`agent_find_files\` finds a file by its NAME, at any depth. Use it when you are looking for a file.
- \`agent_search\` looks INSIDE files for text. Use it when you are looking for a symbol or a string.
Searching the contents for a filename finds nothing — that is not evidence the file is absent.

An empty result is a reason to try again differently, never a reason to stop or to answer.
When a search comes back empty, do ONE of these before saying anything to the user:
- retry with a shorter fragment (\`routes\` instead of \`app-routing.module.ts\`);
- guess by what the code would contain instead of how it is named (\`Routes\`, \`createRouter\`, \`@app.route\`);
- \`agent_list_dir\` the directory you believe it is in and read the real names.
Only after two or three genuinely different attempts may you say something was not found,
and then say what you tried. Never ask the user for information you could have looked up.

A tool that answers with an error is the same case: pick a different tool and carry on.
Never report a broken tool as if it ended the task, never offer to do the work, and never
ask the user to do by hand something you have tools for.

## Editing a file
1. \`agent_read_file\` to read the current content. A big file comes back in parts — it tells you the \`offset\` to continue from, and you can pass \`offset\`/\`limit\` yourself to read just the region you need.
2. \`agent_edit_file\` with \`oldText\` copied EXACTLY from what you just read — same spaces, same indentation — and \`newText\` to put in its place. Send only the lines that change, never the whole file.
   If it answers that the text appears more than once, add the lines above and below to \`oldText\` until it is unique.
   Changing several places in the SAME file? Send them in one \`agent_multi_edit\` call instead of one call per place.
   Use \`agent_write_file\` only to create a file that does not exist yet.
3. \`agent_diagnostics\` to check you did not break anything. It is instant — never skip it, and never run a build to find out instead. Fix what it reports before answering.
4. Say in one or two sentences what changed.
Never print code in the chat instead of writing it to the file.

## Tasks with several steps
Call \`agent_todo_write\` with the whole plan before starting, then again after each step to mark
it done and start the next. Send the full list every time; exactly one item \`in_progress\`.
Read the list back before choosing your next move, and do not stop while items are open.
Skip it for anything that takes one or two tool calls.

## Checking what changed
\`agent_git_status\` lists modified files, \`agent_git_diff\` shows the change itself.

## Exploring
\`agent_list_dir\` with no path lists the workspace root. Read only the files the task needs. Never list \`node_modules\`, \`.git\`, \`dist\` or \`build\`.
Never repeat a tool call you already made in this conversation — if you want to, you already have the answer, so act on it.

## Running commands
\`agent_run_command\` runs a shell command. Anything that does not exit on its own — a dev
server, a watcher — needs \`"background": true\`, or the call hangs until it is killed.
Read \`package.json\` first to find the real start script. Never assume the command or the port.
A background call returns a terminal id and only its first seconds of output. Call
\`agent_read_terminal\` with that id and \`"waitSeconds": 5\` to see what it printed next.

## Running an app in the browser
When the user asks you to run, open, test or look at a web app, in this order:
1. \`agent_read_file\` on \`package.json\` to find the start script.
2. \`agent_run_command\` with that script and \`"background": true\`.
3. \`agent_read_terminal\` with the returned id to read the URL the server actually printed.
4. \`open_browser_page\` with that url. It returns a \`pageId\`.
5. \`read_page\` with the \`pageId\`. This is how you see the page — \`screenshot_page\` returns
   nothing you can read, it is only for showing the user.
6. Interact with \`click_element\` / \`type_in_page\` using refs from the LATEST \`read_page\`,
   then \`read_page\` again to confirm.
Never say the app works until \`read_page\` actually showed it.

## Answering
Cite files as \`path/to/file.ts#symbolName\` or \`path/to/file.ts:120\` so they become clickable.
When the task is done, stop calling tools and give the final answer.

## Say less
Answer from what the tools returned, and stop there. Do not write any of these:
- a restatement of what the user just asked ("Para analisar as rotas da sua aplicação...");
- an announcement of what you are going to do ("Vou buscar...", "Agora vou ler...") — just do it;
- a summary of the steps you took, unless the user asked how you did it;
- a suggestion that the user check something themselves, send you more information, or
  confirm what you found — you have the tools, so go and look;
- an offer of further help ("Se precisar de mais alguma coisa...").

The user wants the answer, not an account of the work. When they ask what the routes
are, list the routes and the file they came from. Nothing else.
`.trim();

/** The full profile's prompt and turn budget, owned by the agent loop. */
export interface IFullProfileDefaults {
	readonly systemPrompt: string;
	readonly maxTurns: number;
}

/**
 * Resolves the profile for `model`.
 *
 * `auto` keys off the vendor rather than the context window: a vendor that
 * serves weights from this machine is the reliable signal that the model is
 * small, and it produces no false positives on hosted models.
 */
export function resolveProfile(model: vscode.LanguageModelChat, defaults: IFullProfileDefaults): IAgentProfile {
	const setting = vscode.workspace.getConfiguration('agent-chat').get<'auto' | 'compact' | 'full'>('agentProfile', 'auto');
	const compact = setting === 'compact' || (setting === 'auto' && isLocallyHosted(model.vendor));
	const profile = compact ? compactProfile() : fullProfile(defaults);
	log(`[profile] ${profile.id} for ${model.vendor}/${model.id} (setting=${setting})`);
	return profile;
}

function isLocallyHosted(vendor: string): boolean {
	return vendor === 'local' || vendor === 'ollama';
}

function compactProfile(): IAgentProfile {
	return {
		id: 'compact',
		// One call per turn means more turns for the same work, not fewer, and a
		// browser run spends several of them before it even reaches the page. A
		// budget below the full one truncated those runs mid-task.
		maxTurns: 32,
		systemPrompt: COMPACT_SYSTEM_PROMPT,
		// Same tools the hosted models get. Withholding them did not make a small
		// model choose better — it made tasks impossible, and the model answered
		// by describing the work it could not do.
		allowDelegation: true,
		allowBrowser: true,
		// A 16k context cannot absorb a 100k-character file; one unbounded read
		// would evict the system prompt and the task itself.
		maxToolResultChars: 8000,
		maxTextRefBytes: 16 * 1024,
		parseTextToolCalls: true,
	};
}

function fullProfile(defaults: IFullProfileDefaults): IAgentProfile {
	return {
		id: 'full',
		maxTurns: defaults.maxTurns,
		systemPrompt: defaults.systemPrompt,
		allowDelegation: true,
		allowBrowser: true,
		maxToolResultChars: 100_000,
		maxTextRefBytes: 100 * 1024,
		parseTextToolCalls: false,
	};
}

/** Cuts `text` to the profile's limit, marking the cut so the model knows. */
export function clampToolResult(text: string, profile: IAgentProfile): string {
	if (text.length <= profile.maxToolResultChars) {
		return text;
	}
	return text.slice(0, profile.maxToolResultChars) + '\n…[truncado]';
}

/**
 * Recovers tool calls that arrived as plain text.
 *
 * When llama.cpp cannot apply a model's tool-call grammar — an unsupported
 * template, a quantization that drifts off the expected syntax — the call comes
 * back as content instead of a structured part. Qwen-family models emit
 * `<tool_call>{...}</tool_call>`; others wrap the same JSON in a fenced block.
 * Gemma is the odd one out and does not use JSON at all: it was trained to write
 * a ```tool_code fence holding a Python call, `agent_read_file(path="src/a.ts")`.
 * All three are recognised here and the matched text is stripped so it never
 * reaches the user.
 *
 * `tools` carries the schemas, not just the names, because a Python call may put
 * its arguments positionally and only the schema says which parameter each one
 * fills.
 */
export function extractTextToolCalls(
	text: string,
	tools: readonly vscode.LanguageModelChatTool[],
): { calls: vscode.LanguageModelToolCallPart[]; remainingText: string } {
	const knownTools = new Set(tools.map(t => t.name));
	const schemas = parameterOrder(tools);
	const calls: vscode.LanguageModelToolCallPart[] = [];
	let remaining = text;

	const patterns = [
		/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g,
		// The fence tag is whatever the model felt like writing: `json` and
		// `tool_call`, but just as often `xml`, `bash` or a language that has
		// nothing to do with the payload. Matching only the expected two dropped
		// a quarter of the calls Qwen-class models make.
		/```[a-zA-Z0-9_+#-]*\s*(\{[\s\S]*?"(?:name|tool)"[\s\S]*?\})\s*```/g,
	];

	for (const pattern of patterns) {
		remaining = remaining.replace(pattern, (match, payload: string) => {
			const call = toToolCall(payload, knownTools);
			if (!call) {
				return match;
			}
			calls.push(call);
			return '';
		});
	}

	// Gemma's fence. Tried after the JSON patterns so a model that emits proper
	// JSON inside a ```tool_code block still takes the path above. The payload
	// must resolve to a known tool, which is what keeps an ordinary Python
	// snippet in an answer from being mistaken for a call.
	if (calls.length === 0) {
		remaining = remaining.replace(/```[a-zA-Z0-9_+#-]*\s*([\s\S]*?)\s*```/g, (match, payload: string) => {
			const call = toPythonToolCall(payload, knownTools, schemas);
			if (!call) {
				return match;
			}
			calls.push(call);
			return '';
		});
	}

	// Same call without the fence: small models drop it often enough that
	// requiring the fence would stall the loop for a whole turn.
	if (calls.length === 0) {
		const call = toPythonToolCall(remaining, knownTools, schemas);
		if (call) {
			calls.push(call);
			remaining = '';
		}
	}

	// Unfenced call: the model narrates a plan and drops the bare object into the
	// middle of it. Brace matching finds it wherever it sits, and `knownTools`
	// keeps prose that merely looks like JSON from becoming a call. Only the
	// first is run — a narrated plan often lists several steps, and running them
	// blind is exactly what the one-call-per-turn rule exists to prevent.
	//
	// The ones that are not run are still stripped. Left in the text they would
	// be shown to the user, kept in the transcript, and read back by the model on
	// the next turn as an example of what to write — which is how a small model
	// ends up re-emitting the same block of calls every turn, advancing one step
	// at a time while paying to generate the whole list again.
	if (calls.length === 0) {
		let taken = false;
		for (const candidate of jsonObjectsIn(remaining)) {
			const call = toToolCall(candidate, knownTools);
			if (!call) {
				continue;
			}
			if (!taken) {
				calls.push(call);
				taken = true;
			}
			remaining = remaining.replace(candidate, '');
		}
	}

	return { calls, remainingText: remaining.trim() };
}

/**
 * Every brace-balanced `{...}` block in `text`, outermost first.
 *
 * A plain regex cannot do this: the arguments object nests, so `\{.*?\}` stops
 * at the first inner brace and yields unparseable fragments. Quoted strings are
 * tracked so a `}` inside a value does not end the block early.
 */
function jsonObjectsIn(text: string): string[] {
	const found: string[] = [];
	for (let i = 0; i < text.length; i++) {
		if (text[i] !== '{') {
			continue;
		}
		let depth = 0;
		let inString = false;
		let escaped = false;
		for (let j = i; j < text.length; j++) {
			const ch = text[j];
			if (escaped) {
				escaped = false;
			} else if (ch === '\\') {
				escaped = true;
			} else if (ch === '"') {
				inString = !inString;
			} else if (!inString && ch === '{') {
				depth++;
			} else if (!inString && ch === '}') {
				depth--;
				if (depth === 0) {
					found.push(text.slice(i, j + 1));
					i = j;
					break;
				}
			}
		}
	}
	return found;
}

function toToolCall(payload: string, knownTools: ReadonlySet<string>): vscode.LanguageModelToolCallPart | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(payload);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== 'object') {
		return undefined;
	}
	const record = parsed as { name?: unknown; tool?: unknown; arguments?: unknown; parameters?: unknown; input?: unknown };
	const name = typeof record.name === 'string' ? record.name : typeof record.tool === 'string' ? record.tool : undefined;
	if (!name || !knownTools.has(name)) {
		return undefined;
	}
	const rawInput = record.arguments ?? record.parameters ?? record.input ?? {};
	const input = normalizeInput(rawInput);
	if (!input) {
		return undefined;
	}
	log(`[profile] recovered tool call "${name}" from assistant text`);
	return new vscode.LanguageModelToolCallPart(freshCallId(name), name, input);
}

/** Arguments sometimes arrive as a JSON string rather than an object. */
function normalizeInput(raw: unknown): object | undefined {
	if (raw && typeof raw === 'object') {
		return raw as object;
	}
	if (typeof raw === 'string') {
		try {
			const parsed: unknown = JSON.parse(raw);
			return parsed && typeof parsed === 'object' ? parsed as object : undefined;
		} catch {
			return undefined;
		}
	}
	return undefined;
}

/** Declared parameter names per tool, in schema order, to place positional arguments. */
function parameterOrder(tools: readonly vscode.LanguageModelChatTool[]): Map<string, readonly string[]> {
	const out = new Map<string, readonly string[]>();
	for (const tool of tools) {
		const schema = tool.inputSchema as { properties?: Record<string, unknown> } | undefined;
		out.set(tool.name, schema?.properties ? Object.keys(schema.properties) : []);
	}
	return out;
}

/**
 * Reads Gemma's tool-call idiom: a Python call, `agent_read_file(path="a.ts")`.
 *
 * The bare name with no parentheses is accepted too — a 4B model writes
 * `agent_list_dir` on its own about as often as it writes `agent_list_dir()`,
 * and both mean the same call with no arguments.
 */
function toPythonToolCall(
	payload: string,
	knownTools: ReadonlySet<string>,
	schemas: ReadonlyMap<string, readonly string[]>,
): vscode.LanguageModelToolCallPart | undefined {
	// `print(...)` shows up because the fence is nominally Python and the model
	// reaches for the way it would normally surface a value.
	const source = payload.trim().replace(/^print\s*\(\s*([\s\S]*)\s*\)$/, '$1').trim();
	const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(([\s\S]*)\))?$/.exec(source);
	if (!match) {
		return undefined;
	}
	const [, name, rawArgs] = match;
	if (!knownTools.has(name)) {
		return undefined;
	}
	const input = parsePythonArguments(rawArgs ?? '', schemas.get(name) ?? []);
	if (!input) {
		return undefined;
	}
	log(`[profile] recovered tool call "${name}" from a Python-style call in assistant text`);
	return new vscode.LanguageModelToolCallPart(freshCallId(name), name, input);
}

/**
 * Turns a Python argument list into the tool's input object.
 *
 * Keyword arguments are what the models actually emit; positional ones fall back
 * to the schema's declaration order, which is the only thing that says what an
 * unnamed value was meant to be.
 */
function parsePythonArguments(raw: string, parameterNames: readonly string[]): object | undefined {
	const input: Record<string, unknown> = {};
	const parts = splitTopLevel(raw);

	// A lone positional object is the argument map itself, not the first
	// parameter's value. This is the shape the model is most likely to produce,
	// because flattenToAlternating describes its previous calls back to it as
	// `agent_read_file({"path":"a.ts"})` and it copies what it sees. Reading that
	// as positional yields `{path: {path: "a.ts"}}`, which then gets described
	// back and copied again — one extra level of nesting per turn until the
	// conversation is unusable. Matching the keys against the schema is what
	// separates "these are the arguments" from a first parameter that genuinely
	// takes an object.
	if (parts.length === 1 && !/^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(parts[0])) {
		const only = parsePythonValue(parts[0]);
		if (only && typeof only === 'object' && !Array.isArray(only)) {
			const entries = Object.entries(only as Record<string, unknown>);
			if (entries.length === 0 || !entries.every(([key]) => parameterNames.includes(key))) {
				// An object that is not the argument map, and no parameter it could
				// belong to. Feeding it to the tool would only produce a failed call
				// with arguments the user never asked for.
				return undefined;
			}
			return Object.fromEntries(entries.map(([key, value]) => [key, unwrapSelfNested(key, value)]));
		}
	}

	let positional = 0;
	for (const part of parts) {
		const keyword = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([\s\S]+)$/.exec(part);
		if (keyword) {
			const value = parsePythonValue(keyword[2]);
			if (value === undefined) {
				return undefined;
			}
			input[keyword[1]] = unwrapSelfNested(keyword[1], value);
			continue;
		}
		const name = parameterNames[positional++];
		if (!name) {
			// An unnamed value with no slot left to put it in. Guessing here would
			// hand the tool an argument the user never asked for.
			return undefined;
		}
		const value = parsePythonValue(part);
		if (value === undefined) {
			return undefined;
		}
		input[name] = unwrapSelfNested(name, value);
	}
	return input;
}

/**
 * Collapses `path={"path": "a.ts"}` down to `"a.ts"`.
 *
 * Once a conversation contains one wrongly nested call, the model keeps copying
 * it, so the loop has to be able to heal rather than carry the mistake forward.
 * Only a single key, matching the parameter it sits under, is unwrapped — that
 * shape is always the model quoting itself, never a real argument.
 */
function unwrapSelfNested(name: string, value: unknown): unknown {
	let current = value;
	while (current && typeof current === 'object' && !Array.isArray(current)) {
		const keys = Object.keys(current as Record<string, unknown>);
		if (keys.length !== 1 || keys[0] !== name) {
			break;
		}
		current = (current as Record<string, unknown>)[name];
	}
	return current;
}

/**
 * Splits on commas that separate arguments, ignoring those inside a string or a
 * nested list/dict — `agent_write_file(path="a,b.ts", content="x")` has one
 * comma that separates and one that does not.
 */
function splitTopLevel(raw: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let quote: string | undefined;
	let escaped = false;
	let current = '';
	for (const ch of raw) {
		if (escaped) {
			current += ch;
			escaped = false;
			continue;
		}
		if (quote) {
			current += ch;
			if (ch === '\\') {
				escaped = true;
			} else if (ch === quote) {
				quote = undefined;
			}
			continue;
		}
		if (ch === '"' || ch === '\'') {
			quote = ch;
			current += ch;
			continue;
		}
		if (ch === '[' || ch === '{' || ch === '(') {
			depth++;
		} else if (ch === ']' || ch === '}' || ch === ')') {
			depth--;
		} else if (ch === ',' && depth === 0) {
			parts.push(current.trim());
			current = '';
			continue;
		}
		current += ch;
	}
	if (current.trim()) {
		parts.push(current.trim());
	}
	return parts.filter(p => p.length > 0);
}

/** One Python literal as its JSON equivalent. `undefined` means "not a literal we trust". */
function parsePythonValue(raw: string): unknown {
	const text = raw.trim();
	if (text === 'True') { return true; }
	if (text === 'False') { return false; }
	if (text === 'None') { return null; }
	if (/^-?\d+$/.test(text)) { return Number.parseInt(text, 10); }
	if (/^-?\d*\.\d+$/.test(text)) { return Number.parseFloat(text); }
	// Triple quotes are how the model passes a whole file to agent_write_file.
	const triple = /^(?:"""|''')([\s\S]*?)(?:"""|''')$/.exec(text);
	if (triple) {
		return triple[1];
	}
	if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith('\'') && text.endsWith('\''))) {
		// JSON.parse handles the escapes, but only understands double quotes.
		const doubled = text.startsWith('\'')
			? `"${text.slice(1, -1).replace(/\\'/g, '\'').replace(/"/g, '\\"')}"`
			: text;
		try {
			return JSON.parse(doubled) as unknown;
		} catch {
			return text.slice(1, -1);
		}
	}
	if (text.startsWith('[') || text.startsWith('{')) {
		try {
			return JSON.parse(text.replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false').replace(/\bNone\b/g, 'null')) as unknown;
		} catch {
			return undefined;
		}
	}
	return undefined;
}

function freshCallId(name: string): string {
	return `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
