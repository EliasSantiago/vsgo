/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { log } from '../logger.js';
import { Plan, PlanStep, StepResult } from './planSchema.js';

/**
 * Turn budget for one sub-agent. It costs the parent a single turn, so it can
 * afford to be generous — and unlike the parent, a sub-agent that runs out
 * cannot be resumed, which makes a tight budget expensive rather than safe.
 */
const MAX_SUBAGENT_TURNS = 20;

export const RUN_SUBAGENT_TOOL_NAME = 'agent_run_subagent';

/**
 * Tool the main agent can call to delegate a single focused task to a sub-agent.
 * Unlike {@link SUBMIT_PLAN_TOOL}, this dispatches one self-contained task on
 * demand and returns its summary, rather than a whole DAG submitted up front.
 */
export const RUN_SUBAGENT_TOOL: vscode.LanguageModelChatTool = {
	name: RUN_SUBAGENT_TOOL_NAME,
	description:
		'Delegate a single focused, self-contained task to a sub-agent that runs with the same file and shell tools you have. The sub-agent works independently in its own context (it does NOT see the conversation history) and returns a short summary of what it did. Use this to offload a well-scoped piece of work — e.g. "investigate why test X fails and fix it" or "refactor module Y" — so your own context stays focused. Always provide a COMPLETE, self-contained task description including the relevant files, goals, and acceptance criteria. For multiple independent tasks that can run in parallel, prefer agent_submit_plan instead. Do NOT use this for trivial single-file edits you can do inline.',
	inputSchema: {
		type: 'object',
		properties: {
			task: {
				type: 'string',
				description: 'The complete, self-contained task for the sub-agent. Include all context it needs: files, goals, and acceptance criteria.',
				minLength: 8,
			},
			context: {
				type: 'string',
				description: 'Optional extra context or constraints the sub-agent should know (e.g. relevant file paths, conventions, prior findings).',
			},
		},
		required: ['task'],
	},
};

export interface SubagentContext {
	readonly model: vscode.LanguageModelChat;
	readonly tools: readonly vscode.LanguageModelChatTool[];
	readonly globalContext: string;
}

/**
 * Run a single sub-agent for an ad-hoc task that is not part of a plan. Reuses
 * {@link runSubagent} by wrapping the task in a synthetic one-step plan.
 */
export async function runStandaloneSubagent(
	task: string,
	extraContext: string,
	ctx: SubagentContext,
	token: vscode.CancellationToken,
): Promise<StepResult> {
	const step: PlanStep = { id: 'subagent', description: task, dependsOn: [], files: [] };
	const plan: Plan = { steps: [step] };
	const mergedCtx: SubagentContext = extraContext
		? { ...ctx, globalContext: [ctx.globalContext, extraContext].filter(Boolean).join('\n\n') }
		: ctx;
	return runSubagent(step, plan, new Map(), mergedCtx, token);
}

export async function runSubagent(
	step: PlanStep,
	plan: Plan,
	priorResults: ReadonlyMap<string, StepResult>,
	ctx: SubagentContext,
	token: vscode.CancellationToken,
): Promise<StepResult> {
	const systemPrompt = buildSubagentSystemPrompt(step, plan, priorResults, ctx.globalContext);
	const messages: vscode.LanguageModelChatMessage[] = [
		vscode.LanguageModelChatMessage.User(systemPrompt),
		vscode.LanguageModelChatMessage.User(`Execute this step:\n\n${step.description}`),
	];

	let lastAssistantText = '';
	let toolCallCount = 0;
	const startedAt = Date.now();

	for (let turn = 0; turn < MAX_SUBAGENT_TURNS; turn++) {
		if (token.isCancellationRequested) {
			return { id: step.id, status: 'failed', summary: '', error: 'Cancelled' };
		}

		const toolCalls: vscode.LanguageModelToolCallPart[] = [];
		let assistantText = '';

		try {
			const response = await ctx.model.sendRequest(messages, { tools: [...ctx.tools], toolMode: vscode.LanguageModelChatToolMode.Auto }, token);
			for await (const part of response.stream) {
				if (token.isCancellationRequested) {
					return { id: step.id, status: 'failed', summary: '', error: 'Cancelled' };
				}
				if (part instanceof vscode.LanguageModelTextPart) {
					assistantText += part.value;
				} else if (part instanceof vscode.LanguageModelToolCallPart) {
					toolCalls.push(part);
				}
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			log(`subagent[${step.id}]: model error: ${message}`);
			return { id: step.id, status: 'failed', summary: lastAssistantText, error: message };
		}

		if (assistantText) {
			lastAssistantText = assistantText;
		}

		if (toolCalls.length === 0) {
			log(`subagent[${step.id}]: concluído — ${turn + 1}/${MAX_SUBAGENT_TURNS} turnos, ${toolCallCount} tool calls, ${elapsedSeconds(startedAt)}s`);
			return {
				id: step.id,
				status: 'done',
				summary: summarize(lastAssistantText, step),
			};
		}

		toolCallCount += toolCalls.length;

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
				return { id: step.id, status: 'failed', summary: '', error: 'Cancelled' };
			}
			try {
				const result = await vscode.lm.invokeTool(tc.name, { input: tc.input, toolInvocationToken: undefined }, token);
				resultParts.push(new vscode.LanguageModelToolResultPart(tc.callId, result.content as Array<vscode.LanguageModelTextPart | vscode.LanguageModelPromptTsxPart>));
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				resultParts.push(new vscode.LanguageModelToolResultPart(tc.callId, [new vscode.LanguageModelTextPart(`Tool error: ${message}`)]));
			}
		}
		messages.push(vscode.LanguageModelChatMessage.User(resultParts));
	}

	log(`subagent[${step.id}]: orçamento esgotado — ${MAX_SUBAGENT_TURNS} turnos, ${toolCallCount} tool calls, ${elapsedSeconds(startedAt)}s`);
	const handoff = await requestHandoff(messages, ctx, step, token);
	return {
		id: step.id,
		status: 'failed',
		summary: handoff || lastAssistantText,
		error: `Sub-agent exhausted ${MAX_SUBAGENT_TURNS} turns without finishing.`,
	};
}

/**
 * Last call of an exhausted sub-agent: it works in its own context, and that
 * context dies with it, so without this everything it read and ran is lost and
 * the caller only learns that it failed. One tool-less request turns the dead
 * end into a handoff the parent — or a later sub-agent — can act on.
 */
async function requestHandoff(
	messages: readonly vscode.LanguageModelChatMessage[],
	ctx: SubagentContext,
	step: PlanStep,
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
		const response = await ctx.model.sendRequest(wrapUp, {}, token);
		let text = '';
		for await (const part of response.stream) {
			if (part instanceof vscode.LanguageModelTextPart) {
				text += part.value;
			}
		}
		return text.trim();
	} catch (err) {
		log(`subagent[${step.id}]: handoff falhou: ${err instanceof Error ? err.message : String(err)}`);
		return '';
	}
}

function elapsedSeconds(startedAt: number): number {
	return Math.round((Date.now() - startedAt) / 1000);
}

function buildSubagentSystemPrompt(step: PlanStep, plan: Plan, priorResults: ReadonlyMap<string, StepResult>, globalContext: string): string {
	const sections: string[] = [
		'You are a focused sub-agent executing one step of a parallel plan.',
		'Your task is narrowly scoped — do exactly what the step requires and nothing else.',
		'Use the file and shell tools available. Do not propose further plans; just execute.',
		'When the step is complete, respond with a short summary (1-3 sentences) and stop.',
		`You have at most ${MAX_SUBAGENT_TURNS} tool-calling turns and cannot be resumed after that, so spend them on the task itself, not on surveying the workspace. ` +
		'Batch independent tool calls into a SINGLE turn — reading four files costs one turn, not four. Sequence calls only when one needs the previous result.',
	];

	if (step.files.length > 0) {
		sections.push(`Files in scope for this step: ${step.files.map(f => `\`${f}\``).join(', ')}.`);
	}

	const otherSteps = plan.steps.filter(s => s.id !== step.id);
	if (otherSteps.length > 0) {
		const lines = otherSteps.map(s => {
			const r = priorResults.get(s.id);
			const mark = r ? `[${r.status}]` : '[pending]';
			return `- ${s.id} ${mark}: ${s.description}`;
		});
		sections.push('Other steps in the same plan (for context — do NOT do their work):\n' + lines.join('\n'));
	}

	const completed = [...priorResults.values()].filter(r => r.status === 'done' && r.summary);
	if (completed.length > 0) {
		const summaries = completed.map(r => `- ${r.id}: ${r.summary}`).join('\n');
		sections.push('Results of dependencies you can rely on:\n' + summaries);
	}

	if (globalContext) {
		sections.push(globalContext);
	}

	return sections.join('\n\n');
}

function summarize(text: string, step: PlanStep): string {
	const trimmed = text.trim();
	if (!trimmed) {
		return `Completed: ${step.description.slice(0, 80)}`;
	}
	if (trimmed.length <= 240) {
		return trimmed;
	}
	const firstPara = trimmed.split(/\n\s*\n/)[0];
	if (firstPara.length <= 240) {
		return firstPara;
	}
	return firstPara.slice(0, 237) + '...';
}
