/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

const SCOPES = ['repo'];

export async function getGitHubToken(createIfNone = false): Promise<string | undefined> {
	const session = await vscode.authentication.getSession('github', SCOPES, { createIfNone, silent: !createIfNone });
	return session?.accessToken;
}

export async function ensureGitHubToken(): Promise<string | undefined> {
	const token = await getGitHubToken(true);
	if (!token) {
		vscode.window.showWarningMessage('Sign in to GitHub to use AI PR review.');
	}
	return token;
}
