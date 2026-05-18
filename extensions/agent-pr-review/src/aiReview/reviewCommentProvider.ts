/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { PullRequestSummary, RepoRef } from '../githubClient.js';
import { ReviewFinding, ReviewResult, ReviewSeverity } from './aiReviewService.js';

const AUTHOR: vscode.CommentAuthorInformation = { name: 'AI Reviewer' };

export interface PendingReview {
	readonly ref: RepoRef;
	readonly pr: PullRequestSummary;
	readonly result: ReviewResult;
	readonly threads: readonly vscode.CommentThread[];
}

export class ReviewCommentProvider implements vscode.Disposable {

	private readonly controller: vscode.CommentController;
	private current: PendingReview | undefined;

	constructor() {
		this.controller = vscode.comments.createCommentController('agent-pr-review.findings', 'AI Review');
		this.controller.options = { prompt: 'AI Review', placeHolder: '' };
	}

	dispose(): void {
		this.clear();
		this.controller.dispose();
	}

	current_review(): PendingReview | undefined {
		return this.current;
	}

	async render(ref: RepoRef, pr: PullRequestSummary, result: ReviewResult): Promise<PendingReview> {
		this.clear();
		const threads: vscode.CommentThread[] = [];
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder) {
			throw new Error('Open the workspace folder where this repo is checked out before rendering inline findings.');
		}
		for (const finding of result.findings) {
			const uri = vscode.Uri.joinPath(folder.uri, finding.path);
			const range = new vscode.Range(finding.line - 1, 0, finding.line - 1, 0);
			const thread = this.controller.createCommentThread(uri, range, [makeComment(finding, pr)]);
			thread.label = `AI Review — ${finding.severity}`;
			thread.canReply = false;
			thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
			thread.contextValue = 'aiReview-finding';
			threads.push(thread);
		}
		const review: PendingReview = { ref, pr, result, threads };
		this.current = review;
		return review;
	}

	clear(): void {
		if (!this.current) {
			return;
		}
		for (const t of this.current.threads) {
			t.dispose();
		}
		this.current = undefined;
	}
}

function makeComment(finding: ReviewFinding, pr: PullRequestSummary): vscode.Comment {
	const body = new vscode.MarkdownString();
	body.supportThemeIcons = true;
	body.appendMarkdown(`${iconForSeverity(finding.severity)} **${finding.severity.toUpperCase()}** — ${finding.comment}\n\n_PR #${pr.number}_`);
	return {
		author: AUTHOR,
		body,
		mode: vscode.CommentMode.Preview,
		contextValue: 'aiReview-finding',
	};
}

function iconForSeverity(s: ReviewSeverity): string {
	switch (s) {
		case 'blocker': return '$(error)';
		case 'concern': return '$(warning)';
		case 'suggestion': return '$(lightbulb)';
		case 'nit': return '$(info)';
	}
}
