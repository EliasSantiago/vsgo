/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const IVsgoWorkspaceService = createDecorator<IVsgoWorkspaceService>('vsgoWorkspaceService');

/** Folder holding every artifact vsgo generates for a workspace. */
export const VSGO_DIR_NAME = '.vsgo';

/**
 * Everything under `.vsgo` is regenerable machine output — QA runs, security reports, run
 * indexes — so the whole folder is kept out of version control. Documents meant to be read
 * and reviewed by people (specs, requirements) are written to the project tree instead,
 * never here.
 */
export const VSGO_GITIGNORE_CONTENT = '*\n';

/**
 * Single owner of the `.vsgo` artifacts folder. Every feature that writes generated output
 * goes through this service so they all agree on which workspace folder hosts the artifacts
 * and on the version control policy that applies to them.
 */
export interface IVsgoWorkspaceService {
	readonly _serviceBrand: undefined;

	/**
	 * Resolves `.vsgo` (or a subdirectory of it) without touching disk, for callers that only
	 * need a path — revealing the folder in the OS, building a URI to open. Returns `undefined`
	 * when no folder is open.
	 */
	getArtifactsRoot(subdir?: string): URI | undefined;

	/**
	 * Same as {@link getArtifactsRoot}, but creates the directory and the `.gitignore` that
	 * keeps it out of version control. Call this before writing any artifact.
	 */
	ensureArtifactsRoot(subdir?: string): Promise<URI | undefined>;
}
