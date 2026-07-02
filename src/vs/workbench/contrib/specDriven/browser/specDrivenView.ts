/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/specDriven.css';
import * as dom from '../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
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
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ISpecDrivenService, ISpecRun } from '../common/spec.js';
import { SDD_AGENT_ID } from './specDrivenAgent.js';

const OPEN_CHAT_COMMAND = 'workbench.action.chat.openInSidebar';

export class SpecDrivenView extends ViewPane {

	private currentRunEl!: HTMLElement;
	private runsListEl!: HTMLElement;

	private readonly currentRunRenderStore = this._register(new DisposableStore());
	private readonly runsListRenderStore = this._register(new DisposableStore());

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
		@ISpecDrivenService private readonly specDrivenService: ISpecDrivenService,
		@IEditorService private readonly editorService: IEditorService,
		@ICommandService private readonly commandService: ICommandService,
		@ITelemetryService _telemetryService: ITelemetryService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		this._register(this.specDrivenService.onDidChangeRuns(() => {
			this.refreshCurrentRun();
			this.refreshRunsList();
		}));
		this._register(this.specDrivenService.onDidChangeRun(() => this.refreshCurrentRun()));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		const root = dom.append(container, dom.$('.spec-driven-view'));

		this.renderHowToUse(root);

		this.currentRunEl = dom.append(root, dom.$('.spec-driven-current'));

		dom.append(root, dom.$('.spec-driven-section-title', undefined, localize('specDriven.historyTitle', "Especificações Geradas")));
		this.runsListEl = dom.append(root, dom.$('.spec-driven-runs-list'));

		this.refreshCurrentRun();
		this.refreshRunsList();
	}

	// ─── Como usar ───────────────────────────────────────────────────────────

	private renderHowToUse(root: HTMLElement): void {
		const card = dom.append(root, dom.$('.spec-driven-howto'));

		const titleRow = dom.append(card, dom.$('.spec-driven-howto-title'));
		dom.append(titleRow, dom.$('span.codicon.codicon-notebook'));
		dom.append(titleRow, dom.$('strong', undefined, localize('specDriven.howtoTitle', "Spec Driven Development")));

		const desc = dom.append(card, dom.$('p.spec-driven-howto-desc'));
		desc.textContent = localize(
			'specDriven.howtoDesc',
			"Gere especificações completas para qualquer projeto usando o agente @sdd no chat. Ele produz requisitos, histórias de usuário, arquitetura e tasks em markdown."
		);

		const steps = dom.append(card, dom.$('ol.spec-driven-howto-steps'));
		const stepTexts = [
			localize('specDriven.step1', "Abra o chat com o botão abaixo"),
			localize('specDriven.step2', "Digite @sdd e descreva seu projeto"),
			localize('specDriven.step3', "Os documentos são salvos em .vsgo/specs/"),
		];
		for (const text of stepTexts) {
			dom.append(steps, dom.$('li', undefined, text));
		}

		const btnRow = dom.append(card, dom.$('.spec-driven-howto-btns'));
		const openChatBtn = dom.append(btnRow, dom.$('button.spec-driven-btn.spec-driven-btn-primary')) as HTMLButtonElement;
		dom.append(openChatBtn, dom.$('span.codicon.codicon-comment-discussion'));
		dom.append(openChatBtn, dom.$('span', undefined, ` ${localize('specDriven.openChatBtn', "Abrir Chat com @sdd")}`));
		this._register(dom.addDisposableListener(openChatBtn, dom.EventType.CLICK, async () => {
			await this.commandService.executeCommand(OPEN_CHAT_COMMAND);
		}));

		const helpBtn = dom.append(btnRow, dom.$('button.spec-driven-btn.spec-driven-btn-secondary')) as HTMLButtonElement;
		helpBtn.title = localize('specDriven.helpBtnTooltip', "Enviar /ajuda para o agente SDD no chat");
		dom.append(helpBtn, dom.$('span.codicon.codicon-question'));
		dom.append(helpBtn, dom.$('span', undefined, ` ${localize('specDriven.helpBtn', "Guia SDD")}`));
		this._register(dom.addDisposableListener(helpBtn, dom.EventType.CLICK, async () => {
			await this.commandService.executeCommand(OPEN_CHAT_COMMAND);
		}));

		const badge = dom.append(card, dom.$('.spec-driven-agent-badge'));
		dom.append(badge, dom.$('span.codicon.codicon-sparkle'));
		dom.append(badge, dom.$('code', undefined, `@${SDD_AGENT_ID}`));
		dom.append(badge, dom.$('span', undefined, ` — ${localize('specDriven.agentBadgeDesc', "Analistas · Gerentes · Desenvolvedores")}`));
	}

	// ─── Geração em andamento ────────────────────────────────────────────────

	private refreshCurrentRun(): void {
		this.currentRunRenderStore.clear();
		dom.clearNode(this.currentRunEl);

		const running = this.specDrivenService.getRuns().find(r => r.status === 'running');
		if (!running) { return; }

		const panel = dom.append(this.currentRunEl, dom.$('.spec-driven-running'));
		const header = dom.append(panel, dom.$('.spec-driven-running-header'));
		dom.append(header, dom.$('span.codicon.codicon-sync.codicon-modifier-spin'));
		dom.append(header, dom.$('span.spec-driven-running-title', undefined, localize('specDriven.generatingTitle', "Gerando especificações…")));

		const cancelBtn = dom.append(header, dom.$('button.spec-driven-btn.spec-driven-btn-cancel')) as HTMLButtonElement;
		cancelBtn.textContent = localize('specDriven.cancelBtn', "Cancelar");
		this.currentRunRenderStore.add(dom.addDisposableListener(cancelBtn, dom.EventType.CLICK, () => {
			this.specDrivenService.cancelRun(running.id);
		}));

		dom.append(panel, dom.$('.spec-driven-running-desc', undefined, truncate(running.description, 80)));

		const PHASE_LABELS: Record<string, string> = {
			context: localize('specDriven.phCtx', "Contexto"),
			requirements: localize('specDriven.phReq', "Requisitos"),
			stories: localize('specDriven.phStories', "Histórias"),
			architecture: localize('specDriven.phArch', "Arquitetura"),
			tasks: localize('specDriven.phTasks', "Tarefas"),
		};
		const currentLabel = PHASE_LABELS[running.currentPhase] ?? running.currentPhase;
		dom.append(panel, dom.$('.spec-driven-running-phase', undefined, currentLabel));

		const totalPhases = running.selectedPhases.length + 1;
		const pct = Math.round((running.phaseIndex / totalPhases) * 100);
		const bar = dom.append(panel, dom.$('.spec-driven-progress-bar'));
		const fill = dom.append(bar, dom.$('.spec-driven-progress-fill')) as HTMLElement;
		fill.style.width = `${pct}%`;
	}

	// ─── Histórico ───────────────────────────────────────────────────────────

	private refreshRunsList(): void {
		this.runsListRenderStore.clear();
		dom.clearNode(this.runsListEl);

		const runs = this.specDrivenService.getRuns().filter(r => r.status !== 'running');
		if (runs.length === 0) {
			const empty = dom.append(this.runsListEl, dom.$('.spec-driven-empty'));
			dom.append(empty, dom.$('span.codicon.codicon-notebook'));
			dom.append(empty, dom.$('p', undefined, localize('specDriven.noRuns', "Nenhuma especificação gerada ainda.")));
			dom.append(empty, dom.$('p.spec-driven-empty-hint', undefined, localize('specDriven.noRunsHint', "Use @sdd no chat para gerar suas primeiras especificações.")));
			return;
		}
		for (const run of runs.slice(0, 30)) {
			this.renderRunRow(run);
		}
	}

	private renderRunRow(run: ISpecRun): void {
		const row = dom.append(this.runsListEl, dom.$('.spec-driven-run-row'));
		row.classList.add(`status-${run.status}`);

		const badge = dom.append(row, dom.$('.spec-driven-run-badge'));
		badge.textContent = statusBadge(run.status);

		const body = dom.append(row, dom.$('.spec-driven-run-body'));
		dom.append(body, dom.$('.spec-driven-run-desc', undefined, truncate(run.description, 70)));

		const meta = dom.append(body, dom.$('.spec-driven-run-meta'));
		const typeLabel = run.projectType === 'new'
			? localize('specDriven.newProject', "Novo")
			: localize('specDriven.existingProject', "Existente");
		const elapsed = run.endedAt ? ` · ${Math.round((run.endedAt - run.startedAt) / 1000)}s` : '';
		meta.textContent = `${new Date(run.startedAt).toLocaleString()} · ${typeLabel}${elapsed}`;

		if (run.status === 'error' && run.error) {
			dom.append(body, dom.$('.spec-driven-run-error', undefined, run.error));
		}

		if (run.status === 'done') {
			const filesRow = dom.append(body, dom.$('.spec-driven-run-files'));
			if (run.artifacts.requirementsUri) { this.renderFileLink(filesRow, run.artifacts.requirementsUri, 'REQUIREMENTS.md'); }
			if (run.artifacts.storiesUri) { this.renderFileLink(filesRow, run.artifacts.storiesUri, 'USER_STORIES.md'); }
			if (run.artifacts.architectureUri) { this.renderFileLink(filesRow, run.artifacts.architectureUri, 'ARCHITECTURE.md'); }
			if (run.artifacts.tasksUri) { this.renderFileLink(filesRow, run.artifacts.tasksUri, 'TASKS.md'); }
		}
	}

	private renderFileLink(parent: HTMLElement, uriStr: string, label: string): void {
		const link = dom.append(parent, dom.$('span.spec-driven-file-link'));
		dom.append(link, dom.$('span.codicon.codicon-file-text'));
		dom.append(link, dom.$('span', undefined, label));
		this.runsListRenderStore.add(dom.addDisposableListener(link, dom.EventType.CLICK, () => {
			this.editorService.openEditor({ resource: URI.parse(uriStr), options: { revealIfOpened: true } });
		}));
	}
}

function statusBadge(status: ISpecRun['status']): string {
	switch (status) {
		case 'done': return 'OK';
		case 'error': return 'ERR';
		case 'cancelled': return 'STOP';
		case 'running': return 'RUN';
	}
}

function truncate(s: string, n: number): string {
	return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
