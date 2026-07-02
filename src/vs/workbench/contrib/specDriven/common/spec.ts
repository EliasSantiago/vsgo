/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const ISpecDrivenService = createDecorator<ISpecDrivenService>('specDrivenService');

export type SpecRunStatus = 'running' | 'done' | 'error' | 'cancelled';
export type SpecProjectType = 'new' | 'existing';
export type SpecPhase = 'context' | 'requirements' | 'stories' | 'architecture' | 'tasks' | 'done';

/** The four generatable document phases (excludes context-gathering). */
export type SpecDocPhase = 'requirements' | 'stories' | 'architecture' | 'tasks';

export const ALL_DOC_PHASES: readonly SpecDocPhase[] = ['requirements', 'stories', 'architecture', 'tasks'];

export interface ISpecArtifacts {
	requirementsUri?: string;
	storiesUri?: string;
	architectureUri?: string;
	tasksUri?: string;
	dirUri?: string;
}

export interface ISpecRun {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly projectType: SpecProjectType;
	readonly selectedPhases: readonly SpecDocPhase[];
	readonly startedAt: number;
	endedAt?: number;
	status: SpecRunStatus;
	currentPhase: SpecPhase;
	phaseIndex: number;
	error?: string;
	artifacts: ISpecArtifacts;
	modelId?: string;
}

export interface ISpecRunOpts {
	readonly projectType?: SpecProjectType;
	/** Which document phases to generate. Defaults to all four. */
	readonly selectedPhases?: readonly SpecDocPhase[];
}

export interface ISpecKitScaffoldResult {
	/** Whether at least one file was created (false when everything already existed). */
	readonly created: boolean;
	/** URI of the constitution document, suitable for opening in an editor. */
	readonly constitutionUri?: URI;
}

export interface ISpecDrivenService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeRuns: Event<void>;
	readonly onDidChangeRun: Event<string>;
	startRun(description: string, opts?: ISpecRunOpts): Promise<string>;
	cancelRun(runId: string): void;
	getRuns(): readonly ISpecRun[];
	getRun(id: string): ISpecRun | undefined;
	getSpecsDirectory(): URI | undefined;
	/** Whether the workspace already has a Spec Driven Development structure set up. */
	isSpecKitConfigured(): Promise<boolean>;
	/**
	 * Scaffolds the Spec Driven Development structure (constitution, templates and a seed spec)
	 * in the first workspace folder. Existing files are never overwritten.
	 */
	scaffoldSpecKit(): Promise<ISpecKitScaffoldResult>;
}

export interface ISpecDrivenConfiguration {
	readonly modelVendor: string;
	readonly modelId: string;
	readonly persistRuns: boolean;
	readonly runRetention: number;
}

export const SPEC_DRIVEN_VIEW_CONTAINER_ID = 'workbench.view.specDriven';
export const SPEC_DRIVEN_VIEW_ID = 'workbench.view.specDriven.runs';
export const SPEC_DRIVEN_CONFIG_SECTION = 'specDriven';
export const SPEC_DRIVEN_DIR_NAME = '.vsgo';
export const SPEC_DRIVEN_SUBDIR = 'specs';

// ─── Spec Kit scaffolding (Spec Driven Development structure) ──────────────────
/** Folder holding non-negotiable project principles. */
export const SPEC_KIT_MEMORY_DIR = 'memory';
export const SPEC_KIT_CONSTITUTION_FILE = 'constitution.md';
/** Folder holding the blank document templates. */
export const SPEC_KIT_SPECIFY_DIR = '.specify';
export const SPEC_KIT_TEMPLATES_DIR = 'templates';
/** Folder holding one `NNN-slug` sub-folder per domain. */
export const SPEC_KIT_SPECS_DIR = 'specs';
