/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export const SUBMIT_PLAN_TOOL_NAME = 'agent_submit_plan';

export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface PlanStep {
	readonly id: string;
	readonly description: string;
	readonly dependsOn: readonly string[];
	readonly files: readonly string[];
}

export interface Plan {
	readonly steps: readonly PlanStep[];
}

export interface StepResult {
	readonly id: string;
	readonly status: StepStatus;
	readonly summary: string;
	readonly error?: string;
}

export interface PlanRunResult {
	readonly success: boolean;
	readonly results: readonly StepResult[];
}

export const SUBMIT_PLAN_TOOL: vscode.LanguageModelChatTool = {
	name: SUBMIT_PLAN_TOOL_NAME,
	description:
		'Submit a parallel execution plan as a directed acyclic graph (DAG) of steps. Use this tool when the user task has multiple independent sub-tasks that can be executed in parallel by sub-agents. Each step is executed by a focused sub-agent with the same file/shell tools you have. Sub-agents run concurrently when their dependencies are satisfied. Do NOT call this for trivial single-file edits. After submitting the plan, wait for the returned summary before continuing.',
	inputSchema: {
		type: 'object',
		properties: {
			steps: {
				type: 'array',
				minItems: 1,
				maxItems: 16,
				description: 'Ordered list of steps. Each step is dispatched to a sub-agent.',
				items: {
					type: 'object',
					required: ['id', 'description'],
					properties: {
						id: {
							type: 'string',
							description: 'Unique short id within this plan (e.g. "ui", "api", "tests"). Used in dependsOn.',
							pattern: '^[a-z0-9][a-z0-9_-]{0,31}$',
						},
						description: {
							type: 'string',
							description: 'What the sub-agent must accomplish. Be specific about files, behaviors, and acceptance criteria. Self-contained.',
							minLength: 8,
						},
						dependsOn: {
							type: 'array',
							description: 'Ids of steps that must finish before this step starts. Empty array means it runs in the first wave.',
							items: { type: 'string' },
							default: [],
						},
						files: {
							type: 'array',
							description: 'Paths the step is likely to modify. Used for conflict detection between concurrent steps.',
							items: { type: 'string' },
							default: [],
						},
					},
				},
			},
		},
		required: ['steps'],
	},
};

export function parsePlan(raw: unknown): Plan {
	if (!raw || typeof raw !== 'object') {
		throw new Error('Plan input must be an object.');
	}
	const stepsRaw = (raw as { steps?: unknown }).steps;
	if (!Array.isArray(stepsRaw) || stepsRaw.length === 0) {
		throw new Error('Plan must include at least one step.');
	}
	const steps: PlanStep[] = stepsRaw.map((s, idx) => {
		if (!s || typeof s !== 'object') {
			throw new Error(`Step ${idx} is not an object.`);
		}
		const step = s as { id?: unknown; description?: unknown; dependsOn?: unknown; files?: unknown };
		if (typeof step.id !== 'string' || !step.id) {
			throw new Error(`Step ${idx} is missing a valid id.`);
		}
		if (typeof step.description !== 'string' || step.description.trim().length < 8) {
			throw new Error(`Step "${step.id}" needs a description (>= 8 chars).`);
		}
		const dependsOn = Array.isArray(step.dependsOn)
			? step.dependsOn.filter((d): d is string => typeof d === 'string')
			: [];
		const files = Array.isArray(step.files)
			? step.files.filter((f): f is string => typeof f === 'string')
			: [];
		return { id: step.id, description: step.description.trim(), dependsOn, files };
	});

	const ids = new Set<string>();
	for (const s of steps) {
		if (ids.has(s.id)) {
			throw new Error(`Duplicate step id "${s.id}".`);
		}
		ids.add(s.id);
	}
	for (const s of steps) {
		for (const dep of s.dependsOn) {
			if (!ids.has(dep)) {
				throw new Error(`Step "${s.id}" depends on unknown id "${dep}".`);
			}
			if (dep === s.id) {
				throw new Error(`Step "${s.id}" depends on itself.`);
			}
		}
	}
	detectCycle(steps);
	return { steps };
}

function detectCycle(steps: readonly PlanStep[]): void {
	const map = new Map(steps.map(s => [s.id, s]));
	const color = new Map<string, 0 | 1 | 2>();
	function visit(id: string): void {
		const c = color.get(id) ?? 0;
		if (c === 1) {
			throw new Error(`Plan has a dependency cycle through "${id}".`);
		}
		if (c === 2) {
			return;
		}
		color.set(id, 1);
		for (const dep of map.get(id)?.dependsOn ?? []) {
			visit(dep);
		}
		color.set(id, 2);
	}
	for (const s of steps) {
		visit(s.id);
	}
}
