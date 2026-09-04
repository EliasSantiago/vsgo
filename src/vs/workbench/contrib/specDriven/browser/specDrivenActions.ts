/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { selectAiFeatureModel } from '../../chat/common/aiFeatureModel.js';
import { ISpecDrivenService, SPEC_DRIVEN_FEATURE, SPEC_DRIVEN_VIEW_ID } from '../common/spec.js';

const SPEC_DRIVEN_CATEGORY = localize2('specDriven.category', "Spec Driven");

export class OpenSpecDrivenViewAction extends Action2 {
	static readonly ID = 'specDriven.openView';
	constructor() {
		super({
			id: OpenSpecDrivenViewAction.ID,
			title: localize2('specDriven.openView', "Show Spec Driven View"),
			category: SPEC_DRIVEN_CATEGORY,
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IViewsService).openView(SPEC_DRIVEN_VIEW_ID, true);
	}
}

export class CancelSpecRunCommand extends Action2 {
	static readonly ID = 'specDriven.cancelRun';
	constructor() {
		super({
			id: CancelSpecRunCommand.ID,
			title: localize2('specDriven.cancelRun', "Cancel Spec Generation"),
			category: SPEC_DRIVEN_CATEGORY,
			icon: Codicon.debugStop,
			menu: {
				id: MenuId.ViewTitle,
				when: ContextKeyExpr.equals('view', SPEC_DRIVEN_VIEW_ID),
				group: 'navigation',
				order: 1,
			},
		});
	}
	async run(accessor: ServicesAccessor, runId?: string): Promise<void> {
		if (!runId) { return; }
		accessor.get(ISpecDrivenService).cancelRun(runId);
	}
}

export class SetUpSpecDrivenAction extends Action2 {
	static readonly ID = 'specDriven.setUp';
	constructor() {
		super({
			id: SetUpSpecDrivenAction.ID,
			title: localize2('specDriven.setUp', "Set Up Spec Driven Development in This Project"),
			category: SPEC_DRIVEN_CATEGORY,
			f1: true,
			icon: Codicon.checklist,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const service = accessor.get(ISpecDrivenService);
		const editorService = accessor.get(IEditorService);
		const notificationService = accessor.get(INotificationService);

		const result = await service.scaffoldSpecKit();
		if (result.constitutionUri) {
			await editorService.openEditor({ resource: result.constitutionUri });
		}
		if (result.migrated) {
			notificationService.info(localize('specDriven.migratedConstitution', "A constituição foi movida de `memory/` para `.specify/memory/`, seguindo o layout do spec-kit."));
		} else if (!result.created && result.constitutionUri) {
			notificationService.info(localize('specDriven.alreadySetUp', "Spec Driven Development já está configurado neste projeto."));
		}
	}
}

export class OpenSpecsFolderAction extends Action2 {
	static readonly ID = 'specDriven.openSpecsFolder';
	constructor() {
		super({
			id: OpenSpecsFolderAction.ID,
			title: localize2('specDriven.openSpecsFolder', "Open Specs Folder"),
			category: SPEC_DRIVEN_CATEGORY,
			f1: true,
			icon: Codicon.folder,
			menu: {
				id: MenuId.ViewTitle,
				when: ContextKeyExpr.equals('view', SPEC_DRIVEN_VIEW_ID),
				group: 'navigation',
				order: 2,
			},
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const service = accessor.get(ISpecDrivenService);
		const openerService = accessor.get(IOpenerService);
		const notificationService = accessor.get(INotificationService);
		const dir = service.getSpecsDirectory();
		if (!dir) {
			notificationService.info(localize('specDriven.noSpecsDir', "Specs directory is not available. Open a workspace folder first."));
			return;
		}
		await openerService.open(dir, { openExternal: true });
	}
}

/** Lets the user say which model generates the spec, plan and tasks documents. */
export class SelectSpecDrivenModelAction extends Action2 {
	static readonly ID = 'specDriven.selectModel';
	constructor() {
		super({
			id: SelectSpecDrivenModelAction.ID,
			title: localize2('specDriven.selectModel', "Select Model for Spec Driven"),
			category: SPEC_DRIVEN_CATEGORY,
			f1: true,
			icon: Codicon.chip,
			menu: {
				id: MenuId.ViewTitle,
				when: ContextKeyExpr.equals('view', SPEC_DRIVEN_VIEW_ID),
				group: 'navigation',
				order: 3,
			},
		});
	}
	run(accessor: ServicesAccessor): Promise<void> {
		return selectAiFeatureModel(accessor, SPEC_DRIVEN_FEATURE);
	}
}
