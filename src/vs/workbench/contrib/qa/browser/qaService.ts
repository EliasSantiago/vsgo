/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { resolveAiFeatureModel } from '../../chat/common/aiFeatureModel.js';
import { ChatMessageRole, getTextResponseFromStream, IChatMessage, ILanguageModelsService } from '../../chat/common/languageModels.js';
import {
	ICaptureResult,
	IQaAssertion,
	IQaConfiguration,
	IQaRun,
	IQaRunOpts,
	IQaService,
	IQaStep,
	IQaToolCall,
	QA_CONFIG_SECTION,
	QA_SUBDIR,
	QaVerdict,
} from '../common/qa.js';
import { IVsgoWorkspaceService } from '../../vsgo/common/vsgoWorkspace.js';
import { IQaDriver } from './qaDriver.js';

/** Folder under `.vsgo/qa` holding one sub-folder per run. */
const RUNS_SUBDIR = 'runs';

const SYSTEM_PROMPT = `You are a QA test agent driving a real browser. You receive a test intent in natural language and execute it step by step.

Each turn:
1. Inspect the current page state (URL, screenshot, list of interactive elements with numeric IDs).
2. Emit exactly ONE tool call as JSON: { "thought": "...", "action": { "tool": "<name>", "args": { ... } } }
3. Wait for the observation, then continue.

Available tools:
- navigate({ url })
- click({ targetId: <number from elements list> })
- type({ targetId: <number>, text })
- pressKey({ key })
- scroll({ direction: "up"|"down", amount })
- waitFor({ condition: "idle"|"load" | { text } | { selector }, timeoutMs })
- getVisibleText()
- assert({ condition: <description>, passed: <boolean>, evidence: <screenshot|text> })
- finish({ verdict: "pass"|"fail", summary: "<one paragraph>" })

Rules:
- Click by targetId from the elements list — never invent selectors.
- Use \`assert\` to record explicit verifications (the report will show them).
- Call \`finish('fail', why)\` if you discover a bug — do NOT try to work around it.
- Terminate early once the intent is verified. Do not exceed the budget.
- Output ONLY the JSON object on each turn, no prose, no markdown fences.`;

interface IAgentDecision {
	thought: string;
	action: IQaToolCall;
}

export class QaService extends Disposable implements IQaService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeRuns = this._register(new Emitter<void>());
	readonly onDidChangeRuns = this._onDidChangeRuns.event;

	private readonly _onDidChangeRun = this._register(new Emitter<string>());
	readonly onDidChangeRun = this._onDidChangeRun.event;

	private readonly _runs = new Map<string, IQaRun>();
	private readonly _activeRuns = new Map<string, CancellationTokenSource>();

	constructor(
		@IQaDriver private readonly driver: IQaDriver,
		@ILanguageModelsService private readonly languageModelsService: ILanguageModelsService,
		@IFileService private readonly fileService: IFileService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@INotificationService private readonly notificationService: INotificationService,
		@ILogService private readonly logService: ILogService,
		@IVsgoWorkspaceService private readonly vsgoWorkspaceService: IVsgoWorkspaceService,
	) {
		super();
	}

	getRuns(): readonly IQaRun[] {
		return Array.from(this._runs.values()).sort((a, b) => b.startedAt - a.startedAt);
	}

	getRun(id: string): IQaRun | undefined {
		return this._runs.get(id);
	}

	getRunsDirectory(): URI | undefined {
		const qaDir = this.vsgoWorkspaceService.getArtifactsRoot(QA_SUBDIR);
		return qaDir ? URI.joinPath(qaDir, RUNS_SUBDIR) : undefined;
	}

	async openLatestReport(): Promise<URI | undefined> {
		const runs = this.getRuns();
		if (runs.length === 0) { return undefined; }
		const latest = runs[0];
		return latest.artifacts.reportPath ? URI.file(latest.artifacts.reportPath) : undefined;
	}

	async startRun(prompt: string, opts?: IQaRunOpts): Promise<string> {
		const config = this.getConfig();
		const runId = generateUuid();
		const startUrl = opts?.startUrl ?? config.defaultStartUrl;
		const run: IQaRun = {
			id: runId,
			prompt,
			startUrl: startUrl || undefined,
			startedAt: Date.now(),
			status: 'running',
			steps: [],
			assertions: [],
			artifacts: {},
		};
		this._runs.set(runId, run);
		this._onDidChangeRuns.fire();

		const cts = new CancellationTokenSource();
		this._activeRuns.set(runId, cts);

		// run asynchronously
		this.executeRun(run, { ...opts, startUrl }, config, cts.token).catch(err => {
			this.logService.error('[qa] run failed', err);
			run.status = 'error';
			run.summary = String(err?.message ?? err);
			this.finalizeRun(run, config);
		});

		return runId;
	}

	cancelRun(runId: string): void {
		this._activeRuns.get(runId)?.cancel();
	}

	private async executeRun(run: IQaRun, opts: IQaRunOpts, config: IQaConfiguration, token: CancellationToken): Promise<void> {
		const maxSteps = opts.maxSteps ?? config.maxSteps;
		const timeoutMs = opts.timeoutMs ?? config.timeoutMs;
		const deadline = Date.now() + timeoutMs;

		const modelId = await this.pickModel(config);
		if (!modelId) {
			throw new Error(localize('qa.noModel', "Nenhum modelo de IA está disponível. Configure um provedor de IA primeiro."));
		}
		run.modelId = modelId;

		try {
			// Opening the browser view crosses into the shared process; if that never answers
			// the run would sit on "step 0" forever. Time-box it so the outer catch surfaces a
			// notification instead.
			await raceLaunch(this.driver.launch(), 30000);
			if (opts.startUrl) {
				await this.driver.navigate(opts.startUrl);
			}

			const messages: IChatMessage[] = [
				{ role: ChatMessageRole.System, content: [{ type: 'text', value: SYSTEM_PROMPT }] },
				{ role: ChatMessageRole.User, content: [{ type: 'text', value: `Test intent:\n${run.prompt}\n\nBudget: ${maxSteps} steps.` }] },
			];

			for (let i = 0; i < maxSteps; i++) {
				if (token.isCancellationRequested) {
					run.status = 'cancelled';
					run.summary = 'Cancelled by user';
					return;
				}
				if (Date.now() > deadline) {
					run.status = 'failed';
					run.summary = `Timeout after ${timeoutMs}ms`;
					return;
				}

				const state = await this.driver.captureState();
				run.currentScreenshotRel = await this.persistScreenshot(run, i, state.screenshotDataBase64);

				messages.push({
					role: ChatMessageRole.User,
					content: [{
						type: 'text',
						value: `Step ${i + 1}/${maxSteps}\nURL: ${state.url}\nTitle: ${state.title}\nInteractive elements:\n${JSON.stringify(state.elements, null, 2)}\n\nWhat is your next action? Respond with JSON only.`,
					}],
				});

				const decision = await this.askLLM(modelId, messages, token);
				if (!decision) {
					run.status = 'error';
					run.summary = 'Agent returned unparseable response';
					return;
				}

				const step: IQaStep = {
					index: i,
					thought: decision.thought,
					action: decision.action,
					observation: { url: state.url, screenshotRel: run.currentScreenshotRel, ok: true },
					durationMs: 0,
				};

				const t0 = Date.now();
				try {
					const finished = await this.executeAction(run, decision.action, state, opts, config);
					if (finished) {
						run.steps.push({ ...step, durationMs: Date.now() - t0 });
						run.currentStepIndex = i;
						this._onDidChangeRun.fire(run.id);
						return;
					}
				} catch (err) {
					const obs = { ...step.observation, ok: false, error: String((err as Error)?.message ?? err) };
					run.steps.push({ ...step, observation: obs, durationMs: Date.now() - t0 });
					run.currentStepIndex = i;
					this._onDidChangeRun.fire(run.id);
					messages.push({
						role: ChatMessageRole.User,
						content: [{ type: 'text', value: `Action failed: ${obs.error}` }],
					});
					continue;
				}

				run.steps.push({ ...step, durationMs: Date.now() - t0 });
				run.currentStepIndex = i;
				this._onDidChangeRun.fire(run.id);

				messages.push({
					role: ChatMessageRole.Assistant,
					content: [{ type: 'text', value: JSON.stringify(decision) }],
				});
			}

			if (run.status === 'running') {
				run.status = 'failed';
				run.summary = `Max steps (${maxSteps}) reached without finish`;
			}
		} finally {
			try { await this.driver.close(); } catch { /* ignore */ }
			run.endedAt = Date.now();
			this._activeRuns.delete(run.id);
			await this.persistRun(run, config);
			this.finalizeRun(run, config);
		}
	}

	private async executeAction(run: IQaRun, action: IQaToolCall, state: ICaptureResult, _opts: IQaRunOpts, _config: IQaConfiguration): Promise<boolean> {
		switch (action.tool) {
			case 'navigate':
				await this.driver.navigate(String(action.args.url));
				return false;
			case 'click':
				await this.driver.click(Number(action.args.targetId));
				return false;
			case 'type':
				await this.driver.type(Number(action.args.targetId), String(action.args.text));
				return false;
			case 'pressKey':
				await this.driver.pressKey(String(action.args.key));
				return false;
			case 'scroll':
				await this.driver.scroll(action.args.direction as 'up' | 'down', Number(action.args.amount));
				return false;
			case 'waitFor': {
				const cond = action.args.condition as 'idle' | 'load' | { text: string } | { selector: string };
				const timeoutMs = Number(action.args.timeoutMs ?? 5000);
				await this.driver.waitFor(cond, timeoutMs);
				return false;
			}
			case 'getVisibleText':
				await this.driver.getVisibleText();
				return false;
			case 'assert': {
				const assertion: IQaAssertion = {
					text: String(action.args.condition ?? action.args.text ?? ''),
					passed: Boolean(action.args.passed),
					evidenceScreenshotRel: state ? run.currentScreenshotRel : undefined,
				};
				run.assertions.push(assertion);
				return false;
			}
			case 'finish': {
				const verdict = (String(action.args.verdict) === 'pass' ? 'pass' : 'fail') as QaVerdict;
				run.verdict = verdict;
				run.summary = String(action.args.summary ?? '');
				run.status = verdict === 'pass' ? 'passed' : 'failed';
				return true;
			}
			default:
				throw new Error(`Unknown tool: ${action.tool}`);
		}
	}

	private async askLLM(modelId: string, messages: IChatMessage[], token: CancellationToken): Promise<IAgentDecision | undefined> {
		try {
			const response = await this.languageModelsService.sendChatRequest(modelId, undefined, messages, {}, token);
			const text = await getTextResponseFromStream(response);
			const cleaned = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
			const start = cleaned.indexOf('{');
			const end = cleaned.lastIndexOf('}');
			if (start < 0 || end <= start) { return undefined; }
			const obj = JSON.parse(cleaned.slice(start, end + 1));
			if (!obj || !obj.action || typeof obj.action.tool !== 'string') { return undefined; }
			return {
				thought: String(obj.thought ?? ''),
				action: { tool: obj.action.tool, args: obj.action.args ?? {} },
			};
		} catch (err) {
			this.logService.warn('[qa] LLM call failed', err);
			return undefined;
		}
	}

	private async pickModel(config: IQaConfiguration): Promise<string | undefined> {
		const resolved = await resolveAiFeatureModel(this.languageModelsService, { vendor: config.modelVendor, id: config.modelId });
		if (!resolved) {
			return undefined;
		}
		if (resolved.isSubstitute) {
			const name = this.languageModelsService.lookupLanguageModel(resolved.identifier)?.name ?? resolved.identifier;
			this.notificationService.warn(localize('qa.modelSubstituted', "O modelo configurado para o QA não está disponível. Usando {0}.", name));
		}
		return resolved.identifier;
	}

	private getConfig(): IQaConfiguration {
		const c = this.configurationService.getValue<Partial<IQaConfiguration>>(QA_CONFIG_SECTION) || {};
		return {
			defaultStartUrl: typeof c.defaultStartUrl === 'string' ? c.defaultStartUrl : '',
			maxSteps: typeof c.maxSteps === 'number' ? Math.max(1, c.maxSteps) : 30,
			timeoutMs: typeof c.timeoutMs === 'number' ? Math.max(1000, c.timeoutMs) : 300000,
			modelVendor: typeof c.modelVendor === 'string' ? c.modelVendor : '',
			modelId: typeof c.modelId === 'string' ? c.modelId : '',
			persistRuns: c.persistRuns !== false,
			runRetention: typeof c.runRetention === 'number' ? Math.max(1, c.runRetention) : 20,
			requireConfirmationForDestructive: c.requireConfirmationForDestructive !== false,
		};
	}

	private runFolderName(run: IQaRun): string {
		const stamp = new Date(run.startedAt).toISOString().replace(/[:.]/g, '-');
		const slug = run.prompt.slice(0, 40).replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
		return `${stamp}-${slug || 'run'}`;
	}

	private async persistScreenshot(run: IQaRun, stepIndex: number, dataBase64: string): Promise<string | undefined> {
		const name = `step-${String(stepIndex).padStart(3, '0')}.png`;
		try {
			const qaDir = await this.vsgoWorkspaceService.ensureArtifactsRoot(QA_SUBDIR);
			if (!qaDir) { return undefined; }
			const folder = URI.joinPath(qaDir, RUNS_SUBDIR, this.runFolderName(run), 'screenshots');
			const uri = URI.joinPath(folder, name);
			await this.fileService.createFolder(folder);
			await this.fileService.writeFile(uri, VSBuffer.wrap(base64ToBytes(dataBase64)));
			return `screenshots/${name}`;
		} catch (err) {
			this.logService.warn('[qa] persistScreenshot failed', err);
			return undefined;
		}
	}

	private async persistRun(run: IQaRun, config: IQaConfiguration): Promise<void> {
		if (!config.persistRuns) { return; }
		try {
			const qaDir = await this.vsgoWorkspaceService.ensureArtifactsRoot(QA_SUBDIR);
			if (!qaDir) { return; }
			const runsDir = URI.joinPath(qaDir, RUNS_SUBDIR);
			const folder = URI.joinPath(runsDir, this.runFolderName(run));
			await this.fileService.createFolder(folder);

			const reportUri = URI.joinPath(folder, 'report.json');
			await this.fileService.writeFile(reportUri, VSBuffer.fromString(JSON.stringify(run, null, 2)));
			run.artifacts = { ...run.artifacts, reportPath: reportUri.fsPath };

			const transcriptUri = URI.joinPath(folder, 'transcript.md');
			await this.fileService.writeFile(transcriptUri, VSBuffer.fromString(this.buildTranscript(run)));
			run.artifacts = { ...run.artifacts, transcriptPath: transcriptUri.fsPath };

			const latestUri = URI.joinPath(qaDir, 'latest.json');
			await this.fileService.writeFile(latestUri, VSBuffer.fromString(JSON.stringify(run, null, 2)));

			const junitUri = URI.joinPath(qaDir, 'latest.junit.xml');
			await this.fileService.writeFile(junitUri, VSBuffer.fromString(this.buildJUnit(run)));
			run.artifacts = { ...run.artifacts, junitPath: junitUri.fsPath };

			await this.pruneRuns(runsDir, config.runRetention);
		} catch (err) {
			this.logService.warn('[qa] persistRun failed', err);
		}
	}

	private buildTranscript(run: IQaRun): string {
		const lines: string[] = [];
		lines.push(`# QA Run ${run.id}`);
		lines.push('');
		lines.push(`- **Prompt:** ${run.prompt}`);
		lines.push(`- **Status:** ${run.status}${run.verdict ? ` (${run.verdict})` : ''}`);
		lines.push(`- **Started:** ${new Date(run.startedAt).toISOString()}`);
		if (run.endedAt) { lines.push(`- **Ended:** ${new Date(run.endedAt).toISOString()}`); }
		if (run.modelId) { lines.push(`- **Model:** ${run.modelId}`); }
		if (run.summary) { lines.push(`- **Summary:** ${run.summary}`); }
		lines.push('');
		lines.push('## Steps');
		lines.push('');
		for (const s of run.steps) {
			lines.push(`### Step ${s.index + 1} — \`${s.action.tool}\``);
			if (s.thought) { lines.push(`> ${s.thought}`); }
			lines.push('```json');
			lines.push(JSON.stringify(s.action.args, null, 2));
			lines.push('```');
			if (s.observation.url) { lines.push(`URL: \`${s.observation.url}\``); }
			if (s.observation.screenshotRel) { lines.push(`![step-${s.index}](${s.observation.screenshotRel})`); }
			if (!s.observation.ok) { lines.push(`**Error:** ${s.observation.error}`); }
			lines.push('');
		}
		if (run.assertions.length > 0) {
			lines.push('## Assertions');
			lines.push('');
			for (const a of run.assertions) {
				lines.push(`- ${a.passed ? '✓' : '✗'} ${a.text}`);
			}
		}
		return lines.join('\n');
	}

	private buildJUnit(run: IQaRun): string {
		const passed = run.status === 'passed';
		const time = ((run.endedAt ?? Date.now()) - run.startedAt) / 1000;
		const testName = escapeXml(run.prompt.slice(0, 100));
		const failure = !passed
			? `<failure message="${escapeXml(run.summary ?? run.status)}">${escapeXml(run.summary ?? '')}</failure>`
			: '';
		return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="vsgo-qa" tests="1" failures="${passed ? 0 : 1}" time="${time}">
  <testsuite name="QA Run ${escapeXml(run.id)}" tests="1" failures="${passed ? 0 : 1}" time="${time}">
    <testcase classname="vsgo.qa" name="${testName}" time="${time}">${failure}</testcase>
  </testsuite>
</testsuites>
`;
	}

	private async pruneRuns(runsDir: URI, retention: number): Promise<void> {
		try {
			const stat = await this.fileService.resolve(runsDir);
			const dirs = (stat.children ?? [])
				.filter(c => c.isDirectory)
				.sort((a, b) => a.name < b.name ? 1 : -1);
			for (const c of dirs.slice(retention)) {
				await this.fileService.del(c.resource, { useTrash: false, recursive: true });
			}
		} catch (err) {
			this.logService.warn('[qa] pruneRuns failed', err);
		}
	}

	private finalizeRun(run: IQaRun, _config: IQaConfiguration): void {
		this._onDidChangeRun.fire(run.id);
		this._onDidChangeRuns.fire();
		if (run.status === 'error') {
			this.notificationService.error(localize('qa.error', "QA run failed: {0}", run.summary ?? 'unknown error'));
		}
	}
}

async function raceLaunch<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`Browser failed to launch within ${timeoutMs}ms (Playwright/Chromium not available?).`)), timeoutMs);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		if (timer) { clearTimeout(timer); }
	}
}

function escapeXml(s: string): string {
	return s.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', '\'': '&apos;' }[c]!));
}

function base64ToBytes(b64: string): Uint8Array {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) { out[i] = bin.charCodeAt(i); }
	return out;
}
