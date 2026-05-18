/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { localize } from '../../../../nls.js';
import { ContextKeyExpr, IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { ILanguageModelsService } from '../common/languageModels.js';
import { ILanguageModelsConfigurationService } from '../common/languageModelsConfiguration.js';
import { getAIBrandLong } from '../common/chatBranding.js';
import { chatViewsWelcomeRegistry } from './viewsWelcome/chatViewsWelcome.js';
import { CONFIGURE_AI_PROVIDER_ACTION_ID } from './actions/chatLanguageModelActions.js';

const HasNoConfiguredAIProvider = new RawContextKey<boolean>('chatHasNoConfiguredAIProvider', true, {
	type: 'boolean',
	description: localize('chatHasNoConfiguredAIProvider', "True when no AI provider has been configured yet (BYOK).")
});

export class ChatBYOKWelcomeContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.chatBYOKWelcome';

	private static registered = false;

	private readonly hasNoProvider: IContextKey<boolean>;

	constructor(
		@IContextKeyService contextKeyService: IContextKeyService,
		@ILanguageModelsService private readonly languageModelsService: ILanguageModelsService,
		@ILanguageModelsConfigurationService private readonly languageModelsConfigurationService: ILanguageModelsConfigurationService,
		@IProductService productService: IProductService,
	) {
		super();

		this.hasNoProvider = HasNoConfiguredAIProvider.bindTo(contextKeyService);
		this.updateContextKey();

		this._register(this.languageModelsService.onDidChangeLanguageModels(() => this.updateContextKey()));
		this._register(this.languageModelsConfigurationService.onDidChangeLanguageModelGroups(() => this.updateContextKey()));

		if (!ChatBYOKWelcomeContribution.registered) {
			ChatBYOKWelcomeContribution.registered = true;
			const productName = getAIBrandLong(productService);
			chatViewsWelcomeRegistry.register({
				icon: Codicon.sparkle,
				title: localize('chat.byokWelcomeTitle', "Set up your AI provider"),
				content: new MarkdownString(localize(
					'chat.byokWelcomeBody',
					"Bring your own keys to chat with your favorite models in {0}.\n\n[Configure AI Provider...](command:{1})\n\nSupports Anthropic, OpenAI, Gemini, Ollama, OpenRouter, X.AI, Azure OpenAI and Custom OAI-compatible endpoints.",
					productName,
					CONFIGURE_AI_PROVIDER_ACTION_ID,
				), { isTrusted: { enabledCommands: [CONFIGURE_AI_PROVIDER_ACTION_ID] } }),
				when: ContextKeyExpr.equals(HasNoConfiguredAIProvider.key, true),
			});
		}
	}

	private updateContextKey(): void {
		const groups = this.languageModelsConfigurationService.getLanguageModelsProviderGroups();
		const hasModels = this.languageModelsService.getLanguageModelIds().length > 0;
		this.hasNoProvider.set(groups.length === 0 && !hasModels);
	}
}
