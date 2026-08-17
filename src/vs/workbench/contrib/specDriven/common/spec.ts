/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const ISpecDrivenService = createDecorator<ISpecDrivenService>('specDrivenService');

export type SpecRunStatus = 'running' | 'done' | 'error' | 'cancelled';
export type SpecProjectType = 'new' | 'existing';
export type SpecPhase = 'context' | 'spec' | 'plan' | 'tasks' | 'done';

/**
 * The three documents of a spec-kit feature folder (excludes context-gathering):
 * `spec.md` says what and why, `plan.md` says how, `tasks.md` breaks the plan into work.
 */
export type SpecDocPhase = 'spec' | 'plan' | 'tasks';

export const ALL_DOC_PHASES: readonly SpecDocPhase[] = ['spec', 'plan', 'tasks'];

export interface ISpecArtifacts {
	specUri?: string;
	planUri?: string;
	tasksUri?: string;
	dirUri?: string;
}

export interface ISpecRun {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly projectType: SpecProjectType;
	readonly selectedPhases: readonly SpecDocPhase[];
	/** Existing feature folder this run revises, when it is not creating a new one. */
	readonly targetFolder?: string;
	readonly startedAt: number;
	endedAt?: number;
	status: SpecRunStatus;
	currentPhase: SpecPhase;
	phaseIndex: number;
	error?: string;
	artifacts: ISpecArtifacts;
	/** Model this run actually generated with. */
	modelId?: string;
	/** Model asked for by the caller, when it overrode the feature's setting. */
	readonly requestedModelId?: string;
}

export interface ISpecRunOpts {
	readonly projectType?: SpecProjectType;
	/** Which documents to generate. Defaults to all three. */
	readonly selectedPhases?: readonly SpecDocPhase[];
	/**
	 * Existing `NNN-slug` folder to write into. When set, the run revises that feature instead of
	 * allocating a new folder, and its current documents are fed back to the model as the base.
	 */
	readonly targetFolder?: string;
	/**
	 * Model to generate with, overriding this feature's own setting.
	 *
	 * Set when the run was started from the chat, where the user has a model
	 * picker in front of them: honouring the setting instead would generate on a
	 * model they can see they did not choose.
	 */
	readonly modelId?: string;
}

/** An existing feature folder under `specs/`, as far as it can be told from its `spec.md`. */
export interface ISpecFolderInfo {
	/** Folder name, e.g. `002-autenticacao`. */
	readonly folder: string;
	readonly title: string;
	readonly summary: string;
}

export interface ISpecKitScaffoldResult {
	/** Whether at least one file was created (false when everything already existed). */
	readonly created: boolean;
	/** URI of the constitution document, suitable for opening in an editor. */
	readonly constitutionUri?: URI;
	/** Whether a constitution from the pre-`.specify` layout was moved into place. */
	readonly migrated?: boolean;
}

export interface ISpecDrivenService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeRuns: Event<void>;
	readonly onDidChangeRun: Event<string>;
	startRun(description: string, opts?: ISpecRunOpts): Promise<string>;
	cancelRun(runId: string): void;
	getRuns(): readonly ISpecRun[];
	getRun(id: string): ISpecRun | undefined;
	/** Directory holding the generated documents, versioned with the project. */
	getSpecsDirectory(): URI | undefined;
	/** Existing feature folders under `specs/`, newest number first. */
	listSpecFolders(): Promise<readonly ISpecFolderInfo[]>;
	/**
	 * Asks the model which existing feature a request continues, so a follow-up lands in the spec
	 * it belongs to instead of creating a near-duplicate. Returns the folder name, or `undefined`
	 * when the request is about something new or the match is not clear enough to act on.
	 */
	matchSpecFolder(description: string, token?: CancellationToken): Promise<string | undefined>;
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

/** Identifies this feature to the shared model picker. */
export const SPEC_DRIVEN_FEATURE = { configSection: SPEC_DRIVEN_CONFIG_SECTION, title: 'Spec Driven' };
/**
 * Subdirectory of the vsgo artifacts folder holding the run index. Only machine state lives
 * there — the generated documents go to {@link SPEC_KIT_SPECS_DIR} so they can be reviewed
 * and committed with the project.
 */
export const SPEC_DRIVEN_STATE_SUBDIR = 'specs';

// ─── Spec Kit scaffolding (Spec Driven Development structure) ──────────────────
// Layout follows GitHub's spec-kit: everything the tooling owns lives under `.specify`,
// while the specs themselves stay in `specs/` at the project root.
/** Folder owned by the tooling, holding the constitution and the blank templates. */
export const SPEC_KIT_SPECIFY_DIR = '.specify';
/** Sub-folder of `.specify` holding non-negotiable project principles. */
export const SPEC_KIT_MEMORY_DIR = 'memory';
export const SPEC_KIT_CONSTITUTION_FILE = 'constitution.md';
/** Sub-folder of `.specify` holding the blank document templates. */
export const SPEC_KIT_TEMPLATES_DIR = 'templates';
/** Project-root folder holding one `NNN-slug` sub-folder per domain. */
export const SPEC_KIT_SPECS_DIR = 'specs';
