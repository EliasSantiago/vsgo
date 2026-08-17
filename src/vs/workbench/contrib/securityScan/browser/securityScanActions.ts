/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ViewAction } from '../../../browser/parts/views/viewPane.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { selectAiFeatureModel } from '../../chat/common/aiFeatureModel.js';
import { ISecurityScanService, SECURITY_SCAN_CONFIG_SECTION, SECURITY_SCAN_FEATURE, SECURITY_SCAN_VIEW_ID } from '../common/securityScan.js';
import { SecurityScanView } from './securityScanView.js';

const SECURITY_SCAN_CATEGORY = localize2('securityScan.category', "Security Scan");

export class ScanWorkspaceAction extends Action2 {
	static readonly ID = 'securityScan.scanWorkspace';
	constructor() {
		super({
			id: ScanWorkspaceAction.ID,
			title: localize2('securityScan.scanWorkspace', "Scan Workspace for Vulnerabilities"),
			category: SECURITY_SCAN_CATEGORY,
			f1: true,
			icon: Codicon.refresh,
			menu: {
				id: MenuId.ViewTitle,
				when: ContextKeyExpr.equals('view', SECURITY_SCAN_VIEW_ID),
				group: 'navigation',
				order: 1,
			},
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const viewsService = accessor.get(IViewsService);
		const securityScanService = accessor.get(ISecurityScanService);
		await viewsService.openView(SECURITY_SCAN_VIEW_ID, true);
		await securityScanService.scanWorkspace();
	}
}

export class ScanActiveFileAction extends Action2 {
	static readonly ID = 'securityScan.scanActiveFile';
	constructor() {
		super({
			id: ScanActiveFileAction.ID,
			title: localize2('securityScan.scanActiveFile', "Scan Active File for Vulnerabilities"),
			category: SECURITY_SCAN_CATEGORY,
			f1: true,
			icon: Codicon.fileCode,
			menu: {
				id: MenuId.ViewTitle,
				when: ContextKeyExpr.equals('view', SECURITY_SCAN_VIEW_ID),
				group: 'navigation',
				order: 2,
			},
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const viewsService = accessor.get(IViewsService);
		const securityScanService = accessor.get(ISecurityScanService);
		const resource = editorService.activeEditor?.resource;
		if (!resource) {
			return;
		}
		await viewsService.openView(SECURITY_SCAN_VIEW_ID, true);
		await securityScanService.scanFile(resource);
	}
}

export class StopScanAction extends Action2 {
	static readonly ID = 'securityScan.stopScan';
	constructor() {
		super({
			id: StopScanAction.ID,
			title: localize2('securityScan.stopScan', "Stop Scan"),
			category: SECURITY_SCAN_CATEGORY,
			f1: true,
			icon: Codicon.debugStop,
			menu: {
				id: MenuId.ViewTitle,
				when: ContextKeyExpr.equals('view', SECURITY_SCAN_VIEW_ID),
				group: 'navigation',
				order: 3,
			},
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		accessor.get(ISecurityScanService).stopScan();
	}
}

export class ClearFindingsAction extends Action2 {
	static readonly ID = 'securityScan.clear';
	constructor() {
		super({
			id: ClearFindingsAction.ID,
			title: localize2('securityScan.clear', "Clear Findings"),
			category: SECURITY_SCAN_CATEGORY,
			f1: true,
			icon: Codicon.clearAll,
			menu: {
				id: MenuId.ViewTitle,
				when: ContextKeyExpr.equals('view', SECURITY_SCAN_VIEW_ID),
				group: 'navigation',
				order: 4,
			},
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		accessor.get(ISecurityScanService).clearFindings();
	}
}

export class ToggleShowIgnoredAction extends ViewAction<SecurityScanView> {
	static readonly ID = 'securityScan.toggleShowIgnored';
	constructor() {
		super({
			id: ToggleShowIgnoredAction.ID,
			title: localize2('securityScan.toggleShowIgnored', "Show Ignored Findings"),
			category: SECURITY_SCAN_CATEGORY,
			f1: true,
			icon: Codicon.eyeClosed,
			toggled: ContextKeyExpr.equals('securityScan.showIgnored', true),
			menu: {
				id: MenuId.ViewTitle,
				when: ContextKeyExpr.equals('view', SECURITY_SCAN_VIEW_ID),
				group: 'navigation',
				order: 5,
			},
			viewId: SECURITY_SCAN_VIEW_ID,
		});
	}
	override runInView(_accessor: ServicesAccessor, view: SecurityScanView): void {
		view.toggleShowIgnored();
	}
}

export class OpenSecurityScanViewAction extends Action2 {
	static readonly ID = 'securityScan.openView';
	constructor() {
		super({
			id: OpenSecurityScanViewAction.ID,
			title: localize2('securityScan.openView', "Show Security Findings"),
			category: SECURITY_SCAN_CATEGORY,
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IViewsService).openView(SECURITY_SCAN_VIEW_ID, true);
	}
}

export class IgnoreFindingCommand extends Action2 {
	static readonly ID = 'securityScan.ignoreFinding';
	constructor() {
		super({
			id: IgnoreFindingCommand.ID,
			title: localize2('securityScan.ignoreFinding', "Ignore Finding"),
			category: SECURITY_SCAN_CATEGORY,
		});
	}
	async run(accessor: ServicesAccessor, findingId?: string): Promise<void> {
		if (!findingId) { return; }
		accessor.get(ISecurityScanService).ignoreFinding(findingId);
	}
}

export class UnignoreFindingCommand extends Action2 {
	static readonly ID = 'securityScan.unignoreFinding';
	constructor() {
		super({
			id: UnignoreFindingCommand.ID,
			title: localize2('securityScan.unignoreFinding', "Unignore Finding"),
			category: SECURITY_SCAN_CATEGORY,
		});
	}
	async run(accessor: ServicesAccessor, findingId?: string): Promise<void> {
		if (!findingId) { return; }
		accessor.get(ISecurityScanService).unignoreFinding(findingId);
	}
}

export class ApplyFixCommand extends Action2 {
	static readonly ID = 'securityScan.applyFix';
	constructor() {
		super({
			id: ApplyFixCommand.ID,
			title: localize2('securityScan.applyFix', "Apply Suggested Fix"),
			category: SECURITY_SCAN_CATEGORY,
		});
	}
	async run(accessor: ServicesAccessor, findingId?: string): Promise<void> {
		if (!findingId) { return; }
		const service = accessor.get(ISecurityScanService);
		const finding = service.getFindings(true).find(f => f.id === findingId);
		if (finding) {
			await service.applyFix(finding);
		}
	}
}

export class OpenLatestReportAction extends Action2 {
	static readonly ID = 'securityScan.openLatestReport';
	constructor() {
		super({
			id: OpenLatestReportAction.ID,
			title: localize2('securityScan.openLatestReport', "Open Latest Report"),
			category: SECURITY_SCAN_CATEGORY,
			f1: true,
			icon: Codicon.json,
			menu: {
				id: MenuId.ViewTitle,
				when: ContextKeyExpr.equals('view', SECURITY_SCAN_VIEW_ID),
				group: 'navigation',
				order: 6,
			},
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const service = accessor.get(ISecurityScanService);
		const editorService = accessor.get(IEditorService);
		const notificationService = accessor.get(INotificationService);
		const uri = service.getLatestReportUri();
		if (!uri) {
			notificationService.info(localize('securityScan.noReport', "No security scan report has been generated yet."));
			return;
		}
		await editorService.openEditor({ resource: uri, options: { revealIfOpened: true } });
	}
}

export class OpenReportsFolderAction extends Action2 {
	static readonly ID = 'securityScan.openReportsFolder';
	constructor() {
		super({
			id: OpenReportsFolderAction.ID,
			title: localize2('securityScan.openReportsFolder', "Open Reports Folder"),
			category: SECURITY_SCAN_CATEGORY,
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const service = accessor.get(ISecurityScanService);
		const openerService = accessor.get(IOpenerService);
		const notificationService = accessor.get(INotificationService);
		const dir = service.getReportsDirectory();
		if (!dir) {
			notificationService.info(localize('securityScan.noReportsDir', "Reports directory is not available."));
			return;
		}
		await openerService.open(dir, { openExternal: true });
	}
}

export class ExportReportAction extends Action2 {
	static readonly ID = 'securityScan.exportReport';
	constructor() {
		super({
			id: ExportReportAction.ID,
			title: localize2('securityScan.exportReport', "Export Report…"),
			category: SECURITY_SCAN_CATEGORY,
			f1: true,
			icon: Codicon.export,
			menu: {
				id: MenuId.ViewTitle,
				when: ContextKeyExpr.equals('view', SECURITY_SCAN_VIEW_ID),
				group: 'navigation',
				order: 7,
			},
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const service = accessor.get(ISecurityScanService);
		const fileDialogService = accessor.get(IFileDialogService);
		const notificationService = accessor.get(INotificationService);
		const defaultUri = await fileDialogService.defaultFilePath();
		const target = await fileDialogService.showSaveDialog({
			title: localize('securityScan.exportTitle', "Export Security Scan Report"),
			// Markdown first: exporting is something a person does to read or to
			// send the result to someone. SARIF stays for the tools that consume
			// it — GitHub code scanning and CI gates — and JSON for scripts.
			defaultUri: defaultUri ? URI.joinPath(defaultUri, `security-scan-${new Date().toISOString().replace(/[:.]/g, '-')}.md`) : undefined,
			filters: [
				{ name: 'Markdown', extensions: ['md'] },
				{ name: 'SARIF', extensions: ['sarif'] },
				{ name: 'JSON', extensions: ['json'] },
			],
		});
		if (!target) { return; }
		const ok = await service.exportReport(target);
		if (ok) {
			notificationService.info(localize('securityScan.exportOk', "Security scan report exported to {0}", target.fsPath));
		}
	}
}

export class RevealFindingCommand extends Action2 {
	static readonly ID = 'securityScan.revealFinding';
	constructor() {
		super({
			id: RevealFindingCommand.ID,
			title: localize2('securityScan.revealFinding', "Reveal Finding"),
			category: SECURITY_SCAN_CATEGORY,
		});
	}
	async run(accessor: ServicesAccessor, findingId?: string): Promise<void> {
		if (!findingId) { return; }
		const service = accessor.get(ISecurityScanService);
		const finding = service.getFindings(true).find(f => f.id === findingId);
		if (!finding) { return; }
		const editorService = accessor.get(IEditorService);
		await editorService.openEditor({
			resource: URI.from(finding.resource),
			options: { selection: finding.range, revealIfOpened: true },
		});
	}
}

/**
 * Lets the user say which model the scan runs on. Without it the choice lived
 * only in `security.scan.modelId`, and an empty setting quietly meant whichever
 * provider registered first.
 */
export class SelectSecurityScanModelAction extends Action2 {
	static readonly ID = 'securityScan.selectModel';
	constructor() {
		super({
			id: SelectSecurityScanModelAction.ID,
			title: localize2('securityScan.selectModel', "Select Model for Security Scan"),
			category: SECURITY_SCAN_CATEGORY,
			f1: true,
			icon: Codicon.chip,
			menu: {
				id: MenuId.ViewTitle,
				when: ContextKeyExpr.equals('view', SECURITY_SCAN_VIEW_ID),
				group: 'navigation',
				order: 8,
			},
		});
	}
	run(accessor: ServicesAccessor): Promise<void> {
		return selectAiFeatureModel(accessor, SECURITY_SCAN_FEATURE);
	}
}

/**
 * Opens the project's own scan instructions, creating them from a template the
 * first time. The built-in prompt is not editable — it owns the JSON contract
 * the parser depends on — so what a project gets to add is guidance appended
 * after it.
 */
export class EditScanInstructionsAction extends Action2 {
	static readonly ID = 'securityScan.editInstructions';
	constructor() {
		super({
			id: EditScanInstructionsAction.ID,
			title: localize2('securityScan.editInstructions', "Edit Scan Instructions"),
			category: SECURITY_SCAN_CATEGORY,
			f1: true,
			icon: Codicon.book,
			menu: {
				id: MenuId.ViewTitle,
				when: ContextKeyExpr.equals('view', SECURITY_SCAN_VIEW_ID),
				group: 'navigation',
				order: 9,
			},
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const configurationService = accessor.get(IConfigurationService);
		const workspaceContextService = accessor.get(IWorkspaceContextService);
		const fileService = accessor.get(IFileService);
		const editorService = accessor.get(IEditorService);
		const notificationService = accessor.get(INotificationService);

		const folder = workspaceContextService.getWorkspace().folders[0];
		if (!folder) {
			notificationService.info(localize('securityScan.instructionsNoWorkspace', "Abra uma pasta para definir instruções de scan."));
			return;
		}
		const relative = configurationService.getValue<string>(`${SECURITY_SCAN_CONFIG_SECTION}.instructionsFile`) || '.vsgo/security/instructions.md';
		const target = URI.joinPath(folder.uri, relative);
		if (!(await fileService.exists(target))) {
			await fileService.createFile(target, VSBuffer.fromString(INSTRUCTIONS_TEMPLATE));
		}
		await editorService.openEditor({ resource: target });
	}
}

const INSTRUCTIONS_TEMPLATE = `# Instruções de scan de segurança

O texto deste arquivo é anexado ao prompt da revisão por IA, depois das instruções
padrão. O formato da resposta continua fixo — descreva contexto, não formato.

## Modelo de ameaças

<!-- Quem é o atacante e o que ele quer. Ex.: usuário autenticado tentando ler
     dados de outro tenant; visitante anônimo em rotas públicas. -->

## O que é confiável neste projeto

<!-- Ex.: tudo que passa por \`withAuth()\` já teve a sessão validada.
     \`db.query\` recebe sempre parâmetros posicionais. -->

## O que merece atenção redobrada

<!-- Ex.: qualquer rota sob /api/admin; o fluxo de upload; o webhook de pagamento. -->

## Falsos positivos conhecidos

<!-- Ex.: \`renderMarkdown()\` já sanitiza; não reportar o innerHTML dentro dela. -->
`;
