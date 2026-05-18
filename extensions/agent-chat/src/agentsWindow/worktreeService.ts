/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'os';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { log } from '../logger.js';

const execAsync = promisify(exec);

export interface Worktree {
	readonly path: string;
	readonly branch: string | undefined;
	readonly head: string | undefined;
	readonly bare: boolean;
}

export interface CreateWorktreeOptions {
	readonly sessionId: string;
	readonly branch: string;
	readonly baseRepoPath: string;
	readonly baseBranch?: string;
}

export interface DiffSummary {
	readonly filesChanged: number;
	readonly insertions: number;
	readonly deletions: number;
}

const WORKTREES_ROOT = path.join(os.homedir(), '.agent-worktrees');

export class WorktreeService {

	static rootDir(): string {
		return WORKTREES_ROOT;
	}

	async resolveRepoRoot(cwd: string): Promise<string> {
		const { stdout } = await execAsync('git rev-parse --show-toplevel', { cwd });
		return stdout.trim();
	}

	async create(options: CreateWorktreeOptions): Promise<string> {
		const repoName = path.basename(options.baseRepoPath);
		const target = path.join(WORKTREES_ROOT, repoName, options.sessionId);

		const existing = await this.list(options.baseRepoPath);
		if (existing.some(w => w.path === target)) {
			throw new Error(`Worktree already exists at ${target}`);
		}
		if (existing.some(w => w.branch === options.branch)) {
			throw new Error(`Branch ${options.branch} is already checked out in another worktree.`);
		}

		await execAsync(`mkdir -p ${shellEscape(path.dirname(target))}`, { cwd: options.baseRepoPath });

		const args = ['worktree', 'add', '-b', options.branch, shellEscape(target)];
		if (options.baseBranch) {
			args.push(shellEscape(options.baseBranch));
		}
		const cmd = `git ${args.join(' ')}`;
		log(`worktree: ${cmd}`);
		try {
			await execAsync(cmd, { cwd: options.baseRepoPath, maxBuffer: 4 * 1024 * 1024 });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			throw new Error(`git worktree add failed: ${message}`);
		}
		return target;
	}

	async remove(worktreePath: string, baseRepoPath: string): Promise<void> {
		try {
			await execAsync(`git worktree remove --force ${shellEscape(worktreePath)}`, { cwd: baseRepoPath });
		} catch (err) {
			log(`worktree: remove failed for ${worktreePath}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	async list(baseRepoPath: string): Promise<Worktree[]> {
		try {
			const { stdout } = await execAsync('git worktree list --porcelain', { cwd: baseRepoPath, maxBuffer: 4 * 1024 * 1024 });
			return parseWorktreeList(stdout);
		} catch (err) {
			log(`worktree: list failed: ${err instanceof Error ? err.message : String(err)}`);
			return [];
		}
	}

	async diffSummary(worktreePath: string): Promise<DiffSummary> {
		try {
			const { stdout } = await execAsync('git diff --shortstat HEAD', { cwd: worktreePath });
			return parseShortStat(stdout);
		} catch {
			return { filesChanged: 0, insertions: 0, deletions: 0 };
		}
	}
}

export function parseWorktreeList(stdout: string): Worktree[] {
	const blocks = stdout.split(/\r?\n\r?\n/).map(b => b.trim()).filter(Boolean);
	const out: Worktree[] = [];
	for (const block of blocks) {
		let p: string | undefined;
		let branch: string | undefined;
		let head: string | undefined;
		let bare = false;
		for (const line of block.split(/\r?\n/)) {
			if (line.startsWith('worktree ')) {
				p = line.slice('worktree '.length).trim();
			} else if (line.startsWith('HEAD ')) {
				head = line.slice('HEAD '.length).trim();
			} else if (line.startsWith('branch ')) {
				branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
			} else if (line.trim() === 'bare') {
				bare = true;
			}
		}
		if (p) {
			out.push({ path: p, branch, head, bare });
		}
	}
	return out;
}

export function parseShortStat(stdout: string): DiffSummary {
	const m = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/.exec(stdout);
	if (!m) {
		return { filesChanged: 0, insertions: 0, deletions: 0 };
	}
	return {
		filesChanged: parseInt(m[1], 10) || 0,
		insertions: parseInt(m[2] ?? '0', 10) || 0,
		deletions: parseInt(m[3] ?? '0', 10) || 0,
	};
}

function shellEscape(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}
