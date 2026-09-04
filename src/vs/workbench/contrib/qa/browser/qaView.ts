/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/qa.css';
import * as dom from '../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { trackAiFeatureModel } from '../../chat/common/aiFeatureModel.js';
import { ILanguageModelsService } from '../../chat/common/languageModels.js';
import { IQaRun, IQaService, QA_FEATURE, QaRunStatus } from '../common/qa.js';

export class QaView extends ViewPane {

	private container!: HTMLElement;
	private promptInput!: HTMLTextAreaElement;
	private urlInput!: HTMLInputElement;
	private runButton!: HTMLButtonElement;
	private currentRunPanel!: HTMLElement;
	private runsListEl!: HTMLElement;
	private readonly renderStore = this._register(new DisposableStore());

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
		@IQaService private readonly qaService: IQaService,
		@ILanguageModelsService languageModelsService: ILanguageModelsService,
		@ITelemetryService _telemetryService: ITelemetryService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		this._register(this.qaService.onDidChangeRuns(() => this.refreshRuns()));
		this._register(this.qaService.onDidChangeRun(() => this.refreshCurrentRun()));
		// Beside the title, so which model drives the browser is answerable
		// without opening the settings.
		this._register(trackAiFeatureModel(languageModelsService, configurationService, QA_FEATURE, label => this.updateTitleDescription(label)));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this.container = dom.append(container, dom.$('.qa-view'));

		// New test form
		const formEl = dom.append(this.container, dom.$('.qa-form'));
		dom.append(formEl, dom.$('.qa-form-label', undefined, localize('qa.intentLabel', "Test intent")));
		this.promptInput = dom.append(formEl, dom.$('textarea.qa-form-input.qa-form-textarea')) as HTMLTextAreaElement;
		this.promptInput.placeholder = localize('qa.intentPlaceholder', "e.g. Log in with email@test.com / wrong-password and verify the 'invalid credentials' message appears.");
		this.promptInput.rows = 4;

		dom.append(formEl, dom.$('.qa-form-label', undefined, localize('qa.urlLabel', "Start URL (optional)")));
		this.urlInput = dom.append(formEl, dom.$('input.qa-form-input')) as HTMLInputElement;
		this.urlInput.type = 'text';
		this.urlInput.placeholder = 'https://localhost:3000';

		const buttonRow = dom.append(formEl, dom.$('.qa-form-buttons'));
		this.runButton = dom.append(buttonRow, dom.$('button.qa-button.qa-button-primary')) as HTMLButtonElement;
		this.runButton.textContent = localize('qa.runButton', "Run Test");
		this.renderStore.add(dom.addDisposableListener(this.runButton, 'click', () => this.onRunClicked()));

		// Current run panel
		this.currentRunPanel = dom.append(this.container, dom.$('.qa-current-run'));

		// Runs history
		dom.append(this.container, dom.$('.qa-section-title', undefined, localize('qa.runsHistory', "Recent Runs")));
		this.runsListEl = dom.append(this.container, dom.$('.qa-runs-list'));

		this.refreshRuns();
		this.refreshCurrentRun();
	}

	private async onRunClicked(): Promise<void> {
		const prompt = this.promptInput.value.trim();
		if (!prompt) { return; }
		const startUrl = this.urlInput.value.trim() || undefined;
		await this.qaService.startRun(prompt, { startUrl });
		this.promptInput.value = '';
	}

	private refreshCurrentRun(): void {
		dom.clearNode(this.currentRunPanel);
		const runs = this.qaService.getRuns();
		const running = runs.find(r => r.status === 'running');
		if (!running) { return; }

		const panel = dom.append(this.currentRunPanel, dom.$('.qa-running'));
		dom.append(panel, dom.$('.qa-running-title', undefined, localize('qa.running', "Running…")));
		dom.append(panel, dom.$('.qa-running-prompt', undefined, running.prompt));
		const statusLine = dom.append(panel, dom.$('.qa-running-status'));
		const stepCount = running.steps.length;
		statusLine.textContent = localize('qa.stepCount', "Step {0} · {1} assertions", stepCount, running.assertions.length);

		const lastStep = running.steps[running.steps.length - 1];
		if (lastStep) {
			const stepEl = dom.append(panel, dom.$('.qa-running-step'));
			stepEl.textContent = `${lastStep.action.tool}: ${JSON.stringify(lastStep.action.args)}`;
		}

		const cancelBtn = dom.append(panel, dom.$('button.qa-button.qa-button-cancel')) as HTMLButtonElement;
		cancelBtn.textContent = localize('qa.cancel', "Stop");
		this.renderStore.add(dom.addDisposableListener(cancelBtn, 'click', () => this.qaService.cancelRun(running.id)));
	}

	private refreshRuns(): void {
		dom.clearNode(this.runsListEl);
		const runs = this.qaService.getRuns().filter(r => r.status !== 'running');
		if (runs.length === 0) {
			dom.append(this.runsListEl, dom.$('.qa-empty', undefined, localize('qa.noRuns', "No completed runs yet.")));
			return;
		}
		for (const run of runs.slice(0, 20)) {
			this.renderRunRow(run);
		}
	}

	private renderRunRow(run: IQaRun): void {
		const row = dom.append(this.runsListEl, dom.$('.qa-run-row'));
		row.classList.add(`qa-run-${run.status}`);

		const badge = dom.append(row, dom.$('.qa-run-badge'));
		badge.textContent = badgeText(run.status);

		const text = dom.append(row, dom.$('.qa-run-text'));
		dom.append(text, dom.$('.qa-run-prompt', undefined, truncate(run.prompt, 80)));
		const meta = dom.append(text, dom.$('.qa-run-meta'));
		const when = new Date(run.startedAt).toLocaleString();
		const duration = run.endedAt ? `${Math.round((run.endedAt - run.startedAt) / 1000)}s` : '—';
		meta.textContent = `${when} · ${run.steps.length} steps · ${duration}`;

		if (run.summary) {
			dom.append(text, dom.$('.qa-run-summary', undefined, run.summary));
		}
	}

	override dispose(): void {
		this.renderStore.dispose();
		super.dispose();
	}
}

function badgeText(s: QaRunStatus): string {
	switch (s) {
		case 'passed': return 'PASS';
		case 'failed': return 'FAIL';
		case 'cancelled': return 'STOP';
		case 'error': return 'ERR';
		case 'running': return 'RUN';
	}
}

function truncate(s: string, n: number): string {
	return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
