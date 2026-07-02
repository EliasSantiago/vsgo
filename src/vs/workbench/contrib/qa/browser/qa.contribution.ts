/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { registerAction2 } from '../../../../platform/actions/common/actions.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IQaService, QA_CONFIG_SECTION } from '../common/qa.js';
import { IQaDriver, PlaywrightQaDriver } from './qaDriver.js';
import { QaService } from './qaService.js';
import {
	CancelQaRunAction,
	OpenLatestQaReportAction,
	OpenQaRunsFolderAction,
	OpenQaViewAction,
	RunQaTestAction,
} from './qaActions.js';

// Services
registerSingleton(IQaDriver, PlaywrightQaDriver, InstantiationType.Delayed);
registerSingleton(IQaService, QaService, InstantiationType.Delayed);


// Configuration
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: QA_CONFIG_SECTION,
	order: 51,
	title: localize('qa.configTitle', "QA (AI Testing)"),
	type: 'object',
	properties: {
		[`${QA_CONFIG_SECTION}.defaultStartUrl`]: {
			type: 'string',
			default: '',
			markdownDescription: localize('qa.defaultStartUrl', "Default URL to open at the start of a QA run when none is provided."),
		},
		[`${QA_CONFIG_SECTION}.headless`]: {
			type: 'boolean',
			default: false,
			markdownDescription: localize('qa.headless', "Run the test browser headless (no visible window). Default is to show the browser so the tester can watch."),
		},
		[`${QA_CONFIG_SECTION}.maxSteps`]: {
			type: 'number',
			default: 30,
			minimum: 1,
			markdownDescription: localize('qa.maxSteps', "Maximum number of agent actions per run before the test is forced to terminate."),
		},
		[`${QA_CONFIG_SECTION}.timeoutMs`]: {
			type: 'number',
			default: 300000,
			minimum: 1000,
			markdownDescription: localize('qa.timeoutMs', "Per-run timeout in milliseconds. Default is 5 minutes."),
		},
		[`${QA_CONFIG_SECTION}.modelVendor`]: {
			type: 'string',
			default: '',
			markdownDescription: localize('qa.modelVendor', "Preferred AI provider vendor (empty = any available). Vision-capable models recommended."),
		},
		[`${QA_CONFIG_SECTION}.modelId`]: {
			type: 'string',
			default: '',
			markdownDescription: localize('qa.modelId', "Preferred model identifier (empty = first available for vendor)."),
		},
		[`${QA_CONFIG_SECTION}.persistRuns`]: {
			type: 'boolean',
			default: true,
			markdownDescription: localize('qa.persistRuns', "Persist runs (report.json, transcript.md, screenshots, JUnit XML) inside `.vsgo/qa/` in the workspace root."),
		},
		[`${QA_CONFIG_SECTION}.runRetention`]: {
			type: 'number',
			default: 20,
			minimum: 1,
			markdownDescription: localize('qa.runRetention', "How many run folders to keep under `.vsgo/qa/runs/`. Older runs are deleted automatically."),
		},
		[`${QA_CONFIG_SECTION}.requireConfirmationForDestructive`]: {
			type: 'boolean',
			default: true,
			markdownDescription: localize('qa.requireConfirmationForDestructive', "Require explicit confirmation before the agent executes destructive actions (form submissions, navigation away from the start origin)."),
		},
	},
});

// Actions
registerAction2(RunQaTestAction);
registerAction2(CancelQaRunAction);
registerAction2(OpenQaViewAction);
registerAction2(OpenLatestQaReportAction);
registerAction2(OpenQaRunsFolderAction);

// Status bar entry
class QaStatusBar extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.qaStatusBar';

	private readonly entry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());

	constructor(
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@IQaService private readonly qaService: IQaService,
	) {
		super();
		this.update();
		this._register(this.qaService.onDidChangeRuns(() => this.update()));
		this._register(this.qaService.onDidChangeRun(() => this.update()));
	}

	private update(): void {
		const props = this.buildEntry();
		if (!props) {
			this.entry.value = undefined;
			return;
		}
		if (this.entry.value) {
			this.entry.value.update(props);
		} else {
			this.entry.value = this.statusbarService.addEntry(props, 'status.qa', StatusbarAlignment.RIGHT, 98);
		}
	}

	private buildEntry(): IStatusbarEntry | undefined {
		const runs = this.qaService.getRuns();
		const running = runs.find(r => r.status === 'running');
		if (running) {
			const stepCount = running.steps.length;
			return {
				name: localize('qa.statusName', "QA"),
				text: '$(sync~spin) ' + localize('qa.statusRunning', "QA: step {0}", stepCount),
				ariaLabel: localize('qa.statusRunningAria', "QA run in progress"),
				tooltip: localize('qa.statusRunningTooltip', "QA run in progress. Click to open."),
				command: 'vsgo.qa.openView',
				showInAllWindows: false,
			};
		}
		const completed = runs.filter(r => r.status !== 'running').slice(0, 10);
		if (completed.length === 0) { return undefined; }
		const counts = { passed: 0, failed: 0, other: 0 };
		for (const r of completed) {
			if (r.status === 'passed') { counts.passed++; }
			else if (r.status === 'failed') { counts.failed++; }
			else { counts.other++; }
		}
		return {
			name: localize('qa.statusName', "QA"),
			text: `$(beaker) ${counts.passed}✓ ${counts.failed}✗`,
			ariaLabel: localize('qa.statusAria', "QA: {0} passed, {1} failed", counts.passed, counts.failed),
			tooltip: localize('qa.statusTooltip', "QA — {0} passed, {1} failed (last {2} runs). Click to open.", counts.passed, counts.failed, completed.length),
			command: 'vsgo.qa.openView',
			showInAllWindows: false,
		};
	}
}

registerWorkbenchContribution2(QaStatusBar.ID, QaStatusBar, WorkbenchPhase.AfterRestored);
