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
import { ChatMessageRole, getTextResponseFromStream, IChatMessage, ILanguageModelsService } from '../../chat/common/languageModels.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
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

const IGNORED_FINDINGS_STORAGE_KEY = 'securityScan.ignoredFindings';
const REPORT_VERSION = 1;
const REPORTS_DIR_NAME = 'securityScan';
const LATEST_REPORT_NAME = 'latest.json';

const DEFAULT_INCLUDE: string[] = ['**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,rs,java,rb,php,cs,cpp,c,h,hpp,sh,sql,html,vue,svelte}'];
const DEFAULT_EXCLUDE: string[] = ['**/node_modules/**', '**/out/**', '**/dist/**', '**/build/**', '**/.git/**', '**/.next/**', '**/coverage/**'];

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

Look for:
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
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
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
			for (const uri of files) {
				try {
					const stat = await this.fileService.stat(uri);
					if (!stat.size || stat.size > maxBytes) { continue; }
					filtered.push(uri);
				} catch {
					// ignore unreadable
				}
			}

			this.clearFindings();
			this.updateProgress({ state: ScanState.Scanning, current: 0, total: filtered.length });
			await this.runWithConcurrency(filtered, Math.max(1, config.concurrency), async (uri, idx) => {
				if (cts.token.isCancellationRequested) { return; }
				this.updateProgress({ state: ScanState.Scanning, current: idx + 1, total: filtered.length, currentFile: uri.path });
				await this.scanFileInternal(uri, config, cts.token);
			});
			this._lastScanAt = Date.now();
			await this.writeReport(config, { archive: true });
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
			this.updateProgress({ state: ScanState.Scanning, current: 0, total: 1, currentFile: resource.path });
			await this.scanFileInternal(resource, config, cts.token);
			this._lastScanAt = Date.now();
			await this.writeReport(config, { archive: false });
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

	private async scanFileInternal(resource: URI, config: ISecurityScanConfiguration, token: CancellationToken): Promise<void> {
		let content: string;
		try {
			const c = await this.fileService.readFile(resource);
			content = c.value.toString();
		} catch (err) {
			this.logService.warn('[securityScan] could not read file', resource.toString(), err);
			return;
		}
		if (token.isCancellationRequested) { return; }

		const modelId = await this.pickModel(config);
		if (!modelId) {
			throw new Error(localize('securityScan.noModel', "No AI model is available. Configure an AI provider first."));
		}

		const lines = content.split(/\r?\n/);
		const numberedSource = lines.map((line, i) => `${String(i + 1).padStart(5, ' ')}  ${line}`).join('\n');
		const userMessage = `File: ${resource.path}\n\n${numberedSource}`;

		const messages: IChatMessage[] = [
			{ role: ChatMessageRole.System, content: [{ type: 'text', value: SYSTEM_PROMPT }] },
			{ role: ChatMessageRole.User, content: [{ type: 'text', value: userMessage }] },
		];

		let responseText: string;
		try {
			const response = await this.languageModelsService.sendChatRequest(modelId, undefined, messages, {}, token);
			responseText = await getTextResponseFromStream(response);
			this._lastModelId = modelId;
		} catch (err) {
			this.logService.warn('[securityScan] LLM error for', resource.toString(), err);
			return;
		}
		if (token.isCancellationRequested) { return; }

		const rawFindings = this.parseFindings(responseText);
		if (!rawFindings) {
			return;
		}
		const findings: IFinding[] = [];
		for (const raw of rawFindings) {
			const finding = this.normalizeFinding(resource, raw, lines, config);
			if (finding) { findings.push(finding); }
		}
		if (findings.length === 0) {
			this._findings.delete(resource);
			this.markerService.remove(SECURITY_SCAN_MARKER_OWNER, [resource]);
		} else {
			this._findings.set(resource, findings);
			this.markerService.changeOne(SECURITY_SCAN_MARKER_OWNER, resource, findings.filter(f => !this._ignored.has(f.id)).map(toMarker));
		}
		this._onDidChangeFindings.fire();
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
		return { id, resource, range, severity, title, description, cwe, fix };
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
		const filter: { vendor?: string; id?: string } = {};
		if (config.modelVendor) { filter.vendor = config.modelVendor; }
		if (config.modelId) { filter.id = config.modelId; }
		const models = await this.languageModelsService.selectLanguageModels(filter);
		if (models.length > 0) { return models[0]; }
		const fallback = await this.languageModelsService.selectLanguageModels({});
		return fallback[0];
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
		const home = this.environmentService.workspaceStorageHome;
		return home ? URI.joinPath(home, REPORTS_DIR_NAME) : undefined;
	}

	getLatestReportUri(): URI | undefined {
		const dir = this.getReportsDirectory();
		return dir ? URI.joinPath(dir, LATEST_REPORT_NAME) : undefined;
	}

	async exportReport(targetUri: URI): Promise<boolean> {
		const report = this.buildReport();
		try {
			await this.fileService.writeFile(targetUri, VSBuffer.fromString(JSON.stringify(report, null, 2)));
			return true;
		} catch (err) {
			this.logService.error('[securityScan] export failed', err);
			this.notificationService.error(localize('securityScan.exportFailed', "Failed to export security scan report: {0}", String(err)));
			return false;
		}
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
		const dir = this.getReportsDirectory();
		const latest = this.getLatestReportUri();
		if (!dir || !latest) { return; }
		const report = this.buildReport();
		const payload = VSBuffer.fromString(JSON.stringify(report, null, 2));
		try {
			await this.fileService.createFolder(dir);
			await this.fileService.writeFile(latest, payload);
			if (opts.archive) {
				const stamp = new Date(this._lastScanAt ?? Date.now()).toISOString().replace(/[:.]/g, '-');
				await this.fileService.writeFile(URI.joinPath(dir, `report-${stamp}.json`), payload);
				await this.pruneReports(dir, config.reportRetention);
			}
		} catch (err) {
			this.logService.warn('[securityScan] writeReport failed', err);
		}
	}

	private async pruneReports(dir: URI, retention: number): Promise<void> {
		try {
			const stat = await this.fileService.resolve(dir);
			const archives = (stat.children ?? [])
				.filter(c => !c.isDirectory && /^report-.*\.json$/.test(c.name))
				.sort((a, b) => a.name < b.name ? 1 : -1);
			const toDelete = archives.slice(retention);
			for (const c of toDelete) {
				await this.fileService.del(c.resource, { useTrash: false });
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
