/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { ILanguageModelsService } from '../common/languageModels.js';
import { ILanguageModelsConfigurationService } from '../common/languageModelsConfiguration.js';
import { getAIBrandShort } from '../common/chatBranding.js';
import { CONFIGURE_AI_PROVIDER_ACTION_ID, MANAGE_AI_PROVIDERS_ACTION_ID } from './actions/chatLanguageModelActions.js';

const STATUS_ENTRY_ID = 'workbench.statusBar.chatProvider';

export class ChatProviderStatusContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.chatProviderStatus';

	private readonly entry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());

	constructor(
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@ILanguageModelsService private readonly languageModelsService: ILanguageModelsService,
		@ILanguageModelsConfigurationService private readonly languageModelsConfigurationService: ILanguageModelsConfigurationService,
		@IProductService private readonly productService: IProductService,
	) {
		super();

		this.render();

		this._register(this.languageModelsService.onDidChangeLanguageModels(() => this.render()));
		this._register(this.languageModelsService.onDidChangeLanguageModelVendors(() => this.render()));
		this._register(this.languageModelsConfigurationService.onDidChangeLanguageModelGroups(() => this.render()));
	}

	private render(): void {
		const entry = this.buildEntry();
		if (this.entry.value) {
			this.entry.value.update(entry);
		} else {
			this.entry.value = this.statusbarService.addEntry(
				entry,
				STATUS_ENTRY_ID,
				StatusbarAlignment.RIGHT,
				100, // priority — sits to the right of language/encoding entries
			);
		}
	}

	private buildEntry(): IStatusbarEntry {
		const groups = this.languageModelsConfigurationService.getLanguageModelsProviderGroups();
		const productName = getAIBrandShort(this.productService);

		if (groups.length === 0) {
			const text = localize('chatProvider.notConfigured', '$(sparkle) AI: Not configured');
			return {
				name: localize('chatProvider.statusName', 'AI Provider'),
				text,
				ariaLabel: localize('chatProvider.notConfiguredAria', 'No AI provider configured. Click to set up.'),
				command: CONFIGURE_AI_PROVIDER_ACTION_ID,
				tooltip: localize('chatProvider.notConfiguredTooltip', "Configure an AI provider for {0} (OpenAI, Anthropic, Gemini, Ollama, …).", productName),
				kind: 'prominent',
				showInAllWindows: true,
			};
		}

		const distinctVendors = new Set(groups.map(g => g.vendor));
		const vendors = this.languageModelsService.getVendors();
		const vendorLabels = Array.from(distinctVendors)
			.map(id => vendors.find(v => v.vendor === id)?.displayName ?? id);

		const tooltipLines = groups.map(g => {
			const vendor = vendors.find(v => v.vendor === g.vendor);
			return `• ${g.name} — ${vendor?.displayName ?? g.vendor}`;
		});

		const summary = vendorLabels.length === 1
			? vendorLabels[0]
			: localize('chatProvider.multipleSummary', '{0} providers', vendorLabels.length);

		return {
			name: localize('chatProvider.statusName', 'AI Provider'),
			text: `$(sparkle) ${summary}`,
			ariaLabel: localize('chatProvider.configuredAria', 'AI providers active: {0}. Click to manage.', vendorLabels.join(', ')),
			command: MANAGE_AI_PROVIDERS_ACTION_ID,
			tooltip: localize('chatProvider.configuredTooltip', "AI providers configured for {0}:\n{1}\n\nClick to manage.", productName, tooltipLines.join('\n')),
			showInAllWindows: true,
		};
	}
}
