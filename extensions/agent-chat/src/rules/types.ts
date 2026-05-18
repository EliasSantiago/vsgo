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

export interface ResolvedRules {
	readonly always: readonly Rule[];
	readonly matched: readonly Rule[];
	readonly rootAgentsMd?: string;
}
