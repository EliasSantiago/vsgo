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
import { FileLinkStream } from './fileLinks.js';
import { collectDiagnostics, computeFileEdit, computeMultiFileEdit, DiagnosticsInput, EditFileInput, findFiles, gitDiff, GitDiffInput, GitInput, gitStatus, listDirectory, MultiEditInput, openFileInEditor, OpenFileInput, readFileForModel, ReadFileInput, resolveUri, searchWorkspace } from './tools.js';
import { parseTodos, renderTodosForModel, renderTodosForUser, TODO_TOOL, TODO_TOOL_NAME, TodoItem } from './todoList.js';
import { restoreTranscript, serializeTranscript, TRANSCRIPT_METADATA_KEY } from './transcript.js';
import { clampToolResult, extractTextToolCalls, IAgentProfile, resolveProfile } from './agentProfile.js';
import { isMcpToolInfo, McpServers } from './mcp.js';
import { usageBus } from './usageBus.js';
import { FIGMA_TOOL_NAME } from './figma/figmaTool.js';

/**
 * Turn budget for one request under the full profile. Tasks that run the app and
 * then drive the browser spend several turns on exploration alone, so this has to
 * be well above the handful of turns a pure question needs. The compact profile
 * carries its own, smaller budget.
 */
const MAX_AGENT_TURNS = 32;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

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
4. \`agent_search\` looks INSIDE files, so it never matches a filename. When you are after a FILE rather than a symbol, use \`agent_find_files\` — it matches names at any depth, so a project whose convention you guessed wrong (\`app.routes.ts\`, not \`app-routing.module.ts\`) still turns up on a shorter fragment.
5. An empty result narrows the guess; it does not answer the question. Retry with a shorter fragment, or search for what the code would contain rather than what it is called, before reporting anything as absent.
6. When you do NOT know what the thing is called — the user describes a behaviour, a concept or a responsibility rather than a name — use \`agent_codebase_search\`. It searches a local semantic index by meaning, so "where does it decide which theme to load" finds the code even when none of those words appear in it. Write its query in the language the answer is most likely written in — English for code and identifiers, the user's own language when they ask about documentation or comments written in it. Use it FIRST for that kind of question, then \`agent_search\` to confirm the exact symbol it points you at. Grep and semantics answer different questions: reach for grep when you have a name, for semantic search when you have an intention.

## File editing rules (CRITICAL)
When asked to refactor, fix, add, remove, or otherwise change code in a file:
1. If the user's message includes a "--- Arquivo: /path ---" block, that is the file to edit. Use the exact path shown. Otherwise, locate the target with \`agent_search\` as described above.
2. Use \`agent_read_file\` to read the FULL current content of the file before writing — unless the block already says it holds the complete file, in which case you have it and reading it again only costs a turn.
3. Change it with \`agent_edit_file\`, giving the exact text to replace and what replaces it. This is the default for a file that already exists. When the change touches several places in the same file, send them together with \`agent_multi_edit\` instead of one call each. Reserve \`agent_write_file\` for a NEW file or a rewrite so sweeping that little of the original survives.
4. NEVER output code changes as markdown in the chat — always write them to the file directly.
5. Call \`agent_diagnostics\` afterwards to see whether the change compiles. It reads what the language server already knows, so it costs a second and needs no build — do this instead of guessing, and fix what you broke before answering.
6. Then give a short summary in the user's language of what changed and why.

## Reviewing your own work
\`agent_git_status\` shows which files are modified; \`agent_git_diff\` shows the actual change.
Use them when the user asks what changed, before summarising a batch of edits, or when you
have lost track of what you already did.

When the user asks "how" (explanation only, no file named), explain in the chat without touching files.

## Workspace exploration (CRITICAL)
You have DIRECT access to every file in the open workspace via tools. NEVER ask the user to paste, attach, or send code that you can read yourself.

When the user asks anything about the project, application, architecture, dependencies, or code — explore it yourself:
1. Call \`agent_list_dir\` with no path to see the workspace root, then drill into relevant directories.
2. Call \`agent_read_file\` on key files (package.json, index files, main entry points, config files, etc.) to understand the project.
3. Form your answer from what you read. Do NOT ask the user for information that is already in the files.

## Citing and opening files
Always cite files by their workspace-relative path, and pin the citation to the exact spot:
- \`src/Service/Foo.php#getUnidades\` — when you are talking about a function, method or class.
Write the plain symbol name, no parentheses and no arguments.
- \`src/Service/Foo.php:120\` — when you know the line number.
- \`src/Service/Foo.php\` — only when the whole file is the subject.

These become clickable links that open the file **at that function**, so the user lands on the
code instead of at the top of a 900-line file. Never split the file and the symbol across
separate lines ("Arquivo: X" then "Função: y") — that loses the link. Write \`X#y\` and, if you
want to spell it out for the reader, do that in the surrounding sentence.

When the user asks to open, show or reveal files, call \`agent_open_file\` for each one. Naming
the file in the answer is not the same as opening it: if they asked for it open, open it.

Explore only as far as the task needs. When the user asks for a concrete action
("run the app", "open it in the browser", "fix function X"), go straight for the
one or two files that unblock it and act — a broad survey first wastes the turn
budget and the task never gets done. Never list \`node_modules\`, \`.git\`, \`dist\`,
\`build\` or similar; they hold no answers.

Never repeat a read you already made in this conversation. If you catch yourself
reading the same file twice, you are stuck — act on what you already know.

A large file does not have to be read whole: \`agent_read_file\` takes \`offset\` and
\`limit\`, and tells you the offset that continues the file when a result is cut short.

## Staying on task
For work that takes several steps, call \`agent_todo_write\` with the plan before you start,
then again after each step to mark it done. Send the whole list every time; keep exactly one
item \`in_progress\`. It exists so a long task does not drift: read the list back before
deciding what to do next, and do not stop while items are still open. Skip it entirely for
anything that takes one or two tool calls.

Examples of when to explore automatically (not an exhaustive list):
- "analyze my application" → list root, read package.json, main files, architecture files
- "what architecture does this use?" → explore src/, read entry points and key modules
- "what does this project do?" → read README, package.json, main entry point
- "what dependencies does this use?" → read package.json / requirements.txt / go.mod etc.

## Testing in a real browser
You can drive the Integrated Browser to verify web apps end to end and to automate
web tasks for the user. Pages open as editor tabs inside this window, so the user
watches you work and can take over at any time (logins, 2FA, captchas).

Use it when the user asks you to test, verify, reproduce, look at the running
application, or automate something on the web — and proactively after changing UI
code that you can check this way.

Workflow:
1. Find the dev server URL before guessing: read package.json (or the vite/next/webpack config) to see the start script and port. Read only what you need — do not survey the whole workspace first.
2. If no server is running, start it with \`agent_run_command\` and \`"background": true\`. A dev server never exits, so a foreground call would hang until it is killed. The tool returns the first seconds of output, which is where the actual port is printed — use that port, do not assume 3000. It also returns a terminal id: a server that prints "ready" can still crash a moment later, so before you trust it, call \`agent_read_terminal\` with that id and \`"waitSeconds": 5\` to see what it printed next.
3. \`open_browser_page\` with an absolute \`url\`. It returns a \`pageId\` plus an accessibility summary of the page. Every other browser tool takes that \`pageId\`.
4. \`read_page\` to see the current state — it returns the accessibility tree WITH element refs. This is how you see. You do NOT receive image content back, so never rely on \`screenshot_page\` to observe anything yourself.
5. Interact using refs from the LATEST \`read_page\` (\`click_element\`, \`type_in_page\`, \`hover_element\`, \`drag_element\`), then \`read_page\` again to confirm the result. Refs go stale after the page changes — re-read instead of reusing old ones.
6. \`navigate_page\` for url/back/forward/reload on a page you already opened. \`handle_dialog\` when an alert/confirm blocks you.
7. \`run_playwright_code\` is the escape hatch for anything the dedicated tools do not cover — waiting for a selector, reading \`document.title\`, extracting a list. Access the page only through the provided \`page\` object, never \`document\`/\`window\` directly.
8. \`screenshot_page\` when the USER would benefit from seeing the result — it is for them, not for you.

Never claim the app works until \`read_page\` or \`run_playwright_code\` output actually shows it. Report what you observed, not what you expect.

## Running commands
Commands that exit on their own run in the foreground and return their full output.
Anything that does NOT exit — dev servers, watchers, \`tail -f\` — needs \`"background": true\`,
which runs it in a visible terminal and returns a terminal id.

That first result is only the opening seconds. Whenever the outcome depends on what
the command prints later — did the server actually serve, did the watcher recompile
cleanly, did the test suite finish green — read it back with \`agent_read_terminal\`
using the terminal id, with \`waitSeconds\` so you block instead of polling. Never
report a background command as working based only on its first seconds of output.

## Tool usage
Do NOT narrate tool invocations. Invoke tools silently and only speak once you have results.

Batch independent calls into a SINGLE turn. Every round-trip you make spends one
turn of a limited budget, so calls that do not depend on each other's output must
go out together — reading four files, a search plus a directory listing, two
\`read_page\` calls on different pages. Issue calls one at a time only when the
next one genuinely needs the previous result (e.g. search, then read the file it
found). Emitting one call per turn when five were independent wastes 80% of the
budget and is the main reason a task runs out of turns before finishing.

## Delegation
To delegate ONE focused, self-contained task to a sub-agent, call \`agent_run_subagent\` with a complete task description. The sub-agent runs with the same tools, works in its own context (it does NOT see this conversation), and returns a summary. Use it to keep your own context focused on larger work — e.g. delegate "investigate and fix failing test X" while you continue elsewhere.
For multiple INDEPENDENT tasks that can run in parallel, call \`agent_submit_plan\` with a DAG instead.
Skip both for trivial single-file edits — just do them inline.
`.trim();

const WRITE_FILE_TOOL_NAME = 'agent_write_file';
const EDIT_FILE_TOOL_NAME = 'agent_edit_file';
const MULTI_EDIT_TOOL_NAME = 'agent_multi_edit';
const OPEN_FILE_TOOL_NAME = 'agent_open_file';

/** Read-only tools whose result cannot change until the agent writes a file. */
const REPEATABLE_READ_TOOLS: ReadonlySet<string> = new Set([
	'agent_read_file',
	'agent_list_dir',
	'agent_search',
	'agent_find_files',
	'agent_codebase_search',
]);

/**
 * Browser automation tools contributed by the workbench itself. They drive the
 * Integrated Browser (an Electron `WebContentsView` steered by Playwright over
 * CDP), so no external Chrome or Chromium download is involved.
 *
 * They are only present in `vscode.lm.tools` when `workbench.browser.enableChatTools`
 * is on; `agent-chat.browser.enabled` additionally controls whether we hand them
 * to the model.
 */
const BROWSER_TOOL_NAMES: ReadonlySet<string> = new Set([
	'open_browser_page',
	'read_page',
	'screenshot_page',
	'navigate_page',
	'click_element',
	'type_in_page',
	'hover_element',
	'drag_element',
	'handle_dialog',
	'run_playwright_code',
]);

const AGENT_TOOL_NAMES: ReadonlySet<string> = new Set([
	'agent_read_file',
	OPEN_FILE_TOOL_NAME,
	WRITE_FILE_TOOL_NAME,
	EDIT_FILE_TOOL_NAME,
	MULTI_EDIT_TOOL_NAME,
	'agent_list_dir',
	'agent_search',
	'agent_find_files',
	'agent_diagnostics',
	'agent_git_status',
	'agent_git_diff',
	'agent_run_command',
	'agent_read_terminal',
	'agent_code_graph',
	'agent_codebase_search',
	FIGMA_TOOL_NAME,
	...BROWSER_TOOL_NAMES,
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
) => Promise<vscode.ChatResult>;

export function createChatHandler(rulesLoader: RulesLoader, memoryService: MemoryService, mcpServers?: McpServers): ChatHandler {
	return (request, context, stream, token) => handleChatRequest(request, context, stream, token, rulesLoader, memoryService, mcpServers);
}

export async function handleChatRequest(
	request: vscode.ChatRequest,
	context: vscode.ChatContext,
	stream: vscode.ChatResponseStream,
	token: vscode.CancellationToken,
	rulesLoader?: RulesLoader,
	memoryService?: MemoryService,
	mcpServers?: McpServers,
): Promise<vscode.ChatResult> {
	// Antes de listar as ferramentas: um servidor MCP parado não aparece em
	// `vscode.lm.tools`, e o que não estiver de pé agora fica de fora deste turno
	// inteiro. Não levanta exceção — servidor fora do ar não cancela a conversa.
	await mcpServers?.ensureStartedForRequest();
	const model = await resolveModel(request);
	if (!model) {
		stream.markdown(
			'Nenhum provedor de IA está configurado. Execute **Agent Chat: Adicionar Chave de API...** na Paleta de Comandos para adicionar uma chave Anthropic, OpenAI, Gemini ou Ollama.',
		);
		stream.button({ command: 'agent-chat.addApiKey', title: 'Adicionar Chave de API...' });
		return {};
	}

	const profile = resolveProfile(model, { systemPrompt: BASE_SYSTEM_PROMPT, maxTurns: MAX_AGENT_TURNS });
	const browserWanted = wantsBrowserTools(request, context);
	const baseTools = collectTools(profile, browserWanted);
	const tools: vscode.LanguageModelChatTool[] = profile.allowDelegation
		? [...baseTools, SUBMIT_PLAN_TOOL, RUN_SUBAGENT_TOOL, TODO_TOOL]
		: [...baseTools, TODO_TOOL];
	// What the model is allowed to invoke, used to validate tool calls that had to
	// be recovered from plain text. The schemas travel along because a recovered
	// Python-style call can pass its arguments positionally.
	const offeredTools = tools;
	// Quais das ferramentas oferecidas vieram de servidores MCP. Usado só para
	// orientar o modelo quando uma delas falha — a saída para um serviço externo
	// fora do ar não é a mesma de uma ferramenta local.
	const mcpToolNames = new Set(vscode.lm.tools.filter(isMcpToolInfo).map(t => t.name));
	log(`tools: offering ${tools.length} (browser ${browserWanted ? 'included' : 'withheld'}, mcp ${mcpToolNames.size})`);
	// A printed call may only be hidden from the user where it is also recovered
	// and run. Under the full profile the same text is part of the answer.
	const hideableTools = profile.parseTextToolCalls
		? new Set(offeredTools.map(tool => tool.name))
		: undefined;
	const activeFile = vscode.window.activeTextEditor?.document.uri;
	const resolvedRules = rulesLoader ? await rulesLoader.resolve(activeFile) : undefined;
	const memories = memoryService ? await loadMemories(memoryService) : [];
	const [attachments, textRefs] = await Promise.all([
		collectAttachments(request, stream),
		collectTextReferences(request, profile),
	]);
	const messages = buildInitialMessages(context, request, resolvedRules, memories, attachments, textRefs, profile);

	// Signatures of read-only calls already answered this request. Re-issuing one
	// verbatim returns nothing new and costs a turn, so it is short-circuited.
	const answeredReads = new Set<string>();

	// Checklist the model keeps for itself, replaced wholesale on every write.
	let todos: readonly TodoItem[] = [];

	// The request itself, kept aside so compaction can re-insert it verbatim: a
	// summary may blur what was discovered, never what was asked.
	const pinnedRequest = messages[messages.length - 1];

	const stats: IRequestStats = { turnsUsed: 0, toolCalls: 0, startedAt: Date.now(), modelId: model.id, profile, droppedMessages: 0, overflowRetries: 0, evictedToolResults: 0, compactions: 0 };

	const budget: IPromptBudget = {
		maxInputTokens: model.maxInputTokens,
		toolTokens: estimateToolsTokens(tools),
		charsPerToken: DEFAULT_CHARS_PER_TOKEN,
	};
	// Bounded so a server that keeps rejecting cannot spin the turn forever.
	let overflowRetries = 0;
	// Consecutive turns in which the model generated nothing at all. Reset by
	// any turn that produces text or a tool call.
	let emptyTurns = 0;
	// The previous turn's calls, to recognise a model that keeps re-issuing them.
	let lastTurnSignature: string | undefined;
	let repeatedTurns = 0;

	for (let turn = 0; turn < profile.maxTurns; turn++) {
		if (token.isCancellationRequested) {
			return finishRequest('cancelado', stats, messages);
		}
		stats.turnsUsed = turn + 1;

		const toolCalls: vscode.LanguageModelToolCallPart[] = [];
		let assistantText = '';
		let budgeted: vscode.LanguageModelChatMessage[] = [];

		try {
			budgeted = await ensurePromptFits(messages, budget, stats, pinnedRequest, model, stream, token);
			// Tagging the request is what lets its token counts find their way back
			// here from the provider; see `usageBus`.
			const usageToken = usageBus.newToken();
			const response = await model.sendRequest(budgeted, { tools, toolMode: vscode.LanguageModelChatToolMode.Auto, modelOptions: usageBus.modelOptions(usageToken) }, token);
			const links = new FileLinkStream(stream, hideableTools);
			for await (const part of response.stream) {
				if (token.isCancellationRequested) {
					await links.end();
					return finishRequest('cancelado', stats, messages);
				}
				if (part instanceof vscode.LanguageModelTextPart) {
					await links.write(part.value);
					assistantText += part.value;
				} else if (part instanceof vscode.LanguageModelToolCallPart) {
					toolCalls.push(part);
				} else if (part instanceof vscode.LanguageModelThinkingPart) {
					// Shown live, but deliberately kept out of `assistantText`:
					// Gemma 4's own guidance is that a previous turn's thoughts must
					// not be replayed into the next one, and it is not an answer
					// worth keeping in the transcript either.
					stream.thinkingProgress({ text: typeof part.value === 'string' ? part.value : part.value.join('') });
				}
			}
			await links.end();
			reportContextUsage(stream, usageToken);
		} catch (err) {
			if (err instanceof vscode.CancellationError || token.isCancellationRequested) {
				return finishRequest('cancelado', stats, messages);
			}
			// The prompt did not fit. The server counted it with the real tokenizer
			// and says by how much, so the estimate is corrected from its numbers
			// and the same turn is sent again, trimmed harder. Nothing was
			// generated before the rejection, so nothing has to be undone.
			const overflow = parseContextOverflow(err);
			if (overflow && overflowRetries < MAX_OVERFLOW_RETRIES && recalibrateBudget(budget, overflow, budgeted, stats)) {
				overflowRetries++;
				log(`context overflow: ${overflow.promptTokens} tokens against ${overflow.contextTokens}; retrying at ${budget.charsPerToken.toFixed(2)} chars/token`);
				turn--;
				continue;
			}
			const message = err instanceof Error ? err.message : String(err);
			stream.markdown(`\n\n_Erro do modelo_: ${message}`);
			return finishRequest(`erro do modelo (${message})`, stats, messages);
		}

		if (toolCalls.length === 0 && profile.parseTextToolCalls && assistantText) {
			const recovered = extractTextToolCalls(assistantText, offeredTools);
			if (recovered.calls.length > 0) {
				toolCalls.push(...recovered.calls);
				assistantText = recovered.remainingText;
			}
		}

		if (toolCalls.length === 0) {
			// A turn with no call and no text is not an answer: the model generated
			// nothing at all. Small local models do this after a tool result they
			// cannot make progress from, and treating it as the closing answer ends
			// the request reporting success while the user is left with a reply that
			// simply stops mid-task. Nudge and let it try again, bounded, and say so
			// out loud when it keeps coming back empty.
			// The other way a turn carries no answer: the model started writing a
			// call and never finished it, so recovery found nothing and what is
			// left is the wreckage of the attempt. Accepting it as the closing
			// answer ends the task on a block of broken JSON.
			const brokenCall = profile.parseTextToolCalls && looksLikeUnfinishedToolCall(assistantText, offeredTools);
			if (!assistantText.trim() || brokenCall) {
				if (emptyTurns < MAX_EMPTY_TURNS) {
					emptyTurns++;
					log(`unusable turn ${emptyTurns}/${MAX_EMPTY_TURNS} (${brokenCall ? 'broken tool call' : 'empty'}): nudging the model to continue`);
					messages.push(vscode.LanguageModelChatMessage.User(brokenCall ? BROKEN_CALL_NUDGE : EMPTY_TURN_NUDGE));
					continue;
				}
				stream.markdown('\n\n_O modelo encerrou o turno sem gerar uma resposta utilizável e a tarefa ficou pela metade. Isso é comum em modelos locais pequenos: reenvie a mensagem, ou escolha um modelo maior._');
				return finishRequest(brokenCall ? 'chamada malformada' : 'resposta vazia', stats, messages);
			}
			emptyTurns = 0;
			// Closing answer: keep it in the transcript so a follow-up sees what was said.
			messages.push(vscode.LanguageModelChatMessage.Assistant(assistantText));
			return finishRequest('concluído', stats, messages);
		}

		emptyTurns = 0;
		stats.toolCalls += toolCalls.length;

		const assistantParts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart> = [];
		if (assistantText) {
			assistantParts.push(new vscode.LanguageModelTextPart(assistantText));
		}
		for (const tc of toolCalls) {
			assistantParts.push(new vscode.LanguageModelToolCallPart(tc.callId, tc.name, tc.input));
		}
		messages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));

		// A model that answers with exactly the calls it just made is stuck. The
		// result was the same last turn and would be the same again, so running it
		// once more only spends a turn — and for a command that writes, it repeats
		// the side effect. Answer the calls instead of running them, saying what
		// has to change. The signature covers the whole turn, so a call that comes
		// back after any other step in between is a legitimate retry and still
		// runs.
		const signature = toolCalls.map(tc => `${tc.name}:${JSON.stringify(tc.input)}`).join('|');
		repeatedTurns = signature === lastTurnSignature ? repeatedTurns + 1 : 0;
		lastTurnSignature = signature;
		if (repeatedTurns >= MAX_REPEATED_TURNS) {
			log(`same tool call for ${repeatedTurns + 1} turns in a row; answering it instead of running it again`);
			messages.push(vscode.LanguageModelChatMessage.User(toolCalls.map(tc =>
				new vscode.LanguageModelToolResultPart(tc.callId, [new vscode.LanguageModelTextPart(REPEATED_CALL_NUDGE)]),
			)));
			continue;
		}

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
						const readSignature = REPEATABLE_READ_TOOLS.has(tc.name) ? `${tc.name}:${JSON.stringify(tc.input)}` : undefined;
						if (readSignature !== undefined) {
							if (answeredReads.has(readSignature)) {
								resultParts.push(new vscode.LanguageModelToolResultPart(tc.callId, [new vscode.LanguageModelTextPart(
									'You already made this exact call in this request and nothing has changed since. Reuse the earlier result and move on to the next step.',
								)]));
								continue;
							}
							answeredReads.add(readSignature);
						}
						if (tc.name === 'agent_search') {
							const input = tc.input as { query: string; isRegex?: boolean; path?: string };
							const text = clampToolResult(await searchWorkspace(input), profile);
							searchCount++;
							resultParts.push(new vscode.LanguageModelToolResultPart(tc.callId, [new vscode.LanguageModelTextPart(text)]));
						} else if (tc.name === 'agent_find_files') {
							const input = tc.input as { name: string; path?: string };
							const text = clampToolResult(await findFiles(input), profile);
							searchCount++;
							resultParts.push(new vscode.LanguageModelToolResultPart(tc.callId, [new vscode.LanguageModelTextPart(text)]));
						} else if (tc.name === WRITE_FILE_TOOL_NAME) {
							const input = tc.input as { path: string; content: string };
							const uri = resolveUri(input.path);
							const summary = await applyFileEdit(input, stream as ChatStreamWithEdits);
							// The workspace changed, so earlier reads may now be stale.
							answeredReads.clear();
							accessedUris.push(uri);
							taskProgress.report(new vscode.ChatResponseReferencePart(uri));
							resultParts.push(new vscode.LanguageModelToolResultPart(tc.callId, [new vscode.LanguageModelTextPart(summary)]));
						} else if (tc.name === EDIT_FILE_TOOL_NAME) {
							const input = tc.input as EditFileInput;
							const uri = resolveUri(input.path);
							const outcome = await computeFileEdit(input);
							if (outcome.content !== undefined) {
								await applyFileEdit({ path: input.path, content: outcome.content }, stream as ChatStreamWithEdits);
								answeredReads.clear();
								accessedUris.push(uri);
								taskProgress.report(new vscode.ChatResponseReferencePart(uri));
							}
							resultParts.push(new vscode.LanguageModelToolResultPart(tc.callId, [new vscode.LanguageModelTextPart(outcome.message)]));
						} else if (tc.name === 'agent_read_file') {
							const input = tc.input as ReadFileInput;
							const uri = resolveUri(input.path);
							// Budgeted rather than clamped: the reader cuts on a line
							// boundary and tells the model which offset continues the file.
							const text = await readFileForModel(input, profile.maxToolResultChars);
							accessedUris.push(uri);
							taskProgress.report(new vscode.ChatResponseReferencePart(uri));
							resultParts.push(new vscode.LanguageModelToolResultPart(tc.callId, [new vscode.LanguageModelTextPart(text)]));
						} else if (tc.name === OPEN_FILE_TOOL_NAME) {
							const input = tc.input as OpenFileInput;
							const uri = resolveUri(input.path);
							const summary = await openFileInEditor(input);
							accessedUris.push(uri);
							taskProgress.report(new vscode.ChatResponseReferencePart(uri));
							resultParts.push(new vscode.LanguageModelToolResultPart(tc.callId, [new vscode.LanguageModelTextPart(summary)]));
						} else if (tc.name === MULTI_EDIT_TOOL_NAME) {
							const input = tc.input as MultiEditInput;
							const uri = resolveUri(input.path);
							const outcome = await computeMultiFileEdit(input);
							if (outcome.content !== undefined) {
								await applyFileEdit({ path: input.path, content: outcome.content }, stream as ChatStreamWithEdits);
								answeredReads.clear();
								accessedUris.push(uri);
								taskProgress.report(new vscode.ChatResponseReferencePart(uri));
							}
							resultParts.push(new vscode.LanguageModelToolResultPart(tc.callId, [new vscode.LanguageModelTextPart(outcome.message)]));
						} else if (tc.name === 'agent_diagnostics') {
							const text = clampToolResult(await collectDiagnostics(tc.input as DiagnosticsInput), profile);
							resultParts.push(new vscode.LanguageModelToolResultPart(tc.callId, [new vscode.LanguageModelTextPart(text)]));
						} else if (tc.name === 'agent_git_status') {
							const text = clampToolResult(await gitStatus(tc.input as GitInput), profile);
							resultParts.push(new vscode.LanguageModelToolResultPart(tc.callId, [new vscode.LanguageModelTextPart(text)]));
						} else if (tc.name === 'agent_git_diff') {
							const text = clampToolResult(await gitDiff(tc.input as GitDiffInput), profile);
							resultParts.push(new vscode.LanguageModelToolResultPart(tc.callId, [new vscode.LanguageModelTextPart(text)]));
						} else if (tc.name === TODO_TOOL_NAME) {
							const parsed = parseTodos(tc.input);
							if (parsed.todos) {
								todos = parsed.todos;
								stream.markdown(renderTodosForUser(todos));
							}
							resultParts.push(new vscode.LanguageModelToolResultPart(tc.callId, [
								new vscode.LanguageModelTextPart(parsed.todos ? renderTodosForModel(parsed.todos) : parsed.error!),
							]));
						} else if (tc.name === 'agent_list_dir') {
							const input = tc.input as { path?: string };
							const text = clampToolResult(await listDirectory(input.path), profile);
							resultParts.push(new vscode.LanguageModelToolResultPart(tc.callId, [new vscode.LanguageModelTextPart(text)]));
						} else {
							// agent_run_command, ferramentas MCP e desconhecidas — o VS Code
							// cuida dos diálogos de confirmação.
							try {
								const result = await vscode.lm.invokeTool(tc.name, {
									input: tc.input,
									toolInvocationToken: request.toolInvocationToken,
								}, token);
								resultParts.push(new vscode.LanguageModelToolResultPart(tc.callId, result.content as Array<vscode.LanguageModelTextPart | vscode.LanguageModelPromptTsxPart>));
							} catch (err) {
								const message = err instanceof Error ? err.message : String(err);
								// The next step travels with the error on purpose: a small model
								// that receives only a failure stops and hands the task back to
								// the user, which is never the right answer while other tools
								// are still available.
								//
								// A saída indicada muda conforme a origem: mandar quem falhou numa
								// ferramenta MCP tentar `agent_search` é conselho ruim — o trabalho
								// dela é com um serviço externo, e nenhuma ferramenta local o faz.
								const nextStep = mcpToolNames.has(tc.name)
									? 'Essa ferramenta vem de um servidor MCP externo; nenhuma ferramenta local faz o trabalho dela. Se o erro indicar falta de autenticação ou servidor fora do ar, diga isso ao usuário e siga com o que for possível sem ela.'
									: 'Não repita essa chamada — faça o mesmo trabalho com outra ferramenta (`agent_search` para um símbolo, `agent_find_files` para um arquivo, `agent_list_dir` para ver o que existe) e siga sem perguntar nada ao usuário.';
								resultParts.push(new vscode.LanguageModelToolResultPart(tc.callId, [new vscode.LanguageModelTextPart(
									`Erro da ferramenta ${tc.name}: ${message}. ${nextStep}`,
								)]));
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

	const unfinished = todos.filter(t => t.status !== 'done');
	const pending = unfinished.length > 0
		? `\n\nFaltou:\n${unfinished.map(t => `- ${t.content}`).join('\n')}`
		: '';
	stream.markdown(`\n\n_Limite de turnos do agente atingido. O que já foi lido e executado ficou preservado — envie **continue** para retomar de onde parei._${pending}`);
	return finishRequest('limite de turnos', stats, messages);
}

/**
 * What the prompt may cost, in the terms the trimmer can measure.
 *
 * There is no tokenizer on this side of the wire: the server owns the model's
 * chat template and its vocabulary, so everything here is an estimate from
 * character counts. {@link recalibrateBudget} corrects it when the server
 * answers with a real count.
 */
interface IPromptBudget {
	/** Input the model accepts, already net of the room reserved for its reply. */
	maxInputTokens: number;
	/**
	 * Tool schemas. They are sent beside the messages and rendered into the same
	 * prompt by the template, so they are charged to the same window even though
	 * the trimmer cannot drop them.
	 */
	readonly toolTokens: number;
	/** Characters per token. Lowered when the server proves the prompt denser. */
	charsPerToken: number;
}

/**
 * Starting guess at characters per token.
 *
 * Prose runs about 4 on these tokenizers, but an agent conversation is mostly
 * code, JSON tool arguments and diffs, which tokenize far denser — the value
 * that matters is the one that does not overflow, and undershooting the prompt
 * is what makes the server reject the whole call.
 */
const DEFAULT_CHARS_PER_TOKEN = 3;

/**
 * Share of the window left to the chat template's own framing: the role markers,
 * the tool-call scaffolding and the system preamble it adds around what we send.
 */
const FRAMING_RESERVE = 0.9;

/** Attempts allowed at correcting the estimate before the error reaches the user. */
const MAX_OVERFLOW_RETRIES = 2;

/**
 * Empty turns tolerated in a row before the request is given up on.
 *
 * Two, because the first one is usually recoverable — the model lost the thread
 * for a turn and picks it back up when told to — while a model that answers
 * nothing twice in a row is stuck, and every further attempt costs another full
 * generation on CPU inference.
 */
const MAX_EMPTY_TURNS = 2;

/**
 * Turns of identical calls tolerated before they stop being run.
 *
 * Two, so the same call still runs once more after its first result — a retry
 * that is genuinely worth making happens on the second attempt, never on the
 * third with nothing changed in between.
 */
const MAX_REPEATED_TURNS = 2;

/** Sent back in place of a tool call the model has been repeating unchanged. */
const REPEATED_CALL_NUDGE = 'You have made this exact call, with these exact arguments, on the last turns in a row, and it was not run again because the result cannot have changed. Do something different: take the next step of the task with a different tool or different arguments, or write the final answer for the user.';

/**
 * Whether `text` is a tool call the model failed to finish.
 *
 * Only asked once recovery has already come up empty, so a well-formed call
 * never lands here — what this catches is the truncated one, most often a
 * `agent_write_file` whose file content ran on until the model stopped
 * mid-string. The test is deliberately narrow: an opening tool tag, or text
 * that opens with a JSON object naming a tool that was actually offered.
 */
function looksLikeUnfinishedToolCall(text: string, tools: readonly vscode.LanguageModelChatTool[]): boolean {
	const trimmed = text.trimStart();
	if (trimmed.includes('<tool_call>')) {
		return true;
	}
	if (!trimmed.startsWith('{') || !trimmed.includes('"name"')) {
		return false;
	}
	return tools.some(tool => trimmed.includes(`"${tool.name}"`));
}

/** Sent back when the model wrote a tool call it never finished. */
const BROKEN_CALL_NUDGE = 'Your last turn was a tool call that never finished — it was cut off before the JSON closed, so nothing ran. Make the call again, and keep it small: write one file at a time, and never paste a whole file into the chat.';

/** Sent back when the model returns a turn with neither text nor a tool call. */
const EMPTY_TURN_NUDGE = 'Your last turn was empty — you generated nothing. Do not stop here. Look at the tool results above, then either call the next tool or write the final answer for the user.';

/**
 * Drops the oldest turns until the conversation fits the model's input budget.
 *
 * Hosted models have six-figure context windows, so nothing here ever mattered;
 * a local model with 16k-32k overflows on the first request that carries any
 * history, and the server rejects the whole call. Trimming keeps the system
 * prompt (index 0) and the newest turns, which is where the task actually lives.
 *
 * Messages are removed from the front so that an assistant message carrying tool
 * calls always leaves before the tool results answering it. Any tool results
 * left orphaned at the new front are dropped too: an OpenAI-format server
 * rejects a tool result whose call it can no longer see.
 */
function trimToBudget(
	messages: readonly vscode.LanguageModelChatMessage[],
	budget: IPromptBudget,
	stats: IRequestStats,
): vscode.LanguageModelChatMessage[] {
	const allowance = messageAllowance(budget);
	if (estimateMessagesTokens(messages, budget) <= allowance) {
		return [...messages];
	}

	const system = messages[0];
	const rest = messages.slice(1);
	// Never drop the newest turn: it is the request being answered.
	while (rest.length > 1 && estimateMessagesTokens([system, ...rest], budget) > allowance) {
		rest.shift();
		stats.droppedMessages++;
	}
	while (rest.length > 1 && isOrphanToolResult(rest[0])) {
		rest.shift();
		stats.droppedMessages++;
	}
	return [system, ...rest];
}

/**
 * Messages at the end of the conversation that neither eviction nor compaction
 * touches. The agent is mid-task: whatever it just read or just ran is what the
 * next step is built on, and summarising that is how a loop starts repeating
 * work it already did.
 */
const KEEP_RECENT_MESSAGES = 6;

/** What an evicted tool result leaves in place of its output. */
const EVICTED_TOOL_RESULT = '[output dropped to free context — call the tool again if you still need it]';

/** Per-message ceiling when the conversation is rendered for the summariser. */
const SUMMARY_PART_CHARS = 2000;

/**
 * Brings the prompt inside the budget, cheapest measure first.
 *
 * Three steps, in increasing cost and increasing loss:
 *
 * 1. Evict old tool output. In an agent conversation this is where the window
 *    actually goes — a handful of file reads outweighs every word the user and
 *    the model exchanged — and it is the cheapest thing to lose, because the
 *    agent can read the file again.
 * 2. Compact: ask the model to summarise the older half and continue with the
 *    summary in its place. Costs one extra request, and is the only step that
 *    preserves *why* the conversation went where it did.
 * 3. Drop the oldest messages outright, which is where {@link trimToBudget} was
 *    the whole strategy. It stays as the floor: it needs no model and cannot
 *    fail, so it is what catches a summariser that errored or was cancelled.
 *
 * Steps 1 and 2 mutate `messages`, so the saving carries to the following turns
 * and into the transcript. Re-summarising the same history once per turn would
 * cost more than the history ever did.
 */
async function ensurePromptFits(
	messages: vscode.LanguageModelChatMessage[],
	budget: IPromptBudget,
	stats: IRequestStats,
	pinned: vscode.LanguageModelChatMessage | undefined,
	model: vscode.LanguageModelChat,
	stream: vscode.ChatResponseStream,
	token: vscode.CancellationToken,
): Promise<vscode.LanguageModelChatMessage[]> {
	const fits = () => estimateMessagesTokens(messages, budget) <= messageAllowance(budget);
	if (fits()) {
		return [...messages];
	}

	stats.evictedToolResults += evictOldToolResults(messages, budget);
	if (fits()) {
		return [...messages];
	}

	if (compactionEnabled() && !token.isCancellationRequested) {
		stream.progress('Compactando a conversa...');
		if (await compactConversation(messages, budget, pinned, model, token)) {
			stats.compactions++;
			stream.markdown('\n\n_A conversa encheu a janela de contexto. Resumi o que veio antes e segui daqui — o histórico completo continua visível acima._\n\n');
			if (fits()) {
				return [...messages];
			}
		}
	}

	return trimToBudget(messages, budget, stats);
}

/** Whether the conversation may be summarised when the window fills. */
function compactionEnabled(): boolean {
	return vscode.workspace.getConfiguration('agent-chat').get<boolean>('compaction.enabled', true);
}

/**
 * Replaces the output of old tool results with a marker, oldest first, until the
 * prompt fits.
 *
 * The call itself is left in place, so every tool call still has the result
 * answering it — an OpenAI-format server rejects the whole prompt over a
 * dangling call, which is the trap that makes dropping whole messages delicate.
 *
 * Returns how many results were emptied.
 */
function evictOldToolResults(messages: vscode.LanguageModelChatMessage[], budget: IPromptBudget): number {
	const allowance = messageAllowance(budget);
	const lastTouchable = messages.length - KEEP_RECENT_MESSAGES;
	let evicted = 0;

	for (let i = 1; i < lastTouchable && estimateMessagesTokens(messages, budget) > allowance; i++) {
		const message = messages[i];
		if (!isOrphanToolResult(message)) {
			continue;
		}
		const replaced: vscode.LanguageModelToolResultPart[] = [];
		let changed = false;
		for (const part of message.content) {
			if (!(part instanceof vscode.LanguageModelToolResultPart)) {
				continue;
			}
			if (isEvictedToolResult(part)) {
				replaced.push(part);
				continue;
			}
			replaced.push(new vscode.LanguageModelToolResultPart(part.callId, [new vscode.LanguageModelTextPart(EVICTED_TOOL_RESULT)]));
			changed = true;
			evicted++;
		}
		if (changed) {
			messages[i] = vscode.LanguageModelChatMessage.User(replaced);
		}
	}
	return evicted;
}

function isEvictedToolResult(part: vscode.LanguageModelToolResultPart): boolean {
	const [only] = part.content;
	return part.content.length === 1
		&& only instanceof vscode.LanguageModelTextPart
		&& only.value === EVICTED_TOOL_RESULT;
}

/**
 * Summarises the older part of the conversation and puts the summary in its
 * place, keeping the recent tail verbatim.
 *
 * The cut never lands on a message of tool results whose assistant call would be
 * summarised away: the tail has to start somewhere the server can still read as
 * a conversation. The message carrying the user's actual request is re-inserted
 * after the summary when it falls inside the compacted range — a summary is
 * allowed to blur what was discovered, never what was asked.
 *
 * Returns false when there was nothing to compact, or when the summariser failed
 * or was cancelled; the caller then falls back to dropping messages. Nothing is
 * mutated unless a usable summary came back.
 */
async function compactConversation(
	messages: vscode.LanguageModelChatMessage[],
	budget: IPromptBudget,
	pinned: vscode.LanguageModelChatMessage | undefined,
	model: vscode.LanguageModelChat,
	token: vscode.CancellationToken,
): Promise<boolean> {
	let cut = Math.max(2, messages.length - KEEP_RECENT_MESSAGES);
	while (cut < messages.length && isOrphanToolResult(messages[cut])) {
		cut++;
	}
	const head = messages.slice(1, cut);
	if (head.length < 2) {
		return false;
	}

	let summary: string;
	try {
		// The summariser gets a request of its own and has to fit the same window.
		// Half of it, in characters, leaves ample room for the summary to come back.
		const renderBudget = Math.floor(budget.maxInputTokens * budget.charsPerToken * 0.5);
		summary = await summarize(head, renderBudget, model, token);
	} catch (err) {
		// A summariser that fails must not take the turn down with it: the caller
		// still has trimming, which needs nothing from the model.
		log(`compaction failed: ${err instanceof Error ? err.message : String(err)}`);
		return false;
	}
	if (!summary.trim() || token.isCancellationRequested) {
		return false;
	}

	const replacement: vscode.LanguageModelChatMessage[] = [
		vscode.LanguageModelChatMessage.User(
			`[Summary of the earlier conversation. The raw history was compacted to free context; what follows continues from here.]\n\n${summary.trim()}`,
		),
	];
	if (pinned && head.includes(pinned)) {
		replacement.push(pinned);
	}

	const before = estimateMessagesTokens(messages, budget);
	messages.splice(1, cut - 1, ...replacement);
	log(`compaction: ${head.length} messages -> ${replacement.length}, ~${before - estimateMessagesTokens(messages, budget)} tokens freed`);
	return true;
}

/** Asks the model for the summary that will stand in for the conversation. */
async function summarize(
	head: readonly vscode.LanguageModelChatMessage[],
	renderBudget: number,
	model: vscode.LanguageModelChat,
	token: vscode.CancellationToken,
): Promise<string> {
	const request = vscode.LanguageModelChatMessage.User(`${COMPACTION_PROMPT}\n\n---\n${renderForSummary(head, renderBudget)}\n---`);
	// Deliberately untagged for the usage bus: these tokens are spent on the
	// summary, not on the conversation the context ring describes.
	const response = await model.sendRequest([request], {}, token);
	let summary = '';
	for await (const part of response.stream) {
		if (part instanceof vscode.LanguageModelTextPart) {
			summary += part.value;
		}
	}
	return summary;
}

const COMPACTION_PROMPT = `
You are compacting a long agent conversation so the work can continue in a smaller context window.
Write the notes you would need to resume this task with nothing else available.

Use exactly these headings:
- Goal: what the user asked for, in their terms, with every constraint they stated.
- Decisions: choices already settled, and the reasoning that still binds the work.
- Done: changes already made, with exact file paths and what changed in each.
- Learned: what it took work to find out — paths, symbols, commands that work, error messages, dead ends already ruled out.
- Pending: what is still open, and the immediate next step.

Keep file paths, symbol names, commands and error text verbatim. Drop pleasantries, tool-call
mechanics and anything later work superseded. Invent nothing that is not in the transcript below:
a gap is better than a guess, because the next turns will be trusted against these notes.
`.trim();

/**
 * Flattens the conversation into the plain transcript the summariser reads,
 * within `maxChars`.
 *
 * Overflowing it is dropped from the middle, not the end. Compaction runs when
 * the window is nearly full, so the transcript can be nearly a window wide on
 * its own — and a summariser request that overflows fails exactly when the
 * conversation most needed compacting. The opening holds what the user asked
 * for and the close holds where the work currently stands; the middle is the
 * part a summary was always going to blur.
 */
function renderForSummary(messages: readonly vscode.LanguageModelChatMessage[], maxChars: number): string {
	const lines: string[] = [];
	for (const message of messages) {
		const role = message.role === vscode.LanguageModelChatMessageRole.Assistant ? 'Assistant' : 'User';
		for (const part of message.content) {
			if (part instanceof vscode.LanguageModelTextPart) {
				if (part.value.trim()) {
					lines.push(`${role}: ${truncate(part.value, SUMMARY_PART_CHARS)}`);
				}
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				lines.push(`${role} called ${part.name}(${truncate(JSON.stringify(part.input), 400)})`);
			} else if (part instanceof vscode.LanguageModelToolResultPart) {
				const text = part.content
					.filter((inner): inner is vscode.LanguageModelTextPart => inner instanceof vscode.LanguageModelTextPart)
					.map(inner => inner.value)
					.join('\n');
				if (text.trim()) {
					lines.push(`Tool result: ${truncate(text, SUMMARY_PART_CHARS)}`);
				}
			}
		}
	}

	const full = lines.join('\n');
	if (full.length <= maxChars) {
		return full;
	}
	const opening = full.slice(0, Math.floor(maxChars * 0.4));
	const closing = full.slice(full.length - Math.floor(maxChars * 0.6));
	return `${opening}\n\n[... middle of the transcript omitted for length ...]\n\n${closing}`;
}

/** Tokens the messages may spend, once the schemas and the framing are paid for. */
function messageAllowance(budget: IPromptBudget): number {
	return Math.max(1024, Math.floor(budget.maxInputTokens * FRAMING_RESERVE) - budget.toolTokens);
}

/**
 * Hands the turn's token counts to the chat view, which draws them as the
 * context-window ring next to the input.
 *
 * Called once per model call rather than once per user message, so during a long
 * agent turn the ring keeps climbing as tool results pile into the prompt —
 * which is the whole point of showing it. The counts describe the conversation
 * as a whole, not this call alone: the prompt already carries every earlier
 * message, so the last call's prompt is the current size of the context.
 *
 * Silent when the provider reported nothing: the view keeps whatever it last
 * showed, which is closer to the truth than zero.
 */
function reportContextUsage(stream: vscode.ChatResponseStream, usageToken: string): void {
	const usage = usageBus.take(usageToken);
	if (!usage) {
		return;
	}
	stream.usage({ promptTokens: usage.inputTokens, completionTokens: usage.outputTokens });
}

/**
 * Server's answer when the prompt did not fit, read out of the 400 body.
 *
 * Both shapes are accepted because the numbers appear twice: as fields of the
 * error object, and spelled out in the message llama.cpp writes beside them.
 */
interface IContextOverflow {
	readonly promptTokens: number;
	readonly contextTokens: number;
}

function parseContextOverflow(err: unknown): IContextOverflow | undefined {
	const message = err instanceof Error ? err.message : String(err);
	if (!message.includes('exceed_context_size_error') && !message.includes('exceeds the available context size')) {
		return undefined;
	}
	const prompt = /"n_prompt_tokens"\s*:\s*(?<count>\d+)/.exec(message)?.groups?.count
		?? /request \((?<count>\d+) tokens\)/.exec(message)?.groups?.count;
	const context = /"n_ctx"\s*:\s*(?<count>\d+)/.exec(message)?.groups?.count
		?? /context size \((?<count>\d+) tokens\)/.exec(message)?.groups?.count;
	if (!prompt || !context) {
		return undefined;
	}
	return { promptTokens: Number(prompt), contextTokens: Number(context) };
}

/**
 * Teaches the budget what the last rejection proved, and reports whether the
 * next attempt is actually going to be smaller.
 *
 * Two things are learned. The window: the server's `n_ctx` is what the process
 * was launched with, which beats whatever the catalog claims. And the density:
 * the prompt we thought was `estimated` came back counted as `promptTokens`, so
 * the ratio between them is how wrong the characters-per-token guess was.
 *
 * Returns false when nothing was learned — an estimate already at least as
 * conservative as the evidence — so the caller stops retrying instead of
 * sending the same prompt again.
 */
function recalibrateBudget(
	budget: IPromptBudget,
	overflow: IContextOverflow,
	sent: readonly vscode.LanguageModelChatMessage[],
	stats: IRequestStats,
): boolean {
	let learned = false;

	// Room for the reply has to come out of the window the server reported.
	const window = overflow.contextTokens - REPLY_RESERVE_TOKENS;
	if (window > 0 && window < budget.maxInputTokens) {
		budget.maxInputTokens = window;
		learned = true;
	}

	const estimated = estimateMessagesTokens(sent, budget) + budget.toolTokens;
	if (estimated > 0 && overflow.promptTokens > estimated) {
		const corrected = Math.max(MIN_CHARS_PER_TOKEN, budget.charsPerToken * (estimated / overflow.promptTokens));
		// Only worth another round trip if the correction really tightens things.
		if (corrected < budget.charsPerToken * 0.98) {
			budget.charsPerToken = corrected;
			learned = true;
		}
	}

	if (learned) {
		stats.overflowRetries++;
	}
	return learned;
}

/**
 * Floor on the correction. Below this the estimate stops describing any real
 * tokenizer and starts throwing away conversation to chase a number that must
 * be wrong for another reason.
 */
const MIN_CHARS_PER_TOKEN = 1.5;

/** Room the reply needs inside the window the server reported. */
const REPLY_RESERVE_TOKENS = 2048;

/**
 * Tool schemas cost, as the template renders them into the prompt.
 *
 * Deliberately counted with the same fixed ratio as the messages: they are the
 * one part of the prompt the trimmer cannot shrink, so they are subtracted from
 * the allowance instead of being trimmed.
 */
function estimateToolsTokens(tools: readonly vscode.LanguageModelChatTool[]): number {
	let chars = 0;
	for (const tool of tools) {
		chars += tool.name.length + (tool.description?.length ?? 0);
		if (tool.inputSchema) {
			chars += JSON.stringify(tool.inputSchema).length;
		}
	}
	return Math.ceil(chars / DEFAULT_CHARS_PER_TOKEN);
}

/** True for a message whose only content is tool results. */
function isOrphanToolResult(message: vscode.LanguageModelChatMessage): boolean {
	return message.content.length > 0
		&& message.content.every(part => part instanceof vscode.LanguageModelToolResultPart);
}

function estimateMessagesTokens(messages: readonly vscode.LanguageModelChatMessage[], budget: IPromptBudget): number {
	const perToken = budget.charsPerToken;
	let total = 0;
	for (const message of messages) {
		for (const part of message.content) {
			if (part instanceof vscode.LanguageModelTextPart) {
				total += Math.ceil(part.value.length / perToken);
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				total += Math.ceil((part.name.length + JSON.stringify(part.input).length) / perToken);
			} else if (part instanceof vscode.LanguageModelToolResultPart) {
				for (const inner of part.content) {
					if (inner instanceof vscode.LanguageModelTextPart) {
						total += Math.ceil(inner.value.length / perToken);
					}
				}
			}
		}
		// Per-message framing (role markers, separators).
		total += 4;
	}
	return total;
}

/** What one request actually spent, so the turn budget can be tuned from data. */
interface IRequestStats {
	turnsUsed: number;
	toolCalls: number;
	readonly startedAt: number;
	readonly modelId: string;
	readonly profile: IAgentProfile;
	/** Messages dropped to keep the prompt inside the model's input budget. */
	droppedMessages: number;
	/** Times the server rejected the prompt and the estimate had to be corrected. */
	overflowRetries: number;
	/** Tool outputs emptied to free context, the cheapest room there is to make. */
	evictedToolResults: number;
	/** Times the conversation was summarised to keep going in the same session. */
	compactions: number;
}

/**
 * Closes a request: records what it cost in the Agent Chat output channel and
 * stashes the working messages in the result metadata, so the next request can
 * resume with the tool calls and tool results intact instead of rebuilding a
 * text-only summary of the conversation.
 *
 * The leading system prompt is dropped from the snapshot: it is rebuilt from the
 * rules and memories that are current at the time of the next request.
 */
function finishRequest(outcome: string, stats: IRequestStats, messages: readonly vscode.LanguageModelChatMessage[]): vscode.ChatResult {
	const seconds = Math.round((Date.now() - stats.startedAt) / 1000);
	const perTurn = stats.turnsUsed > 0 ? (stats.toolCalls / stats.turnsUsed).toFixed(1) : '0';
	const dropped = stats.droppedMessages > 0 ? `, ${stats.droppedMessages} mensagens descartadas por limite de contexto` : '';
	const recalibrated = stats.overflowRetries > 0 ? `, ${stats.overflowRetries} reenvios após estouro de contexto` : '';
	const evicted = stats.evictedToolResults > 0 ? `, ${stats.evictedToolResults} resultados de ferramenta descartados` : '';
	const compacted = stats.compactions > 0 ? `, ${stats.compactions} compactações da conversa` : '';
	log(`request: ${outcome} — ${stats.turnsUsed}/${stats.profile.maxTurns} turnos, ${stats.toolCalls} tool calls (${perTurn}/turno), ${seconds}s, modelo ${stats.modelId}, perfil ${stats.profile.id}${evicted}${compacted}${dropped}${recalibrated}`);
	return { metadata: { [TRANSCRIPT_METADATA_KEY]: serializeTranscript(messages.slice(1)) } };
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
	if ([...names].some(name => BROWSER_TOOL_NAMES.has(name))) {
		return 'Testando no navegador...';
	}
	if (names.has('agent_run_command')) {
		return 'Executando comandos...';
	}
	if (names.has('agent_read_terminal')) {
		return 'Acompanhando o terminal...';
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
	if (result.summary) {
		stream.markdown(`\n${truncate(result.summary, 400)}\n`);
	}
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

/**
 * Words that earn the browser tools their place in the prompt.
 *
 * Their ten schemas measure ~2400 tokens, which a small model pays for on every
 * single turn — and on CPU inference those tokens are seconds, not cents. The
 * list errs towards including them: a false positive costs what the old
 * behaviour always cost, while a false negative breaks the task.
 */
const BROWSER_INTENT_RE = /\b(navegador|browser|chrome|playwright|screenshot|captura de tela|print da tela|pagina|page|url|localhost|https?:\/\/|site|frontend|front-end|interface|tela|clic\w*|cliqu\w*|click\w*|preench\w*|renderiz\w*)\b/;

/** A verb aimed at something runnable, which almost always ends up in a page. */
const BROWSER_TASK_RE = /\b(abr\w*|rod\w*|execut\w*|sub\w*|inici\w*|start\w*|run|open|test\w*)\b[\s\S]{0,40}\b(app|aplicacao|aplicativo|projeto|servidor|server|dev|site|ui)\b/;

/**
 * Whether this conversation has asked for anything the browser tools serve.
 *
 * The whole conversation is scanned, not just the new message, so the answer can
 * only ever turn on. The tool schemas sit at the very front of the prompt: taking
 * one away mid-conversation would invalidate the runtime's cached prefix and buy
 * a full re-read of every token before it — far more than the tools ever cost.
 */
function wantsBrowserTools(request: vscode.ChatRequest, context: vscode.ChatContext): boolean {
	const asked: string[] = [request.prompt];
	for (const turn of context.history) {
		if (turn instanceof vscode.ChatRequestTurn) {
			asked.push(turn.prompt);
		}
	}
	// Accents dropped so `página` and `pagina` are one word to the matcher.
	const text = asked.join(' ').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
	return BROWSER_INTENT_RE.test(text) || BROWSER_TASK_RE.test(text);
}

function collectTools(profile: IAgentProfile, browserWanted: boolean): vscode.LanguageModelChatTool[] {
	const config = vscode.workspace.getConfiguration('agent-chat');
	const browserEnabled = config.get<boolean>('browser.enabled', true)
		&& profile.allowBrowser
		// Only the compact profile pays enough for the schemas to be worth gating: a
		// hosted model has the room, and withholding there would be a regression for
		// no gain.
		&& (browserWanted || profile.id !== 'compact');
	// `vscode.lm.tools` lists every tool the manifest contributes, whether or not
	// an implementation was registered for it. The code graph registers itself only
	// while its setting is on, so without this it is offered as a tool that always
	// fails to invoke — and a model that gets an error with no way forward stops
	// and asks the user to do the work by hand.
	const graphEnabled = config.get<boolean>('codeGraph.enabled', false);
	// Same reasoning for the semantic index: the manifest always contributes the
	// tool, but it only has an implementation while the setting is on.
	const semanticIndexEnabled = config.get<boolean>('semanticIndex.enabled', true);
	const mcpEnabled = config.get<boolean>('mcp.enabled', true);
	const mcpLimit = config.get<number>('mcp.maxTools', 48);
	const result: vscode.LanguageModelChatTool[] = [];
	const mcpTools: vscode.LanguageModelChatTool[] = [];
	for (const info of vscode.lm.tools) {
		// Ferramentas vindas de servidores MCP se anunciam pela tag, posta pelo
		// núcleo em mcpLanguageModelToolContribution.ts. A tag está no objeto
		// público da API — não é preciso API proposta para reconhecê-las. O nome
		// já chega saneado de lá (pontos viram `_`, tamanho limitado), então
		// serve como está para os provedores que validam nomes de ferramenta.
		if (isMcpToolInfo(info)) {
			if (mcpEnabled) {
				mcpTools.push({ name: info.name, description: info.description, inputSchema: info.inputSchema });
			}
			continue;
		}
		if (!AGENT_TOOL_NAMES.has(info.name)) {
			continue;
		}
		if (!browserEnabled && BROWSER_TOOL_NAMES.has(info.name)) {
			continue;
		}
		if (!graphEnabled && info.name === 'agent_code_graph') {
			continue;
		}
		if (!semanticIndexEnabled && info.name === 'agent_codebase_search') {
			continue;
		}
		result.push({
			name: info.name,
			description: info.description,
			inputSchema: info.inputSchema,
		});
	}
	// As ferramentas próprias entram inteiras; as de MCP cedem primeiro se houver
	// excesso. Um punhado de servidores passa fácil das cem ferramentas, e cada
	// uma custa o schema dela em todo turno — sem teto, um servidor falante come
	// a janela de contexto antes de o usuário escrever qualquer coisa. O corte é
	// avisado no log porque um teto silencioso vira um mistério mais tarde.
	if (mcpTools.length > mcpLimit) {
		log(`tools: ${mcpTools.length} ferramentas MCP disponíveis, oferecendo ${mcpLimit} (agent-chat.mcp.maxTools)`);
		mcpTools.length = mcpLimit;
	}
	return [...result, ...mcpTools];
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
	/** Left out when the file is too large to inline; the block says so instead. */
	readonly content?: string;
	readonly bytes: number;
}

function buildInitialMessages(
	context: vscode.ChatContext,
	request: vscode.ChatRequest,
	rules: ResolvedRules | undefined,
	memories: readonly LoadedMemory[],
	attachments: readonly vscode.LanguageModelDataPart[],
	textRefs: readonly ITextReference[],
	profile: IAgentProfile,
): vscode.LanguageModelChatMessage[] {
	const messages: vscode.LanguageModelChatMessage[] = [];
	messages.push(vscode.LanguageModelChatMessage.User(buildSystemPrompt(rules, memories, profile)));

	appendHistory(context.history, messages);

	let userPrompt = request.prompt || '';
	if (textRefs.length > 0) {
		const refBlocks = textRefs.map(ref => {
			if (ref.content === undefined) {
				// Saying nothing would leave the model looking for a file it was just
				// handed, which is how a read-only question turns into a search.
				return `--- Arquivo: ${ref.uri.fsPath} — anexado, mas grande demais (${formatBytes(ref.bytes)}) para caber aqui. Leia-o com agent_read_file, usando offset/limit. ---`;
			}
			if (ref.range) {
				const lines = ` (linhas ${ref.range.start.line + 1}–${ref.range.end.line + 1})`;
				return `--- Arquivo: ${ref.uri.fsPath}${lines} — apenas o trecho selecionado; leia o arquivo se precisar do resto ---\n${ref.content}\n---`;
			}
			return `--- Arquivo: ${ref.uri.fsPath} — conteúdo COMPLETO abaixo. Este arquivo já está lido: responda a partir do que está aqui e NÃO chame agent_read_file para ele. ---\n${ref.content}\n---`;
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

async function collectTextReferences(request: vscode.ChatRequest, profile: IAgentProfile): Promise<ITextReference[]> {
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
			if (bytes.byteLength > profile.maxTextRefBytes) {
				result.push({ uri, bytes: bytes.byteLength });
				continue;
			}
			let content = Buffer.from(bytes).toString('utf8');
			if (range) {
				const lines = content.split('\n');
				content = lines.slice(range.start.line, range.end.line + 1).join('\n');
			}
			result.push({ uri, range, content, bytes: bytes.byteLength });
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

function buildSystemPrompt(rules: ResolvedRules | undefined, memories: readonly LoadedMemory[], profile: IAgentProfile): string {
	const sections: string[] = [profile.systemPrompt];
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

/**
 * Replays the conversation so far. The most recent response that carries a
 * transcript snapshot wins: it restores that request's tool calls and results
 * verbatim, so a continuation resumes with everything the agent had read and
 * run. Only turns after it — and conversations from before this existed — fall
 * back to the text-only reconstruction, which loses all tool activity.
 */
function appendHistory(history: readonly (vscode.ChatRequestTurn | vscode.ChatResponseTurn)[], messages: vscode.LanguageModelChatMessage[]): void {
	let snapshotIndex = -1;
	for (let i = history.length - 1; i >= 0; i--) {
		const turn = history[i];
		if (!(turn instanceof vscode.ChatResponseTurn)) {
			continue;
		}
		const restored = restoreTranscript(turn.result);
		if (restored) {
			messages.push(...restored);
			snapshotIndex = i;
			break;
		}
	}

	for (let i = snapshotIndex + 1; i < history.length; i++) {
		const turn = history[i];
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
