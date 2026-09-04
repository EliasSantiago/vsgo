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

/** Where a finding came from, which decides how much to trust it. */
export type FindingSource = 'rule' | 'ai';

export interface IFinding {
	readonly id: string;
	readonly resource: URI;
	readonly range: IRange;
	readonly severity: FindingSeverity;
	readonly title: string;
	readonly description: string;
	readonly cwe?: string;
	readonly fix?: IFindingFix;
	/** A pattern that matched, or a model that judged. Defaults to the model. */
	readonly source?: FindingSource;
	/** Identifier of the rule that fired, for findings from a rule. */
	readonly ruleId?: string;
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
	/**
	 * Which stage of the scan is running. A scan walks the codebase one layer at
	 * a time, and on a slow model a file count alone leaves no way to tell a
	 * working scan from a stuck one.
	 */
	readonly phase?: IScanPhase;
}

export interface IScanPhase {
	/** What is being examined, e.g. "Rotas e endpoints". */
	readonly label: string;
	/** 1-based. */
	readonly index: number;
	readonly total: number;
	/** Set while a model is being waited on, which is the slow part. */
	readonly aiReview?: boolean;
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
	readonly source?: FindingSource;
	readonly ruleId?: string;
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

/** Identifies this feature to the shared model picker. */
export const SECURITY_SCAN_FEATURE = { configSection: SECURITY_SCAN_CONFIG_SECTION, title: 'Security Scan' };

export interface ISecurityScanConfiguration {
	readonly include: string[];
	readonly exclude: string[];
	readonly maxFileSizeKB: number;
	readonly concurrency: number;
	readonly modelVendor: string;
	readonly modelId: string;
	readonly severityThreshold: FindingSeverity;
	/** Whether a model reviews the code after the deterministic rules have run. */
	readonly aiReview: boolean;
	/** Ceiling on files sent to the model in one scan; the rules always see all of them. */
	readonly aiReviewMaxFiles: number;
	/** Workspace-relative file whose text is appended to the review prompt. */
	readonly instructionsFile: string;
	readonly autoScanOnSave: boolean;
	readonly persistReports: boolean;
	readonly reportRetention: number;
}
