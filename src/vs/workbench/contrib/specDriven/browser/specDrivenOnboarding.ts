/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { ISpecDrivenService } from '../common/spec.js';
import { SetUpSpecDrivenAction } from './specDrivenActions.js';

const DISMISSED_STORAGE_KEY = 'specDriven.onboarding.dismissed';

/**
 * Offers to set up Spec Driven Development when a workspace folder is open and the structure
 * is not yet present. The prompt is suppressed once the user chooses "don't ask again"
 * (remembered per workspace) or dismisses it for the current session.
 */
export class SpecDrivenOnboarding extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.specDrivenOnboarding';

	private dismissedThisSession = false;
	private offering = false;

	constructor(
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@INotificationService private readonly notificationService: INotificationService,
		@IStorageService private readonly storageService: IStorageService,
		@ICommandService private readonly commandService: ICommandService,
		@ISpecDrivenService private readonly specDrivenService: ISpecDrivenService,
	) {
		super();
		this.maybeOffer();
		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(() => this.maybeOffer()));
	}

	private async maybeOffer(): Promise<void> {
		if (this.offering || this.dismissedThisSession) {
			return;
		}
		if (this.workspaceContextService.getWorkbenchState() === WorkbenchState.EMPTY) {
			return;
		}
		if (this.storageService.getBoolean(DISMISSED_STORAGE_KEY, StorageScope.WORKSPACE, false)) {
			return;
		}

		this.offering = true;
		try {
			if (await this.specDrivenService.isSpecKitConfigured()) {
				return;
			}

			this.notificationService.prompt(
				Severity.Info,
				localize('specDriven.onboardingPrompt', "Deseja usar Spec Driven Development (SDD) neste projeto? Será criada a estrutura de constituição, modelos e specs."),
				[
					{
						label: localize('specDriven.onboardingSetUp', "Configurar SDD"),
						run: () => { this.commandService.executeCommand(SetUpSpecDrivenAction.ID); },
					},
					{
						label: localize('specDriven.onboardingLater', "Agora não"),
						run: () => { this.dismissedThisSession = true; },
					},
					{
						label: localize('specDriven.onboardingNever', "Não perguntar novamente"),
						run: () => {
							this.dismissedThisSession = true;
							this.storageService.store(DISMISSED_STORAGE_KEY, true, StorageScope.WORKSPACE, StorageTarget.MACHINE);
						},
					},
				],
				{ sticky: false },
			);
		} finally {
			this.offering = false;
		}
	}
}
