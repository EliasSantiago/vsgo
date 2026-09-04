/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/securityScan.css';
import * as dom from '../../../../base/browser/dom.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ResourceMap } from '../../../../base/common/map.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { trackAiFeatureModel } from '../../chat/common/aiFeatureModel.js';
import { ILanguageModelsService } from '../../chat/common/languageModels.js';
import { IFinding, ISecurityScanService, SECURITY_SCAN_FEATURE, ScanState } from '../common/securityScan.js';

interface IFileGroup {
	resource: URI;
	findings: IFinding[];
	collapsed: boolean;
}

export class SecurityScanView extends ViewPane {

	private container!: HTMLElement;
	private headerEl!: HTMLElement;
	private listEl!: HTMLElement;
	private readonly collapsedGroups = new Set<string>();
	private showIgnored = false;
	private readonly renderStore = this._register(new DisposableStore());
	/**
	 * Separate from `renderStore`: the header is redrawn on its own for progress,
	 * and `renderList` clears `renderStore` right after — which would dispose a
	 * listener the header had just registered.
	 */
	private readonly headerStore = this._register(new DisposableStore());

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@ISecurityScanService private readonly securityScanService: ISecurityScanService,
		@IEditorService private readonly editorService: IEditorService,
		@ILabelService private readonly labelService: ILabelService,
		@ILanguageModelsService languageModelsService: ILanguageModelsService,
		@ITelemetryService _telemetryService: ITelemetryService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		this._register(this.securityScanService.onDidChangeFindings(() => this.refresh()));
		this._register(this.securityScanService.onDidChangeProgress(() => this.redrawHeader()));
		// Beside the title, so which model a scan will run on is answerable
		// without opening the settings.
		this._register(trackAiFeatureModel(languageModelsService, configurationService, SECURITY_SCAN_FEATURE, label => this.updateTitleDescription(label)));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this.container = dom.append(container, dom.$('.security-scan-view'));
		this.headerEl = dom.append(this.container, dom.$('.security-scan-header'));
		this.listEl = dom.append(this.container, dom.$('.security-scan-list'));
		this.refresh();
	}

	toggleShowIgnored(): void {
		this.showIgnored = !this.showIgnored;
		this.refresh();
	}

	getShowIgnored(): boolean {
		return this.showIgnored;
	}

	private refresh(): void {
		this.redrawHeader();
		this.renderList();
	}

	private redrawHeader(): void {
		if (!this.headerEl) {
			return;
		}
		this.headerStore.clear();
		dom.clearNode(this.headerEl);
		const progress = this.securityScanService.progress;
		if (progress.state === ScanState.Scanning) {
			const icon = dom.append(this.headerEl, dom.$('span.codicon.codicon-sync.codicon-modifier-spin'));
			icon.setAttribute('aria-hidden', 'true');
			// Phase first, file second: on a slow model the file can sit unchanged
			// for minutes, and the phase is what says the scan is alive and where
			// it has got to.
			const phase = progress.phase;
			// Preparation stages carry a name but no number, since how many layers
			// there will be is not known until the files have been walked.
			const label = !phase
				? localize('securityScan.scanningGeneric', "Analisando…")
				: phase.total > 0
					? localize('securityScan.scanningPhase', "Fase {0}/{1} — {2}", phase.index, phase.total, phase.label)
					: localize('securityScan.scanningPreparing', "{0}…", phase.label);
			dom.append(this.headerEl, dom.$('span', undefined, label));

			const detailParts: string[] = [];
			if (progress.total > 0) {
				detailParts.push(localize('securityScan.scanningCount', "{0}/{1} arquivos", progress.current, progress.total));
			}
			if (progress.currentFile) {
				detailParts.push(phase?.aiReview
					? localize('securityScan.scanningAiFile', "revisando com IA: {0}", basename(progress.currentFile))
					: basename(progress.currentFile));
			}
			if (detailParts.length > 0) {
				const detail = dom.append(this.headerEl, dom.$('span.security-scan-progress-detail'));
				detail.textContent = ` · ${detailParts.join(' · ')}`;
			}
		} else {
			const findings = this.securityScanService.getFindings(this.showIgnored);
			const counts = countBySeverity(findings);
			const summary = findings.length === 0
				? localize('securityScan.noFindings', "Nenhum achado.")
				: localize('securityScan.summary', "{0} achados — {1} erro, {2} aviso, {3} informação", findings.length, counts.error, counts.warning, counts.info);
			dom.append(this.headerEl, dom.$('span', undefined, summary));

			// Without this the panel says "nenhum achado" while the report says
			// otherwise, and the difference — findings the user once ignored — is
			// invisible. Hiding them is right; hiding that they exist is not.
			if (!this.showIgnored) {
				const hidden = this.securityScanService.getFindings(true).length - findings.length;
				if (hidden > 0) {
					dom.append(this.headerEl, dom.$('span', undefined, ' · '));
					const hiddenEl = dom.append(this.headerEl, dom.$('a.security-scan-hidden-count'));
					hiddenEl.textContent = localize('securityScan.hiddenCount', "{0} ignorado(s)", hidden);
					hiddenEl.title = localize('securityScan.hiddenCountTooltip', "Mostrar os achados marcados como ignorados");
					hiddenEl.setAttribute('role', 'button');
					hiddenEl.tabIndex = 0;
					this.headerStore.add(dom.addDisposableListener(hiddenEl, dom.EventType.CLICK, () => this.toggleShowIgnored()));
				}
			}
			const lastScan = this.securityScanService.lastScanAt;
			if (lastScan) {
				dom.append(this.headerEl, dom.$('span', undefined, ' · '));
				const lastEl = dom.append(this.headerEl, dom.$('span'));
				lastEl.textContent = localize('securityScan.lastScan', "Last scan: {0}", formatRelative(lastScan));
				lastEl.title = new Date(lastScan).toLocaleString();
			}
		}
	}

	private renderList(): void {
		if (!this.listEl) {
			return;
		}
		this.renderStore.clear();
		dom.clearNode(this.listEl);

		const findings = this.securityScanService.getFindings(this.showIgnored);
		if (findings.length === 0) {
			const empty = dom.append(this.listEl, dom.$('.security-scan-empty'));
			dom.append(empty, dom.$('span.codicon.codicon-shield'));
			dom.append(empty, dom.$('div', undefined, localize('securityScan.emptyText', "No security findings yet. Run a scan to analyze your workspace.")));
			const btn = dom.append(empty, dom.$('button')) as HTMLButtonElement;
			btn.textContent = localize('securityScan.runScan', "Scan Workspace");
			this.renderStore.add(dom.addDisposableListener(btn, dom.EventType.CLICK, () => {
				this.securityScanService.scanWorkspace();
			}));
			return;
		}

		const groups = new ResourceMap<IFileGroup>();
		for (const f of findings) {
			let g = groups.get(f.resource);
			if (!g) {
				g = { resource: f.resource, findings: [], collapsed: this.collapsedGroups.has(f.resource.toString()) };
				groups.set(f.resource, g);
			}
			g.findings.push(f);
		}

		for (const group of groups.values()) {
			group.findings.sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || a.range.startLineNumber - b.range.startLineNumber);
			this.renderGroup(group);
		}
	}

	private renderGroup(group: IFileGroup): void {
		const groupEl = dom.append(this.listEl, dom.$('.security-scan-file-group'));
		const header = dom.append(groupEl, dom.$('.security-scan-file-header'));
		const twistie = dom.append(header, dom.$('span.twistie.codicon'));
		twistie.classList.add(group.collapsed ? 'codicon-chevron-right' : 'codicon-chevron-down');
		const fileIcon = dom.append(header, dom.$('span.codicon.codicon-file'));
		fileIcon.setAttribute('aria-hidden', 'true');
		const pathEl = dom.append(header, dom.$('span.file-path'));
		pathEl.textContent = this.labelService.getUriLabel(group.resource, { relative: true });
		pathEl.title = group.resource.fsPath;
		const count = dom.append(header, dom.$('span.file-count'));
		count.textContent = String(group.findings.length);

		this.renderStore.add(dom.addDisposableListener(header, dom.EventType.CLICK, () => {
			const key = group.resource.toString();
			if (this.collapsedGroups.has(key)) {
				this.collapsedGroups.delete(key);
			} else {
				this.collapsedGroups.add(key);
			}
			this.renderList();
		}));

		if (group.collapsed) {
			return;
		}

		for (const finding of group.findings) {
			this.renderFinding(groupEl, finding);
		}
	}

	private renderFinding(parent: HTMLElement, finding: IFinding): void {
		const ignored = this.securityScanService.isIgnored(finding.id);
		const row = dom.append(parent, dom.$('.security-scan-finding'));
		if (ignored) {
			row.classList.add('ignored');
		}
		row.title = finding.description;

		const firstRow = dom.append(row, dom.$('.finding-row'));
		const sev = dom.append(firstRow, dom.$('span.finding-severity.codicon'));
		sev.classList.add(finding.severity, severityIcon(finding.severity));
		const title = dom.append(firstRow, dom.$('span.finding-title'));
		title.textContent = finding.title;
		const meta = dom.append(firstRow, dom.$('span.finding-meta'));
		// The origin is part of how much weight a finding carries: a rule matched
		// text, a model formed an opinion.
		const origin = finding.source === 'rule'
			? localize('securityScan.originRule', "regra")
			: localize('securityScan.originAi', "IA");
		meta.textContent = finding.cwe
			? localize('securityScan.metaWithCwe', "{0} · {1} · linha {2}", finding.cwe, origin, finding.range.startLineNumber)
			: localize('securityScan.meta', "{0} · linha {1}", origin, finding.range.startLineNumber);
		if (finding.ruleId) {
			meta.title = finding.ruleId;
		}

		const actions = dom.append(firstRow, dom.$('span.finding-actions'));
		if (finding.fix) {
			const fixBtn = dom.append(actions, dom.$('span.codicon.codicon-lightbulb-autofix'));
			fixBtn.title = localize('securityScan.applyFixTooltip', "Apply suggested fix");
			fixBtn.setAttribute('role', 'button');
			this.renderStore.add(dom.addDisposableListener(fixBtn, dom.EventType.CLICK, (e) => {
				e.stopPropagation();
				this.securityScanService.applyFix(finding);
			}));
		}
		const ignoreBtn = dom.append(actions, dom.$('span.codicon'));
		ignoreBtn.classList.add(ignored ? 'codicon-eye' : 'codicon-eye-closed');
		ignoreBtn.title = ignored ? localize('securityScan.unignore', "Unignore") : localize('securityScan.ignore', "Ignore finding");
		ignoreBtn.setAttribute('role', 'button');
		this.renderStore.add(dom.addDisposableListener(ignoreBtn, dom.EventType.CLICK, (e) => {
			e.stopPropagation();
			if (ignored) {
				this.securityScanService.unignoreFinding(finding.id);
			} else {
				this.securityScanService.ignoreFinding(finding.id);
			}
		}));

		if (finding.description) {
			const desc = dom.append(row, dom.$('.finding-description'));
			desc.textContent = finding.description;
		}

		this.renderStore.add(dom.addDisposableListener(row, dom.EventType.CLICK, () => {
			this.editorService.openEditor({
				resource: finding.resource,
				options: {
					selection: finding.range,
					revealIfOpened: true,
					preserveFocus: false,
				},
			});
		}));
	}
}

function basename(path: string): string {
	const idx = path.lastIndexOf('/');
	return idx >= 0 ? path.slice(idx + 1) : path;
}

function severityRank(s: IFinding['severity']): number {
	return s === 'error' ? 0 : s === 'warning' ? 1 : 2;
}

function severityIcon(s: IFinding['severity']): string {
	if (s === 'error') { return ThemeIcon.asClassNameArray(Codicon.error)[1]; }
	if (s === 'warning') { return ThemeIcon.asClassNameArray(Codicon.warning)[1]; }
	return ThemeIcon.asClassNameArray(Codicon.info)[1];
}

function formatRelative(ts: number): string {
	const diffMs = Date.now() - ts;
	const sec = Math.floor(diffMs / 1000);
	if (sec < 60) { return localize('securityScan.relSeconds', "just now"); }
	const min = Math.floor(sec / 60);
	if (min < 60) { return localize('securityScan.relMinutes', "{0} min ago", min); }
	const hr = Math.floor(min / 60);
	if (hr < 24) { return localize('securityScan.relHours', "{0} h ago", hr); }
	const day = Math.floor(hr / 24);
	return localize('securityScan.relDays', "{0} d ago", day);
}

function countBySeverity(findings: readonly IFinding[]): { error: number; warning: number; info: number } {
	const counts = { error: 0, warning: 0, info: 0 };
	for (const f of findings) {
		counts[f.severity]++;
	}
	return counts;
}
