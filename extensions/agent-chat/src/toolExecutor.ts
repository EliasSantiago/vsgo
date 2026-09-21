/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { clampToolResult, IAgentProfile } from './agentProfile.js';
import { collectDiagnostics, computeFileEdit, computeMultiFileEdit, DiagnosticsInput, EditFileInput, findFiles, gitDiff, GitDiffInput, GitInput, gitStatus, listDirectory, MultiEditInput, openFileInEditor, OpenFileInput, readFileForModel, ReadFileInput, resolveUri, searchWorkspace } from './tools.js';

export const WRITE_FILE_TOOL_NAME = 'agent_write_file';
export const EDIT_FILE_TOOL_NAME = 'agent_edit_file';
export const MULTI_EDIT_TOOL_NAME = 'agent_multi_edit';
export const OPEN_FILE_TOOL_NAME = 'agent_open_file';

/** Read-only tools whose result cannot change until the agent writes a file. */
const REPEATABLE_READ_TOOLS: ReadonlySet<string> = new Set([
	'agent_read_file',
	'agent_list_dir',
	'agent_search',
	'agent_find_files',
]);

/**
 * Tools that only look. A sub-agent restricted to these can run beside any
 * number of others, because nothing it does can change what they see.
 */
export const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
	'agent_read_file',
	'agent_list_dir',
	'agent_search',
	'agent_find_files',
	'agent_diagnostics',
	'agent_git_status',
	'agent_git_diff',
	'agent_code_graph',
]);

/** Augmented stream type that includes the proposed `textEdit` API from `chatParticipantAdditions`. */
export type ChatStreamWithEdits = vscode.ChatResponseStream & {
	textEdit(target: vscode.Uri, edits: vscode.TextEdit | vscode.TextEdit[]): void;
	textEdit(target: vscode.Uri, isDone: true): void;
};

/** What one agent — the main one or a sub-agent — needs to run its tool calls. */
export interface IToolRunEnvironment {
	/**
	 * The request's stream. File edits go through it as text edits, so an edit
	 * made by a sub-agent lands in the same review flow as one made by the main
	 * agent: shown inline, with Accept / Reject.
	 */
	readonly stream: vscode.ChatResponseStream;
	readonly profile: IAgentProfile;
	/** Ties confirmations of commands and MCP tools to the chat request. */
	readonly toolInvocationToken: vscode.ChatParticipantToolToken | undefined;
	/** Tools that came from MCP servers, to steer the model when one fails. */
	readonly mcpToolNames: ReadonlySet<string>;
	/**
	 * Signatures of read-only calls already answered. Re-issuing one verbatim
	 * returns nothing new and costs a turn, so it is short-circuited. Cleared on
	 * every write, since a write can change what a read returns.
	 */
	readonly answeredReads: Set<string>;
}

export interface IToolRunOutcome {
	readonly part: vscode.LanguageModelToolResultPart;
	/** What the call was, for the one-line summary of a turn's activity. */
	readonly kind: 'search' | 'file' | 'command' | 'other';
	/** The file the call read or changed, when there was one. */
	readonly uri?: vscode.Uri;
}

/** Runs one tool call and returns its result for the model. Never throws for a tool error. */
export async function runAgentTool(tc: vscode.LanguageModelToolCallPart, env: IToolRunEnvironment, token: vscode.CancellationToken): Promise<IToolRunOutcome> {
	const text = (value: string) => new vscode.LanguageModelToolResultPart(tc.callId, [new vscode.LanguageModelTextPart(value)]);

	const readSignature = REPEATABLE_READ_TOOLS.has(tc.name) ? `${tc.name}:${JSON.stringify(tc.input)}` : undefined;
	if (readSignature !== undefined) {
		if (env.answeredReads.has(readSignature)) {
			return {
				part: text('You already made this exact call in this request and nothing has changed since. Reuse the earlier result and move on to the next step.'),
				kind: 'other',
			};
		}
		env.answeredReads.add(readSignature);
	}

	try {
		switch (tc.name) {
			case 'agent_search':
				return { part: text(clampToolResult(await searchWorkspace(tc.input as { query: string; isRegex?: boolean; path?: string }), env.profile)), kind: 'search' };
			case 'agent_find_files':
				return { part: text(clampToolResult(await findFiles(tc.input as { name: string; path?: string }), env.profile)), kind: 'search' };
			case WRITE_FILE_TOOL_NAME: {
				const input = tc.input as { path: string; content: string };
				const uri = resolveUri(input.path);
				const summary = await applyFileEdit(input, env.stream as ChatStreamWithEdits);
				env.answeredReads.clear();
				return { part: text(summary), kind: 'file', uri };
			}
			case EDIT_FILE_TOOL_NAME: {
				const input = tc.input as EditFileInput;
				const uri = resolveUri(input.path);
				const outcome = await computeFileEdit(input);
				if (outcome.content === undefined) {
					return { part: text(outcome.message), kind: 'other' };
				}
				await applyFileEdit({ path: input.path, content: outcome.content }, env.stream as ChatStreamWithEdits);
				env.answeredReads.clear();
				return { part: text(outcome.message), kind: 'file', uri };
			}
			case MULTI_EDIT_TOOL_NAME: {
				const input = tc.input as MultiEditInput;
				const uri = resolveUri(input.path);
				const outcome = await computeMultiFileEdit(input);
				if (outcome.content === undefined) {
					return { part: text(outcome.message), kind: 'other' };
				}
				await applyFileEdit({ path: input.path, content: outcome.content }, env.stream as ChatStreamWithEdits);
				env.answeredReads.clear();
				return { part: text(outcome.message), kind: 'file', uri };
			}
			case 'agent_read_file': {
				const input = tc.input as ReadFileInput;
				const uri = resolveUri(input.path);
				// Budgeted rather than clamped: the reader cuts on a line boundary
				// and tells the model which offset continues the file.
				return { part: text(await readFileForModel(input, env.profile.maxToolResultChars)), kind: 'file', uri };
			}
			case OPEN_FILE_TOOL_NAME: {
				const input = tc.input as OpenFileInput;
				const uri = resolveUri(input.path);
				return { part: text(await openFileInEditor(input)), kind: 'file', uri };
			}
			case 'agent_diagnostics':
				return { part: text(clampToolResult(await collectDiagnostics(tc.input as DiagnosticsInput), env.profile)), kind: 'other' };
			case 'agent_git_status':
				return { part: text(clampToolResult(await gitStatus(tc.input as GitInput), env.profile)), kind: 'other' };
			case 'agent_git_diff':
				return { part: text(clampToolResult(await gitDiff(tc.input as GitDiffInput), env.profile)), kind: 'other' };
			case 'agent_list_dir':
				return { part: text(clampToolResult(await listDirectory((tc.input as { path?: string }).path), env.profile)), kind: 'other' };
		}
	} catch (err) {
		return { part: text(`Tool error: ${err instanceof Error ? err.message : String(err)}`), kind: 'other' };
	}

	// agent_run_command, ferramentas MCP e desconhecidas — o VS Code cuida dos
	// diálogos de confirmação.
	try {
		const result = await vscode.lm.invokeTool(tc.name, { input: tc.input, toolInvocationToken: env.toolInvocationToken }, token);
		return {
			part: new vscode.LanguageModelToolResultPart(tc.callId, result.content as Array<vscode.LanguageModelTextPart | vscode.LanguageModelPromptTsxPart>),
			kind: 'command',
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		// The next step travels with the error on purpose: a small model that
		// receives only a failure stops and hands the task back to the user,
		// which is never the right answer while other tools are still available.
		//
		// A saída indicada muda conforme a origem: mandar quem falhou numa
		// ferramenta MCP tentar `agent_search` é conselho ruim — o trabalho dela é
		// com um serviço externo, e nenhuma ferramenta local o faz.
		const nextStep = env.mcpToolNames.has(tc.name)
			? 'Essa ferramenta vem de um servidor MCP externo; nenhuma ferramenta local faz o trabalho dela. Se o erro indicar falta de autenticação ou servidor fora do ar, diga isso ao usuário e siga com o que for possível sem ela.'
			: 'Não repita essa chamada — faça o mesmo trabalho com outra ferramenta (`agent_search` para um símbolo, `agent_find_files` para um arquivo, `agent_list_dir` para ver o que existe) e siga sem perguntar nada ao usuário.';
		return { part: text(`Erro da ferramenta ${tc.name}: ${message}. ${nextStep}`), kind: 'command' };
	}
}

/**
 * Streams a file write as a textEdit so VS Code shows the diff inline
 * with Accept / Reject decorations instead of writing directly to disk.
 */
async function applyFileEdit(
	input: { path: string; content: string },
	stream: ChatStreamWithEdits,
): Promise<string> {
	const uri = resolveUri(input.path);
	let range: vscode.Range;
	try {
		const oldBytes = await vscode.workspace.fs.readFile(uri);
		const oldText = Buffer.from(oldBytes).toString('utf8');
		const lines = oldText.split('\n');
		range = new vscode.Range(0, 0, lines.length - 1, lines[lines.length - 1].length);
	} catch {
		// File does not exist yet — insert from position 0.
		range = new vscode.Range(0, 0, 0, 0);
	}
	stream.textEdit(uri, new vscode.TextEdit(range, input.content));
	stream.textEdit(uri, true);
	return `Alterações em ${input.path} exibidas no editor para revisão (Aceitar / Rejeitar).`;
}
