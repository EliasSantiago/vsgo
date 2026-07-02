/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { registerAction2 } from '../../../../platform/actions/common/actions.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { Extensions as ViewContainerExtensions, IViewContainersRegistry, IViewsRegistry, ViewContainer, ViewContainerLocation } from '../../../common/views.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { ISecurityScanService, SECURITY_SCAN_CONFIG_SECTION, SECURITY_SCAN_VIEW_CONTAINER_ID, SECURITY_SCAN_VIEW_ID, ScanState } from '../common/securityScan.js';
import { SecurityScanService } from './securityScanService.js';
import { SecurityScanView } from './securityScanView.js';
import {
	ApplyFixCommand,
	ClearFindingsAction,
	ExportReportAction,
	IgnoreFindingCommand,
	OpenLatestReportAction,
	OpenReportsFolderAction,
	OpenSecurityScanViewAction,
	RevealFindingCommand,
	ScanActiveFileAction,
	ScanWorkspaceAction,
	StopScanAction,
	ToggleShowIgnoredAction,
	UnignoreFindingCommand,
} from './securityScanActions.js';

// Service
registerSingleton(ISecurityScanService, SecurityScanService, InstantiationType.Delayed);

// View container in the Activity Bar
const securityScanIcon = registerIcon('security-scan-view-icon', Codicon.shield, localize('securityScanViewIcon', "View icon of the security scan view."));

const VIEW_CONTAINER: ViewContainer = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry).registerViewContainer({
	id: SECURITY_SCAN_VIEW_CONTAINER_ID,
	title: localize2('securityScan.containerTitle', "Security Scan"),
	icon: securityScanIcon,
	order: 6,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [SECURITY_SCAN_VIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: SECURITY_SCAN_VIEW_CONTAINER_ID,
	hideIfEmpty: false,
}, ViewContainerLocation.Sidebar);

// Findings view
Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry).registerViews([{
	id: SECURITY_SCAN_VIEW_ID,
	containerIcon: securityScanIcon,
	name: localize2('securityScan.viewTitle', "Findings"),
	canToggleVisibility: true,
	canMoveView: true,
	ctorDescriptor: new SyncDescriptor(SecurityScanView),
	openCommandActionDescriptor: {
		id: 'workbench.view.securityScan.open',
		mnemonicTitle: localize({ key: 'miSecurityScan', comment: ['&& denotes a mnemonic'] }, "&&Security Scan"),
		order: 5,
	},
}], VIEW_CONTAINER);

// Configuration
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: SECURITY_SCAN_CONFIG_SECTION,
	order: 50,
	title: localize('securityScan.configTitle', "Security Scan"),
	type: 'object',
	properties: {
		[`${SECURITY_SCAN_CONFIG_SECTION}.include`]: {
			type: 'array',
			items: { type: 'string' },
			default: ['**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,rs,java,rb,php,cs,cpp,c,h,hpp,sh,sql,html,vue,svelte}'],
			markdownDescription: localize('securityScan.include', "Glob patterns of files to include in the workspace scan."),
		},
		[`${SECURITY_SCAN_CONFIG_SECTION}.exclude`]: {
			type: 'array',
			items: { type: 'string' },
			default: ['**/node_modules/**', '**/out/**', '**/dist/**', '**/build/**', '**/.git/**', '**/.next/**', '**/coverage/**'],
			markdownDescription: localize('securityScan.exclude', "Glob patterns to exclude from the workspace scan. Combined with `#files.exclude#`."),
		},
		[`${SECURITY_SCAN_CONFIG_SECTION}.maxFileSizeKB`]: {
			type: 'number',
			default: 100,
			minimum: 1,
			markdownDescription: localize('securityScan.maxFileSize', "Skip files larger than this size (in KB). Larger files consume more tokens."),
		},
		[`${SECURITY_SCAN_CONFIG_SECTION}.concurrency`]: {
			type: 'number',
			default: 3,
			minimum: 1,
			maximum: 16,
			markdownDescription: localize('securityScan.concurrency', "How many files to scan in parallel."),
		},
		[`${SECURITY_SCAN_CONFIG_SECTION}.modelVendor`]: {
			type: 'string',
			default: '',
			markdownDescription: localize('securityScan.modelVendor', "Preferred AI provider vendor (empty = any available)."),
		},
		[`${SECURITY_SCAN_CONFIG_SECTION}.modelId`]: {
			type: 'string',
			default: '',
			markdownDescription: localize('securityScan.modelId', "Preferred model identifier (empty = first available for vendor)."),
		},
		[`${SECURITY_SCAN_CONFIG_SECTION}.severityThreshold`]: {
			type: 'string',
			enum: ['error', 'warning', 'info'],
			default: 'info',
			markdownDescription: localize('securityScan.severityThreshold', "Minimum severity to report. Findings below this level are discarded."),
		},
		[`${SECURITY_SCAN_CONFIG_SECTION}.autoScanOnSave`]: {
			type: 'boolean',
			default: false,
			markdownDescription: localize('securityScan.autoScanOnSave', "Automatically scan a file when it is saved."),
		},
		[`${SECURITY_SCAN_CONFIG_SECTION}.persistReports`]: {
			type: 'boolean',
			default: true,
			markdownDescription: localize('securityScan.persistReports', "Persist scan results as `latest.json` (internal) and `latest.sarif` (SARIF v2.1.0 interchange) inside `.vsgo/security/` in the workspace root, and restore them on startup."),
		},
		[`${SECURITY_SCAN_CONFIG_SECTION}.reportRetention`]: {
			type: 'number',
			default: 10,
			minimum: 1,
			markdownDescription: localize('securityScan.reportRetention', "How many timestamped report archives to keep. Older reports are deleted automatically."),
		},
	},
});

// Actions
registerAction2(ScanWorkspaceAction);
registerAction2(ScanActiveFileAction);
registerAction2(StopScanAction);
registerAction2(ClearFindingsAction);
registerAction2(ToggleShowIgnoredAction);
registerAction2(OpenSecurityScanViewAction);
registerAction2(ApplyFixCommand);
registerAction2(IgnoreFindingCommand);
registerAction2(UnignoreFindingCommand);
registerAction2(RevealFindingCommand);
registerAction2(OpenLatestReportAction);
registerAction2(OpenReportsFolderAction);
registerAction2(ExportReportAction);

// Status bar entry
class SecurityScanStatusBar extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.securityScanStatusBar';

	private readonly entry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());

	constructor(
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@ISecurityScanService private readonly securityScanService: ISecurityScanService,
	) {
		super();
		this.update();
		this._register(this.securityScanService.onDidChangeFindings(() => this.update()));
		this._register(this.securityScanService.onDidChangeProgress(() => this.update()));
	}

	private update(): void {
		const props = this.buildEntry();
		if (!props) {
			this.entry.value = undefined;
			return;
		}
		if (this.entry.value) {
			this.entry.value.update(props);
		} else {
			this.entry.value = this.statusbarService.addEntry(props, 'status.securityScan', StatusbarAlignment.RIGHT, 99);
		}
	}

	private buildEntry(): IStatusbarEntry | undefined {
		const progress = this.securityScanService.progress;
		if (progress.state === ScanState.Scanning) {
			return {
				name: localize('securityScan.statusName', "Security Scan"),
				text: progress.total > 0
					? '$(sync~spin) ' + localize('securityScan.statusScanningCount', "Scanning {0}/{1}", progress.current, progress.total)
					: '$(sync~spin) ' + localize('securityScan.statusScanning', "Scanning…"),
				ariaLabel: localize('securityScan.statusAria', "Security scan in progress"),
				tooltip: localize('securityScan.statusScanningTooltip', "Security scan in progress. Click to open the Security view."),
				command: 'securityScan.openView',
				showInAllWindows: false,
			};
		}
		const findings = this.securityScanService.getFindings();
		if (findings.length === 0) {
			return undefined;
		}
		const counts: Record<'error' | 'warning' | 'info', number> = { error: 0, warning: 0, info: 0 };
		for (const f of findings) { counts[f.severity]++; }
		const text = `$(shield) ${findings.length}`;
		return {
			name: localize('securityScan.statusName', "Security Scan"),
			text,
			ariaLabel: localize('securityScan.statusFindingsAria', "{0} security findings", findings.length),
			tooltip: localize('securityScan.statusTooltip', "Security findings — {0} error, {1} warning, {2} info. Click to open.", counts.error, counts.warning, counts.info),
			command: 'securityScan.openView',
			showInAllWindows: false,
		};
	}
}

registerWorkbenchContribution2(SecurityScanStatusBar.ID, SecurityScanStatusBar, WorkbenchPhase.AfterRestored);
