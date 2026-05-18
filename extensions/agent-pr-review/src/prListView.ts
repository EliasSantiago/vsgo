/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { getGitHubToken } from './auth.js';
import { GitHubClient, PullRequestSummary, RepoRef } from './githubClient.js';
import { log } from './logger.js';
import { detectGitHubRepo } from './repoContext.js';

interface ListState {
	readonly ref?: RepoRef;
	readonly prs: readonly PullRequestSummary[];
	readonly error?: string;
	readonly signedIn: boolean;
}

export class PullRequestListProvider implements vscode.TreeDataProvider<PullRequestSummary>, vscode.Disposable {

	private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private state: ListState = { prs: [], signedIn: false };
	private loadPromise: Promise<void> | undefined;

	dispose(): void {
		this._onDidChangeTreeData.dispose();
	}

	async refresh(): Promise<void> {
		this.loadPromise = this.load();
		await this.loadPromise;
	}

	getTreeItem(pr: PullRequestSummary): vscode.TreeItem {
		const item = new vscode.TreeItem(`#${pr.number} ${pr.title}`, vscode.TreeItemCollapsibleState.None);
		item.description = `${pr.headRef} → ${pr.baseRef} · ${pr.authorLogin}`;
		item.tooltip = new vscode.MarkdownString(
			`**#${pr.number} ${pr.title}**\n\nBy @${pr.authorLogin}\n\n\`${pr.headRef}\` → \`${pr.baseRef}\`\n\nUpdated ${formatRelative(pr.updatedAt)}\n\n[Open on GitHub](${pr.htmlUrl})`,
		);
		item.iconPath = new vscode.ThemeIcon(pr.draft ? 'git-pull-request-draft' : 'git-pull-request');
		item.contextValue = 'pullRequest';
		item.command = {
			command: 'agent-pr-review.aiReview',
			title: 'AI Review',
			arguments: [pr],
		};
		return item;
	}

	async getChildren(element?: PullRequestSummary): Promise<PullRequestSummary[]> {
		if (element) {
			return [];
		}
		if (!this.loadPromise) {
			this.loadPromise = this.load();
		}
		await this.loadPromise;
		return [...this.state.prs];
	}

	getCurrentRepo(): RepoRef | undefined {
		return this.state.ref;
	}

	getLastError(): string | undefined {
		return this.state.error;
	}

	private async load(): Promise<void> {
		const prev = this.state;
		try {
			const ref = await detectGitHubRepo();
			if (!ref) {
				this.state = { prs: [], signedIn: prev.signedIn, error: 'No GitHub remote found in workspace.' };
				this._onDidChangeTreeData.fire();
				return;
			}
			const token = await getGitHubToken(false);
			if (!token) {
				this.state = { ref, prs: [], signedIn: false, error: 'Sign in to GitHub to load pull requests.' };
				this._onDidChangeTreeData.fire();
				return;
			}
			const client = new GitHubClient(token);
			const prs = await client.listPullRequests(ref, 'open');
			this.state = { ref, prs, signedIn: true };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			log(`prList: load failed: ${message}`);
			this.state = { ref: prev.ref, prs: [], signedIn: prev.signedIn, error: message };
		}
		this._onDidChangeTreeData.fire();
	}
}

function formatRelative(iso: string): string {
	if (!iso) {
		return '';
	}
	const t = Date.parse(iso);
	if (isNaN(t)) {
		return iso;
	}
	const diff = Date.now() - t;
	const minutes = Math.floor(diff / 60_000);
	if (minutes < 60) {
		return `${minutes}m ago`;
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 48) {
		return `${hours}h ago`;
	}
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}
