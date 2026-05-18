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
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
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
	private itemCount = 0;

	constructor(
		@ILanguageModelsService private readonly languageModelsService: ILanguageModelsService,
		@ILanguageModelsConfigurationService private readonly languageModelsConfigurationService: ILanguageModelsConfigurationService,
		@IHoverService private readonly hoverService: IHoverService,
		@IDialogService private readonly dialogService: IDialogService,
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
		const headerText = DOM.append(header, $('p.ai-providers-description'));
		headerText.textContent = localize('aiProvidersInfo', "Attach API keys to AI providers to enable Anthropic (Claude), OpenAI, Gemini, Ollama and other models in chat. Each provider can have multiple named configurations.");

		this.listContainer = DOM.append(this.element, $('.ai-providers-list'));
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
			empty.textContent = localize('noVendorsRegistered', "No AI providers are currently registered. Make sure the chat extension is enabled.");
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

		const subEl = DOM.append(details, $('.ai-provider-status'));
		if (groups.length === 0) {
			subEl.textContent = localize('notConfigured', "Not configured");
			subEl.classList.add('not-configured');
		} else if (groups.length === 1) {
			subEl.textContent = localize('oneConfigured', "1 configuration");
		} else {
			subEl.textContent = localize('nConfigured', "{0} configurations", groups.length);
		}

		const actions = DOM.append(headerRow, $('.ai-provider-actions'));

		const primaryBtn = this.listDisposables.add(new Button(actions, { ...defaultButtonStyles, supportIcons: true, secondary: groups.length > 0 }));
		primaryBtn.label = groups.length === 0
			? localize('configureProvider', "$(add) Configure")
			: localize('addAnotherProvider', "$(add) Add Configuration");
		this.listDisposables.add(primaryBtn.onDidClick(() => {
			void this.languageModelsService.configureLanguageModelsProviderGroup(vendor.vendor);
		}));

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
				? localize('oneModelAvailable', "1 model available")
				: localize('nModelsAvailable', "{0} models available", modelCount);

			const groupActions = DOM.append(groupRow, $('.ai-provider-group-actions'));

			const editBtn = this.listDisposables.add(new Button(groupActions, { ...defaultButtonStyles, supportIcons: true, secondary: true }));
			editBtn.label = '$(gear)';
			this.listDisposables.add(this.hoverService.setupDelayedHover(editBtn.element, () => ({ content: localize('editGroupTooltip', "Edit configuration"), appearance: { showPointer: true } }), { groupId: 'ai-providers' }));
			this.listDisposables.add(editBtn.onDidClick(() => {
				void this.languageModelsService.configureLanguageModelsProviderGroup(vendor.vendor, group.name);
			}));

			const removeBtn = this.listDisposables.add(new Button(groupActions, { ...defaultButtonStyles, supportIcons: true, secondary: true }));
			removeBtn.label = '$(trash)';
			this.listDisposables.add(this.hoverService.setupDelayedHover(removeBtn.element, () => ({ content: localize('removeGroupTooltip', "Remove configuration"), appearance: { showPointer: true } }), { groupId: 'ai-providers' }));
			this.listDisposables.add(removeBtn.onDidClick(async () => {
				const confirmation = await this.dialogService.confirm({
					message: localize('removeConfirmMessage', "Remove the \"{0}\" configuration for {1}?", group.name, vendor.displayName),
					detail: localize('removeConfirmDetail', "The API key will be removed from secure storage. You can add it again later."),
					primaryButton: localize('removeAction', "Remove"),
					type: Severity.Warning,
				});
				if (confirmation.confirmed) {
					await this.languageModelsService.removeLanguageModelsProviderGroup(vendor.vendor, group.name);
				}
			}));
		}
	}

	fireItemCount(): void {
		this._onDidChangeItemCount.fire(this.itemCount);
	}
}
