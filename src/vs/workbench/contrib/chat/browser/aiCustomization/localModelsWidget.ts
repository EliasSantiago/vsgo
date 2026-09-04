/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/aiCustomizationManagement.css';
import * as DOM from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../../../base/browser/ui/inputbox/inputBox.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { defaultButtonStyles, defaultInputBoxStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { IPreferencesService } from '../../../../services/preferences/common/preferences.js';

const $ = DOM.$;

/** How often the panel re-reads state while something is in flight. */
const ACTIVE_POLL_MS = 700;

type FitLevel = 'ideal' | 'ok' | 'tight' | 'unsupported';

/**
 * Shape produced by the agent-chat extension's local models controller. The
 * extension owns the catalog, the hardware probe and the downloads; this panel
 * only renders the snapshot and sends actions back.
 */
interface ILocalModelsState {
	readonly hardwareSummary: string;
	readonly modelsDirectory: string;
	readonly runtime: {
		readonly installed: boolean;
		readonly path?: string;
		readonly state: 'stopped' | 'installing' | 'starting' | 'ready' | 'error';
		readonly baseUrl?: string;
		readonly message?: string;
		/** Name of the single model the running process is serving. */
		readonly modelName?: string;
		readonly install?: { readonly message: string; readonly percent: number };
	};
	readonly models: readonly ILocalModelEntry[];
}

interface ILocalModelEntry {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly params: string;
	readonly sizeLabel: string;
	readonly contextLabel: string;
	readonly fitLevel: FitLevel;
	readonly fitReason: string;
	readonly installed: boolean;
	readonly requiresPatchedRuntime: boolean;
	readonly download?: { readonly percent: number; readonly label: string };
}

interface IProgressNodes {
	readonly bar: HTMLElement;
	readonly label: HTMLElement;
}

const FIT_ICON: Record<FitLevel, ThemeIcon> = {
	ideal: Codicon.pass,
	ok: Codicon.check,
	tight: Codicon.warning,
	unsupported: Codicon.error,
};

/** Settings owned by the local models runtime, edited inline by this panel. */
const SETTING_SERVER_PATH = 'agent-chat.localModels.serverPath';
const SETTING_MODELS_DIRECTORY = 'agent-chat.localModels.modelsDirectory';
const SETTINGS_QUERY = 'agent-chat.localModels';

function setProgress(nodes: IProgressNodes, percent: number, label?: string): void {
	nodes.bar.style.width = `${Math.max(0, Math.min(100, percent)).toFixed(1)}%`;
	nodes.label.textContent = label ?? `${Math.round(percent)}%`;
}

function fitLabel(level: FitLevel): string {
	switch (level) {
		case 'ideal': return localize('fitIdeal', "Roda muito bem aqui");
		case 'ok': return localize('fitOk', "Roda aqui");
		case 'tight': return localize('fitTight', "Cabe justo");
		case 'unsupported': return localize('fitUnsupported', "Grande demais para esta máquina");
	}
}

/**
 * Panel for models that run on the user's own machine: what the hardware can
 * handle, what is downloaded, and the state of the local inference runtime.
 *
 * Reached from the Local Models provider card in
 * {@link AIProvidersWidget}, and rendered in place of the provider list so the
 * whole flow stays inside the AI Customizations editor.
 */
export class LocalModelsWidget extends Disposable {

	readonly element: HTMLElement;

	private readonly renderDisposables = this._register(new DisposableStore());

	private headerContainer!: HTMLElement;
	private runtimeContainer!: HTMLElement;
	private settingsBody!: HTMLElement;
	private settingsSummary!: HTMLElement;
	private settingsChevron!: HTMLElement;
	private listContainer!: HTMLElement;

	private serverPathInput!: InputBox;
	private modelsDirectoryInput!: InputBox;
	private settingsExpanded = false;

	private state: ILocalModelsState | undefined;
	private loadError: string | undefined;
	private pollHandle: number | undefined;
	private disposed = false;

	/** Model card asking the user to confirm, if any. Confirmation is inline. */
	private pendingConfirm: { readonly id: string; readonly kind: 'download' | 'remove' } | undefined;

	/**
	 * Progress nodes of whatever is currently downloading, so a poll can move the
	 * bars without rebuilding the list underneath the user's cursor.
	 */
	private readonly progressNodes = new Map<string, IProgressNodes>();
	private runtimeProgress: (IProgressNodes & { readonly status: HTMLElement }) | undefined;
	private renderSignature: string | undefined;

	constructor(
		@ICommandService private readonly commandService: ICommandService,
		@IHoverService private readonly hoverService: IHoverService,
		@ILogService private readonly logService: ILogService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IPreferencesService private readonly preferencesService: IPreferencesService,
	) {
		super();
		this.element = $('.local-models-widget');
		this.headerContainer = DOM.append(this.element, $('.local-models-header'));
		this.runtimeContainer = DOM.append(this.element, $('.local-models-runtime'));
		this.createSettings();
		this.listContainer = DOM.append(this.element, $('.local-models-list'));
		this._register({ dispose: () => this.stopPolling() });

		// Settings are edited elsewhere too (Settings editor, settings.json), so
		// mirror external changes back into the inputs.
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(SETTING_SERVER_PATH) || e.affectsConfiguration(SETTING_MODELS_DIRECTORY)) {
				this.syncSettingsFromConfiguration();
			}
		}));
	}

	/**
	 * Builds the inline configuration section once, so a poll-driven re-render
	 * never steals focus or discards half-typed input.
	 */
	private createSettings(): void {
		const section = DOM.append(this.element, $('.local-models-settings'));

		const header = DOM.append(section, $('.local-models-settings-header'));
		header.tabIndex = 0;
		header.setAttribute('role', 'button');
		this.settingsChevron = DOM.append(header, $('span.local-models-settings-chevron'));
		const title = DOM.append(header, $('.local-models-settings-title'));
		title.textContent = localize('localModelsSettingsTitle', "Configuração");
		this.settingsSummary = DOM.append(header, $('.local-models-settings-summary'));

		const toggle = () => this.setSettingsExpanded(!this.settingsExpanded);
		this._register(DOM.addDisposableListener(header, DOM.EventType.CLICK, toggle));
		this._register(DOM.addDisposableListener(header, DOM.EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter' || e.key === ' ') {
				DOM.EventHelper.stop(e, true);
				toggle();
			}
		}));

		this.settingsBody = DOM.append(section, $('.local-models-settings-body'));

		this.serverPathInput = this.createSettingInput(
			localize('serverPathLabel', "Binário do runtime"),
			localize('serverPathHint', "Caminho para um binário llama-server. Deixe vazio para usar um encontrado no PATH ou uma build oficial baixada pelo vsgo."),
			localize('serverPathPlaceholder', "Automático"),
			SETTING_SERVER_PATH,
		);

		this.modelsDirectoryInput = this.createSettingInput(
			localize('modelsDirectoryLabel', "Pasta dos modelos"),
			localize('modelsDirectoryHint', "Onde os pesos GGUF baixados ficam guardados. Deixe vazio para mantê-los na pasta de armazenamento da extensão."),
			localize('modelsDirectoryPlaceholder', "Local padrão"),
			SETTING_MODELS_DIRECTORY,
		);

		const footer = DOM.append(this.settingsBody, $('.local-models-settings-footer'));
		const allSettings = this._register(new Button(footer, { ...defaultButtonStyles, supportIcons: true, secondary: true }));
		allSettings.label = '$(settings-gear) ' + localize('openAllLocalModelSettings', "Todas as Configurações de Modelos Locais");
		this._register(allSettings.onDidClick(() => {
			void this.preferencesService.openSettings({ query: SETTINGS_QUERY });
		}));

		this.syncSettingsFromConfiguration();
		this.setSettingsExpanded(false);
	}

	/**
	 * One labelled text setting. The value is written on blur and on Enter
	 * rather than per keystroke, so a half-typed path never reaches the runtime.
	 */
	private createSettingInput(label: string, hint: string, placeholder: string, settingKey: string): InputBox {
		const row = DOM.append(this.settingsBody, $('.local-models-setting'));
		const labelEl = DOM.append(row, $('label.local-models-setting-label'));
		labelEl.textContent = label;

		const input = this._register(new InputBox(DOM.append(row, $('.local-models-setting-input')), this.contextViewService, {
			placeholder,
			inputBoxStyles: defaultInputBoxStyles,
			ariaLabel: label,
		}));

		const hintEl = DOM.append(row, $('.local-models-setting-hint'));
		hintEl.textContent = hint;

		const commit = () => {
			const current = this.configurationService.getValue<string>(settingKey) ?? '';
			const next = input.value.trim();
			if (next === current) {
				return;
			}
			// An empty field means "use the default", which is what removing the
			// user value does — keeps settings.json free of empty strings.
			void this.configurationService.updateValue(settingKey, next === '' ? undefined : next, ConfigurationTarget.USER);
		};
		this._register(DOM.addDisposableListener(input.inputElement, DOM.EventType.BLUR, commit));
		this._register(DOM.addDisposableListener(input.inputElement, DOM.EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter') {
				commit();
			}
		}));

		return input;
	}

	private setSettingsExpanded(expanded: boolean): void {
		this.settingsExpanded = expanded;
		DOM.setVisibility(expanded, this.settingsBody);
		this.settingsChevron.className = 'local-models-settings-chevron';
		this.settingsChevron.classList.add(...ThemeIcon.asClassNameArray(expanded ? Codicon.chevronDown : Codicon.chevronRight));
		DOM.setVisibility(!expanded, this.settingsSummary);
	}

	private syncSettingsFromConfiguration(): void {
		const serverPath = this.configurationService.getValue<string>(SETTING_SERVER_PATH) ?? '';
		const modelsDirectory = this.configurationService.getValue<string>(SETTING_MODELS_DIRECTORY) ?? '';

		// Never overwrite a field the user is currently editing.
		if (!this.serverPathInput.hasFocus()) {
			this.serverPathInput.value = serverPath;
		}
		if (!this.modelsDirectoryInput.hasFocus()) {
			this.modelsDirectoryInput.value = modelsDirectory;
		}

		this.settingsSummary.textContent = serverPath || modelsDirectory
			? localize('settingsSummaryCustom', "Runtime ou local de armazenamento personalizado")
			: localize('settingsSummaryDefault', "Runtime e pasta de armazenamento escolhidos automaticamente");
	}

	/** Loads state and starts rendering. Call whenever the panel becomes visible. */
	async show(): Promise<void> {
		this.disposed = false;
		await this.refresh();
	}

	/** Stops background polling while the panel is not on screen. */
	hide(): void {
		this.stopPolling();
		// A question asked before leaving should not be waiting on the way back.
		this.pendingConfirm = undefined;
		this.renderSignature = undefined;
	}

	private async refresh(): Promise<void> {
		try {
			const state = await this.commandService.executeCommand<ILocalModelsState>('_vsgo.localModels.state');
			this.state = state;
			this.loadError = state ? undefined : localize('localModelsUnavailable', "O serviço de modelos locais não respondeu.");
		} catch (err) {
			this.logService.error('[LocalModels] failed to read state', err);
			this.state = undefined;
			this.loadError = err instanceof Error ? err.message : String(err);
		}
		if (this.disposed) {
			return;
		}
		// A download only changes numbers, and it polls twice a second: rebuilding
		// the list that often would fight the pointer and drop hovers mid-gesture.
		const signature = this.computeSignature();
		if (signature === this.renderSignature) {
			this.updateProgress();
		} else {
			this.renderSignature = signature;
			this.render();
		}
		this.schedulePoll();
	}

	/** Everything that changes the shape of the panel, but not the numbers in it. */
	private computeSignature(): string {
		const state = this.state;
		if (!state) {
			return `error:${this.loadError ?? ''}`;
		}
		const pending = this.pendingConfirm ? `${this.pendingConfirm.id}:${this.pendingConfirm.kind}` : '';
		const runtime = [
			state.runtime.installed ? 1 : 0,
			state.runtime.state,
			state.runtime.install ? 1 : 0,
			state.runtime.baseUrl ?? '',
			state.runtime.message ?? '',
		].join(':');
		const models = state.models.map(m => `${m.id}:${m.installed ? 1 : 0}:${m.download ? 1 : 0}`).join(',');
		return `${state.hardwareSummary}|${runtime}|${pending}|${models}`;
	}

	/** Moves the bars of whatever is in flight, leaving the rest of the DOM alone. */
	private updateProgress(): void {
		const state = this.state;
		if (!state) {
			return;
		}
		if (state.runtime.install && this.runtimeProgress) {
			this.runtimeProgress.status.textContent = state.runtime.install.message;
			setProgress(this.runtimeProgress, state.runtime.install.percent);
		}
		for (const model of state.models) {
			const nodes = model.download && this.progressNodes.get(model.id);
			if (nodes) {
				setProgress(nodes, model.download!.percent, model.download!.label);
			}
		}
	}

	/**
	 * Polls only while a download or install is running. A settled panel makes
	 * no calls at all, so an idle editor costs nothing.
	 */
	private schedulePoll(): void {
		this.stopPolling();
		const busy = !!this.state && (
			!!this.state.runtime.install
			|| this.state.runtime.state === 'starting'
			|| this.state.models.some(m => m.download)
		);
		if (!busy) {
			return;
		}
		this.pollHandle = DOM.getWindow(this.element).setTimeout(() => void this.refresh(), ACTIVE_POLL_MS);
	}

	private stopPolling(): void {
		if (this.pollHandle !== undefined) {
			DOM.getWindow(this.element).clearTimeout(this.pollHandle);
			this.pollHandle = undefined;
		}
	}

	override dispose(): void {
		this.disposed = true;
		super.dispose();
	}

	private render(): void {
		this.renderDisposables.clear();
		this.progressNodes.clear();
		this.runtimeProgress = undefined;
		this.renderHeader();
		this.renderRuntime();
		this.renderList();
	}

	private renderHeader(): void {
		DOM.clearNode(this.headerContainer);
		const description = DOM.append(this.headerContainer, $('p.local-models-description'));
		description.textContent = localize('localModelsInfo', "Modelos que rodam inteiramente nesta máquina — sem chave de API, sem dados saindo do seu computador. Cada item é conferido contra o seu hardware antes de você baixar.");

		if (this.state) {
			const hardware = DOM.append(this.headerContainer, $('.local-models-hardware'));
			const icon = DOM.append(hardware, $('span.local-models-hardware-icon'));
			icon.classList.add(...ThemeIcon.asClassNameArray(Codicon.deviceDesktop));
			const text = DOM.append(hardware, $('span'));
			text.textContent = this.state.hardwareSummary;
		}
	}

	private renderRuntime(): void {
		DOM.clearNode(this.runtimeContainer);
		if (this.loadError) {
			const error = DOM.append(this.runtimeContainer, $('.local-models-error'));
			error.textContent = localize('localModelsError', "Não foi possível falar com o serviço de modelos locais: {0}", this.loadError);
			return;
		}
		const state = this.state;
		if (!state) {
			return;
		}

		// One class drives the whole card's colour so the runtime state is
		// readable at a glance instead of only from the status sentence.
		const health = state.runtime.install ? 'busy' : !state.runtime.installed ? 'missing' : state.runtime.state;
		const card = DOM.append(this.runtimeContainer, $(`.local-models-runtime-card.state-${health}`));
		DOM.append(card, $('span.local-models-runtime-dot'));
		const details = DOM.append(card, $('.local-models-runtime-details'));
		const title = DOM.append(details, $('.local-models-runtime-title'));
		title.textContent = localize('runtimeTitle', "Runtime de inferência (llama.cpp)");
		if (state.runtime.path) {
			this.renderDisposables.add(this.hoverService.setupDelayedHover(title, () => ({
				content: state.runtime.path!,
				appearance: { showPointer: true },
			}), { groupId: 'local-models' }));
		}

		const status = DOM.append(details, $('.local-models-runtime-status'));
		const actions = DOM.append(card, $('.local-models-runtime-actions'));

		if (state.runtime.install) {
			status.textContent = state.runtime.install.message;
			this.runtimeProgress = { ...this.renderProgressBar(details, state.runtime.install.percent), status };
			return;
		}

		if (!state.runtime.installed) {
			status.textContent = localize('runtimeMissing', "Não instalado — necessário antes de qualquer modelo rodar.");
			status.classList.add('not-configured');
			const install = this.renderDisposables.add(new Button(actions, { ...defaultButtonStyles, supportIcons: true }));
			install.label = '$(cloud-download) ' + localize('installRuntime', "Instalar Runtime");
			this.renderDisposables.add(install.onDidClick(() => void this.run('_vsgo.localModels.installRuntime')));
			return;
		}

		switch (state.runtime.state) {
			case 'ready':
				status.textContent = state.runtime.modelName
					? localize('runtimeReadyModel', "Rodando {0} em {1}", state.runtime.modelName, state.runtime.baseUrl ?? '')
					: localize('runtimeReady', "Rodando em {0}", state.runtime.baseUrl ?? '');
				break;
			case 'starting':
				status.textContent = localize('runtimeStarting', "Iniciando…");
				break;
			case 'error':
				status.textContent = state.runtime.message ?? localize('runtimeError', "Falha ao iniciar.");
				status.classList.add('not-configured');
				break;
			default:
				status.textContent = localize('runtimeIdle', "Instalado. Sobe ao clicar em Iniciar, ou na primeira mensagem do chat — sempre com um modelo por vez.");
		}

		if (state.runtime.state === 'ready') {
			const stop = this.renderDisposables.add(new Button(actions, { ...defaultButtonStyles, supportIcons: true, secondary: true }));
			stop.label = '$(debug-stop) ' + localize('stopServer', "Parar");
			this.renderDisposables.add(stop.onDidClick(() => void this.run('_vsgo.localModels.stopServer')));
		} else if (state.models.some(m => m.installed)) {
			const start = this.renderDisposables.add(new Button(actions, { ...defaultButtonStyles, supportIcons: true, secondary: true }));
			start.label = '$(play) ' + localize('startServer', "Iniciar");
			this.renderDisposables.add(start.onDidClick(() => void this.run('_vsgo.localModels.startServer')));
		}

		const folder = this.renderDisposables.add(new Button(actions, { ...defaultButtonStyles, supportIcons: true, secondary: true }));
		folder.label = '$(folder-opened)';
		this.renderDisposables.add(this.hoverService.setupDelayedHover(folder.element, () => ({
			content: localize('openModelsFolder', "Abrir a pasta dos modelos ({0})", state.modelsDirectory),
			appearance: { showPointer: true },
		}), { groupId: 'local-models' }));
		this.renderDisposables.add(folder.onDidClick(() => void this.run('_vsgo.localModels.openFolder')));
	}

	private renderList(): void {
		DOM.clearNode(this.listContainer);
		const state = this.state;
		if (!state) {
			return;
		}
		if (state.models.length === 0) {
			const empty = DOM.append(this.listContainer, $('.local-models-empty'));
			empty.textContent = localize('noCatalog', "Nenhum modelo no catálogo.");
			return;
		}

		// Downloaded models are what the user acts on day to day; the rest of the
		// catalog is a shopping list and reads better under its own heading.
		const downloaded = state.models.filter(m => m.installed);
		const available = state.models.filter(m => !m.installed);

		if (downloaded.length > 0) {
			this.renderSectionHeading(localize('downloadedHeading', "Nesta máquina"), downloaded.length);
			for (const model of downloaded) {
				this.renderModel(model, state);
			}
		}
		if (available.length > 0) {
			this.renderSectionHeading(
				downloaded.length > 0 ? localize('availableHeading', "Disponíveis para baixar") : localize('catalogHeading', "Catálogo"),
				available.length);
			for (const model of available) {
				this.renderModel(model, state);
			}
		}
	}

	private renderSectionHeading(label: string, count: number): void {
		const heading = DOM.append(this.listContainer, $('.local-models-section-heading'));
		const text = DOM.append(heading, $('span'));
		text.textContent = label;
		const badge = DOM.append(heading, $('span.local-models-section-count'));
		badge.textContent = String(count);
	}

	private renderModel(model: ILocalModelEntry, state: ILocalModelsState): void {
		const card = DOM.append(this.listContainer, $('.local-model-card'));
		card.classList.add(`fit-${model.fitLevel}`);
		if (model.installed) {
			card.classList.add('installed');
		}

		const row = DOM.append(card, $('.local-model-row'));

		const icon = DOM.append(row, $('.local-model-icon'));
		icon.classList.add(...ThemeIcon.asClassNameArray(model.installed ? Codicon.checkAll : FIT_ICON[model.fitLevel]));

		const details = DOM.append(row, $('.local-model-details'));
		const nameRow = DOM.append(details, $('.local-model-name-row'));
		const name = DOM.append(nameRow, $('.local-model-name'));
		name.textContent = model.name;

		for (const badge of [model.params, model.sizeLabel, localize('contextBadge', "{0} ctx", model.contextLabel)]) {
			const el = DOM.append(nameRow, $('span.local-model-badge'));
			el.textContent = badge;
		}
		if (model.requiresPatchedRuntime) {
			const el = DOM.append(nameRow, $('span.local-model-badge.warning'));
			el.textContent = localize('patchedRuntimeBadge', "exige runtime modificado");
		}

		const fit = DOM.append(details, $('.local-model-fit'));
		fit.classList.add(model.fitLevel);
		fit.textContent = model.installed
			? model.fitReason
			: `${fitLabel(model.fitLevel)} — ${model.fitReason}`;

		if (model.description) {
			const description = DOM.append(details, $('.local-model-description'));
			description.textContent = model.description;
		}

		const actions = DOM.append(row, $('.local-model-actions'));

		if (model.download) {
			const cancel = this.renderDisposables.add(new Button(actions, { ...defaultButtonStyles, supportIcons: true, secondary: true }));
			cancel.label = '$(stop-circle) ' + localize('pauseDownload', "Pausar");
			this.renderDisposables.add(this.hoverService.setupDelayedHover(cancel.element, () => ({
				content: localize('pauseDownloadTooltip', "Interrompe o download. Ao iniciar de novo, ele continua daqui."),
				appearance: { showPointer: true },
			}), { groupId: 'local-models' }));
			this.renderDisposables.add(cancel.onDidClick(() => void this.run('_vsgo.localModels.cancelDownload', model.id)));
			this.progressNodes.set(model.id, this.renderProgressBar(details, model.download.percent, model.download.label));
			return;
		}

		if (model.installed) {
			const remove = this.renderDisposables.add(new Button(actions, { ...defaultButtonStyles, supportIcons: true, secondary: true }));
			remove.label = '$(trash)';
			this.renderDisposables.add(this.hoverService.setupDelayedHover(remove.element, () => ({
				content: localize('removeModelTooltip', "Excluir este modelo do disco"),
				appearance: { showPointer: true },
			}), { groupId: 'local-models' }));
			this.renderDisposables.add(remove.onDidClick(() => this.setPendingConfirm({ id: model.id, kind: 'remove' })));
		} else {
			const download = this.renderDisposables.add(new Button(actions, { ...defaultButtonStyles, supportIcons: true, secondary: model.fitLevel !== 'ideal' }));
			download.label = '$(cloud-download) ' + localize('downloadModel', "Baixar");
			this.renderDisposables.add(download.onDidClick(() => void this.requestDownload(model, state)));
		}

		if (this.pendingConfirm?.id !== model.id) {
			return;
		}
		if (this.pendingConfirm.kind === 'remove') {
			this.renderConfirm(card, {
				message: localize('removeModelMessage', "Excluir {0} do disco?", model.name),
				details: [localize('removeModelDetail', "Os pesos são removidos desta máquina. Você pode baixá-los de novo depois.")],
				primary: localize('removeModelAction', "Excluir"),
				run: () => this.run('_vsgo.localModels.remove', model.id),
			});
		} else {
			this.renderConfirm(card, {
				message: localize('downloadAnywayMessage', "Baixar {0} mesmo assim?", model.name),
				details: this.downloadWarnings(model, state),
				primary: localize('downloadAnyway', "Baixar Mesmo Assim"),
				run: () => this.run('_vsgo.localModels.download', model.id),
			});
		}
	}

	private renderProgressBar(parent: HTMLElement, percent: number, label?: string): IProgressNodes {
		const wrapper = DOM.append(parent, $('.local-model-progress'));
		const track = DOM.append(wrapper, $('.local-model-progress-track'));
		const bar = DOM.append(track, $('.local-model-progress-bar'));
		const text = DOM.append(wrapper, $('.local-model-progress-label'));
		const nodes: IProgressNodes = { bar, label: text };
		setProgress(nodes, percent, label);
		return nodes;
	}

	/**
	 * Asks in place rather than in a modal: the answer belongs to one card, and a
	 * dialog over the whole window is a heavy way to say "this one is too big".
	 */
	private renderConfirm(card: HTMLElement, options: { message: string; details: readonly string[]; primary: string; run: () => Promise<void> }): void {
		const strip = DOM.append(card, $('.local-model-confirm'));
		const icon = DOM.append(strip, $('span.local-model-confirm-icon'));
		icon.classList.add(...ThemeIcon.asClassNameArray(Codicon.warning));

		const body = DOM.append(strip, $('.local-model-confirm-body'));
		const message = DOM.append(body, $('.local-model-confirm-message'));
		message.textContent = options.message;
		for (const detail of options.details) {
			const line = DOM.append(body, $('.local-model-confirm-detail'));
			line.textContent = detail;
		}

		const confirmActions = DOM.append(strip, $('.local-model-confirm-actions'));
		const confirm = this.renderDisposables.add(new Button(confirmActions, { ...defaultButtonStyles, supportIcons: true }));
		confirm.label = options.primary;
		this.renderDisposables.add(confirm.onDidClick(() => {
			this.pendingConfirm = undefined;
			void options.run();
		}));
		const cancel = this.renderDisposables.add(new Button(confirmActions, { ...defaultButtonStyles, secondary: true }));
		cancel.label = localize('cancelConfirm', "Cancelar");
		this.renderDisposables.add(cancel.onDidClick(() => this.setPendingConfirm(undefined)));
	}

	private setPendingConfirm(pending: { id: string; kind: 'download' | 'remove' } | undefined): void {
		this.pendingConfirm = pending;
		this.renderSignature = this.computeSignature();
		this.render();
	}

	/**
	 * Reasons this download deserves a warning. All of them are shown at once —
	 * a model can be both too large and need a custom runtime.
	 */
	private downloadWarnings(model: ILocalModelEntry, state: ILocalModelsState): string[] {
		const warnings: string[] = [];
		if (model.fitLevel === 'unsupported') {
			warnings.push(localize('tooLargeDetail', "{0} Ele vai falhar ao carregar ou rodar lentíssimo.", model.fitReason));
		}
		if (model.requiresPatchedRuntime) {
			warnings.push(localize('patchedRuntimeDetail', "Esta quantização não está no llama.cpp oficial. O download funciona, mas o modelo só carrega se o binário do runtime acima apontar para uma build com os kernels necessários."));
		}
		if (!state.runtime.installed) {
			warnings.push(localize('runtimeMissingDetail', "O runtime do llama.cpp ainda não está instalado. Você pode baixar os pesos agora, mas nada roda até o runtime estar no lugar."));
		}
		return warnings;
	}

	/** Downloads straight away when there is nothing worth warning about. */
	private async requestDownload(model: ILocalModelEntry, state: ILocalModelsState): Promise<void> {
		if (this.downloadWarnings(model, state).length === 0) {
			await this.run('_vsgo.localModels.download', model.id);
			return;
		}
		this.setPendingConfirm({ id: model.id, kind: 'download' });
	}

	/** Runs an action command and immediately re-reads state so the UI catches up. */
	private async run(command: string, ...args: unknown[]): Promise<void> {
		try {
			await this.commandService.executeCommand(command, ...args);
		} catch (err) {
			this.logService.error(`[LocalModels] ${command} failed`, err);
		}
		await this.refresh();
	}
}
