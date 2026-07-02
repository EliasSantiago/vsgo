/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const IQaService = createDecorator<IQaService>('qaService');

export type QaRunStatus = 'running' | 'passed' | 'failed' | 'cancelled' | 'error';
export type QaVerdict = 'pass' | 'fail';

export interface IInteractiveElement {
	readonly id: number;
	readonly role: string;
	readonly label: string;
	readonly bbox: [number, number, number, number];
}

export interface ICaptureResult {
	readonly url: string;
	readonly title: string;
	readonly screenshotDataBase64: string;
	readonly elements: readonly IInteractiveElement[];
}

export interface IQaRunOpts {
	readonly startUrl?: string;
	readonly headless?: boolean;
	readonly maxSteps?: number;
	readonly timeoutMs?: number;
	readonly allowDestructiveActions?: boolean;
}

export interface IQaToolCall {
	readonly tool: string;
	readonly args: Record<string, unknown>;
}

export interface IQaStepObservation {
	readonly url?: string;
	readonly screenshotRel?: string;
	readonly text?: string;
	readonly ok: boolean;
	readonly error?: string;
}

export interface IQaStep {
	readonly index: number;
	readonly thought: string;
	readonly action: IQaToolCall;
	readonly observation: IQaStepObservation;
	readonly durationMs: number;
}

export interface IQaAssertion {
	readonly text: string;
	readonly passed: boolean;
	readonly evidenceScreenshotRel?: string;
}

export interface IQaRunArtifacts {
	screenshotsDir?: string;
	transcriptPath?: string;
	junitPath?: string;
	reportPath?: string;
	tracePath?: string;
}

export interface IQaRun {
	readonly id: string;
	readonly prompt: string;
	readonly startUrl?: string;
	readonly startedAt: number;
	endedAt?: number;
	status: QaRunStatus;
	verdict?: QaVerdict;
	summary?: string;
	currentStepIndex?: number;
	currentScreenshotRel?: string;
	readonly steps: IQaStep[];
	readonly assertions: IQaAssertion[];
	artifacts: IQaRunArtifacts;
	modelId?: string;
}

export interface IQaService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeRuns: Event<void>;
	readonly onDidChangeRun: Event<string>;
	startRun(prompt: string, opts?: IQaRunOpts): Promise<string>;
	cancelRun(runId: string): void;
	getRuns(): readonly IQaRun[];
	getRun(id: string): IQaRun | undefined;
	getRunsDirectory(): URI | undefined;
	openLatestReport(): Promise<URI | undefined>;
}

export interface IQaConfiguration {
	readonly defaultStartUrl: string;
	readonly headless: boolean;
	readonly maxSteps: number;
	readonly timeoutMs: number;
	readonly modelVendor: string;
	readonly modelId: string;
	readonly persistRuns: boolean;
	readonly runRetention: number;
	readonly requireConfirmationForDestructive: boolean;
}

export const QA_VIEW_CONTAINER_ID = 'workbench.view.qa';
export const QA_VIEW_ID = 'workbench.view.qa.runs';
export const QA_PREVIEW_VIEW_ID = 'workbench.view.qa.preview';
export const QA_CONFIG_SECTION = 'qa';
export const QA_DIR_NAME = '.vsgo';
export const QA_SUBDIR = 'qa';
