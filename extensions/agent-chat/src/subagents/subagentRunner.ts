/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { clampToolResult } from '../agentProfile.js';
import { log } from '../logger.js';
import { IToolRunEnvironment, READ_ONLY_TOOL_NAMES, runAgentTool } from '../toolExecutor.js';
import { ISubagentDefinition } from './definitions.js';

export const TASK_TOOL_NAME = 'agent_task';

/**
 * Turn budget for one sub-agent. It costs the parent a single turn, so it can
 * afford to be generous — and unlike the parent, a sub-agent that runs out
 * cannot be resumed, which makes a tight budget expensive rather than safe.
 */
const MAX_SUBAGENT_TURNS = 20;

/** Sub-agents running at once. Each one is a stream of model requests of its own. */
const MAX_CONCURRENT_SUBAGENTS = 4;

/**
 * Cap on the report handed back to the parent. It lands in the parent's
 * context, and a sub-agent is worth running precisely because it keeps most
 * of what it read out of there.
 */
const MAX_REPORT_CHARS = 20_000;

/** Builds the delegation tool, listing the sub-agents available in this request. */
export function buildTaskTool(definitions: readonly ISubagentDefinition[]): vscode.LanguageModelChatTool {
	const catalog = definitions
		.map(d => `- \`${d.name}\`${d.readonly ? ' (read-only)' : ''}: ${d.description}`)
		.join('\n');
	return {
		name: TASK_TOOL_NAME,
		description: [
			'Delegate a self-contained task to a sub-agent. It works in its own context — it does NOT see this conversation — and returns a written report as the result.',
			'Use it to keep your own context focused: broad investigations, or a well-scoped piece of work you can hand off whole.',
			'Several calls in the same turn run in PARALLEL: read-only sub-agents all at once, sub-agents that can edit one after another. So when a question splits into independent parts, send one call per part in a single turn.',
			'The prompt must be complete: the goal, the relevant files or symbols you already know, and what the report should contain.',
			'Skip it for anything you can do in one or two tool calls yourself.',
			'',
			'Available sub-agents:',
			catalog,
		].join('\n'),
		inputSchema: {
			type: 'object',
			properties: {
				agent: {
					type: 'string',
					enum: definitions.map(d => d.name),
					description: 'Which sub-agent runs the task.',
				},
				description: {
					type: 'string',
					description: 'A short label for the task, 3 to 8 words, shown to the user.',
				},
				prompt: {
					type: 'string',
					description: 'The complete, self-contained task. Include everything the sub-agent needs: goal, known files and symbols, constraints, and what to report back.',
				},
			},
			required: ['agent', 'description', 'prompt'],
		},
	};
}

/** Everything a sub-agent inherits from the request that launched it. */
export interface ISubagentRunContext {
	/** The main agent's model, used by sub-agents whose definition says `inherit`. */
	readonly model: vscode.LanguageModelChat;
	/** The main agent's tools, before a definition narrows them. Never includes `agent_task`. */
	readonly tools: readonly vscode.LanguageModelChatTool[];
	readonly environment: Omit<IToolRunEnvironment, 'answeredReads'>;
	/** Workspace, project instructions, rules and memories, as the main agent sees them. */
	readonly projectContext: string;
}

/**
 * Runs every `agent_task` call of one turn and returns their results in order.
 *
 * Read-only sub-agents run side by side, up to {@link MAX_CONCURRENT_SUBAGENTS};
 * a sub-agent that can write waits for the previous writer to finish, since two
 * of them editing the same checkout would trample each other's changes.
 */
export async function runTaskCalls(
	calls: readonly vscode.LanguageModelToolCallPart[],
	definitions: readonly ISubagentDefinition[],
	ctx: ISubagentRunContext,
	token: vscode.CancellationToken,
): Promise<vscode.LanguageModelToolResultPart[]> {
	const limit = createLimiter(MAX_CONCURRENT_SUBAGENTS);
	let writerChain: Promise<unknown> = Promise.resolve();
	const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
		const run = writerChain.then(fn);
		writerChain = run.catch(() => undefined);
		return run;
	};

	const reports = calls.map(async (tc): Promise<string> => {
		const input = tc.input as { agent?: unknown; description?: unknown; prompt?: unknown };
		const definition = definitions.find(d => d.name === input.agent);
		const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
		if (!definition) {
			return `Sub-agente desconhecido: ${String(input.agent)}. Use um destes: ${definitions.map(d => d.name).join(', ')}.`;
		}
		if (prompt.length < 8) {
			return 'Tarefa inválida: forneça em `prompt` uma descrição completa e autocontida.';
		}
		const label = typeof input.description === 'string' && input.description.trim() ? input.description.trim() : truncate(prompt, 80);
		const run = () => limit(() => runSubagent(definition, label, prompt, ctx, token));
		return definition.readonly ? run() : exclusive(run);
	});

	const settled = await Promise.all(reports);
	return calls.map((tc, i) => new vscode.LanguageModelToolResultPart(tc.callId, [new vscode.LanguageModelTextPart(settled[i])]));
}

/** Runs one sub-agent to completion and returns the report for the parent. */
async function runSubagent(
	definition: ISubagentDefinition,
	label: string,
	task: string,
	ctx: ISubagentRunContext,
	token: vscode.CancellationToken,
): Promise<string> {
	const { stream } = ctx.environment;
	const tools = ctx.tools.filter(tool => isAllowed(definition, tool.name));
	const allowed = new Set(tools.map(tool => tool.name));
	const model = await resolveModel(definition, ctx.model);
	const env: IToolRunEnvironment = { ...ctx.environment, answeredReads: new Set() };
	const tag = `subagent[${definition.name}]`;

	stream.markdown(`\n\n🤖 **${definition.name}** — ${label}\n`);
	log(`${tag}: início — ${tools.length} ferramentas, modelo ${model.id}: ${truncate(task, 120)}`);

	const messages: vscode.LanguageModelChatMessage[] = [
		vscode.LanguageModelChatMessage.User(buildSystemPrompt(definition, ctx.projectContext)),
		vscode.LanguageModelChatMessage.User(task),
	];
	let lastText = '';
	let toolCallCount = 0;
	const startedAt = Date.now();
	const finish = (outcome: 'done' | 'failed', report: string, error?: string): string => {
		const stats = `${toolCallCount} ferramentas, ${elapsedSeconds(startedAt)}s`;
		log(`${tag}: ${outcome === 'done' ? 'concluído' : `falhou (${error})`} — ${stats}`);
		stream.markdown(outcome === 'done'
			? `\n✅ **${definition.name}** — ${label} _(${stats})_\n`
			: `\n❌ **${definition.name}** — ${label}: ${error} _(${stats})_\n`);
		const body = clampToolResult(report.trim().slice(0, MAX_REPORT_CHARS), ctx.environment.profile);
		if (outcome === 'done') {
			return body || 'O sub-agente terminou sem escrever um relatório.';
		}
		return `O sub-agente não concluiu: ${error}.${body ? `\n\nO que ele deixou registrado:\n${body}` : ''}`;
	};

	for (let turn = 0; turn < MAX_SUBAGENT_TURNS; turn++) {
		if (token.isCancellationRequested) {
			return finish('failed', lastText, 'cancelado');
		}

		const toolCalls: vscode.LanguageModelToolCallPart[] = [];
		let text = '';
		try {
			// Some providers reject an empty tool list outright.
			const options: vscode.LanguageModelChatRequestOptions = tools.length > 0 ? { tools, toolMode: vscode.LanguageModelChatToolMode.Auto } : {};
			const response = await model.sendRequest(messages, options, token);
			for await (const part of response.stream) {
				if (part instanceof vscode.LanguageModelTextPart) {
					text += part.value;
				} else if (part instanceof vscode.LanguageModelToolCallPart) {
					toolCalls.push(part);
				}
			}
		} catch (err) {
			if (err instanceof vscode.CancellationError || token.isCancellationRequested) {
				return finish('failed', lastText, 'cancelado');
			}
			return finish('failed', lastText, `erro do modelo: ${err instanceof Error ? err.message : String(err)}`);
		}

		if (text) {
			lastText = text;
		}
		if (toolCalls.length === 0) {
			return finish('done', lastText);
		}
		toolCallCount += toolCalls.length;

		const assistantParts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart> = [];
		if (text) {
			assistantParts.push(new vscode.LanguageModelTextPart(text));
		}
		assistantParts.push(...toolCalls.map(tc => new vscode.LanguageModelToolCallPart(tc.callId, tc.name, tc.input)));
		messages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));

		const results: vscode.LanguageModelToolResultPart[] = [];
		for (const tc of toolCalls) {
			if (token.isCancellationRequested) {
				return finish('failed', lastText, 'cancelado');
			}
			// The model only saw the allowed tools, but a call to one it was not
			// offered still arrives now and then; a read-only sub-agent that could
			// write through it would not be read-only.
			if (!allowed.has(tc.name)) {
				results.push(new vscode.LanguageModelToolResultPart(tc.callId, [new vscode.LanguageModelTextPart(
					`A ferramenta ${tc.name} não está disponível para este sub-agente. Use apenas: ${[...allowed].join(', ')}.`,
				)]));
				continue;
			}
			results.push((await runAgentTool(tc, env, token)).part);
		}
		messages.push(vscode.LanguageModelChatMessage.User(results));
	}

	const handoff = await requestHandoff(messages, model, tag, token);
	return finish('failed', handoff || lastText, `esgotou os ${MAX_SUBAGENT_TURNS} turnos sem terminar`);
}

function isAllowed(definition: ISubagentDefinition, toolName: string): boolean {
	if (definition.readonly && !READ_ONLY_TOOL_NAMES.has(toolName)) {
		return false;
	}
	return !definition.tools || definition.tools.includes(toolName);
}

/** The model a definition names, or the main agent's when it names none that is available. */
async function resolveModel(definition: ISubagentDefinition, inherited: vscode.LanguageModelChat): Promise<vscode.LanguageModelChat> {
	if (definition.model === 'inherit' || definition.model === inherited.id) {
		return inherited;
	}
	// An exact id first, then a family — preferring the main agent's vendor — so
	// the short names Claude Code definitions use (`sonnet`, `haiku`) resolve too.
	const wanted = definition.model;
	const candidates = [
		...await vscode.lm.selectChatModels({ id: wanted }),
		...await vscode.lm.selectChatModels({ vendor: inherited.vendor, family: wanted }),
		...await vscode.lm.selectChatModels({ vendor: inherited.vendor, family: `claude-${wanted}` }),
		...await vscode.lm.selectChatModels({ family: wanted }),
	];
	if (candidates.length > 0) {
		return candidates[0];
	}
	log(`subagent[${definition.name}]: modelo ${definition.model} indisponível; usando ${inherited.id}`);
	return inherited;
}

function buildSystemPrompt(definition: ISubagentDefinition, projectContext: string): string {
	const sections = [
		definition.prompt,
		'You do NOT see the conversation that led to this task — everything you know is in the task itself and in what you find. Do not ask questions; nobody will answer them. Decide, act, and report.',
		`You have at most ${MAX_SUBAGENT_TURNS} tool-calling turns and cannot be resumed after that, so spend them on the task itself, not on surveying the workspace. ` +
		'Batch independent tool calls into a SINGLE turn — reading four files costs one turn, not four. Sequence calls only when one needs the previous result.',
	];
	if (projectContext) {
		sections.push(projectContext);
	}
	return sections.join('\n\n');
}

/**
 * Last call of an exhausted sub-agent: it works in its own context, and that
 * context dies with it, so without this everything it read and ran is lost and
 * the caller only learns that it failed. One tool-less request turns the dead
 * end into a handoff the parent can act on.
 */
async function requestHandoff(
	messages: readonly vscode.LanguageModelChatMessage[],
	model: vscode.LanguageModelChat,
	tag: string,
	token: vscode.CancellationToken,
): Promise<string> {
	if (token.isCancellationRequested) {
		return '';
	}
	const wrapUp = [
		...messages,
		vscode.LanguageModelChatMessage.User(
			'Your turn budget is exhausted and you must stop now. Do NOT call any tools. ' +
			'Write a handoff report so someone else can pick this up cold:\n' +
			'1. What you did and what you changed (exact file paths).\n' +
			'2. What you found, concretely — symbols, line numbers, commands you ran and their outcome.\n' +
			'3. What is left to finish the task, as concrete next steps.\n' +
			'Be specific and factual. Do not claim anything you did not verify.',
		),
	];
	try {
		const response = await model.sendRequest(wrapUp, {}, token);
		let text = '';
		for await (const part of response.stream) {
			if (part instanceof vscode.LanguageModelTextPart) {
				text += part.value;
			}
		}
		return text.trim();
	} catch (err) {
		log(`${tag}: handoff falhou: ${err instanceof Error ? err.message : String(err)}`);
		return '';
	}
}

/** Runs at most `max` of the functions handed to it at a time, in arrival order. */
function createLimiter(max: number): <T>(fn: () => Promise<T>) => Promise<T> {
	let active = 0;
	const waiting: Array<() => void> = [];
	return async fn => {
		// A finishing run hands its slot straight to the next in line, so a caller
		// arriving in between cannot take it and push the count past `max`.
		if (active >= max) {
			await new Promise<void>(resolve => waiting.push(resolve));
		} else {
			active++;
		}
		try {
			return await fn();
		} finally {
			const next = waiting.shift();
			if (next) {
				next();
			} else {
				active--;
			}
		}
	};
}

function elapsedSeconds(startedAt: number): number {
	return Math.round((Date.now() - startedAt) / 1000);
}

function truncate(text: string, max: number): string {
	return text.length <= max ? text : text.slice(0, max - 1) + '…';
}
