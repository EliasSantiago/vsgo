/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { log } from '../logger.js';
import { Plan, PlanRunResult, StepResult, StepStatus } from './planSchema.js';
import { runSubagent, SubagentContext } from './subagent.js';

export interface PlanRunnerOptions {
	readonly stream: vscode.ChatResponseStream;
	readonly subagentCtx: SubagentContext;
	readonly maxConcurrency?: number;
}

const DEFAULT_MAX_CONCURRENCY = 4;

export class PlanRunner {

	async run(plan: Plan, options: PlanRunnerOptions, token: vscode.CancellationToken): Promise<PlanRunResult> {
		const maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
		const status = new Map<string, StepStatus>();
		const results = new Map<string, StepResult>();
		const conflictLocks = new Map<string, Promise<void>>();

		for (const s of plan.steps) {
			status.set(s.id, 'pending');
		}

		options.stream.markdown(renderPlanHeader(plan));

		const inFlight = new Map<string, Promise<void>>();

		const dispatch = async (stepId: string): Promise<void> => {
			const step = plan.steps.find(s => s.id === stepId)!;
			status.set(step.id, 'running');
			options.stream.markdown(`\n\n▶️ **${step.id}** — ${truncate(step.description, 140)}\n`);

			const fileGate = acquireFileLocks(step.files, conflictLocks);
			await fileGate.acquired;
			try {
				const result = await runSubagent(step, plan, results, options.subagentCtx, token);
				results.set(step.id, result);
				status.set(step.id, result.status);
				if (result.status === 'done') {
					options.stream.markdown(`\n✅ **${step.id}** — ${truncate(result.summary, 200)}\n`);
				} else {
					options.stream.markdown(`\n❌ **${step.id}** — ${result.error ?? 'failed'}\n`);
				}
			} finally {
				fileGate.release();
			}
		};

		while (true) {
			if (token.isCancellationRequested) {
				break;
			}

			cascadeFailures(plan, status, results);

			const ready = plan.steps.filter(s =>
				status.get(s.id) === 'pending' &&
				s.dependsOn.every(d => status.get(d) === 'done') &&
				!inFlight.has(s.id),
			);

			while (ready.length > 0 && inFlight.size < maxConcurrency) {
				const next = ready.shift()!;
				const p = dispatch(next.id).finally(() => inFlight.delete(next.id));
				inFlight.set(next.id, p);
			}

			if (inFlight.size === 0) {
				const stillPending = plan.steps.some(s => status.get(s.id) === 'pending');
				if (!stillPending) {
					break;
				}
				log('planRunner: no ready steps and nothing in flight — aborting');
				break;
			}

			await Promise.race(inFlight.values());
		}

		const orderedResults: StepResult[] = plan.steps.map(s => {
			const existing = results.get(s.id);
			if (existing) {
				return existing;
			}
			return { id: s.id, status: status.get(s.id) ?? 'failed', summary: '', error: 'Not executed' };
		});
		const success = orderedResults.every(r => r.status === 'done');
		return { success, results: orderedResults };
	}
}

interface FileGate {
	readonly acquired: Promise<void>;
	readonly release: () => void;
}

function acquireFileLocks(files: readonly string[], locks: Map<string, Promise<void>>): FileGate {
	if (files.length === 0) {
		return { acquired: Promise.resolve(), release: () => { /* noop */ } };
	}
	const existing = files.map(f => locks.get(f)).filter((p): p is Promise<void> => !!p);
	const acquired = existing.length === 0 ? Promise.resolve() : Promise.all(existing).then(() => undefined);
	let resolveRelease: () => void = () => { /* placeholder */ };
	const releasePromise = new Promise<void>(r => { resolveRelease = r; });
	for (const f of files) {
		locks.set(f, releasePromise);
	}
	return {
		acquired,
		release: () => {
			for (const f of files) {
				if (locks.get(f) === releasePromise) {
					locks.delete(f);
				}
			}
			resolveRelease();
		},
	};
}

function cascadeFailures(plan: Plan, status: Map<string, StepStatus>, results: Map<string, StepResult>): void {
	let changed = true;
	while (changed) {
		changed = false;
		for (const s of plan.steps) {
			if (status.get(s.id) !== 'pending') {
				continue;
			}
			const blockedBy = s.dependsOn.find(d => {
				const st = status.get(d);
				return st === 'failed' || st === 'skipped';
			});
			if (blockedBy) {
				status.set(s.id, 'skipped');
				results.set(s.id, { id: s.id, status: 'skipped', summary: '', error: `Skipped because dependency "${blockedBy}" did not complete.` });
				changed = true;
			}
		}
	}
}

function renderPlanHeader(plan: Plan): string {
	const lines: string[] = ['\n\n### 📋 Parallel plan\n'];
	for (const s of plan.steps) {
		const deps = s.dependsOn.length > 0 ? ` _(after ${s.dependsOn.join(', ')})_` : '';
		lines.push(`- **${s.id}**${deps} — ${truncate(s.description, 120)}`);
	}
	lines.push('');
	return lines.join('\n');
}

function truncate(s: string, n: number): string {
	if (s.length <= n) {
		return s;
	}
	return s.slice(0, n - 1) + '…';
}
