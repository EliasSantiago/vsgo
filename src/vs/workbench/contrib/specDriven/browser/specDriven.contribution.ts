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
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { Extensions as ViewContainerExtensions, IViewContainersRegistry, IViewsRegistry, ViewContainer, ViewContainerLocation } from '../../../common/views.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IChatAgentService } from '../../chat/common/participants/chatAgents.js';
import { ChatAgentLocation, ChatModeKind } from '../../chat/common/constants.js';
import { IChatSlashCommandService } from '../../chat/common/participants/chatSlashCommands.js';
import { IChatProgress } from '../../chat/common/chatService/chatService.js';
import { ISpecDrivenService, SPEC_DRIVEN_CONFIG_SECTION, SPEC_DRIVEN_VIEW_CONTAINER_ID, SPEC_DRIVEN_VIEW_ID } from '../common/spec.js';
import { SpecDrivenService } from './specDrivenService.js';
import { SpecDrivenView } from './specDrivenView.js';
import { SpecDrivenAgent, SDD_AGENT_ID } from './specDrivenAgent.js';
import { SpecDrivenOnboarding } from './specDrivenOnboarding.js';
import {
	CancelSpecRunCommand,
	OpenSpecDrivenViewAction,
	OpenSpecsFolderAction,
	SetUpSpecDrivenAction,
} from './specDrivenActions.js';

// Service
registerSingleton(ISpecDrivenService, SpecDrivenService, InstantiationType.Delayed);

// Activity bar icon
const specDrivenIcon = registerIcon(
	'spec-driven-view-icon',
	Codicon.notebook,
	localize('specDrivenViewIcon', "View icon of the Spec Driven view.")
);

// View container
const VIEW_CONTAINER: ViewContainer = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry)
	.registerViewContainer({
		id: SPEC_DRIVEN_VIEW_CONTAINER_ID,
		title: localize2('specDriven.containerTitle', "Spec Driven"),
		icon: specDrivenIcon,
		order: 7,
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [SPEC_DRIVEN_VIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
		storageId: SPEC_DRIVEN_VIEW_CONTAINER_ID,
		hideIfEmpty: false,
	}, ViewContainerLocation.Sidebar);

// Specs view
Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry).registerViews([{
	id: SPEC_DRIVEN_VIEW_ID,
	containerIcon: specDrivenIcon,
	name: localize2('specDriven.viewTitle', "Spec Driven"),
	canToggleVisibility: true,
	canMoveView: true,
	ctorDescriptor: new SyncDescriptor(SpecDrivenView),
	openCommandActionDescriptor: {
		id: 'workbench.view.specDriven.open',
		mnemonicTitle: localize({ key: 'miSpecDriven', comment: ['&& denotes a mnemonic'] }, "&&Spec Driven"),
		order: 6,
	},
}], VIEW_CONTAINER);

// Configuration
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: SPEC_DRIVEN_CONFIG_SECTION,
	order: 51,
	title: localize('specDriven.configTitle', "Spec Driven"),
	type: 'object',
	properties: {
		[`${SPEC_DRIVEN_CONFIG_SECTION}.modelVendor`]: {
			type: 'string',
			default: '',
			markdownDescription: localize('specDriven.modelVendor', "Preferred AI provider vendor for spec generation (empty = any available)."),
		},
		[`${SPEC_DRIVEN_CONFIG_SECTION}.modelId`]: {
			type: 'string',
			default: '',
			markdownDescription: localize('specDriven.modelId', "Preferred model identifier for spec generation (empty = first available for vendor)."),
		},
		[`${SPEC_DRIVEN_CONFIG_SECTION}.persistRuns`]: {
			type: 'boolean',
			default: true,
			markdownDescription: localize('specDriven.persistRuns', "Persist generated spec runs in `.vsgo/specs/` and restore them on startup."),
		},
		[`${SPEC_DRIVEN_CONFIG_SECTION}.runRetention`]: {
			type: 'number',
			default: 20,
			minimum: 1,
			markdownDescription: localize('specDriven.runRetention', "Maximum number of spec runs to keep in the history."),
		},
	},
});

// Actions
registerAction2(OpenSpecDrivenViewAction);
registerAction2(CancelSpecRunCommand);
registerAction2(OpenSpecsFolderAction);
registerAction2(SetUpSpecDrivenAction);

// Onboarding: offer SDD setup when a folder is opened
registerWorkbenchContribution2(SpecDrivenOnboarding.ID, SpecDrivenOnboarding, WorkbenchPhase.AfterRestored);

// Status bar entry
class SpecDrivenStatusBar extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.specDrivenStatusBar';

	private readonly entry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());

	constructor(
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@ISpecDrivenService private readonly specDrivenService: ISpecDrivenService,
	) {
		super();
		this.update();
		this._register(this.specDrivenService.onDidChangeRuns(() => this.update()));
		this._register(this.specDrivenService.onDidChangeRun(() => this.update()));
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
			this.entry.value = this.statusbarService.addEntry(props, 'status.specDriven', StatusbarAlignment.RIGHT, 98);
		}
	}

	private buildEntry(): IStatusbarEntry | undefined {
		const running = this.specDrivenService.getRuns().find(r => r.status === 'running');
		if (!running) { return undefined; }
		const phaseLabels: Record<string, string> = {
			context: localize('specDriven.statusContext', "context"),
			requirements: localize('specDriven.statusRequirements', "requirements"),
			stories: localize('specDriven.statusStories', "stories"),
			architecture: localize('specDriven.statusArchitecture', "architecture"),
			tasks: localize('specDriven.statusTasks', "tasks"),
		};
		const phase = phaseLabels[running.currentPhase] ?? running.currentPhase;
		return {
			name: localize('specDriven.statusName', "Spec Driven"),
			text: '$(sync~spin) ' + localize('specDriven.statusGenerating', "Spec: {0}", phase),
			ariaLabel: localize('specDriven.statusAria', "Generating spec — {0}", phase),
			tooltip: localize('specDriven.statusTooltip', "Spec generation in progress. Click to open the Spec Driven view."),
			command: OpenSpecDrivenViewAction.ID,
			showInAllWindows: false,
		};
	}
}

registerWorkbenchContribution2(SpecDrivenStatusBar.ID, SpecDrivenStatusBar, WorkbenchPhase.AfterRestored);

// ─── Chat Agent Registration ──────────────────────────────────────────────────

class SpecDrivenAgentRegistration extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.specDrivenAgent';

	constructor(
		@IChatAgentService chatAgentService: IChatAgentService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IChatSlashCommandService slashCommandService: IChatSlashCommandService,
		@ISpecDrivenService specDrivenService: ISpecDrivenService,
	) {
		super();

		this._register(chatAgentService.registerAgent(SDD_AGENT_ID, {
			id: SDD_AGENT_ID,
			name: 'sdd',
			fullName: localize('specDriven.agentFullName', "Spec Driven Development"),
			description: localize('specDriven.agentDescription', "Especialista em SDD — gera requisitos, histórias, arquitetura e tarefas."),
			isDefault: false,
			isCore: true,
			isDynamic: false,
			locations: [ChatAgentLocation.Chat],
			modes: [ChatModeKind.Ask],
			disambiguation: [],
			slashCommands: [
				{ name: 'completo', description: localize('specDriven.cmdCompleto', "Gera todos os 4 documentos SDD") },
				{ name: 'requisitos', description: localize('specDriven.cmdRequisitos', "Gera apenas REQUIREMENTS.md") },
				{ name: 'historias', description: localize('specDriven.cmdHistorias', "Gera apenas USER_STORIES.md") },
				{ name: 'arquitetura', description: localize('specDriven.cmdArquitetura', "Gera apenas ARCHITECTURE.md") },
				{ name: 'tarefas', description: localize('specDriven.cmdTarefas', "Gera apenas TASKS.md") },
				{ name: 'ajuda', description: localize('specDriven.cmdAjuda', "Exibe o guia SDD") },
			],
			metadata: {},
			extensionId: new ExtensionIdentifier(''),
			extensionVersion: '1.0.0',
			extensionDisplayName: 'VS Code',
			extensionPublisherId: 'Microsoft',
		}));

		const agent = instantiationService.createInstance(SpecDrivenAgent);
		this._register(agent);
		this._register(chatAgentService.registerAgentImplementation(SDD_AGENT_ID, agent));

		// Registra os slash commands SDD globalmente (sem precisar de @sdd)
		const sddCommands: Array<{ command: string; detail: string }> = [
			{ command: 'completo', detail: localize('specDriven.cmdCompleto', "Gera todos os 4 documentos SDD") },
			{ command: 'requisitos', detail: localize('specDriven.cmdRequisitos', "Gera apenas REQUIREMENTS.md") },
			{ command: 'historias', detail: localize('specDriven.cmdHistorias', "Gera apenas USER_STORIES.md") },
			{ command: 'arquitetura', detail: localize('specDriven.cmdArquitetura', "Gera apenas ARCHITECTURE.md") },
			{ command: 'tarefas', detail: localize('specDriven.cmdTarefas', "Gera apenas TASKS.md") },
			{ command: 'ajuda', detail: localize('specDriven.cmdAjuda', "Exibe o guia SDD") },
		];

		for (const { command: cmd, detail } of sddCommands) {
			this._register(slashCommandService.registerSlashCommand(
				{ command: cmd, detail, locations: [ChatAgentLocation.Chat], modes: [ChatModeKind.Ask] },
				async (prompt, progress, _history, _location, _sessionResource, token) => {
					const adaptedProgress = (parts: IChatProgress[]) => parts.forEach(p => progress.report(p));
					await agent.handleGenerate(prompt, cmd, adaptedProgress, token);
				}
			));
		}
	}
}

registerWorkbenchContribution2(SpecDrivenAgentRegistration.ID, SpecDrivenAgentRegistration, WorkbenchPhase.AfterRestored);
