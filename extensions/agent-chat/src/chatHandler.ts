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
import { RUN_SUBAGENT_TOOL, RUN_SUBAGENT_TOOL_NAME, runStandaloneSubagent } from './planner/subagent.js';
import { log } from './logger.js';
import { resolveUri, searchWorkspace } from './tools.js';

const MAX_AGENT_TURNS = 12;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_REF_BYTES = 100 * 1024;

const MIME_BY_EXT: Record<string, string> = {
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.pdf': 'application/pdf',
};

const BASE_SYSTEM_PROMPT = `
You are an AI coding assistant integrated into the VS Code editor.
Be concise and accurate.

## Language
Always reply in the same language the user wrote in.
If the user writes in Portuguese, respond entirely in Portuguese.
If the user writes in English, respond in English.
Never switch languages unless the user does first.

## Finding code (CRITICAL)
When the user asks you to change a function, class, method, variable, or any symbol and you are NOT certain which file contains it:
1. Use \`agent_search\` to locate the symbol across the workspace FIRST. Search by the symbol name (e.g. the function name).
2. NEVER tell the user that a function or symbol "does not exist" or "was not found" until you have searched the ENTIRE workspace with \`agent_search\`. A symbol missing from one file is not proof it is absent — search before concluding.
3. The active file shown in context is only a hint, not the only place to look. The symbol is often defined in a different file.

## File editing rules (CRITICAL)
When asked to refactor, fix, add, remove, or otherwise change code in a file:
1. If the user's message includes a "--- Arquivo: /path ---" block, that is the file to edit. Use the exact path shown. Otherwise, locate the target with \`agent_search\` as described above.
2. Use \`agent_read_file\` to read the FULL current content of the file before writing (the block may show only a selection).
3. Apply ALL changes and write the COMPLETE updated file with \`agent_write_file\` using the exact path from step 1.
4. NEVER output code changes as markdown in the chat — always write them to the file directly.
5. After writing, give a short summary in the user's language of what changed and why.

When the user asks "how" (explanation only, no file named), explain in the chat without touching files.

## Workspace exploration (CRITICAL)
You have DIRECT access to every file in the open workspace via tools. NEVER ask the user to paste, attach, or send code that you can read yourself.

When the user asks anything about the project, application, architecture, dependencies, or code — explore it yourself:
1. Call \`agent_list_dir\` with no path to see the workspace root, then drill into relevant directories.
2. Call \`agent_read_file\` on key files (package.json, index files, main entry points, config files, etc.) to understand the project.
3. Form your answer from what you read. Do NOT ask the user for information that is already in the files.

Examples of when to explore automatically (not an exhaustive list):
- "analyze my application" → list root, read package.json, main files, architecture files
- "what architecture does this use?" → explore src/, read entry points and key modules
- "what does this project do?" → read README, package.json, main entry point
- "what dependencies does this use?" → read package.json / requirements.txt / go.mod etc.

## Tool usage
Do NOT narrate tool invocations. Invoke tools silently and only speak once you have results.

## Delegation
To delegate ONE focused, self-contained task to a sub-agent, call \`agent_run_subagent\` with a complete task description. The sub-agent runs with the same tools, works in its own context (it does NOT see this conversation), and returns a summary. Use it to keep your own context focused on larger work — e.g. delegate "investigate and fix failing test X" while you continue elsewhere.
For multiple INDEPENDENT tasks that can run in parallel, call \`agent_submit_plan\` with a DAG instead.
Skip both for trivial single-file edits — just do them inline.
`.trim();

const WRITE_FILE_TOOL_NAME = 'agent_write_file';

const AGENT_TOOL_NAMES: ReadonlySet<string> = new Set([
	'agent_read_file',
	WRITE_FILE_TOOL_NAME,
	'agent_list_dir',
	'agent_search',
	'agent_run_command',
	// Only registered in vscode.lm.tools while `agent-chat.codeGraph.enabled` is on,
	// so it is naturally absent from the tool list when the graph is disabled.
	'agent_code_graph',
]);

/** Augmented stream type that includes the proposed `textEdit` API from `chatParticipantAdditions`. */
type ChatStreamWithEdits = vscode.ChatResponseStream & {
	textEdit(target: vscode.Uri, edits: vscode.TextEdit | vscode.TextEdit[]): void;
	textEdit(target: vscode.Uri, isDone: true): void;
};

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
			'Nenhum provedor de IA está configurado. Execute **Agent Chat: Adicionar Chave de API...** na Paleta de Comandos para adicionar uma chave Anthropic, OpenAI, Gemini ou Ollama.',
		);
		stream.button({ command: 'agent-chat.addApiKey', title: 'Adicionar Chave de API...' });
		return;
	}

	const baseTools = collectTools();
	const tools: vscode.LanguageModelChatTool[] = [...baseTools, SUBMIT_PLAN_TOOL, RUN_SUBAGENT_TOOL];
	const activeFile = vscode.window.activeTextEditor?.document.uri;
	const resolvedRules = rulesLoader ? await rulesLoader.resolve(activeFile) : undefined;
	const memories = memoryService ? await loadMemories(memoryService) : [];
	const [attachments, textRefs] = await Promise.all([
		collectAttachments(request, stream),
		collectTextReferences(request),
	]);
	const messages = buildInitialMessages(context, request, resolvedRules, memories, attachments, textRefs);

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
			stream.markdown(`\n\n_Erro do modelo_: ${message}`);
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

		// Plan tool must run first — it calls back into stream and model directly.
		for (const tc of toolCalls) {
			if (tc.name !== SUBMIT_PLAN_TOOL_NAME) {
				continue;
			}
			if (token.isCancellationRequested) {
				break;
			}
			const planSummary = await executePlanTool(tc, model, baseTools, stream, token);
			resultParts.push(new vscode.LanguageModelToolResultPart(tc.callId, [new vscode.LanguageModelTextPart(planSummary)]));
		}

		// Sub-agent tool also runs separately — it needs model + tools and streams its own progress.
		for (const tc of toolCalls) {
			if (tc.name !== RUN_SUBAGENT_TOOL_NAME) {
				continue;
			}
			if (token.isCancellationRequested) {
				break;
			}
			const summary = await executeSubagentTool(tc, model, baseTools, stream, token);
			resultParts.push(new vscode.LanguageModelToolResultPart(tc.callId, [new vscode.LanguageModelTextPart(summary)]));
		}

		// All other tool calls run inside a single collapsible progress section.
		const agentToolCalls = toolCalls.filter(tc => tc.name !== SUBMIT_PLAN_TOOL_NAME && tc.name !== RUN_SUBAGENT_TOOL_NAME);
		if (agentToolCalls.length > 0 && !token.isCancellationRequested) {
			let toolsDoneResolve!: () => void;
			const toolsDone = new Promise<void>(resolve => { toolsDoneResolve = resolve; });

			stream.progress(progressLabel(agentToolCalls), async taskProgress => {
				const accessedUris: vscode.Uri[] = [];
				let cmdCount = 0;
				let searchCount = 0;
				try {
					for (const tc of agentToolCalls) {
						if (token.isCancellationRequested) {
							break;
						}
						if (tc.name === 'agent_search') {
							const input = tc.input as { query: string; isRegex?: boolean; path?: string };
							const text = await searchWorkspace(input);
							searchCount++;
							resultParts.push(new vscode.LanguageModelToolResultPart(tc.callId, [new vscode.LanguageModelTextPart(text)]));
						} else if (tc.name === WRITE_FILE_TOOL_NAME) {
							const input = tc.input as { path: string; content: string };
							const uri = resolveUri(input.path);
							const summary = await applyFileEdit(input, stream as ChatStreamWithEdits);
							accessedUris.push(uri);
							taskProgress.report(new vscode.ChatResponseReferencePart(uri));
							resultParts.push(new vscode.LanguageModelToolResultPart(tc.callId, [new vscode.LanguageModelTextPart(summary)]));
						} else if (tc.name === 'agent_read_file') {
							const input = tc.input as { path: string };
							const uri = resolveUri(input.path);
							let text: string;
							try {
								const bytes = await vscode.workspace.fs.readFile(uri);
								text = Buffer.from(bytes).toString('utf8');
								if (text.length > 100_000) {
									text = text.slice(0, 100_000) + '\n…[truncado]';
								}
							} catch (err) {
								text = `Erro ao ler: ${err instanceof Error ? err.message : String(err)}`;
							}
							accessedUris.push(uri);
							taskProgress.report(new vscode.ChatResponseReferencePart(uri));
							resultParts.push(new vscode.LanguageModelToolResultPart(tc.callId, [new vscode.LanguageModelTextPart(text)]));
						} else if (tc.name === 'agent_list_dir') {
							const input = tc.input as { path?: string };
							const dirPath = input.path ?? '.';
							let text: string;
							const folders = vscode.workspace.workspaceFolders ?? [];
							if (!input.path && folders.length > 1) {
								const lines = folders.map(f => `📁 ${f.name}/  (root: ${f.uri.fsPath})`);
								text = `Workspace tem ${folders.length} pastas raiz. Informe o nome da pasta como primeiro segmento do caminho.\n\n${lines.join('\n')}`;
							} else {
								try {
									const uri = resolveUri(dirPath);
									const entries = await vscode.workspace.fs.readDirectory(uri);
									const sorted = entries.sort(([a], [b]) => a.localeCompare(b));
									text = sorted.map(([name, kind]) => `${kind === vscode.FileType.Directory ? '📁' : '📄'} ${name}`).join('\n') || '(vazio)';
								} catch (err) {
									text = `Erro: ${err instanceof Error ? err.message : String(err)}`;
								}
							}
							resultParts.push(new vscode.LanguageModelToolResultPart(tc.callId, [new vscode.LanguageModelTextPart(text)]));
						} else {
							// agent_run_command and unknowns — VS Code handles confirmation dialogs.
							try {
								const result = await vscode.lm.invokeTool(tc.name, {
									input: tc.input,
									toolInvocationToken: request.toolInvocationToken,
								}, token);
								resultParts.push(new vscode.LanguageModelToolResultPart(tc.callId, result.content as Array<vscode.LanguageModelTextPart | vscode.LanguageModelPromptTsxPart>));
							} catch (err) {
								const message = err instanceof Error ? err.message : String(err);
								resultParts.push(new vscode.LanguageModelToolResultPart(tc.callId, [new vscode.LanguageModelTextPart(`Erro da ferramenta: ${message}`)]));
							}
							cmdCount++;
						}
					}
				} finally {
					toolsDoneResolve();
				}
				const parts: string[] = [];
				if (searchCount > 0) {
					parts.push(searchCount === 1 ? '1 busca' : `${searchCount} buscas`);
				}
				if (accessedUris.length > 0) {
					parts.push(accessedUris.length === 1 ? '1 arquivo' : `${accessedUris.length} arquivos`);
				}
				if (cmdCount > 0) {
					parts.push(cmdCount === 1 ? '1 comando' : `${cmdCount} comandos`);
				}
				return parts.length > 0 ? `Explorado: ${parts.join(', ')}` : undefined;
			});

			await toolsDone;
		}

		messages.push(vscode.LanguageModelChatMessage.User(resultParts));
	}

	stream.markdown('\n\n_Limite de turnos do agente atingido; encerrando. Envie outra mensagem para continuar._');
}

/** Pick a progress label that reflects what the agent is doing this turn. */
function progressLabel(toolCalls: readonly vscode.LanguageModelToolCallPart[]): string {
	const names = new Set(toolCalls.map(tc => tc.name));
	if (names.has('agent_search')) {
		return 'Buscando no código...';
	}
	if (names.has(WRITE_FILE_TOOL_NAME)) {
		return 'Editando arquivos...';
	}
	if (names.has('agent_read_file') || names.has('agent_list_dir')) {
		return 'Lendo arquivos...';
	}
	if (names.has('agent_run_command')) {
		return 'Executando comandos...';
	}
	return 'Analisando...';
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
		stream.markdown(`\n\n_Plano rejeitado_: ${message}\n\n`);
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

/** Dispatch a single on-demand sub-agent and stream its progress. Returns the summary fed back to the main agent. */
async function executeSubagentTool(
	toolCall: vscode.LanguageModelToolCallPart,
	model: vscode.LanguageModelChat,
	subagentTools: readonly vscode.LanguageModelChatTool[],
	stream: vscode.ChatResponseStream,
	token: vscode.CancellationToken,
): Promise<string> {
	const input = toolCall.input as { task?: string; context?: string };
	const task = typeof input.task === 'string' ? input.task.trim() : '';
	if (task.length < 8) {
		return 'Tarefa do subagente inválida: forneça uma descrição completa e autocontida (mínimo 8 caracteres).';
	}
	stream.markdown(`\n\n🤖 **Subagente** — ${truncate(task, 140)}\n`);
	const result = await runStandaloneSubagent(task, input.context ?? '', { model, tools: subagentTools, globalContext: '' }, token);
	if (result.status === 'done') {
		stream.markdown(`\n✅ **Subagente concluído** — ${truncate(result.summary, 200)}\n`);
		return result.summary || 'Subagente concluiu a tarefa.';
	}
	stream.markdown(`\n❌ **Subagente falhou** — ${result.error ?? 'erro desconhecido'}\n`);
	const partial = result.summary ? ` Progresso parcial: ${result.summary}` : '';
	return `Subagente não concluiu: ${result.error ?? 'erro desconhecido'}.${partial}`;
}

/** Truncate a string to at most `max` characters, appending an ellipsis when cut. */
function truncate(text: string, max: number): string {
	const trimmed = text.trim();
	return trimmed.length <= max ? trimmed : trimmed.slice(0, max - 1) + '…';
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

interface ITextReference {
	readonly uri: vscode.Uri;
	readonly range?: vscode.Range;
	readonly content: string;
}

function buildInitialMessages(
	context: vscode.ChatContext,
	request: vscode.ChatRequest,
	rules: ResolvedRules | undefined,
	memories: readonly LoadedMemory[],
	attachments: readonly vscode.LanguageModelDataPart[],
	textRefs: readonly ITextReference[],
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

	let userPrompt = request.prompt || '';
	if (textRefs.length > 0) {
		const refBlocks = textRefs.map(ref => {
			const rangeStr = ref.range
				? ` (linhas ${ref.range.start.line + 1}–${ref.range.end.line + 1})`
				: '';
			return `--- Arquivo: ${ref.uri.fsPath}${rangeStr} ---\n${ref.content}\n---`;
		});
		userPrompt = refBlocks.join('\n\n') + (userPrompt ? '\n\n' + userPrompt : '');
	}

	if (attachments.length > 0) {
		const parts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelDataPart> = [...attachments];
		parts.push(new vscode.LanguageModelTextPart(userPrompt || '(see attachments)'));
		messages.push(vscode.LanguageModelChatMessage.User(parts as Array<vscode.LanguageModelTextPart>));
	} else {
		messages.push(vscode.LanguageModelChatMessage.User(userPrompt));
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
				stream.markdown(`\n\n_Anexo ${shortName(uri)} ignorado: ${formatBytes(bytes.byteLength)} excede o limite de ${formatBytes(MAX_ATTACHMENT_BYTES)}._\n\n`);
				continue;
			}
			parts.push(vscode.LanguageModelDataPart.image(bytes, mime));
		} catch (err) {
			log(`attachment: failed to read ${uri.fsPath}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	return parts;
}

async function collectTextReferences(request: vscode.ChatRequest): Promise<ITextReference[]> {
	const refs = (request as { references?: readonly vscode.ChatPromptReference[] }).references ?? [];
	const result: ITextReference[] = [];
	for (const ref of refs) {
		let uri: vscode.Uri | undefined;
		let range: vscode.Range | undefined;

		if (ref.value instanceof vscode.Uri) {
			uri = ref.value;
		} else if (ref.value && typeof ref.value === 'object' && (ref.value as { uri?: unknown }).uri !== undefined) {
			const inner = ref.value as { uri: unknown; range?: unknown };
			if (inner.uri instanceof vscode.Uri) {
				uri = inner.uri;
				if (inner.range instanceof vscode.Range) {
					range = inner.range;
				}
			}
		}

		if (!uri) {
			continue;
		}

		// Skip binary file types (images, PDFs) — those are handled by collectAttachments
		if (mimeFromUri(uri)) {
			continue;
		}

		try {
			const bytes = await vscode.workspace.fs.readFile(uri);
			if (bytes.byteLength > MAX_TEXT_REF_BYTES) {
				continue;
			}
			let content = Buffer.from(bytes).toString('utf8');
			if (range) {
				const lines = content.split('\n');
				content = lines.slice(range.start.line, range.end.line + 1).join('\n');
			}
			result.push({ uri, range, content });
		} catch {
			// ignore unreadable files
		}
	}
	return result;
}

function extractUri(value: unknown): vscode.Uri | undefined {
	if (value instanceof vscode.Uri) {
		return value;
	}
	if (value && typeof value === 'object' && (value as { uri?: unknown }).uri !== undefined) {
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
