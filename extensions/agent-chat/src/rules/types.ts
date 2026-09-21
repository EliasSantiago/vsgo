/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export interface Rule {
	readonly id: string;
	readonly uri: vscode.Uri;
	readonly description?: string;
	readonly globs: readonly string[];
	readonly alwaysApply: boolean;
	readonly body: string;
}

/**
 * One project instruction file (`AGENTS.md`, `CLAUDE.md`, ...) found at a workspace folder root.
 */
export interface ProjectInstructions {
	/** Path relative to the workspace folder, e.g. `.claude/CLAUDE.md`. */
	readonly file: string;
	readonly body: string;
}

export interface ResolvedRules {
	readonly always: readonly Rule[];
	readonly matched: readonly Rule[];
	readonly projectInstructions: readonly ProjectInstructions[];
}
