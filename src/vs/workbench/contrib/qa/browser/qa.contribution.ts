/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { registerAction2 } from '../../../../platform/actions/common/actions.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { Extensions as ViewContainerExtensions, IViewContainersRegistry, IViewsRegistry, ViewContainer, ViewContainerLocation } from '../../../common/views.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IQaService, QA_CONFIG_SECTION, QA_VIEW_CONTAINER_ID, QA_VIEW_ID } from '../common/qa.js';
import { IQaDriver, BrowserViewQaDriver } from './qaDriver.js';
import { QaService } from './qaService.js';
import { QaView } from './qaView.js';
import {
	CancelQaRunAction,
	OpenLatestQaReportAction,
	OpenQaRunsFolderAction,
	OpenQaViewAction,
	RunQaTestAction,
	SelectQaModelAction,
} from './qaActions.js';

// Services
registerSingleton(IQaDriver, BrowserViewQaDriver, InstantiationType.Delayed);
registerSingleton(IQaService, QaService, InstantiationType.Delayed);

// View container, next to Security Scan and Spec Driven in the sidebar
const qaIcon = registerIcon('qa-view-icon', Codicon.beaker, localize('qaViewIcon', "View icon of the QA view."));

const VIEW_CONTAINER: ViewContainer = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry).registerViewContainer({
	id: QA_VIEW_CONTAINER_ID,
	title: localize2('qa.containerTitle', "QA"),
	icon: qaIcon,
	order: 8,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [QA_VIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: QA_VIEW_CONTAINER_ID,
	hideIfEmpty: false,
}, ViewContainerLocation.Sidebar);

// Runs view
Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry).registerViews([{
	id: QA_VIEW_ID,
	containerIcon: qaIcon,
	name: localize2('qa.viewTitle', "Runs"),
	canToggleVisibility: true,
	canMoveView: true,
	ctorDescriptor: new SyncDescriptor(QaView),
	openCommandActionDescriptor: {
		id: 'workbench.view.qa.open',
		mnemonicTitle: localize({ key: 'miQa', comment: ['&& denotes a mnemonic'] }, "&&QA"),
		order: 6,
	},
}], VIEW_CONTAINER);

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
			markdownDescription: localize('qa.modelVendor', "Provedor de IA usado pelo agente de QA. Vazio aceita qualquer um. Prefira modelos com visão — o agente lê uma captura de tela a cada passo."),
		},
		[`${QA_CONFIG_SECTION}.modelId`]: {
			type: 'string',
			default: '',
			markdownDescription: localize('qa.modelId', "Modelo que dirige o navegador. Vazio significa o primeiro disponível, que não é necessariamente o do chat. Mais fácil de escolher pelo botão de modelo no título da view."),
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
registerAction2(SelectQaModelAction);

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
