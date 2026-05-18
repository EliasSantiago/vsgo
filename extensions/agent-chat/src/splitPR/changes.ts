/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export type ChangeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';

export interface FileChange {
	readonly path: string;
	readonly kind: ChangeKind;
	readonly oldPath?: string;
	readonly diffPreview?: string;
}

const MAX_DIFF_LINES_PER_FILE = 100;

export async function collectChanges(repoPath: string): Promise<FileChange[]> {
	const { stdout } = await execAsync('git status --porcelain=v1 -z', { cwd: repoPath, maxBuffer: 4 * 1024 * 1024 });
	const changes = parseStatus(stdout);
	const enriched: FileChange[] = [];
	for (const change of changes) {
		if (change.kind !== 'untracked' && change.kind !== 'deleted') {
			enriched.push({ ...change, diffPreview: await diffPreview(repoPath, change.path) });
		} else {
			enriched.push(change);
		}
	}
	return enriched;
}

export function parseStatus(stdout: string): FileChange[] {
	const out: FileChange[] = [];
	const parts = stdout.split('\0');
	for (let i = 0; i < parts.length; i++) {
		const entry = parts[i];
		if (!entry) {
			continue;
		}
		const code = entry.slice(0, 2);
		const path = entry.slice(3);
		if (!path) {
			continue;
		}
		const kind = classify(code);
		if (kind === 'renamed') {
			const oldPath = parts[++i] ?? '';
			out.push({ path, kind, oldPath });
		} else {
			out.push({ path, kind });
		}
	}
	return out;
}

function classify(code: string): ChangeKind {
	const x = code[0];
	const y = code[1];
	if (x === '?' && y === '?') {
		return 'untracked';
	}
	if (x === 'A' || y === 'A') {
		return 'added';
	}
	if (x === 'D' || y === 'D') {
		return 'deleted';
	}
	if (x === 'R' || y === 'R') {
		return 'renamed';
	}
	return 'modified';
}

async function diffPreview(repoPath: string, file: string): Promise<string> {
	try {
		const { stdout } = await execAsync(`git diff --no-color -U2 -- ${shellEscape(file)}`, { cwd: repoPath, maxBuffer: 4 * 1024 * 1024 });
		return clampLines(stdout, MAX_DIFF_LINES_PER_FILE);
	} catch {
		return '';
	}
}

function clampLines(text: string, max: number): string {
	const lines = text.split(/\r?\n/);
	if (lines.length <= max) {
		return text;
	}
	return lines.slice(0, max).join('\n') + `\n…[truncated ${lines.length - max} more lines]`;
}

function shellEscape(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}
