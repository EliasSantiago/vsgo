/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Emitter } from '../../../../base/common/event.js';
import { IExpression } from '../../../../base/common/glob.js';
import { hash } from '../../../../base/common/hash.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ResourceMap } from '../../../../base/common/map.js';
import { URI } from '../../../../base/common/uri.js';
import { IRange } from '../../../../editor/common/core/range.js';
import { IBulkEditService, ResourceTextEdit } from '../../../../editor/browser/services/bulkEditService.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { FileOperationResult, IFileService, toFileOperationResult } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IMarkerData, IMarkerService, MarkerSeverity } from '../../../../platform/markers/common/markers.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { resolveAiFeatureModel } from '../../chat/common/aiFeatureModel.js';
import { classifyLayer, IRuleMatch, layerLabel, pathPriority, reviewPriority, runSecurityRules, SECURITY_ANALYSIS_VERSION, SECURITY_LAYERS, SECURITY_RULES, SecurityLayer } from '../common/securityRules.js';
import { ChatMessageRole, getTextResponseFromStream, IChatMessage, ILanguageModelsService } from '../../chat/common/languageModels.js';
import { getExcludes, IFileQuery, ISearchConfiguration, ISearchService, QueryType } from '../../../services/search/common/search.js';
import {
	FindingSeverity,
	IFinding,
	IFindingFix,
	IScanProgress,
	ISecurityScanConfiguration,
	ISecurityScanReport,
	ISecurityScanService,
	ISerializedFinding,
	SECURITY_SCAN_CONFIG_SECTION,
	SECURITY_SCAN_MARKER_OWNER,
	ScanState,
} from '../common/securityScan.js';
import { IVsgoWorkspaceService } from '../../vsgo/common/vsgoWorkspace.js';

const IGNORED_FINDINGS_STORAGE_KEY = 'securityScan.ignoredFindings';
const REPORT_VERSION = 1;
/** Subdirectory of the vsgo artifacts folder holding scan reports. */
const SECURITY_REPORTS_SUBDIR = 'security';
const LATEST_REPORT_NAME = 'latest.json';
const LATEST_SARIF_NAME = 'latest.sarif';
/** The one of the three a person actually opens. */
const LATEST_MARKDOWN_NAME = 'latest.md';
const SARIF_SCHEMA_URI = 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json';
const SARIF_VERSION = '2.1.0';

const DEFAULT_INCLUDE: string[] = ['**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,rs,java,rb,php,cs,cpp,c,h,hpp,sh,sql,html,vue,svelte}'];
const DEFAULT_EXCLUDE: string[] = ['**/node_modules/**', '**/out/**', '**/dist/**', '**/build/**', '**/.git/**', '**/.next/**', '**/coverage/**'];

/**
 * Model reviews already paid for, keyed by file and by the exact bytes that
 * were reviewed.
 *
 * A second scan of a repository where three files changed should cost three
 * reviews, not the whole tree. Every incremental analyser works this way: hash
 * the input, reuse the verdict when the hash is unchanged. Only the model pass
 * is cached — the rules are cheap and deterministic, so re-running them lets a
 * new rule take effect on the next scan without invalidating anything.
 */
const AI_CACHE_STORAGE_KEY = 'securityScan.aiReviewCache';

/**
 * Files kept in the cache. Large enough for a real repository, bounded so the
 * workspace storage does not grow without end.
 */
const AI_CACHE_MAX_ENTRIES = 4000;

interface IAiCacheEntry {
	/** Hash of the reviewed content, with the analysis version mixed in. */
	readonly hash: string;
	/** Identifier of the model that produced this, so a better model re-reviews. */
	readonly modelId: string;
	readonly findings: ISerializedFinding[];
}

/** Files whose size is asked for at once while the candidate list is built. */
const STAT_BATCH_SIZE = 64;

/** A stage that runs before the layers, so it carries a name but no number. */
function preparingPhase(label: string): { label: string; index: number; total: number } {
	return { label, index: 0, total: 0 };
}

/** First line of an error, since provider errors carry a JSON body after it. */
function firstLine(text: string): string {
	const line = text.split('\n', 1)[0].trim();
	return line.length > 160 ? `${line.slice(0, 160)}…` : line;
}

/** Cache key for a review: the exact bytes, plus what analysed them. */
function contentHash(content: string): string {
	return `${SECURITY_ANALYSIS_VERSION}:${hash(content)}`;
}

/** Ordering weight, worst first. */
function severityWeight(severity: FindingSeverity): number {
	return severity === 'error' ? 2 : severity === 'warning' ? 1 : 0;
}

function worstSeverity(findings: readonly IFinding[]): number {
	let worst = 0;
	for (const finding of findings) {
		worst = Math.max(worst, severityWeight(finding.severity));
	}
	return worst;
}

/** Marker carrying the severity into plain text, where there is no colour. */
function severityMark(severity: FindingSeverity): string {
	return severity === 'error' ? '🔴' : severity === 'warning' ? '🟡' : '🔵';
}

/** What one scan did, so an empty report can be told apart from a broken one. */
interface IScanStats {
	files: number;
	ruleFindings: number;
	aiFindings: number;
	/** Files the model answered for. */
	aiReviewed: number;
	/** Requests that errored — no model, context overflow, timeout. */
	aiFailed: number;
	/** Answers that came back as something other than the requested JSON. */
	aiUnparsed: number;
	/** Files left to the rules because the review budget ran out. */
	aiSkipped: number;
	/** Files whose review was reused from an earlier scan, unchanged since. */
	aiCached: number;
	/** Files with no security-relevant surface, so never worth a review. */
	aiNoSurface: number;
	/** First failure reason, which is almost always every failure's reason. */
	aiFailureReason?: string;
}

/** What the model is told to concentrate on, given where the file sits. */
function layerFocus(layer: SecurityLayer): string {
	switch (layer) {
		case SecurityLayer.Config:
			return 'secrets committed to the repo, permissive defaults, debug switches left on, anything that widens exposure in production';
		case SecurityLayer.Routes:
			return 'missing authentication and authorization, unvalidated request input reaching sinks, mass assignment, SSRF, rate limiting, data returned to the wrong caller';
		case SecurityLayer.Data:
			return 'query construction, tenant and ownership filters, over-fetching of sensitive columns, migrations that widen access, secrets in connection setup';
		default:
			return 'untrusted input crossing a trust boundary, unsafe rendering, weak crypto, logic that can be skipped or replayed';
	}
}

interface IRawLLMFinding {
	startLine: number;
	endLine?: number;
	startColumn?: number;
	endColumn?: number;
	severity: string;
	title: string;
	description: string;
	cwe?: string;
	suggestedFix?: {
		explanation?: string;
		startLine?: number;
		endLine?: number;
		newText?: string;
	};
}

const SYSTEM_PROMPT = `You are an expert security code auditor. You analyze source code for security vulnerabilities and respond with a STRICT JSON object only — no prose, no markdown fences.

A pattern scanner has already flagged the obvious textual giveaways in this file — hard-coded secrets, string-built SQL, disabled TLS checks, unsafe HTML sinks. Do not re-report those. Your value is the part a regular expression cannot see: input that reaches a dangerous sink through several steps, an authorization check that is missing rather than wrong, a guard that can be bypassed by the order calls are made in, a value trusted because of where it came from.

Report only what you can point at in this file. Do not speculate about code you were not shown, and do not report style, performance or maintainability. Each finding must name the attack: who supplies the input, how it travels, and what they get.

Write every "title", "description" and "explanation" you emit in Brazilian Portuguese (pt-BR). These strings are shown to the user and printed into the report next to findings written in Portuguese by the rule engine; an answer in English makes the report bilingual. Keep identifiers, code, CWE ids and the JSON keys themselves exactly as they are — translate the prose, never the code.

The "Focus" line in the user message says which layer this file belongs to and what matters most there. Weigh it, but report anything real you find.

Classes worth checking:
- Injection: SQL, command, LDAP, NoSQL, template
- XSS, SSRF, CSRF, path traversal
- Hard-coded secrets, weak cryptography, insecure randomness
- Insecure deserialization, prototype pollution
- Improper authentication / authorization
- Insecure file handling, race conditions, TOCTOU
- Memory safety issues where applicable
- Dependency / supply-chain risks visible in the code

Respond with this exact JSON shape:
{
  "findings": [
    {
      "startLine": <1-based line where issue begins>,
      "endLine": <inclusive end line>,
      "severity": "error" | "warning" | "info",
      "title": "<short title>",
      "description": "<detailed explanation incl. attack vector and impact>",
      "cwe": "CWE-<id>",
      "suggestedFix": {
        "explanation": "<why this fix is safer>",
        "startLine": <line>,
        "endLine": <line>,
        "newText": "<full replacement text for the range>"
      }
    }
  ]
}

If there are no issues, respond with: {"findings": []}
Use "error" for exploitable issues, "warning" for likely issues, "info" for hardening suggestions.
Omit suggestedFix when you don't have a confident fix.
Line numbers MUST match the line numbers prefixed in the user message.`;

export class SecurityScanService extends Disposable implements ISecurityScanService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeFindings = this._register(new Emitter<void>());
	readonly onDidChangeFindings = this._onDidChangeFindings.event;

	private readonly _onDidChangeProgress = this._register(new Emitter<IScanProgress>());
	readonly onDidChangeProgress = this._onDidChangeProgress.event;

	private _findings = new ResourceMap<IFinding[]>();
	private _ignored = new Set<string>();
	private _activeScan: CancellationTokenSource | undefined;
	private _progress: IScanProgress = { state: ScanState.Idle, current: 0, total: 0 };
	private _lastScanAt: number | undefined;
	private _lastModelId: string | undefined;
	/** Cleared at the start of every scan: the substitution is reported once, not per file. */
	private _warnedAboutModel = false;
	/** Model reviews from earlier scans, reused while the file is unchanged. */
	private _aiCache = new Map<string, IAiCacheEntry>();
	/** Extra instructions from the workspace, appended to the system prompt. */
	private _instructions = '';

	constructor(
		@ILanguageModelsService private readonly languageModelsService: ILanguageModelsService,
		@ISearchService private readonly searchService: ISearchService,
		@IFileService private readonly fileService: IFileService,
		@IMarkerService private readonly markerService: IMarkerService,
		@IStorageService private readonly storageService: IStorageService,
		@IBulkEditService private readonly bulkEditService: IBulkEditService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@INotificationService private readonly notificationService: INotificationService,
		@ILogService private readonly logService: ILogService,
		@IVsgoWorkspaceService private readonly vsgoWorkspaceService: IVsgoWorkspaceService,
	) {
		super();
		this.loadIgnored();
		this.rehydrateFromLatestReport().catch(err => this.logService.warn('[securityScan] rehydrate failed', err));
	}

	get progress(): IScanProgress { return this._progress; }
	get lastScanAt(): number | undefined { return this._lastScanAt; }

	getFindings(includeIgnored = false): readonly IFinding[] {
		const all: IFinding[] = [];
		for (const list of this._findings.values()) {
			for (const f of list) {
				if (includeIgnored || !this._ignored.has(f.id)) {
					all.push(f);
				}
			}
		}
		return all;
	}

	isIgnored(id: string): boolean { return this._ignored.has(id); }

	ignoreFinding(id: string): void {
		this._ignored.add(id);
		this.saveIgnored();
		this.refreshMarkers();
		this._onDidChangeFindings.fire();
	}

	unignoreFinding(id: string): void {
		if (this._ignored.delete(id)) {
			this.saveIgnored();
			this.refreshMarkers();
			this._onDidChangeFindings.fire();
		}
	}

	clearFindings(): void {
		for (const uri of this._findings.keys()) {
			this.markerService.remove(SECURITY_SCAN_MARKER_OWNER, [uri]);
		}
		this._findings.clear();
		this._lastScanAt = undefined;
		this._onDidChangeFindings.fire();
		this.deleteLatestReport().catch(err => this.logService.warn('[securityScan] could not delete latest report', err));
	}

	stopScan(): void {
		this._activeScan?.cancel();
	}

	async scanWorkspace(token?: CancellationToken): Promise<void> {
		if (this._activeScan) {
			this.notificationService.info(localize('securityScan.alreadyRunning', "A security scan is already running."));
			return;
		}
		const config = this.getConfig();
		const folders = this.workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) {
			this.notificationService.info(localize('securityScan.noWorkspace', "Security Scan: open a folder to scan."));
			return;
		}

		const cts = new CancellationTokenSource(token);
		this._activeScan = cts;

		// Announced before any work starts. Everything below — walking the tree,
		// stat-ing every file, asking the providers for their model lists — happens
		// before the first file is read, and on a real repository that is seconds
		// of the panel showing the previous scan's result as if nothing had begun.
		this.updateProgress({ state: ScanState.Scanning, current: 0, total: 0, phase: preparingPhase(localize('securityScan.phaseMapping', "Mapeando arquivos")) });

		try {
			const files: URI[] = [];
			for (const folder of folders) {
				const userExcludes = getExcludes(this.configurationService.getValue<ISearchConfiguration>({ resource: folder.uri })) || {};
				const excludeMap: IExpression = { ...userExcludes };
				for (const glob of config.exclude) { excludeMap[glob] = true; }
				const includeMap: IExpression = {};
				for (const glob of config.include) { includeMap[glob] = true; }
				const query: IFileQuery = {
					folderQueries: [{ folder: folder.uri }],
					type: QueryType.File,
					includePattern: includeMap,
					excludePattern: excludeMap,
					maxResults: 5000,
				};
				const result = await this.searchService.fileSearch(query, cts.token);
				for (const m of result.results) {
					files.push(m.resource);
				}
			}
			if (cts.token.isCancellationRequested) { return; }

			const maxBytes = Math.max(1, config.maxFileSizeKB) * 1024;
			const filtered: URI[] = [];
			// In batches rather than one await per file: the sizes are independent,
			// and a repository with a few thousand files spent that whole walk
			// waiting on one round trip at a time.
			for (let i = 0; i < files.length; i += STAT_BATCH_SIZE) {
				if (cts.token.isCancellationRequested) { return; }
				const batch = files.slice(i, i + STAT_BATCH_SIZE);
				const sizes = await Promise.all(batch.map(uri => this.fileService.stat(uri).then(stat => stat.size, () => undefined)));
				for (let j = 0; j < batch.length; j++) {
					const size = sizes[j];
					if (size && size <= maxBytes) {
						filtered.push(batch[j]);
					}
				}
			}

			this.clearFindings();
			this._warnedAboutModel = false;
			this.loadAiCache();
			await this.loadInstructions(config);
			this.updateProgress({ state: ScanState.Scanning, current: 0, total: filtered.length, phase: preparingPhase(localize('securityScan.phaseModel', "Selecionando o modelo")) });

			// Grouped before anything is read: which layer a file sits in decides
			// both the order it is examined in and what is worth asking about it.
			const byLayer = new Map<SecurityLayer, URI[]>();
			for (const uri of filtered) {
				const layer = classifyLayer(uri.path);
				const bucket = byLayer.get(layer);
				if (bucket) {
					bucket.push(uri);
				} else {
					byLayer.set(layer, [uri]);
				}
			}
			const phases = SECURITY_LAYERS.filter(layer => (byLayer.get(layer)?.length ?? 0) > 0);

			// The model is optional, and resolved once for the whole scan — per
			// file it made every provider rebuild its list for each file in the
			// workspace. The rules run either way, so a missing model costs the
			// review, not the scan.
			const stats: IScanStats = { files: filtered.length, ruleFindings: 0, aiFindings: 0, aiReviewed: 0, aiFailed: 0, aiUnparsed: 0, aiSkipped: 0, aiCached: 0, aiNoSurface: 0 };
			let modelId: string | undefined;
			if (config.aiReview) {
				modelId = await this.pickModel(config);
				if (!modelId) {
					this.notificationService.warn(localize('securityScan.noModelRulesOnly', "Nenhum modelo de IA disponível: o scan rodou só com as regras determinísticas."));
				}
			}

			let completed = 0;
			// Counted on completion, not on start: with several files in flight the
			// index of the last one started only looks like progress, and it stalls
			// at the width of the pool while the first batch is still running.
			const reportProgress = (phaseIndex: number, label: string, file?: string, aiReview?: boolean) => {
				this.updateProgress({
					state: ScanState.Scanning,
					current: completed,
					total: filtered.length,
					currentFile: file,
					phase: { label, index: phaseIndex + 1, total: phases.length, aiReview },
				});
			};

			for (let phaseIndex = 0; phaseIndex < phases.length; phaseIndex++) {
				if (cts.token.isCancellationRequested) { break; }
				const layer = phases[phaseIndex];
				const label = layerLabel(layer);
				// Riskiest paths first, so a budget that runs out runs out on the
				// files least likely to be hiding anything.
				const inLayer = (byLayer.get(layer) ?? []).sort((a, b) => pathPriority(b.path) - pathPriority(a.path));
				reportProgress(phaseIndex, label);
				this.logService.info(`[securityScan] phase ${phaseIndex + 1}/${phases.length} — ${label}: ${inLayer.length} arquivos`);

				await this.runWithConcurrency(inLayer, Math.max(1, config.concurrency), async uri => {
					if (cts.token.isCancellationRequested) { return; }
					reportProgress(phaseIndex, label, uri.path);
					await this.scanFileInternal(uri, config, layer, modelId, stats, cts.token, (file, aiReview) => reportProgress(phaseIndex, label, file, aiReview));
					completed++;
					reportProgress(phaseIndex, label, uri.path);
				});
			}

			this._lastScanAt = Date.now();
			this.updateProgress({
				state: ScanState.Scanning,
				current: completed,
				total: filtered.length,
				phase: { label: localize('securityScan.phaseReport', "Gerando relatório"), index: phases.length, total: phases.length },
			});
			await this.writeReport(config, { archive: true });
			this.saveAiCache();
			this.reportScanOutcome(stats);
		} catch (err) {
			this.logService.error('[securityScan] workspace scan failed', err);
			this.updateProgress({ state: ScanState.Idle, current: 0, total: 0, error: String(err) });
			this.notificationService.error(localize('securityScan.scanFailed', "Security Scan failed: {0}", String(err)));
			return;
		} finally {
			const total = this._progress.total;
			this._activeScan = undefined;
			this.updateProgress({ state: ScanState.Idle, current: total, total });
		}
	}

	async scanFile(resource: URI, token?: CancellationToken): Promise<void> {
		if (this._activeScan) {
			this.notificationService.info(localize('securityScan.alreadyRunning', "A security scan is already running."));
			return;
		}
		const cts = new CancellationTokenSource(token);
		this._activeScan = cts;
		const config = this.getConfig();
		try {
			this.removeFindingsForResource(resource);
			this._warnedAboutModel = false;
			this.loadAiCache();
			await this.loadInstructions(config);
			const layer = classifyLayer(resource.path);
			const stats: IScanStats = { files: 1, ruleFindings: 0, aiFindings: 0, aiReviewed: 0, aiFailed: 0, aiUnparsed: 0, aiSkipped: 0, aiCached: 0, aiNoSurface: 0 };
			const modelId = config.aiReview ? await this.pickModel(config) : undefined;
			this.updateProgress({
				state: ScanState.Scanning,
				current: 0,
				total: 1,
				currentFile: resource.path,
				phase: { label: layerLabel(layer), index: 1, total: 1 },
			});
			await this.scanFileInternal(resource, config, layer, modelId, stats, cts.token);
			this._lastScanAt = Date.now();
			await this.writeReport(config, { archive: false });
			this.saveAiCache();
			this.reportScanOutcome(stats);
		} catch (err) {
			this.logService.error('[securityScan] file scan failed', err);
			this.notificationService.error(localize('securityScan.scanFailed', "Security Scan failed: {0}", String(err)));
		} finally {
			this._activeScan = undefined;
			this.updateProgress({ state: ScanState.Idle, current: 1, total: 1 });
		}
	}

	async applyFix(finding: IFinding): Promise<boolean> {
		if (!finding.fix) { return false; }
		const edit = new ResourceTextEdit(finding.resource, { range: finding.fix.range, text: finding.fix.newText });
		await this.bulkEditService.apply([edit], {
			label: localize('securityScan.applyFixLabel', "Apply security fix: {0}", finding.title),
			code: 'undoredo.securityScanFix',
			showPreview: true,
		});
		this.removeFinding(finding);
		return true;
	}

	/**
	 * Examines one file: the rules first, then the model if there is one.
	 *
	 * The two passes are deliberately independent. The rules always run and
	 * always produce the same answer, so an unavailable, slow or confused model
	 * costs the review it would have added — not the whole file.
	 */
	private async scanFileInternal(
		resource: URI,
		config: ISecurityScanConfiguration,
		layer: SecurityLayer,
		modelId: string | undefined,
		stats: IScanStats,
		token: CancellationToken,
		onProgress?: (file: string, aiReview: boolean) => void,
	): Promise<void> {
		let content: string;
		try {
			const c = await this.fileService.readFile(resource);
			content = c.value.toString();
		} catch (err) {
			this.logService.warn('[securityScan] could not read file', resource.toString(), err);
			return;
		}
		if (token.isCancellationRequested) { return; }

		const lines = content.split(/\r?\n/);
		const findings: IFinding[] = [];

		for (const match of runSecurityRules(content, resource.path, layer)) {
			const finding = this.findingFromRule(resource, match, lines, config);
			if (finding) {
				findings.push(finding);
				stats.ruleFindings++;
			}
		}

		if (modelId) {
			const cached = this.cachedReview(resource, content, modelId);
			if (cached) {
				findings.push(...cached);
				stats.aiCached++;
				stats.aiFindings += cached.length;
			} else if (reviewPriority(content, resource.path, layer) === 0) {
				// No input, no sink, no secret, no identity: there is nothing here
				// for the review to find, and the budget is better spent elsewhere.
				stats.aiNoSurface++;
			} else if (stats.aiReviewed >= config.aiReviewMaxFiles) {
				stats.aiSkipped++;
			} else {
				onProgress?.(resource.path, true);
				const reviewed = await this.reviewWithModel(resource, content, lines, layer, modelId, config, stats, token);
				findings.push(...reviewed);
			}
		}

		if (token.isCancellationRequested) { return; }

		if (findings.length === 0) {
			this._findings.delete(resource);
			this.markerService.remove(SECURITY_SCAN_MARKER_OWNER, [resource]);
		} else {
			this._findings.set(resource, findings);
			this.markerService.changeOne(SECURITY_SCAN_MARKER_OWNER, resource, findings.filter(f => !this._ignored.has(f.id)).map(toMarker));
		}
		this._onDidChangeFindings.fire();
	}

	/**
	 * Second pass: what the patterns cannot judge.
	 *
	 * Every way this can go wrong is counted rather than swallowed. An empty
	 * report is a real answer only when the model was actually asked and
	 * actually replied, and previously a failed request and a clean file looked
	 * exactly the same from the panel.
	 */
	private async reviewWithModel(
		resource: URI,
		content: string,
		lines: string[],
		layer: SecurityLayer,
		modelId: string,
		config: ISecurityScanConfiguration,
		stats: IScanStats,
		token: CancellationToken,
	): Promise<IFinding[]> {
		const numberedSource = lines.map((line, i) => `${String(i + 1).padStart(5, ' ')}  ${line}`).join('\n');
		const userMessage = `File: ${resource.path}\nLayer: ${layerLabel(layer)}\nFocus: ${layerFocus(layer)}\n\n${numberedSource}`;

		const messages: IChatMessage[] = [
			{ role: ChatMessageRole.System, content: [{ type: 'text', value: this.systemPrompt() }] },
			{ role: ChatMessageRole.User, content: [{ type: 'text', value: userMessage }] },
		];

		let responseText: string;
		try {
			const response = await this.languageModelsService.sendChatRequest(modelId, undefined, messages, {}, token);
			responseText = await getTextResponseFromStream(response);
			this._lastModelId = modelId;
			stats.aiReviewed++;
		} catch (err) {
			if (!token.isCancellationRequested) {
				const reason = err instanceof Error ? err.message : String(err);
				stats.aiFailed++;
				stats.aiFailureReason ??= firstLine(reason);
				this.logService.warn(`[securityScan] model review failed for ${resource.path}: ${reason}`);
			}
			return [];
		}
		if (token.isCancellationRequested) { return []; }

		const rawFindings = this.parseFindings(responseText);
		if (!rawFindings) {
			stats.aiUnparsed++;
			this.logService.warn(`[securityScan] model answer for ${resource.path} was not the expected JSON (${responseText.length} chars)`);
			return [];
		}

		const findings: IFinding[] = [];
		for (const raw of rawFindings) {
			const finding = this.normalizeFinding(resource, raw, lines, config);
			if (finding) {
				findings.push(finding);
				stats.aiFindings++;
			}
		}
		// Cached including when it is empty: "nothing here" is the answer worth
		// not paying for a second time.
		this.storeReview(resource, content, modelId, findings);
		return findings;
	}

	/**
	 * The instructions the review runs under: the built-in prompt, plus whatever
	 * the project added.
	 *
	 * The project's text is appended rather than substituted, and lands after
	 * the response contract, because the JSON shape is a protocol between this
	 * service and the model — a prompt that replaced it would produce answers
	 * the parser drops on the floor. Everything above it is advice, and advice
	 * is what a project has reason to override.
	 */
	private systemPrompt(): string {
		if (!this._instructions) {
			return SYSTEM_PROMPT;
		}
		return [
			SYSTEM_PROMPT,
			'',
			'--- Project-specific instructions ---',
			this._instructions,
			'--- End of project-specific instructions. The JSON response shape above still applies. ---',
		].join('\n');
	}

	/**
	 * Says what the scan actually did. "No findings" earns belief only when it
	 * comes with how many files were read and how many reviews got through.
	 */
	private reportScanOutcome(stats: IScanStats): void {
		// Counted the way the panel counts, or the notification claims findings the
		// user cannot see. Ignored ones are named separately instead of vanishing.
		const all = this.getFindings(true);
		const ignored = all.filter(f => this._ignored.has(f.id)).length;
		const total = all.length - ignored;
		const hidden = ignored > 0
			? localize('securityScan.plusIgnored', " ({0} ignorado(s) não contam)", ignored)
			: '';
		this.logService.info(`[securityScan] ${stats.files} arquivos · ${stats.ruleFindings} achados por regra · ${stats.aiFindings} por IA · IA: ${stats.aiReviewed} revisados agora, ${stats.aiCached} reaproveitados do cache, ${stats.aiNoSurface} sem superfície de ataque, ${stats.aiSkipped} acima do teto, ${stats.aiFailed} falhas, ${stats.aiUnparsed} respostas inválidas`);

		const failed = stats.aiFailed + stats.aiUnparsed;
		if (failed > 0) {
			// The reason travels with the message: "check the log" is what a tool
			// says when it knows the answer and makes you go find it.
			this.notificationService.warn(localize(
				'securityScan.aiTrouble',
				"Scan concluído: {0} achados em {1} arquivos{2}. A revisão por IA falhou em {3} arquivos — só as regras rodaram neles. Motivo: {4}",
				total, stats.files, hidden, failed, stats.aiFailureReason ?? localize('securityScan.unknownReason', "desconhecido, veja o log")));
			return;
		}
		if (stats.aiSkipped > 0) {
			this.notificationService.info(localize(
				'securityScan.aiCapped',
				"Scan concluído: {0} achados em {1} arquivos{2}. {3} arquivos ficaram acima do teto de revisão por IA e entram no próximo scan — aumente \"security.scan.aiReviewMaxFiles\" para cobri-los agora.",
				total, stats.files, hidden, stats.aiSkipped));
			return;
		}
		this.notificationService.info(localize(
			'securityScan.done',
			"Scan concluído: {0} achados em {1} arquivos{2}.",
			total, stats.files, hidden));
	}

	/** Turns a rule match into a finding, with the rule's own text as the report. */
	private findingFromRule(resource: URI, match: IRuleMatch, lines: string[], config: ISecurityScanConfiguration): IFinding | undefined {
		if (!this.meetsThreshold(match.rule.severity, config.severityThreshold)) {
			return undefined;
		}
		const lineText = lines[match.line - 1] ?? '';
		const range: IRange = {
			startLineNumber: match.line,
			startColumn: match.column,
			endLineNumber: match.line,
			endColumn: Math.min(lineText.length + 1, match.column + match.length),
		};
		const id = String(hash(`${resource.toString()}|${match.rule.id}|${match.line}|${match.column}`));
		return {
			id,
			resource,
			range,
			severity: match.rule.severity,
			title: match.rule.title,
			description: match.rule.description,
			cwe: match.rule.cwe,
			source: 'rule',
			ruleId: match.rule.id,
		};
	}

	private parseFindings(text: string): IRawLLMFinding[] | undefined {
		if (!text) { return undefined; }
		const cleaned = text
			.replace(/^\s*```(?:json)?\s*/i, '')
			.replace(/```\s*$/i, '')
			.trim();
		const start = cleaned.indexOf('{');
		const end = cleaned.lastIndexOf('}');
		if (start < 0 || end <= start) { return undefined; }
		const json = cleaned.slice(start, end + 1);
		try {
			const parsed = JSON.parse(json);
			if (parsed && Array.isArray(parsed.findings)) {
				return parsed.findings as IRawLLMFinding[];
			}
		} catch (err) {
			this.logService.warn('[securityScan] failed to parse model response', err);
		}
		return undefined;
	}

	private normalizeFinding(resource: URI, raw: IRawLLMFinding, lines: string[], config: ISecurityScanConfiguration): IFinding | undefined {
		const severity = this.normalizeSeverity(raw.severity);
		if (!this.meetsThreshold(severity, config.severityThreshold)) { return undefined; }
		const lineCount = Math.max(1, lines.length);
		const startLine = clamp((raw.startLine ?? 1) | 0, 1, lineCount);
		const endLine = clamp((raw.endLine ?? raw.startLine ?? startLine) | 0, startLine, lineCount);
		const startColumn = Math.max(1, ((raw.startColumn ?? 0) | 0) || 1);
		const endLineText = lines[endLine - 1] ?? '';
		const endColumn = Math.max(startColumn + 1, ((raw.endColumn ?? 0) | 0) || endLineText.length + 1);
		const range: IRange = { startLineNumber: startLine, startColumn, endLineNumber: endLine, endColumn };
		const title = String(raw.title || localize('securityScan.untitled', "Security issue")).trim();
		const description = String(raw.description || '').trim();
		const cwe = raw.cwe ? String(raw.cwe).trim() : undefined;
		let fix: IFindingFix | undefined;
		if (raw.suggestedFix && typeof raw.suggestedFix.newText === 'string') {
			const fixStart = clamp((raw.suggestedFix.startLine ?? startLine) | 0, 1, lineCount);
			const fixEnd = clamp((raw.suggestedFix.endLine ?? endLine) | 0, fixStart, lineCount);
			fix = {
				explanation: String(raw.suggestedFix.explanation || '').trim(),
				range: {
					startLineNumber: fixStart,
					startColumn: 1,
					endLineNumber: fixEnd,
					endColumn: (lines[fixEnd - 1]?.length ?? 0) + 1,
				},
				newText: raw.suggestedFix.newText,
			};
		}
		const id = String(hash(`${resource.toString()}|${startLine}|${endLine}|${cwe ?? ''}|${title}`));
		return { id, resource, range, severity, title, description, cwe, fix, source: 'ai' };
	}

	private normalizeSeverity(value: string | undefined): FindingSeverity {
		const v = (value || '').toLowerCase();
		if (v === 'error' || v === 'critical' || v === 'high') { return 'error'; }
		if (v === 'info' || v === 'low' || v === 'hint') { return 'info'; }
		return 'warning';
	}

	private meetsThreshold(s: FindingSeverity, threshold: FindingSeverity): boolean {
		const rank: Record<FindingSeverity, number> = { info: 0, warning: 1, error: 2 };
		return rank[s] >= rank[threshold];
	}

	private async pickModel(config: ISecurityScanConfiguration): Promise<string | undefined> {
		const resolved = await resolveAiFeatureModel(this.languageModelsService, { vendor: config.modelVendor, id: config.modelId });
		if (!resolved) {
			return undefined;
		}
		// Silence here is what let a scan run for an hour on a model the user
		// never picked, so the substitution is said out loud — once per scan,
		// not once per file.
		if (resolved.isSubstitute && !this._warnedAboutModel) {
			this._warnedAboutModel = true;
			const name = this.languageModelsService.lookupLanguageModel(resolved.identifier)?.name ?? resolved.identifier;
			this.notificationService.warn(localize('securityScan.modelSubstituted', "O modelo configurado para o Security Scan não está disponível. Usando {0}.", name));
		}
		return resolved.identifier;
	}

	private getConfig(): ISecurityScanConfiguration {
		const c = this.configurationService.getValue<Partial<ISecurityScanConfiguration>>(SECURITY_SCAN_CONFIG_SECTION) || {};
		return {
			include: Array.isArray(c.include) && c.include.length > 0 ? c.include : DEFAULT_INCLUDE,
			exclude: Array.isArray(c.exclude) ? c.exclude : DEFAULT_EXCLUDE,
			maxFileSizeKB: typeof c.maxFileSizeKB === 'number' ? c.maxFileSizeKB : 100,
			concurrency: typeof c.concurrency === 'number' ? c.concurrency : 3,
			modelVendor: typeof c.modelVendor === 'string' ? c.modelVendor : '',
			modelId: typeof c.modelId === 'string' ? c.modelId : '',
			severityThreshold: (c.severityThreshold as FindingSeverity) || 'info',
			aiReview: c.aiReview !== false,
			aiReviewMaxFiles: typeof c.aiReviewMaxFiles === 'number' ? Math.max(0, c.aiReviewMaxFiles) : 100,
			instructionsFile: typeof c.instructionsFile === 'string' ? c.instructionsFile : '.vsgo/security/instructions.md',
			autoScanOnSave: Boolean(c.autoScanOnSave),
			persistReports: c.persistReports !== false,
			reportRetention: typeof c.reportRetention === 'number' ? Math.max(1, c.reportRetention) : 10,
		};
	}

	private async runWithConcurrency<T>(items: T[], limit: number, fn: (item: T, idx: number) => Promise<void>): Promise<void> {
		let next = 0;
		const workers: Promise<void>[] = [];
		const total = items.length;
		const run = async () => {
			while (true) {
				const i = next++;
				if (i >= total) { return; }
				try { await fn(items[i], i); } catch (err) { this.logService.warn('[securityScan] worker error', err); }
			}
		};
		for (let i = 0; i < Math.min(limit, total); i++) { workers.push(run()); }
		await Promise.all(workers);
	}

	private updateProgress(p: IScanProgress): void {
		this._progress = p;
		this._onDidChangeProgress.fire(p);
	}

	private removeFinding(finding: IFinding): void {
		const list = this._findings.get(finding.resource);
		if (!list) { return; }
		const filtered = list.filter(f => f.id !== finding.id);
		if (filtered.length === 0) {
			this._findings.delete(finding.resource);
			this.markerService.remove(SECURITY_SCAN_MARKER_OWNER, [finding.resource]);
		} else {
			this._findings.set(finding.resource, filtered);
			this.markerService.changeOne(SECURITY_SCAN_MARKER_OWNER, finding.resource, filtered.filter(f => !this._ignored.has(f.id)).map(toMarker));
		}
		this._onDidChangeFindings.fire();
	}

	private removeFindingsForResource(resource: URI): void {
		if (this._findings.delete(resource)) {
			this.markerService.remove(SECURITY_SCAN_MARKER_OWNER, [resource]);
			this._onDidChangeFindings.fire();
		}
	}

	private refreshMarkers(): void {
		for (const [uri, list] of this._findings) {
			this.markerService.changeOne(SECURITY_SCAN_MARKER_OWNER, uri, list.filter(f => !this._ignored.has(f.id)).map(toMarker));
		}
	}

	/**
	 * Review kept from an earlier scan, when the file has not changed since.
	 *
	 * The key mixes the content with the analysis version, so changing the rules
	 * or the prompt invalidates every entry at once instead of leaving stale
	 * verdicts behind. The model is part of the entry rather than the key: moving
	 * to a different model should re-review, but moving back should not throw
	 * away what the first one said.
	 */
	private cachedReview(resource: URI, content: string, modelId: string): IFinding[] | undefined {
		const entry = this._aiCache.get(resource.toString());
		if (!entry || entry.modelId !== modelId || entry.hash !== contentHash(content)) {
			return undefined;
		}
		return entry.findings.map(f => ({
			id: f.id,
			resource,
			range: f.range,
			severity: f.severity,
			title: f.title,
			description: f.description,
			cwe: f.cwe,
			fix: f.fix,
			source: f.source ?? 'ai',
			ruleId: f.ruleId,
		}));
	}

	private storeReview(resource: URI, content: string, modelId: string, findings: readonly IFinding[]): void {
		this._aiCache.set(resource.toString(), {
			hash: contentHash(content),
			modelId,
			findings: findings.map(f => ({
				id: f.id,
				resource: f.resource.toString(),
				range: f.range,
				severity: f.severity,
				title: f.title,
				description: f.description,
				cwe: f.cwe,
				fix: f.fix,
				source: f.source,
				ruleId: f.ruleId,
			})),
		});
	}

	private loadAiCache(): void {
		const raw = this.storageService.get(AI_CACHE_STORAGE_KEY, StorageScope.WORKSPACE, '');
		if (!raw) { return; }
		try {
			const parsed = JSON.parse(raw);
			if (parsed && typeof parsed === 'object' && parsed.entries) {
				this._aiCache = new Map(Object.entries(parsed.entries as Record<string, IAiCacheEntry>));
			}
		} catch {
			// A corrupt cache costs a re-review, which is recoverable; a throw here
			// would take the whole service down with it.
		}
	}

	private saveAiCache(): void {
		// Oldest insertions go first, which is also least-recently-scanned: the
		// Map preserves insertion order and every scan re-inserts what it touched.
		while (this._aiCache.size > AI_CACHE_MAX_ENTRIES) {
			const oldest = this._aiCache.keys().next();
			if (oldest.done) { break; }
			this._aiCache.delete(oldest.value);
		}
		const entries: Record<string, IAiCacheEntry> = {};
		for (const [key, value] of this._aiCache) {
			entries[key] = value;
		}
		this.storageService.store(AI_CACHE_STORAGE_KEY, JSON.stringify({ version: SECURITY_ANALYSIS_VERSION, entries }), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	/**
	 * Reads the project's own scan instructions, if it has any. Called once per
	 * scan so an edit takes effect on the next run without a reload.
	 */
	private async loadInstructions(config: ISecurityScanConfiguration): Promise<void> {
		this._instructions = '';
		const relative = config.instructionsFile.trim();
		if (!relative) { return; }
		for (const folder of this.workspaceContextService.getWorkspace().folders) {
			const uri = URI.joinPath(folder.uri, relative);
			try {
				const file = await this.fileService.readFile(uri);
				const text = file.value.toString().trim();
				if (text) {
					this._instructions = text;
					this.logService.info(`[securityScan] instruções do projeto carregadas de ${relative} (${text.length} caracteres)`);
					return;
				}
			} catch {
				// Absent is the normal case, not an error.
			}
		}
	}

	private loadIgnored(): void {
		const raw = this.storageService.get(IGNORED_FINDINGS_STORAGE_KEY, StorageScope.WORKSPACE, '[]');
		try {
			const parsed = JSON.parse(raw);
			if (Array.isArray(parsed)) { this._ignored = new Set(parsed); }
		} catch {
			// ignore corrupt storage
		}
	}

	private saveIgnored(): void {
		this.storageService.store(IGNORED_FINDINGS_STORAGE_KEY, JSON.stringify([...this._ignored]), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	getReportsDirectory(): URI | undefined {
		return this.vsgoWorkspaceService.getArtifactsRoot(SECURITY_REPORTS_SUBDIR);
	}

	getLatestReportUri(): URI | undefined {
		const dir = this.getReportsDirectory();
		return dir ? URI.joinPath(dir, LATEST_REPORT_NAME) : undefined;
	}

	async exportReport(targetUri: URI): Promise<boolean> {
		// Format follows the extension the user typed in the save dialog, so the
		// three audiences — a person, a CI gate, a script — each get theirs.
		const payload = /\.sarif$/i.test(targetUri.path)
			? JSON.stringify(this.buildSarifReport(), null, 2)
			: /\.mdx?$/i.test(targetUri.path)
				? this.buildMarkdownReport()
				: JSON.stringify(this.buildReport(), null, 2);
		try {
			await this.fileService.writeFile(targetUri, VSBuffer.fromString(payload));
			return true;
		} catch (err) {
			this.logService.error('[securityScan] export failed', err);
			this.notificationService.error(localize('securityScan.exportFailed', "Failed to export security scan report: {0}", String(err)));
			return false;
		}
	}

	/**
	 * The report for a person to read.
	 *
	 * SARIF is the interchange format and stays the one CI reads, but it is a
	 * wire format: nobody opens it to find out what is wrong with their code.
	 * This one is ordered the way it gets acted on — worst first, grouped by
	 * file — and carries the reasoning that SARIF flattens into a message field.
	 */
	private buildMarkdownReport(): string {
		const all = this.getFindings(true);
		const active = all.filter(f => !this._ignored.has(f.id));
		const ignored = all.filter(f => this._ignored.has(f.id));
		const counts = { error: 0, warning: 0, info: 0 };
		for (const finding of active) {
			counts[finding.severity]++;
		}

		const out: string[] = [];
		out.push('# Relatório de segurança');
		out.push('');
		out.push(`**Gerado em:** ${new Date(this._lastScanAt ?? Date.now()).toLocaleString()}  `);
		const folders = this.workspaceContextService.getWorkspace().folders;
		if (folders.length > 0) {
			out.push(`**Projeto:** ${folders.map(f => f.name).join(', ')}  `);
		}
		if (this._lastModelId) {
			const name = this.languageModelsService.lookupLanguageModel(this._lastModelId)?.name ?? this._lastModelId;
			out.push(`**Modelo da revisão por IA:** ${name}  `);
		}
		out.push(`**Regras determinísticas:** ${SECURITY_RULES.length}`);
		out.push('');

		out.push('## Resumo');
		out.push('');
		out.push('| Severidade | Achados |');
		out.push('| --- | ---: |');
		out.push(`| 🔴 Erro | ${counts.error} |`);
		out.push(`| 🟡 Aviso | ${counts.warning} |`);
		out.push(`| 🔵 Informação | ${counts.info} |`);
		out.push(`| **Total** | **${active.length}** |`);
		out.push('');
		if (ignored.length > 0) {
			out.push(`${ignored.length} achado(s) marcados como ignorados estão listados no fim e não entram nos números acima.`);
			out.push('');
		}
		if (active.length === 0) {
			out.push('Nenhum achado ativo. Vale lembrar o que isso significa: as regras determinísticas não casaram com nada, e a revisão por IA não apontou nada nos arquivos que ela alcançou. Consulte o log do Security Scan para quantos arquivos a IA de fato revisou.');
			out.push('');
		}

		out.push(this.renderFindingSections(active));
		if (ignored.length > 0) {
			out.push('## Ignorados');
			out.push('');
			out.push('Marcados como ignorados nesta workspace. Mantidos no relatório para que a decisão fique visível em vez de sumir.');
			out.push('');
			out.push(this.renderFindingSections(ignored));
		}
		return out.join('\n');
	}

	/** Findings grouped by file, worst first inside each. */
	private renderFindingSections(findings: readonly IFinding[]): string {
		if (findings.length === 0) {
			return '';
		}
		const byFile = new ResourceMap<IFinding[]>();
		for (const finding of findings) {
			const list = byFile.get(finding.resource);
			if (list) {
				list.push(finding);
			} else {
				byFile.set(finding.resource, [finding]);
			}
		}
		// Files with the worst problem first, so the top of the document is the
		// part worth reading when there is no time to read all of it.
		const files = [...byFile.entries()].sort((a, b) => worstSeverity(b[1]) - worstSeverity(a[1]) || b[1].length - a[1].length);

		const out: string[] = [];
		for (const [resource, list] of files) {
			list.sort((a, b) => severityWeight(b.severity) - severityWeight(a.severity) || a.range.startLineNumber - b.range.startLineNumber);
			out.push(`## ${this.relativePath(resource)}`);
			out.push('');
			for (const finding of list) {
				const origin = finding.source === 'rule'
					? `regra \`${finding.ruleId ?? '—'}\``
					: 'revisão por IA';
				out.push(`### ${severityMark(finding.severity)} ${finding.title}`);
				out.push('');
				out.push(`**Linha ${finding.range.startLineNumber}** · ${finding.cwe ? `${finding.cwe} · ` : ''}${origin}`);
				out.push('');
				if (finding.description) {
					out.push(finding.description);
					out.push('');
				}
				if (finding.fix) {
					out.push('**Correção sugerida**');
					out.push('');
					if (finding.fix.explanation) {
						out.push(finding.fix.explanation);
						out.push('');
					}
					// An empty replacement is a deletion, and printing it as an empty
					// code block says nothing — it reads like the report lost the fix.
					if (finding.fix.newText.trim()) {
						out.push('```');
						out.push(finding.fix.newText);
						out.push('```');
					} else {
						const { startLineNumber, endLineNumber } = finding.fix.range;
						out.push(startLineNumber === endLineNumber
							? `_Remover a linha ${startLineNumber}._`
							: `_Remover as linhas ${startLineNumber} a ${endLineNumber}._`);
					}
					out.push('');
				}
			}
		}
		return out.join('\n');
	}

	/** Workspace-relative path when the file is inside one, absolute otherwise. */
	private relativePath(resource: URI): string {
		for (const folder of this.workspaceContextService.getWorkspace().folders) {
			const base = folder.uri.toString();
			const full = resource.toString();
			if (full.startsWith(base.endsWith('/') ? base : `${base}/`)) {
				return decodeURIComponent(full.slice(base.length + (base.endsWith('/') ? 0 : 1)));
			}
		}
		return resource.path;
	}

	private buildSarifReport(): object {
		const folders = this.workspaceContextService.getWorkspace().folders;
		const originalUriBaseIds: Record<string, { uri: string }> = {};
		for (let i = 0; i < folders.length; i++) {
			const uri = folders[i].uri.toString();
			originalUriBaseIds[`SRCROOT${i}`] = { uri: uri.endsWith('/') ? uri : `${uri}/` };
		}

		type SarifRule = { id: string; shortDescription: { text: string }; defaultConfiguration: { level: string } };

		const rules = new Map<string, SarifRule>();
		const results: object[] = [];

		for (const list of this._findings.values()) {
			for (const f of list) {
				// A rule identifier when one fired, since that is stable across runs
				// and across files; the CWE otherwise, which is all a model finding
				// has to group by.
				const ruleId = f.ruleId || f.cwe || 'vsgo.uncategorized';
				if (!rules.has(ruleId)) {
					rules.set(ruleId, {
						id: ruleId,
						shortDescription: { text: f.ruleId || f.cwe ? f.title : 'Uncategorized finding' },
						defaultConfiguration: { level: severityToSarifLevel(f.severity) },
					});
				}

				const loc = this.toSarifArtifactLocation(f.resource);
				const artifactLocation = loc.uriBaseId !== undefined
					? { uri: loc.uri, uriBaseId: loc.uriBaseId }
					: { uri: loc.uri };

				const result: Record<string, unknown> = {
					ruleId,
					level: severityToSarifLevel(f.severity),
					message: { text: f.description || f.title },
					locations: [{
						physicalLocation: {
							artifactLocation,
							region: {
								startLine: f.range.startLineNumber,
								startColumn: f.range.startColumn,
								endLine: f.range.endLineNumber,
								endColumn: f.range.endColumn,
							},
						},
					}],
					properties: {
						'vsgo.id': f.id,
						'vsgo.title': f.title,
						...(this._ignored.has(f.id) ? { 'vsgo.ignored': true } : {}),
					},
				};

				if (f.fix) {
					result.fixes = [{
						description: { text: f.fix.explanation },
						artifactChanges: [{
							artifactLocation,
							replacements: [{
								deletedRegion: {
									startLine: f.fix.range.startLineNumber,
									startColumn: f.fix.range.startColumn,
									endLine: f.fix.range.endLineNumber,
									endColumn: f.fix.range.endColumn,
								},
								insertedContent: { text: f.fix.newText },
							}],
						}],
					}];
				}

				results.push(result);
			}
		}

		const driver: Record<string, unknown> = {
			name: 'vsgo Security Scan',
			informationUri: 'https://github.com/microsoft/vscode',
			rules: Array.from(rules.values()),
		};
		if (this._lastModelId) {
			driver.properties = { modelId: this._lastModelId };
		}

		const run: Record<string, unknown> = {
			tool: { driver },
			invocations: [{
				executionSuccessful: true,
				endTimeUtc: new Date(this._lastScanAt ?? Date.now()).toISOString(),
			}],
			results,
		};
		if (Object.keys(originalUriBaseIds).length > 0) {
			run.originalUriBaseIds = originalUriBaseIds;
		}

		return {
			$schema: SARIF_SCHEMA_URI,
			version: SARIF_VERSION,
			runs: [run],
		};
	}

	private toSarifArtifactLocation(resource: URI): { uri: string; uriBaseId?: string } {
		const folders = this.workspaceContextService.getWorkspace().folders;
		const resPath = resource.toString();
		for (let i = 0; i < folders.length; i++) {
			const base = folders[i].uri.toString();
			const baseSlash = base.endsWith('/') ? base : `${base}/`;
			if (resPath.startsWith(baseSlash)) {
				return { uri: resPath.slice(baseSlash.length), uriBaseId: `SRCROOT${i}` };
			}
		}
		return { uri: resPath };
	}

	private buildReport(): ISecurityScanReport {
		const findings: ISerializedFinding[] = [];
		for (const list of this._findings.values()) {
			for (const f of list) {
				findings.push({
					id: f.id,
					resource: f.resource.toString(),
					range: f.range,
					severity: f.severity,
					title: f.title,
					description: f.description,
					cwe: f.cwe,
					fix: f.fix,
					ignored: this._ignored.has(f.id) || undefined,
					source: f.source,
					ruleId: f.ruleId,
				});
			}
		}
		return {
			version: REPORT_VERSION,
			generatedAt: new Date(this._lastScanAt ?? Date.now()).toISOString(),
			workspaceFolders: this.workspaceContextService.getWorkspace().folders.map(f => f.uri.toString()),
			modelId: this._lastModelId,
			findings,
		};
	}

	private async writeReport(config: ISecurityScanConfiguration, opts: { archive: boolean }): Promise<void> {
		if (!config.persistReports) { return; }
		const payload = VSBuffer.fromString(JSON.stringify(this.buildReport(), null, 2));
		const sarifPayload = VSBuffer.fromString(JSON.stringify(this.buildSarifReport(), null, 2));
		const markdownPayload = VSBuffer.fromString(this.buildMarkdownReport());
		try {
			const dir = await this.vsgoWorkspaceService.ensureArtifactsRoot(SECURITY_REPORTS_SUBDIR);
			if (!dir) { return; }
			const latest = URI.joinPath(dir, LATEST_REPORT_NAME);
			await this.fileService.writeFile(latest, payload);
			await this.fileService.writeFile(URI.joinPath(dir, LATEST_SARIF_NAME), sarifPayload);
			await this.fileService.writeFile(URI.joinPath(dir, LATEST_MARKDOWN_NAME), markdownPayload);
			if (opts.archive) {
				const stamp = new Date(this._lastScanAt ?? Date.now()).toISOString().replace(/[:.]/g, '-');
				await this.fileService.writeFile(URI.joinPath(dir, `report-${stamp}.json`), payload);
				await this.fileService.writeFile(URI.joinPath(dir, `report-${stamp}.sarif`), sarifPayload);
				await this.fileService.writeFile(URI.joinPath(dir, `report-${stamp}.md`), markdownPayload);
				await this.pruneReports(dir, config.reportRetention);
			}
		} catch (err) {
			this.logService.warn('[securityScan] writeReport failed', err);
		}
	}

	private async pruneReports(dir: URI, retention: number): Promise<void> {
		try {
			const stat = await this.fileService.resolve(dir);
			const stampToFiles = new Map<string, URI[]>();
			for (const c of stat.children ?? []) {
				if (c.isDirectory) { continue; }
				const m = c.name.match(/^report-(.+)\.(json|sarif|md)$/);
				if (!m) { continue; }
				const list = stampToFiles.get(m[1]) ?? [];
				list.push(c.resource);
				stampToFiles.set(m[1], list);
			}
			const sortedStamps = Array.from(stampToFiles.keys()).sort().reverse();
			for (const stamp of sortedStamps.slice(retention)) {
				for (const uri of stampToFiles.get(stamp) ?? []) {
					await this.fileService.del(uri, { useTrash: false });
				}
			}
		} catch (err) {
			this.logService.warn('[securityScan] pruneReports failed', err);
		}
	}

	private async deleteLatestReport(): Promise<void> {
		const latest = this.getLatestReportUri();
		if (!latest) { return; }
		try {
			await this.fileService.del(latest, { useTrash: false });
		} catch (err) {
			if (toFileOperationResult(err) !== FileOperationResult.FILE_NOT_FOUND) {
				throw err;
			}
		}
	}

	private async rehydrateFromLatestReport(): Promise<void> {
		const config = this.getConfig();
		if (!config.persistReports) { return; }
		const latest = this.getLatestReportUri();
		if (!latest) { return; }
		let content: string;
		try {
			const buf = await this.fileService.readFile(latest);
			content = buf.value.toString();
		} catch (err) {
			if (toFileOperationResult(err) !== FileOperationResult.FILE_NOT_FOUND) {
				this.logService.warn('[securityScan] could not read latest report', err);
			}
			return;
		}
		let report: ISecurityScanReport;
		try {
			report = JSON.parse(content) as ISecurityScanReport;
		} catch (err) {
			this.logService.warn('[securityScan] latest report is corrupt', err);
			return;
		}
		if (!report || report.version !== REPORT_VERSION || !Array.isArray(report.findings)) {
			return;
		}
		this._findings.clear();
		for (const sf of report.findings) {
			try {
				const resource = URI.parse(sf.resource);
				const finding: IFinding = {
					id: sf.id,
					resource,
					range: sf.range,
					severity: sf.severity,
					title: sf.title,
					description: sf.description,
					cwe: sf.cwe,
					fix: sf.fix,
				};
				const list = this._findings.get(resource) ?? [];
				list.push(finding);
				this._findings.set(resource, list);
			} catch {
				// skip malformed entry
			}
		}
		this._lastScanAt = Date.parse(report.generatedAt) || undefined;
		this._lastModelId = report.modelId;
		this.refreshMarkers();
		this._onDidChangeFindings.fire();
	}
}

function clamp(v: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, v));
}

function severityToSarifLevel(s: FindingSeverity): 'error' | 'warning' | 'note' {
	return s === 'error' ? 'error' : s === 'warning' ? 'warning' : 'note';
}

function toMarker(f: IFinding): IMarkerData {
	return {
		severity: f.severity === 'error' ? MarkerSeverity.Error : f.severity === 'warning' ? MarkerSeverity.Warning : MarkerSeverity.Info,
		message: f.cwe ? `${f.title} (${f.cwe}): ${f.description}` : `${f.title}: ${f.description}`,
		source: 'Security Scan',
		code: f.cwe,
		startLineNumber: f.range.startLineNumber,
		startColumn: f.range.startColumn,
		endLineNumber: f.range.endLineNumber,
		endColumn: f.range.endColumn,
	};
}
