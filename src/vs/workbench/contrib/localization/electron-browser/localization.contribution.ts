/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions as WorkbenchExtensions, IWorkbenchContributionsRegistry } from '../../../common/contributions.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import * as platform from '../../../../base/common/platform.js';
import { IExtensionManagementService, IExtensionGalleryService, InstallOperation, ILocalExtension, InstallExtensionResult, DidUninstallExtensionEvent } from '../../../../platform/extensionManagement/common/extensionManagement.js';
import { INotificationService, NeverShowAgainScope, NotificationPriority } from '../../../../platform/notification/common/notification.js';
import Severity from '../../../../base/common/severity.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { ILocaleService } from '../../../services/localization/common/locale.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { BaseLocalizationWorkbenchContribution } from '../common/localization.contribution.js';

class NativeLocalizationWorkbenchContribution extends BaseLocalizationWorkbenchContribution {

	constructor(
		@INotificationService private readonly notificationService: INotificationService,
		@ILocaleService private readonly localeService: ILocaleService,
		@IProductService private readonly productService: IProductService,
		@IExtensionManagementService private readonly extensionManagementService: IExtensionManagementService,
		@IExtensionGalleryService private readonly galleryService: IExtensionGalleryService,
	) {
		super();

		this.checkAndInstall();
		this._register(this.extensionManagementService.onDidInstallExtensions(e => this.onDidInstallExtensions(e)));
		this._register(this.extensionManagementService.onDidUninstallExtension(e => this.onDidUninstallExtension(e)));
	}

	private async onDidInstallExtensions(results: readonly InstallExtensionResult[]): Promise<void> {
		for (const result of results) {
			if (result.operation === InstallOperation.Install && result.local) {
				await this.onDidInstallExtension(result.local, !!result.context?.extensionsSync);
			}
		}

	}

	private async onDidInstallExtension(localExtension: ILocalExtension, fromSettingsSync: boolean): Promise<void> {
		const localization = localExtension.manifest.contributes?.localizations?.[0];
		if (!localization || platform.language === localization.languageId) {
			return;
		}
		const { languageId, languageName } = localization;

		this.notificationService.prompt(
			Severity.Info,
			localize('updateLocale', "Would you like to change {0}'s display language to {1} and restart?", this.productService.nameLong, languageName || languageId),
			[{
				label: localize('changeAndRestart', "Change Language and Restart"),
				run: async () => {
					await this.localeService.setLocale({
						id: languageId,
						label: languageName ?? languageId,
						extensionId: localExtension.identifier.id,
						// If settings sync installs the language pack, then we would have just shown the notification so no
						// need to show the dialog.
					}, true);
				}
			}],
			{
				sticky: true,
				priority: NotificationPriority.URGENT,
				neverShowAgain: { id: 'langugage.update.donotask', isSecondary: true, scope: NeverShowAgainScope.APPLICATION }
			}
		);
	}

	private async onDidUninstallExtension(_event: DidUninstallExtensionEvent): Promise<void> {
		if (!await this.isLocaleInstalled(platform.language)) {
			this.localeService.setLocale({
				id: 'en',
				label: 'English'
			});
		}
	}

	private async checkAndInstall(): Promise<void> {
		const language = platform.language;
		let locale = platform.locale ?? '';

		if (!this.galleryService.isEnabled()) {
			return;
		}
		if (!language || !locale) {
			return;
		}
		// Locale already matches the active language — nothing to do.
		if (locale.startsWith(language)) {
			return;
		}
		// English requested explicitly — nothing to do.
		if (locale.startsWith('en')) {
			return;
		}

		const installed = await this.isLocaleInstalled(locale);
		if (installed) {
			return;
		}

		// Auto-install the language pack for the configured locale without prompting.
		// This runs on first launch when a non-English locale is set in argv.json
		// (e.g. pt-br) but the pack is not yet installed.
		let tagResult = await this.galleryService.query({ text: `tag:lp-${locale}` }, CancellationToken.None);
		if (tagResult.total === 0) {
			locale = locale.split('-')[0];
			tagResult = await this.galleryService.query({ text: `tag:lp-${locale}` }, CancellationToken.None);
			if (tagResult.total === 0) {
				return;
			}
		}

		const extensionToInstall = tagResult.total === 1 ? tagResult.firstPage[0] : tagResult.firstPage.find(e => e.publisher === 'MS-CEINTL' && e.name.startsWith('vscode-language-pack'));
		if (!extensionToInstall) {
			return;
		}

		const manifest = await this.galleryService.getManifest(extensionToInstall, CancellationToken.None);
		const loc = manifest?.contributes?.localizations?.find(x => locale.startsWith(x.languageId.toLowerCase()));
		const languageName = loc?.languageName ?? locale;

		await this.localeService.setLocale({
			id: locale,
			label: languageName,
			extensionId: extensionToInstall.identifier.id,
			galleryExtension: extensionToInstall
		}, true);
	}

	private async isLocaleInstalled(locale: string): Promise<boolean> {
		const installed = await this.extensionManagementService.getInstalled();
		return installed.some(i => !!i.manifest.contributes?.localizations?.length
			&& i.manifest.contributes.localizations.some(l => locale.startsWith(l.languageId.toLowerCase())));
	}
}

const workbenchRegistry = Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench);
workbenchRegistry.registerWorkbenchContribution(NativeLocalizationWorkbenchContribution, LifecyclePhase.Eventually);
