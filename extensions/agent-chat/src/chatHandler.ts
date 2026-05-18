/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { RulesLoader } from './rules/rulesLoader.js';
import { ResolvedRules, Rule } from './rules/types.js';
import { MemoryEntry, MemoryService } from './memory/memoryService.js';
import { parsePlan, SUBMIT_PLAN_TOOL, SUBMIT_PLAN_TOOL_NAME } from './planner/planSchema.js';
import { PlanRunner } from './planner/planRunner.js';
import { log } from './logger.js';

const MAX_AGENT_TURNS = 12;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.pdf': 'application/pdf',
};

const BASE_SYSTEM_PROMPT = [
	'You are an AI coding assistant integrated into the VS Code editor.',
	'Be concise, accurate, and produce working code.',
	'When the user asks "how", explain the path forward before producing code.',
	'You have access to file system and shell tools. Prefer using them over guessing.',
	'When you reference files or code, use fenced code blocks with a language tag.',
	'',
	'For tasks with multiple independent sub-tasks (e.g. "add a feature with UI + API + tests"),',
	'call the `agent_submit_plan` tool with a DAG of steps. Sub-agents will execute them in parallel.',
	'Skip planning for trivial single-file edits — just do them inline.',
].join(' ');

const AGENT_TOOL_NAMES: ReadonlySet<string> = new Set([
	'agent_read_file',
	'agent_write_file',
	'agent_list_dir',
	'agent_run_command',
]);

export type ChatHandler = (
	request: vscode.ChatRequest,
	context: vscode.ChatContext,
	stream: vscode.ChatResponseStream,
	token: vscode.CancellationToken,
) => Promise<void>;

export function createChatHandler(rulesLoader: RulesLoader, memoryService: MemoryService): ChatHandler {
	return (request, context, stream, token) => handleChatRequest(request, context, stream, token, rulesLoader, memoryService);
}

export async function handleChatRequest(
	request: vscode.ChatRequest,
	context: vscode.ChatContext,
	stream: vscode.ChatResponseStream,
	token: vscode.CancellationToken,
	rulesLoader?: RulesLoader,
	memoryService?: MemoryService,
): Promise<void> {
	const model = await resolveModel(request);
	if (!model) {
		stream.markdown(
			'No AI provider is configured. Run **Agent Chat: Add API Key...** from the Command Palette to add an Anthropic, OpenAI, Gemini, or Ollama key.',
		);
		stream.button({ command: 'agent-chat.addApiKey', title: 'Add API Key...' });
		return;
	}

	const baseTools = collectTools();
	const tools: vscode.LanguageModelChatTool[] = [...baseTools, SUBMIT_PLAN_TOOL];
	const activeFile = vscode.window.activeTextEditor?.document.uri;
	const resolvedRules = rulesLoader ? await rulesLoader.resolve(activeFile) : undefined;
	const memories = memoryService ? await loadMemories(memoryService) : [];
	const attachments = await collectAttachments(request, stream);
	const messages = buildInitialMessages(context, request, resolvedRules, memories, attachments);

	for (let turn = 0; turn < MAX_AGENT_TURNS; turn++) {
		if (token.isCancellationRequested) {
			return;
		}

		const toolCalls: vscode.LanguageModelToolCallPart[] = [];
		let assistantText = '';

		try {
			const response = await model.sendRequest(messages, { tools, toolMode: vscode.LanguageModelChatToolMode.Auto }, token);
			for await (const part of response.stream) {
				if (token.isCancellationRequested) {
					return;
				}
				if (part instanceof vscode.LanguageModelTextPart) {
					stream.markdown(part.value);
					assistantText += part.value;
				} else if (part instanceof vscode.LanguageModelToolCallPart) {
					toolCalls.push(part);
				}
			}
		} catch (err) {
			if (err instanceof vscode.CancellationError || token.isCancellationRequested) {
				return;
			}
			const message = err instanceof Error ? err.message : String(err);
			stream.markdown(`\n\n_Model error_: ${message}`);
			return;
		}

		if (toolCalls.length === 0) {
			return;
		}

		const assistantParts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart> = [];
		if (assistantText) {
			assistantParts.push(new vscode.LanguageModelTextPart(assistantText));
		}
		for (const tc of toolCalls) {
			assistantParts.push(new vscode.LanguageModelToolCallPart(tc.callId, tc.name, tc.input));
		}
		messages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));

		const resultParts: vscode.LanguageModelToolResultPart[] = [];
		for (const tc of toolCalls) {
			if (token.isCancellationRequested) {
				return;
			}
			if (tc.name === SUBMIT_PLAN_TOOL_NAME) {
				const planSummary = await executePlanTool(tc, model, baseTools, stream, token);
				resultParts.push(new vscode.LanguageModelToolResultPart(tc.callId, [new vscode.LanguageModelTextPart(planSummary)]));
				continue;
			}
			try {
				const result = await vscode.lm.invokeTool(tc.name, {
					input: tc.input,
					toolInvocationToken: request.toolInvocationToken,
				}, token);
				resultParts.push(new vscode.LanguageModelToolResultPart(tc.callId, result.content as Array<vscode.LanguageModelTextPart | vscode.LanguageModelPromptTsxPart>));
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				resultParts.push(new vscode.LanguageModelToolResultPart(tc.callId, [new vscode.LanguageModelTextPart(`Tool error: ${message}`)]));
			}
		}
		messages.push(vscode.LanguageModelChatMessage.User(resultParts));
	}

	stream.markdown('\n\n_Reached max agent turns; stopping. Send another message to continue._');
}

async function executePlanTool(
	toolCall: vscode.LanguageModelToolCallPart,
	model: vscode.LanguageModelChat,
	subagentTools: readonly vscode.LanguageModelChatTool[],
	stream: vscode.ChatResponseStream,
	token: vscode.CancellationToken,
): Promise<string> {
	let plan;
	try {
		plan = parsePlan(toolCall.input);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		stream.markdown(`\n\n_Plan rejected_: ${message}\n\n`);
		return `Plan validation failed: ${message}. Adjust the plan and try again, or do the work inline without submitting a plan.`;
	}

	const runner = new PlanRunner();
	const result = await runner.run(plan, {
		stream,
		subagentCtx: { model, tools: subagentTools, globalContext: '' },
	}, token);

	const lines: string[] = [];
	lines.push(result.success ? 'Plan completed successfully.' : 'Plan partially completed; some steps failed or were skipped.');
	for (const r of result.results) {
		lines.push(`- ${r.id} [${r.status}]: ${r.summary || r.error || ''}`);
	}
	return lines.join('\n');
}

async function resolveModel(request: vscode.ChatRequest): Promise<vscode.LanguageModelChat | undefined> {
	if (request.model) {
		return request.model;
	}
	const preferred = await vscode.lm.selectChatModels({ vendor: 'anthropic', family: 'claude-opus' });
	if (preferred.length > 0) {
		return preferred[0];
	}
	const anyModel = await vscode.lm.selectChatModels();
	return anyModel[0];
}

function collectTools(): vscode.LanguageModelChatTool[] {
	const result: vscode.LanguageModelChatTool[] = [];
	for (const info of vscode.lm.tools) {
		if (!AGENT_TOOL_NAMES.has(info.name)) {
			continue;
		}
		result.push({
			name: info.name,
			description: info.description,
			inputSchema: info.inputSchema,
		});
	}
	return result;
}

interface LoadedMemory {
	readonly entry: MemoryEntry;
	readonly body: string;
}

async function loadMemories(service: MemoryService): Promise<LoadedMemory[]> {
	const entries = await service.list();
	const loaded: LoadedMemory[] = [];
	for (const entry of entries) {
		const body = (await service.readBody(entry)).trim();
		if (body) {
			loaded.push({ entry, body });
		}
	}
	return loaded;
}

function buildInitialMessages(
	context: vscode.ChatContext,
	request: vscode.ChatRequest,
	rules: ResolvedRules | undefined,
	memories: readonly LoadedMemory[],
	attachments: readonly vscode.LanguageModelDataPart[],
): vscode.LanguageModelChatMessage[] {
	const messages: vscode.LanguageModelChatMessage[] = [];
	messages.push(vscode.LanguageModelChatMessage.User(buildSystemPrompt(rules, memories)));

	for (const turn of context.history) {
		if (turn instanceof vscode.ChatRequestTurn) {
			const prompt = turn.prompt?.trim();
			if (prompt) {
				messages.push(vscode.LanguageModelChatMessage.User(prompt));
			}
		} else if (turn instanceof vscode.ChatResponseTurn) {
			const text = collectResponseText(turn);
			if (text) {
				messages.push(vscode.LanguageModelChatMessage.Assistant(text));
			}
		}
	}

	if (attachments.length > 0) {
		const parts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelDataPart> = [...attachments];
		parts.push(new vscode.LanguageModelTextPart(request.prompt || '(see attachments)'));
		messages.push(vscode.LanguageModelChatMessage.User(parts));
	} else {
		messages.push(vscode.LanguageModelChatMessage.User(request.prompt));
	}
	return messages;
}

async function collectAttachments(request: vscode.ChatRequest, stream: vscode.ChatResponseStream): Promise<vscode.LanguageModelDataPart[]> {
	const parts: vscode.LanguageModelDataPart[] = [];
	const refs = (request as { references?: readonly vscode.ChatPromptReference[] }).references ?? [];
	for (const ref of refs) {
		const uri = extractUri(ref.value);
		if (!uri) {
			continue;
		}
		const mime = mimeFromUri(uri);
		if (!mime) {
			continue;
		}
		try {
			const bytes = await vscode.workspace.fs.readFile(uri);
			if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
				stream.markdown(`\n\n_Skipped attachment ${shortName(uri)}: ${formatBytes(bytes.byteLength)} exceeds ${formatBytes(MAX_ATTACHMENT_BYTES)} limit._\n\n`);
				continue;
			}
			parts.push(vscode.LanguageModelDataPart.image(bytes, mime));
		} catch (err) {
			log(`attachment: failed to read ${uri.fsPath}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	return parts;
}

function extractUri(value: unknown): vscode.Uri | undefined {
	if (value instanceof vscode.Uri) {
		return value;
	}
	if (value && typeof value === 'object' && 'uri' in value) {
		const inner = (value as { uri: unknown }).uri;
		if (inner instanceof vscode.Uri) {
			return inner;
		}
	}
	return undefined;
}

function mimeFromUri(uri: vscode.Uri): string | undefined {
	const path = uri.path.toLowerCase();
	const dot = path.lastIndexOf('.');
	if (dot < 0) {
		return undefined;
	}
	return MIME_BY_EXT[path.slice(dot)];
}

function shortName(uri: vscode.Uri): string {
	return uri.path.split('/').slice(-1)[0] || uri.toString();
}

function formatBytes(n: number): string {
	if (n < 1024) {
		return `${n}B`;
	}
	if (n < 1024 * 1024) {
		return `${(n / 1024).toFixed(1)}KB`;
	}
	return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

function buildSystemPrompt(rules: ResolvedRules | undefined, memories: readonly LoadedMemory[]): string {
	const sections: string[] = [BASE_SYSTEM_PROMPT];
	const workspaceSection = describeWorkspaceRoots();
	if (workspaceSection) {
		sections.push(workspaceSection);
	}
	if (rules?.rootAgentsMd) {
		sections.push('# Project instructions (AGENTS.md)\n\n' + rules.rootAgentsMd);
	}
	if (rules && rules.always.length > 0) {
		sections.push('# Always-on rules\n\n' + rules.always.map(renderRule).join('\n\n'));
	}
	if (rules && rules.matched.length > 0) {
		sections.push('# Rules for the current file\n\n' + rules.matched.map(renderRule).join('\n\n'));
	}
	if (memories.length > 0) {
		const rendered = memories.map(m => `## ${m.entry.title}\n${m.body}`).join('\n\n');
		sections.push('# Memories about this project\n\n' + rendered);
	}
	return sections.join('\n\n');
}

function describeWorkspaceRoots(): string | undefined {
	const folders = vscode.workspace.workspaceFolders ?? [];
	if (folders.length === 0) {
		return undefined;
	}
	if (folders.length === 1) {
		return `# Workspace\n\nSingle-root workspace at \`${folders[0].uri.fsPath}\`. Relative paths in tools resolve against this root.`;
	}
	const lines = folders.map(f => `- \`${f.name}\` → ${f.uri.fsPath}`);
	return [
		'# Workspace (multi-root)',
		'',
		'This workspace has multiple root folders. To target a specific root in any tool call, prefix the relative path with the folder name, e.g. `frontend/src/app.ts`.',
		'',
		...lines,
	].join('\n');
}

function renderRule(rule: Rule): string {
	const header = rule.description ? `## ${rule.id} — ${rule.description}` : `## ${rule.id}`;
	return `${header}\n${rule.body}`;
}

function collectResponseText(turn: vscode.ChatResponseTurn): string {
	let text = '';
	for (const part of turn.response) {
		if (part instanceof vscode.ChatResponseMarkdownPart) {
			text += part.value.value;
		}
	}
	return text;
}
