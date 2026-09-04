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
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { ISpecDrivenService, SPEC_DRIVEN_VIEW_ID } from '../common/spec.js';
import { SetUpSpecDrivenAction } from './specDrivenActions.js';

/** Set when the user answers "not now" — scoped to the workspace that was declined. */
const DISMISSED_WORKSPACE_KEY = 'specDriven.onboarding.dismissed';
/** Set when the user answers "don't ask again" — suppresses the prompt everywhere. */
const DISMISSED_PROFILE_KEY = 'specDriven.onboarding.dismissedGlobally';

/**
 * Offers to set up Spec Driven Development the first time the user opens the Spec Driven view
 * in a workspace that does not have the structure yet. Scaffolding creates folders in the
 * project root, so the offer waits for the user to show interest instead of greeting every
 * folder that gets opened.
 */
export class SpecDrivenOnboarding extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.specDrivenOnboarding';

	private offered = false;

	constructor(
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@INotificationService private readonly notificationService: INotificationService,
		@IStorageService private readonly storageService: IStorageService,
		@ICommandService private readonly commandService: ICommandService,
		@IViewsService private readonly viewsService: IViewsService,
		@ISpecDrivenService private readonly specDrivenService: ISpecDrivenService,
	) {
		super();
		this._register(this.viewsService.onDidChangeViewVisibility(e => {
			if (e.id === SPEC_DRIVEN_VIEW_ID && e.visible) {
				this.maybeOffer();
			}
		}));
		if (this.viewsService.isViewVisible(SPEC_DRIVEN_VIEW_ID)) {
			this.maybeOffer();
		}
	}

	private async maybeOffer(): Promise<void> {
		if (this.offered) {
			return;
		}
		if (this.workspaceContextService.getWorkbenchState() === WorkbenchState.EMPTY) {
			return;
		}
		if (this.storageService.getBoolean(DISMISSED_PROFILE_KEY, StorageScope.PROFILE, false)) {
			return;
		}
		if (this.storageService.getBoolean(DISMISSED_WORKSPACE_KEY, StorageScope.WORKSPACE, false)) {
			return;
		}

		this.offered = true;
		if (await this.specDrivenService.isSpecKitConfigured()) {
			return;
		}

		this.notificationService.prompt(
			Severity.Info,
			localize(
				'specDriven.onboardingPrompt',
				"Deseja usar Spec Driven Development (SDD) neste projeto? Seguindo o layout do spec-kit, serão criadas `.specify/` (constituição e modelos) e `specs/` na raiz do projeto."
			),
			[
				{
					label: localize('specDriven.onboardingSetUp', "Configurar SDD"),
					run: () => { this.commandService.executeCommand(SetUpSpecDrivenAction.ID); },
				},
				{
					label: localize('specDriven.onboardingLater', "Agora não"),
					run: () => {
						this.storageService.store(DISMISSED_WORKSPACE_KEY, true, StorageScope.WORKSPACE, StorageTarget.MACHINE);
					},
				},
				{
					label: localize('specDriven.onboardingNever', "Não perguntar novamente"),
					run: () => {
						this.storageService.store(DISMISSED_PROFILE_KEY, true, StorageScope.PROFILE, StorageTarget.MACHINE);
					},
				},
			],
			{ sticky: false },
		);
	}
}
