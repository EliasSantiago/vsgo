/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'os';
import * as vscode from 'vscode';
import { log } from '../logger.js';
import { extractFrontmatter, parseBool } from '../rules/rulesLoader.js';
import { READ_ONLY_TOOL_NAMES } from '../toolExecutor.js';

/** A kind of sub-agent the main agent can delegate to. */
export interface ISubagentDefinition {
	/** Identifier the main agent passes to `agent_task`. */
	readonly name: string;
	/** When to use it, shown to the main agent in the tool description. */
	readonly description: string;
	/**
	 * Restricted to tools that only look. Read-only sub-agents run in parallel
	 * with each other; one that can write runs alone.
	 */
	readonly readonly: boolean;
	/** `inherit` for the main agent's model, or a model id to run on. */
	readonly model: string;
	/** Instructions added to the sub-agent's system prompt. */
	readonly prompt: string;
	/** Tool allowlist. Absent means every tool the main agent has that the mode permits. */
	readonly tools?: readonly string[];
	/** Where the definition came from: `builtin`, or the file that declared it. */
	readonly source: string;
}

export const BUILTIN_SUBAGENTS: readonly ISubagentDefinition[] = [
	{
		name: 'explore',
		description: 'Read-only investigation: finds where something lives, how a flow works, what calls what. Cannot edit files or run commands. Several of these run in parallel, so split a broad question into independent ones and send them in the same turn.',
		readonly: true,
		model: 'inherit',
		prompt: [
			'You are an exploration sub-agent. You can only read: search, list, read files, look at diagnostics and git state.',
			'Answer the question you were given with evidence. Your final message is a report to the agent that sent you, which cannot see anything you read — so put the substance in the report itself:',
			'- exact file paths with line numbers for everything relevant;',
			'- the key code quoted briefly where it matters;',
			'- a direct answer to the question, and what you could not determine.',
			'Do not suggest edits unless asked. Do not pad the report.',
		].join('\n'),
		source: 'builtin',
	},
	{
		name: 'general',
		description: 'Carries out a well-scoped task end to end with the same file and shell tools you have: implement a change, fix a failing test, refactor a module. Edits go through the same review flow as yours. Sub-agents that can edit run one at a time.',
		readonly: false,
		model: 'inherit',
		prompt: [
			'You are a sub-agent carrying out one well-scoped task. Do exactly what the task requires and nothing else.',
			'Your final message is a report to the agent that sent you: what you changed (exact file paths), how you verified it, and anything left undone.',
		].join('\n'),
		source: 'builtin',
	},
];

/**
 * Folders custom sub-agents are read from, in precedence order, under each
 * workspace folder and then under the home directory. `.agents/` is this
 * extension's own convention, beside `.agents/rules/`; the other two let a
 * project written for Claude Code or Cursor bring its sub-agents along.
 */
const SUBAGENT_DIRECTORIES: readonly string[] = ['.agents/agents', '.claude/agents', '.cursor/agents'];

/**
 * Tool names other agents use in their definitions, mapped onto ours. A name
 * with no counterpart here is dropped rather than failing the whole file.
 */
const FOREIGN_TOOL_NAMES: ReadonlyMap<string, readonly string[]> = new Map([
	['read', ['agent_read_file']],
	['grep', ['agent_search']],
	['glob', ['agent_find_files']],
	['ls', ['agent_list_dir']],
	['edit', ['agent_edit_file', 'agent_multi_edit']],
	['multiedit', ['agent_multi_edit']],
	['write', ['agent_write_file']],
	['bash', ['agent_run_command', 'agent_read_terminal']],
]);

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/**
 * The sub-agents available right now: the built-in ones, overridden or joined by
 * whatever the project and the user define.
 *
 * Read on every request rather than watched: there are a handful of small files
 * at most, and a definition edited mid-conversation takes effect on the next
 * message without anything to keep in sync.
 */
export async function loadSubagentDefinitions(): Promise<readonly ISubagentDefinition[]> {
	const roots = [...(vscode.workspace.workspaceFolders ?? []).map(f => f.uri), vscode.Uri.file(os.homedir())];
	const byName = new Map<string, ISubagentDefinition>();
	for (const root of roots) {
		for (const directory of SUBAGENT_DIRECTORIES) {
			for (const definition of await readDirectory(vscode.Uri.joinPath(root, directory))) {
				// The first one found wins: a project's definition beats the user's.
				if (!byName.has(definition.name)) {
					byName.set(definition.name, definition);
				}
			}
		}
	}
	const custom = [...byName.values()];
	if (custom.length > 0) {
		log(`subagents: ${custom.map(d => `${d.name} (${d.source})`).join(', ')}`);
	}
	return [...BUILTIN_SUBAGENTS.filter(b => !byName.has(b.name)), ...custom];
}

async function readDirectory(directory: vscode.Uri): Promise<ISubagentDefinition[]> {
	let entries: [string, vscode.FileType][];
	try {
		entries = await vscode.workspace.fs.readDirectory(directory);
	} catch {
		return [];
	}
	const definitions: ISubagentDefinition[] = [];
	for (const [file, type] of entries.sort(([a], [b]) => a.localeCompare(b))) {
		if (type !== vscode.FileType.File || !file.endsWith('.md')) {
			continue;
		}
		const uri = vscode.Uri.joinPath(directory, file);
		try {
			const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
			const definition = parseSubagentDefinition(file.replace(/\.md$/, ''), text, uri.fsPath);
			if (definition) {
				definitions.push(definition);
			}
		} catch (err) {
			log(`subagents: não consegui ler ${uri.fsPath}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	return definitions;
}

/**
 * Parses one definition file: YAML frontmatter with `name`, `description`,
 * `model`, `readonly` and `tools`, followed by the sub-agent's instructions.
 */
function parseSubagentDefinition(fileName: string, text: string, source: string): ISubagentDefinition | undefined {
	const { fields, body } = extractFrontmatter(text);
	const name = (typeof fields['name'] === 'string' ? fields['name'] : fileName).trim().toLowerCase();
	if (!NAME_PATTERN.test(name)) {
		log(`subagents: ${source} ignorado — nome inválido "${name}" (use letras minúsculas, dígitos, - e _)`);
		return undefined;
	}
	const description = typeof fields['description'] === 'string' ? fields['description'].trim() : '';
	if (!description) {
		// Without it the main agent has no way to know when to call this one.
		log(`subagents: ${source} ignorado — falta \`description\``);
		return undefined;
	}
	const tools = parseTools(fields['tools']);
	// An allowlist of tools that only look makes a sub-agent read-only whether or
	// not it says so, and read-only is what lets it run in parallel.
	const readonly = parseBool(fields['readonly']) ?? (tools !== undefined && tools.every(t => READ_ONLY_TOOL_NAMES.has(t)));
	return {
		name,
		description,
		readonly,
		model: typeof fields['model'] === 'string' && fields['model'].trim() ? fields['model'].trim() : 'inherit',
		prompt: body.trim() || `You are the \`${name}\` sub-agent. ${description}`,
		tools,
		source,
	};
}

/**
 * Accepts our tool names and the ones Claude Code uses, as a list or a
 * comma-separated string. A list in which nothing is recognised yields no
 * tools rather than all of them: whoever wrote it meant to restrict.
 */
function parseTools(value: unknown): readonly string[] | undefined {
	const raw = Array.isArray(value)
		? value.map(String)
		: typeof value === 'string' ? value.split(',') : undefined;
	if (!raw) {
		return undefined;
	}
	const names = new Set<string>();
	for (const entry of raw.map(t => t.trim()).filter(Boolean)) {
		const mapped = entry.startsWith('agent_') ? [entry] : FOREIGN_TOOL_NAMES.get(entry.toLowerCase());
		for (const tool of mapped ?? []) {
			names.add(tool);
		}
	}
	return [...names];
}
