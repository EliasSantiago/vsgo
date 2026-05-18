/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { log } from '../logger.js';
import { SuggestedGroup } from './groupClassifier.js';

const execAsync = promisify(exec);

export interface SplitOptions {
	readonly repoPath: string;
	readonly baseBranch: string;
	readonly push?: boolean;
	readonly createPullRequest?: boolean;
}

export interface SplitOutcome {
	readonly group: SuggestedGroup;
	readonly branch: string;
	readonly commit?: string;
	readonly pushed: boolean;
	readonly pullRequestUrl?: string;
	readonly error?: string;
}

interface GroupSnapshot {
	readonly group: SuggestedGroup;
	readonly trackedPatch?: string;
	readonly deletions: readonly string[];
	readonly untrackedFiles: ReadonlyMap<string, Buffer>;
}

export class SplitService {

	async execute(groups: readonly SuggestedGroup[], options: SplitOptions): Promise<SplitOutcome[]> {
		const { repoPath, baseBranch } = options;
		const outcomes: SplitOutcome[] = [];

		const originalRef = await this.currentRef(repoPath);

		const snapshots: GroupSnapshot[] = [];
		for (const group of groups) {
			snapshots.push(await this.captureGroup(repoPath, group));
		}

		const stashRef = await this.stashAll(repoPath);
		if (!stashRef) {
			throw new Error('Failed to stash working tree. Aborting split.');
		}

		try {
			for (const snap of snapshots) {
				const outcome = await this.applyGroup(repoPath, baseBranch, snap, options);
				outcomes.push(outcome);
				try { await execAsync('git reset --hard HEAD', { cwd: repoPath }); } catch { /* noop */ }
				try { await execAsync('git clean -fd', { cwd: repoPath }); } catch { /* noop */ }
			}

			await execAsync(`git checkout ${shellEscape(originalRef)}`, { cwd: repoPath });
		} finally {
			try {
				await execAsync('git stash pop', { cwd: repoPath });
			} catch (err) {
				log(`split: stash pop failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		}

		return outcomes;
	}

	private async captureGroup(repoPath: string, group: SuggestedGroup): Promise<GroupSnapshot> {
		const tracked: string[] = [];
		const untracked = new Map<string, Buffer>();
		const deletions: string[] = [];

		for (const file of group.files) {
			const status = await this.fileStatus(repoPath, file);
			if (status === 'untracked') {
				try {
					untracked.set(file, await fs.promises.readFile(path.join(repoPath, file)));
				} catch (err) {
					log(`split: failed to read untracked ${file}: ${err instanceof Error ? err.message : String(err)}`);
				}
			} else if (status === 'deleted') {
				deletions.push(file);
			} else {
				tracked.push(file);
			}
		}

		let trackedPatch: string | undefined;
		if (tracked.length > 0) {
			const { stdout } = await execAsync(
				`git diff --binary HEAD -- ${tracked.map(shellEscape).join(' ')}`,
				{ cwd: repoPath, maxBuffer: 32 * 1024 * 1024 },
			);
			if (stdout.trim()) {
				trackedPatch = stdout;
			}
		}

		return { group, trackedPatch, deletions, untrackedFiles: untracked };
	}

	private async applyGroup(repoPath: string, baseBranch: string, snap: GroupSnapshot, options: SplitOptions): Promise<SplitOutcome> {
		const { group } = snap;
		const branch = group.suggestedBranch;
		try {
			await execAsync(`git checkout -B ${shellEscape(branch)} ${shellEscape(baseBranch)}`, { cwd: repoPath });

			if (snap.trackedPatch) {
				await this.applyPatch(repoPath, snap.trackedPatch);
			}
			for (const [file, content] of snap.untrackedFiles) {
				const target = path.join(repoPath, file);
				await fs.promises.mkdir(path.dirname(target), { recursive: true });
				await fs.promises.writeFile(target, content);
			}
			for (const file of snap.deletions) {
				try {
					await execAsync(`git rm -- ${shellEscape(file)}`, { cwd: repoPath });
				} catch (err) {
					log(`split: git rm failed for ${file}: ${err instanceof Error ? err.message : String(err)}`);
				}
			}

			const stagePaths = group.files.map(shellEscape).join(' ');
			await execAsync(`git add -A -- ${stagePaths}`, { cwd: repoPath });

			const message = buildCommitMessage(group);
			await execAsync(`git commit -m ${shellEscape(message)}`, { cwd: repoPath });
			const { stdout: shaOut } = await execAsync('git rev-parse HEAD', { cwd: repoPath });
			const commit = shaOut.trim();

			let pushed = false;
			let pullRequestUrl: string | undefined;
			if (options.push) {
				try {
					await execAsync(`git push -u origin ${shellEscape(branch)}`, { cwd: repoPath });
					pushed = true;
				} catch (err) {
					log(`split: push failed for ${branch}: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
			if (options.createPullRequest && pushed) {
				pullRequestUrl = await this.createPullRequest(repoPath, group);
			}
			return { group, branch, commit, pushed, pullRequestUrl };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return { group, branch, pushed: false, error: message };
		}
	}

	private async applyPatch(repoPath: string, patch: string): Promise<void> {
		const tmp = path.join(os.tmpdir(), `agent-chat-split-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.patch`);
		await fs.promises.writeFile(tmp, patch);
		try {
			await execAsync(`git apply --binary --index ${shellEscape(tmp)}`, { cwd: repoPath });
		} finally {
			try { await fs.promises.unlink(tmp); } catch { /* noop */ }
		}
	}

	private async stashAll(repoPath: string): Promise<string | undefined> {
		const tag = `agent-chat/split-${Date.now()}`;
		try {
			await execAsync(`git stash push --include-untracked -m ${shellEscape(tag)}`, { cwd: repoPath });
			return tag;
		} catch (err) {
			log(`split: stash failed: ${err instanceof Error ? err.message : String(err)}`);
			return undefined;
		}
	}

	private async currentRef(repoPath: string): Promise<string> {
		try {
			const { stdout } = await execAsync('git symbolic-ref --short HEAD', { cwd: repoPath });
			return stdout.trim();
		} catch {
			const { stdout } = await execAsync('git rev-parse HEAD', { cwd: repoPath });
			return stdout.trim();
		}
	}

	private async fileStatus(repoPath: string, file: string): Promise<'tracked' | 'untracked' | 'deleted'> {
		try {
			const { stdout } = await execAsync(
				`git status --porcelain=v1 -z -- ${shellEscape(file)}`,
				{ cwd: repoPath },
			);
			if (!stdout) {
				return 'tracked';
			}
			const code = stdout.slice(0, 2);
			if (code[0] === '?' && code[1] === '?') {
				return 'untracked';
			}
			if (code[0] === 'D' || code[1] === 'D') {
				return 'deleted';
			}
			return 'tracked';
		} catch {
			return 'tracked';
		}
	}

	private async createPullRequest(repoPath: string, group: SuggestedGroup): Promise<string | undefined> {
		try {
			const body = group.description || group.title;
			const { stdout } = await execAsync(
				`gh pr create --title ${shellEscape(group.title)} --body ${shellEscape(body)} --head ${shellEscape(group.suggestedBranch)}`,
				{ cwd: repoPath },
			);
			return stdout.trim().split(/\s+/).find(t => t.startsWith('http'));
		} catch (err) {
			log(`split: gh pr create failed: ${err instanceof Error ? err.message : String(err)}`);
			return undefined;
		}
	}
}

function buildCommitMessage(group: SuggestedGroup): string {
	if (group.description) {
		return `${group.title}\n\n${group.description}`;
	}
	return group.title;
}

function shellEscape(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}
