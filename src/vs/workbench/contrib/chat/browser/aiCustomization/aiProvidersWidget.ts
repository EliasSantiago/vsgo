/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/aiCustomizationManagement.css';
import * as DOM from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { IExtensionService } from '../../../../services/extensions/common/extensions.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { LocalModelsWidget } from './localModelsWidget.js';
import { ILanguageModelProviderDescriptor, ILanguageModelsService } from '../../common/languageModels.js';
import { ILanguageModelsConfigurationService, ILanguageModelsProviderGroup } from '../../common/languageModelsConfiguration.js';
import Severity from '../../../../../base/common/severity.js';

const $ = DOM.$;

/**
 * Section widget for the AI Customization Management Editor that lists
 * registered language model providers (Anthropic, OpenAI, Gemini, Ollama, ...)
 * and lets the user attach API keys / endpoints to them.
 *
 * Backed by the same workbench services as the Models section: provider
 * descriptors come from `ILanguageModelsService`, configured "groups"
 * (named credential bundles) come from `ILanguageModelsConfigurationService`.
 */
export class AIProvidersWidget extends Disposable {

	readonly element: HTMLElement;

	private readonly _onDidChangeItemCount = this._register(new Emitter<number>());
	readonly onDidChangeItemCount = this._onDidChangeItemCount.event;

	private readonly listDisposables = this._register(new DisposableStore());
	private listContainer!: HTMLElement;
	private headerText!: HTMLElement;
	private itemCount = 0;

	/** Drill-down shown in place of the provider list; created on first use. */
	private localModelsContainer!: HTMLElement;
	private localModelsWidget: LocalModelsWidget | undefined;
	private breadcrumbTitle: HTMLElement | undefined;

	constructor(
		@ILanguageModelsService private readonly languageModelsService: ILanguageModelsService,
		@ILanguageModelsConfigurationService private readonly languageModelsConfigurationService: ILanguageModelsConfigurationService,
		@IHoverService private readonly hoverService: IHoverService,
		@IDialogService private readonly dialogService: IDialogService,
		@ICommandService private readonly commandService: ICommandService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IExtensionService private readonly extensionService: IExtensionService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super();
		this.element = $('.ai-providers-widget');
		this.create();

		this._register(this.languageModelsService.onDidChangeLanguageModelVendors(() => this.refresh()));
		this._register(this.languageModelsConfigurationService.onDidChangeLanguageModelGroups(() => this.refresh()));
		this._register(this.languageModelsService.onDidChangeLanguageModels(() => this.refresh()));
	}

	private create(): void {
		const header = DOM.append(this.element, $('.ai-providers-header'));
		this.headerText = DOM.append(header, $('p.ai-providers-description'));
		this.headerText.textContent = localize('aiProvidersInfo', "Vincule chaves de API aos provedores de IA para habilitar no chat os modelos da Anthropic, OpenAI, Gemini, Mistral, Groq, DeepSeek, xAI e outros. Cada provedor pode ter várias configurações nomeadas.");

		this.listContainer = DOM.append(this.element, $('.ai-providers-list'));
		this.localModelsContainer = DOM.append(this.element, $('.ai-providers-drilldown'));
		DOM.setVisibility(false, this.localModelsContainer);
		this.refresh();
	}

	private refresh(): void {
		this.listDisposables.clear();
		DOM.clearNode(this.listContainer);

		const vendors = this.languageModelsService.getVendors();
		const groups = this.languageModelsConfigurationService.getLanguageModelsProviderGroups();

		const groupsByVendor = new Map<string, ILanguageModelsProviderGroup[]>();
		for (const g of groups) {
			const list = groupsByVendor.get(g.vendor) ?? [];
			list.push(g);
			groupsByVendor.set(g.vendor, list);
		}

		if (vendors.length === 0) {
			const empty = DOM.append(this.listContainer, $('.ai-providers-empty'));
			empty.textContent = localize('noVendorsRegistered', "Nenhum provedor de IA registrado no momento. Verifique se a extensão de chat está habilitada.");
		}

		// Sort: configured providers first, then alphabetically by display name
		const sortedVendors = vendors.slice().sort((a, b) => {
			const aConfigured = (groupsByVendor.get(a.vendor)?.length ?? 0) > 0 ? 0 : 1;
			const bConfigured = (groupsByVendor.get(b.vendor)?.length ?? 0) > 0 ? 0 : 1;
			if (aConfigured !== bConfigured) {
				return aConfigured - bConfigured;
			}
			return a.displayName.localeCompare(b.displayName);
		});

		for (const vendor of sortedVendors) {
			this.renderVendor(vendor, groupsByVendor.get(vendor.vendor) ?? []);
		}

		this.itemCount = vendors.length;
		this._onDidChangeItemCount.fire(this.itemCount);
	}

	private renderVendor(vendor: ILanguageModelProviderDescriptor, groups: readonly ILanguageModelsProviderGroup[]): void {
		const card = DOM.append(this.listContainer, $('.ai-provider-card'));

		const headerRow = DOM.append(card, $('.ai-provider-row'));

		const iconEl = DOM.append(headerRow, $('.ai-provider-icon'));
		iconEl.classList.add(...ThemeIcon.asClassNameArray(Codicon.sparkle));

		const details = DOM.append(headerRow, $('.ai-provider-details'));
		const nameEl = DOM.append(details, $('.ai-provider-name'));
		nameEl.textContent = vendor.displayName;

		// A provider that hosts its own weights and declares no credential schema
		// has nothing to configure: its models come from local downloads, so the
		// model manager replaces the configuration flow entirely.
		const manageCommand = vendor.manageModelsCommand;
		const selfManaged = !!manageCommand && !vendor.configuration;

		// An account-backed provider — the vsgo account — has no credential to
		// type either: signing in through the browser is what produces it. It
		// declares `managementCommand` and no configuration schema, and the
		// generic "Configurar" flow below would only prompt for a name and a key
		// that do not exist for it.
		const accountCommand = !vendor.configuration && !selfManaged ? vendor.managementCommand : undefined;

		// Both credential-less kinds count models instead of configurations: it is
		// the only signal they have that the provider is actually usable.
		const modelCount = accountCommand || selfManaged
			? this.languageModelsService.getLanguageModelGroups(vendor.vendor)
				.reduce((total, group) => total + group.modelIdentifiers.length, 0)
			: 0;

		const subEl = DOM.append(details, $('.ai-provider-status'));
		if (accountCommand) {
			if (modelCount === 0) {
				subEl.textContent = localize('accountNotConnected', "Nenhuma conta conectada");
				subEl.classList.add('not-configured');
			} else {
				subEl.textContent = modelCount === 1
					? localize('oneModelInAccount', "1 modelo na sua conta")
					: localize('nModelsInAccount', "{0} modelos na sua conta", modelCount);
			}
		} else if (selfManaged) {
			if (modelCount === 0) {
				subEl.textContent = localize('noModelsDownloaded', "Nenhum modelo baixado");
				subEl.classList.add('not-configured');
			} else {
				subEl.textContent = modelCount === 1
					? localize('oneModelDownloaded', "1 modelo baixado")
					: localize('nModelsDownloaded', "{0} modelos baixados", modelCount);
			}
		} else if (groups.length === 0) {
			subEl.textContent = localize('notConfigured', "Não configurado");
			subEl.classList.add('not-configured');
		} else if (groups.length === 1) {
			subEl.textContent = localize('oneConfigured', "1 configuração");
		} else {
			subEl.textContent = localize('nConfigured', "{0} configurações", groups.length);
		}

		const actions = DOM.append(headerRow, $('.ai-provider-actions'));

		if (manageCommand) {
			const manageBtn = this.listDisposables.add(new Button(actions, { ...defaultButtonStyles, supportIcons: true, secondary: !selfManaged }));
			manageBtn.label = '$(cloud-download) ' + localize('manageLocalModels', "Gerenciar Modelos");
			this.listDisposables.add(this.hoverService.setupDelayedHover(manageBtn.element, () => ({ content: localize('manageLocalModelsTooltip', "Explore, baixe e remova modelos que rodam nesta máquina"), appearance: { showPointer: true } }), { groupId: 'ai-providers' }));
			this.listDisposables.add(manageBtn.onDidClick(() => {
				void this.showLocalModels(vendor, manageCommand);
			}));
		}

		if (accountCommand) {
			const accountBtn = this.listDisposables.add(new Button(actions, { ...defaultButtonStyles, supportIcons: true }));
			accountBtn.label = '$(account) ' + localize('manageAccount', "Gerenciar Conta");
			this.listDisposables.add(this.hoverService.setupDelayedHover(accountBtn.element, () => ({ content: localize('manageAccountTooltip', "Entre na sua conta para usar os modelos que o seu plano libera"), appearance: { showPointer: true } }), { groupId: 'ai-providers' }));
			this.listDisposables.add(accountBtn.onDidClick(async () => {
				try {
					await this.commandService.executeCommand(accountCommand, vendor.vendor);
				} catch {
					this.notificationService.info(localize('accountUnavailable', "O gerenciamento da conta não está disponível no momento."));
				}
			}));
		} else if (!selfManaged) {
			const primaryBtn = this.listDisposables.add(new Button(actions, { ...defaultButtonStyles, supportIcons: true, secondary: groups.length > 0 }));
			primaryBtn.label = groups.length === 0
				? '$(add) ' + localize('configureProvider', "Configurar")
				: '$(add) ' + localize('addAnotherProvider', "Adicionar Configuração");
			this.listDisposables.add(primaryBtn.onDidClick(() => {
				void this.languageModelsService.configureLanguageModelsProviderGroup(vendor.vendor);
			}));
		}

		for (const group of groups) {
			const groupRow = DOM.append(card, $('.ai-provider-group-row'));

			const groupDetails = DOM.append(groupRow, $('.ai-provider-group-details'));
			const groupName = DOM.append(groupDetails, $('.ai-provider-group-name'));
			groupName.textContent = group.name;

			const modelGroup = this.languageModelsService.getLanguageModelGroups(vendor.vendor)
				.find(g => g.group?.name === group.name);
			const modelCount = modelGroup?.modelIdentifiers.length ?? 0;
			const groupMeta = DOM.append(groupDetails, $('.ai-provider-group-meta'));
			groupMeta.textContent = modelCount === 1
				? localize('oneModelAvailable', "1 modelo disponível")
				: localize('nModelsAvailable', "{0} modelos disponíveis", modelCount);

			const groupActions = DOM.append(groupRow, $('.ai-provider-group-actions'));

			const editBtn = this.listDisposables.add(new Button(groupActions, { ...defaultButtonStyles, supportIcons: true, secondary: true }));
			editBtn.label = '$(gear)';
			this.listDisposables.add(this.hoverService.setupDelayedHover(editBtn.element, () => ({ content: localize('editGroupTooltip', "Editar configuração"), appearance: { showPointer: true } }), { groupId: 'ai-providers' }));
			this.listDisposables.add(editBtn.onDidClick(() => {
				void this.languageModelsService.configureLanguageModelsProviderGroup(vendor.vendor, group.name);
			}));

			const removeBtn = this.listDisposables.add(new Button(groupActions, { ...defaultButtonStyles, supportIcons: true, secondary: true }));
			removeBtn.label = '$(trash)';
			this.listDisposables.add(this.hoverService.setupDelayedHover(removeBtn.element, () => ({ content: localize('removeGroupTooltip', "Remover configuração"), appearance: { showPointer: true } }), { groupId: 'ai-providers' }));
			this.listDisposables.add(removeBtn.onDidClick(async () => {
				const confirmation = await this.dialogService.confirm({
					message: localize('removeConfirmMessage', "Remover a configuração \"{0}\" de {1}?", group.name, vendor.displayName),
					detail: localize('removeConfirmDetail', "A chave de API será removida do armazenamento seguro. Você pode adicioná-la de novo depois."),
					primaryButton: localize('removeAction', "Remover"),
					type: Severity.Warning,
				});
				if (confirmation.confirmed) {
					await this.languageModelsService.removeLanguageModelsProviderGroup(vendor.vendor, group.name);
				}
			}));
		}
	}

	/**
	 * Swaps the provider list for the local models panel.
	 *
	 * Falls back to running the vendor's own command when the panel cannot be
	 * served — a third-party provider may declare `manageModelsCommand` without
	 * implementing the local models protocol the panel speaks.
	 */
	/**
	 * Whether the local models backend is reachable.
	 *
	 * `_vsgo.localModels.state` is registered at runtime by the provider extension
	 * rather than declared in its manifest, so calling it cannot activate that
	 * extension. On a window that has just opened the first probe therefore fails
	 * even though the backend is about to exist — wait for startup activation and
	 * ask again before giving up.
	 */
	private async hasLocalModelsBackend(): Promise<boolean> {
		const probe = () => this.commandService.executeCommand('_vsgo.localModels.state').then(() => true, () => false);
		if (await probe()) {
			return true;
		}

		await this.extensionService.activateByEvent('onStartupFinished');
		return probe();
	}

	private async showLocalModels(vendor: ILanguageModelProviderDescriptor, fallbackCommand: string): Promise<void> {
		if (!this.localModelsWidget) {
			const known = await this.hasLocalModelsBackend();
			if (!known) {
				// Providers that manage models through their own UI handle this
				// themselves. If that call fails too, say so — silently reopening
				// the editor the user is already looking at reads as a dead button.
				try {
					await this.commandService.executeCommand(fallbackCommand);
				} catch {
					this.notificationService.info(localize('localModelsUnavailable', "O gerenciamento de modelos locais não está disponível no momento."));
				}
				return;
			}
			this.localModelsWidget = this._register(this.instantiationService.createInstance(LocalModelsWidget));

			const backBar = DOM.append(this.localModelsContainer, $('.local-models-back-bar'));
			const backBtn = this._register(new Button(backBar, { ...defaultButtonStyles, supportIcons: true, secondary: true }));
			backBtn.label = '$(arrow-left) ' + localize('backToProviders', "Todos os Provedores");
			this._register(backBtn.onDidClick(() => this.showProviderList()));

			// Breadcrumb, so the panel reads as a place inside this editor rather
			// than a screen that replaced it.
			const crumb = DOM.append(backBar, $('.local-models-breadcrumb'));
			const crumbRoot = DOM.append(crumb, $('span.local-models-breadcrumb-root'));
			crumbRoot.textContent = localize('providersCrumb', "Provedores de IA");
			const crumbSeparator = DOM.append(crumb, $('span.local-models-breadcrumb-separator'));
			crumbSeparator.classList.add(...ThemeIcon.asClassNameArray(Codicon.chevronRight));
			this.breadcrumbTitle = DOM.append(crumb, $('span.local-models-breadcrumb-current'));

			this.localModelsContainer.appendChild(this.localModelsWidget.element);
		}

		this.breadcrumbTitle!.textContent = vendor.displayName;
		DOM.setVisibility(false, this.headerText);
		DOM.setVisibility(false, this.listContainer);
		DOM.setVisibility(true, this.localModelsContainer);
		await this.localModelsWidget.show();
	}

	private showProviderList(): void {
		this.localModelsWidget?.hide();
		DOM.setVisibility(true, this.headerText);
		DOM.setVisibility(true, this.listContainer);
		DOM.setVisibility(false, this.localModelsContainer);
		this.refresh();
	}

	fireItemCount(): void {
		this._onDidChangeItemCount.fire(this.itemCount);
	}
}
