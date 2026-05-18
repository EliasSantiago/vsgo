/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import { RepoRef } from './githubClient.js';

const execAsync = promisify(exec);

const cache = new Map<string, RepoRef | undefined>();

export async function detectGitHubRepo(folder?: vscode.WorkspaceFolder): Promise<RepoRef | undefined> {
	const f = folder ?? vscode.workspace.workspaceFolders?.[0];
	if (!f) {
		return undefined;
	}
	const key = f.uri.fsPath;
	if (cache.has(key)) {
		return cache.get(key);
	}
	const ref = await readRemote(key);
	cache.set(key, ref);
	return ref;
}

export function clearRepoCache(): void {
	cache.clear();
}

async function readRemote(cwd: string): Promise<RepoRef | undefined> {
	try {
		const { stdout } = await execAsync('git remote get-url origin', { cwd });
		return parseGitHubUrl(stdout.trim());
	} catch {
		return undefined;
	}
}

export function parseGitHubUrl(url: string): RepoRef | undefined {
	const trimmed = url.trim().replace(/\.git$/, '');
	const ssh = /^git@github\.com:([^\/]+)\/(.+)$/.exec(trimmed);
	if (ssh) {
		return { owner: ssh[1], repo: ssh[2] };
	}
	const https = /^https?:\/\/github\.com\/([^\/]+)\/(.+)$/.exec(trimmed);
	if (https) {
		return { owner: https[1], repo: https[2] };
	}
	const sshAlt = /^ssh:\/\/git@github\.com\/([^\/]+)\/(.+)$/.exec(trimmed);
	if (sshAlt) {
		return { owner: sshAlt[1], repo: sshAlt[2] };
	}
	return undefined;
}
