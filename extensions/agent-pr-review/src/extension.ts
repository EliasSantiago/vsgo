/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ensureGitHubToken, getGitHubToken } from './auth.js';
import { GitHubClient, PullRequestSummary } from './githubClient.js';
import { initLogger, log } from './logger.js';
import { PullRequestListProvider } from './prListView.js';
import { clearRepoCache } from './repoContext.js';
import { AiReviewService } from './aiReview/aiReviewService.js';
import { PendingReview, ReviewCommentProvider } from './aiReview/reviewCommentProvider.js';

export function activate(context: vscode.ExtensionContext): void {
	const channel = initLogger();
	context.subscriptions.push(channel);
	log('activate: starting');

	const listProvider = new PullRequestListProvider();
	const listView = vscode.window.createTreeView('agentPrReview.list', { treeDataProvider: listProvider, showCollapseAll: false });
	const reviewProvider = new ReviewCommentProvider();
	const reviewService = new AiReviewService();

	context.subscriptions.push(
		listProvider,
		listView,
		reviewProvider,
		vscode.commands.registerCommand('agent-pr-review.refresh', async () => {
			clearRepoCache();
			await listProvider.refresh();
		}),
		vscode.commands.registerCommand('agent-pr-review.signIn', async () => {
			const token = await ensureGitHubToken();
			if (token) {
				await listProvider.refresh();
			}
		}),
		vscode.commands.registerCommand('agent-pr-review.openOnGitHub', async (pr?: PullRequestSummary) => {
			if (pr?.htmlUrl) {
				await vscode.env.openExternal(vscode.Uri.parse(pr.htmlUrl));
			}
		}),
		vscode.commands.registerCommand('agent-pr-review.aiReview', (pr?: PullRequestSummary) => runAiReview(pr, listProvider, reviewService, reviewProvider)),
		vscode.commands.registerCommand('agent-pr-review.clearReview', () => {
			reviewProvider.clear();
		}),
		vscode.commands.registerCommand('agent-pr-review.postPendingReview', () => postPendingReview(reviewProvider)),
	);

	void listProvider.refresh();
	log('activate: registered');
}

async function runAiReview(
	pr: PullRequestSummary | undefined,
	listProvider: PullRequestListProvider,
	reviewService: AiReviewService,
	reviewProvider: ReviewCommentProvider,
): Promise<void> {
	const ref = listProvider.getCurrentRepo();
	if (!ref) {
		vscode.window.showWarningMessage('No GitHub repository detected for this workspace.');
		return;
	}
	let target = pr;
	if (!target) {
		const children = await listProvider.getChildren();
		if (!Array.isArray(children) || children.length === 0) {
			vscode.window.showInformationMessage('No open pull requests to review.');
			return;
		}
		const picked = await vscode.window.showQuickPick(
			(children as PullRequestSummary[]).map(p => ({ label: `#${p.number} ${p.title}`, description: `${p.headRef} → ${p.baseRef}`, pr: p })),
			{ placeHolder: 'Review which pull request?', ignoreFocusOut: true },
		);
		target = picked?.pr;
	}
	if (!target) {
		return;
	}
	const token = await getGitHubToken(true);
	if (!token) {
		return;
	}
	const client = new GitHubClient(token);

	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: `Reviewing PR #${target.number}…`, cancellable: true },
		async (_progress, cancellationToken) => {
			try {
				const detail = await client.getPullRequest(ref, target!.number);
				const diff = await client.getPullRequestDiff(ref, target!.number);
				const result = await reviewService.review(diff, detail.title, detail.body, cancellationToken);
				const review = await reviewProvider.render(ref, target!, result);
				summarizeReview(review);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				log(`aiReview: failed: ${message}`);
				vscode.window.showErrorMessage(`AI Review failed: ${message}`);
			}
		},
	);
}

function summarizeReview(review: PendingReview): void {
	const counts = countBySeverity(review);
	const parts: string[] = [];
	for (const [k, v] of counts) {
		if (v > 0) {
			parts.push(`${v} ${k}`);
		}
	}
	const headline = parts.length > 0 ? parts.join(' · ') : 'no findings';
	const summary = review.result.summary ? `\n\n${review.result.summary}` : '';
	const truncatedNote = review.result.truncated ? '\n\n_(diff was truncated)_' : '';
	vscode.window.showInformationMessage(`AI review for PR #${review.pr.number}: ${headline}.${summary}${truncatedNote}`, { modal: false });
}

function countBySeverity(review: PendingReview): Map<string, number> {
	const counts = new Map<string, number>();
	for (const f of review.result.findings) {
		counts.set(f.severity, (counts.get(f.severity) ?? 0) + 1);
	}
	return counts;
}

async function postPendingReview(reviewProvider: ReviewCommentProvider): Promise<void> {
	const review = reviewProvider.current_review();
	if (!review) {
		vscode.window.showInformationMessage('No AI review to post. Run "AI Review" first.');
		return;
	}
	if (review.result.findings.length === 0) {
		vscode.window.showInformationMessage('Nothing to post — review has no findings.');
		return;
	}
	const confirm = await vscode.window.showWarningMessage(
		`Post ${review.result.findings.length} comment(s) as a draft review on PR #${review.pr.number}?`,
		{ modal: true },
		'Post Draft',
	);
	if (confirm !== 'Post Draft') {
		return;
	}
	const token = await getGitHubToken(true);
	if (!token) {
		return;
	}
	const client = new GitHubClient(token);
	try {
		const posted = await client.createPendingReview(
			review.ref,
			review.pr.number,
			review.result.findings.map(f => ({ path: f.path, line: f.line, side: f.side, body: `**${f.severity}** — ${f.comment}` })),
			review.result.summary,
		);
		if (posted.htmlUrl) {
			const action = await vscode.window.showInformationMessage('Draft review posted.', 'Open in GitHub');
			if (action === 'Open in GitHub') {
				await vscode.env.openExternal(vscode.Uri.parse(posted.htmlUrl));
			}
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		vscode.window.showErrorMessage(`Failed to post review: ${message}`);
	}
}

export function deactivate(): void { }
