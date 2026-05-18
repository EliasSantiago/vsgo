/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { IRange } from '../../../../editor/common/core/range.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const ISecurityScanService = createDecorator<ISecurityScanService>('securityScanService');

export type FindingSeverity = 'error' | 'warning' | 'info';

export interface IFindingFix {
	readonly explanation: string;
	readonly range: IRange;
	readonly newText: string;
}

export interface IFinding {
	readonly id: string;
	readonly resource: URI;
	readonly range: IRange;
	readonly severity: FindingSeverity;
	readonly title: string;
	readonly description: string;
	readonly cwe?: string;
	readonly fix?: IFindingFix;
}

export const enum ScanState {
	Idle = 'idle',
	Scanning = 'scanning',
}

export interface IScanProgress {
	readonly state: ScanState;
	readonly current: number;
	readonly total: number;
	readonly currentFile?: string;
	readonly error?: string;
}

export interface ISecurityScanReport {
	readonly version: number;
	readonly generatedAt: string;
	readonly workspaceFolders: string[];
	readonly modelId?: string;
	readonly findings: ISerializedFinding[];
}

export interface ISerializedFinding {
	readonly id: string;
	readonly resource: string;
	readonly range: IRange;
	readonly severity: FindingSeverity;
	readonly title: string;
	readonly description: string;
	readonly cwe?: string;
	readonly fix?: IFindingFix;
	readonly ignored?: boolean;
}

export interface ISecurityScanService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeFindings: Event<void>;
	readonly onDidChangeProgress: Event<IScanProgress>;
	readonly progress: IScanProgress;
	readonly lastScanAt: number | undefined;
	getFindings(includeIgnored?: boolean): readonly IFinding[];
	isIgnored(id: string): boolean;
	ignoreFinding(id: string): void;
	unignoreFinding(id: string): void;
	clearFindings(): void;
	scanWorkspace(token?: CancellationToken): Promise<void>;
	scanFile(resource: URI, token?: CancellationToken): Promise<void>;
	stopScan(): void;
	applyFix(finding: IFinding): Promise<boolean>;
	getReportsDirectory(): URI | undefined;
	getLatestReportUri(): URI | undefined;
	exportReport(targetUri: URI): Promise<boolean>;
}

export const SECURITY_SCAN_VIEW_CONTAINER_ID = 'workbench.view.securityScan';
export const SECURITY_SCAN_VIEW_ID = 'workbench.view.securityScan.findings';
export const SECURITY_SCAN_MARKER_OWNER = 'securityScan';
export const SECURITY_SCAN_CONFIG_SECTION = 'security.scan';

export interface ISecurityScanConfiguration {
	readonly include: string[];
	readonly exclude: string[];
	readonly maxFileSizeKB: number;
	readonly concurrency: number;
	readonly modelVendor: string;
	readonly modelId: string;
	readonly severityThreshold: FindingSeverity;
	readonly autoScanOnSave: boolean;
	readonly persistReports: boolean;
	readonly reportRetention: number;
}
