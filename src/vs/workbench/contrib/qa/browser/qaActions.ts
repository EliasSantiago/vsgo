/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IQaService, QA_VIEW_ID } from '../common/qa.js';

const QA_CATEGORY = localize2('qa.category', "QA");

export class RunQaTestAction extends Action2 {
	static readonly ID = 'vsgo.qa.runTest';
	constructor() {
		super({
			id: RunQaTestAction.ID,
			title: localize2('qa.runTest', "Run AI Test…"),
			category: QA_CATEGORY,
			f1: true,
			icon: Codicon.play,
			menu: {
				id: MenuId.ViewTitle,
				when: ContextKeyExpr.equals('view', QA_VIEW_ID),
				group: 'navigation',
				order: 1,
			},
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInput = accessor.get(IQuickInputService);
		const service = accessor.get(IQaService);
		const prompt = await quickInput.input({
			prompt: localize('qa.intentPrompt', "Describe the test in natural language"),
			placeHolder: localize('qa.intentPlaceholder2', "e.g. Log in with bad password and verify error message"),
		});
		if (!prompt) { return; }
		const startUrl = await quickInput.input({
			prompt: localize('qa.urlPrompt', "Start URL (optional)"),
			placeHolder: 'https://localhost:3000',
		});
		await service.startRun(prompt, { startUrl: startUrl || undefined });
	}
}

export class CancelQaRunAction extends Action2 {
	static readonly ID = 'vsgo.qa.cancelRun';
	constructor() {
		super({
			id: CancelQaRunAction.ID,
			title: localize2('qa.cancelRun', "Stop Current Run"),
			category: QA_CATEGORY,
			f1: true,
			icon: Codicon.debugStop,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const service = accessor.get(IQaService);
		const running = service.getRuns().find(r => r.status === 'running');
		if (!running) { return; }
		service.cancelRun(running.id);
	}
}

export class OpenQaViewAction extends Action2 {
	static readonly ID = 'vsgo.qa.openView';
	constructor() {
		super({
			id: OpenQaViewAction.ID,
			title: localize2('qa.openView', "Show QA"),
			category: QA_CATEGORY,
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const viewsService = accessor.get(IViewsService);
		await viewsService.openView(QA_VIEW_ID, true);
	}
}

export class OpenLatestQaReportAction extends Action2 {
	static readonly ID = 'vsgo.qa.openLastReport';
	constructor() {
		super({
			id: OpenLatestQaReportAction.ID,
			title: localize2('qa.openLastReport', "Open Latest Report"),
			category: QA_CATEGORY,
			f1: true,
			icon: Codicon.fileText,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const service = accessor.get(IQaService);
		const opener = accessor.get(IOpenerService);
		const notif = accessor.get(INotificationService);
		const reportUri = await service.openLatestReport();
		if (!reportUri) {
			notif.info(localize('qa.noReports', "No QA runs yet."));
			return;
		}
		await opener.open(reportUri);
	}
}

export class OpenQaRunsFolderAction extends Action2 {
	static readonly ID = 'vsgo.qa.openRunsFolder';
	constructor() {
		super({
			id: OpenQaRunsFolderAction.ID,
			title: localize2('qa.openRunsFolder', "Open Runs Folder"),
			category: QA_CATEGORY,
			f1: true,
			icon: Codicon.folderOpened,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const service = accessor.get(IQaService);
		const opener = accessor.get(IOpenerService);
		const notif = accessor.get(INotificationService);
		const dir = service.getRunsDirectory();
		if (!dir) {
			notif.info(localize('qa.noWorkspace', "Open a folder to use QA."));
			return;
		}
		await opener.open(dir, { openExternal: true });
	}
}
