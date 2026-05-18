/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { BugFinding, severityWeight } from './findings.js';

const AUTHOR: vscode.CommentAuthorInformation = {
	name: 'Bug Bot',
	iconPath: undefined,
};

interface ThreadRecord {
	readonly thread: vscode.CommentThread;
	readonly finding: BugFinding;
}

export class BugBotProvider implements vscode.Disposable {

	private readonly controller: vscode.CommentController;
	private readonly threads = new Map<string, ThreadRecord[]>();
	private readonly disposables: vscode.Disposable[] = [];

	constructor() {
		this.controller = vscode.comments.createCommentController('agent-chat.bugBot', 'Bug Bot');
		this.controller.options = {
			prompt: 'Bug Bot finding',
			placeHolder: '',
		};
		this.disposables.push(this.controller);
	}

	dispose(): void {
		for (const records of this.threads.values()) {
			for (const r of records) {
				r.thread.dispose();
			}
		}
		this.threads.clear();
		for (const d of this.disposables) {
			d.dispose();
		}
	}

	render(uri: vscode.Uri, findings: readonly BugFinding[], minSeverity: 'error' | 'warning' | 'info'): void {
		this.clear(uri);
		if (findings.length === 0) {
			return;
		}
		const threshold = severityWeight(minSeverity);
		const filtered = findings.filter(f => severityWeight(f.severity) >= threshold);
		const records: ThreadRecord[] = [];
		for (const finding of filtered) {
			const range = new vscode.Range(finding.line - 1, 0, finding.endLine - 1, 0);
			const thread = this.controller.createCommentThread(uri, range, [makeComment(finding)]);
			thread.label = `Bug Bot — ${finding.severity}`;
			thread.canReply = false;
			thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
			thread.contextValue = finding.fix ? 'bugBot-with-fix' : 'bugBot-no-fix';
			records.push({ thread, finding });
		}
		this.threads.set(uri.toString(), records);
	}

	clear(uri: vscode.Uri): void {
		const key = uri.toString();
		const existing = this.threads.get(key);
		if (!existing) {
			return;
		}
		for (const r of existing) {
			r.thread.dispose();
		}
		this.threads.delete(key);
	}

	clearAll(): void {
		for (const key of [...this.threads.keys()]) {
			this.clear(vscode.Uri.parse(key));
		}
	}

	findingForThread(thread: vscode.CommentThread): BugFinding | undefined {
		for (const records of this.threads.values()) {
			const match = records.find(r => r.thread === thread);
			if (match) {
				return match.finding;
			}
		}
		return undefined;
	}
}

function makeComment(finding: BugFinding): vscode.Comment {
	const body = new vscode.MarkdownString();
	body.supportThemeIcons = true;
	const icon = iconForSeverity(finding.severity);
	body.appendMarkdown(`${icon} **${finding.severity.toUpperCase()}** — ${finding.message}`);
	if (finding.fix) {
		body.appendMarkdown('\n\n_Suggested fix available — use the title-bar action to apply._');
	}
	return {
		author: AUTHOR,
		body,
		mode: vscode.CommentMode.Preview,
		contextValue: finding.fix ? 'bugBot-with-fix' : 'bugBot-no-fix',
	};
}

function iconForSeverity(s: BugFinding['severity']): string {
	switch (s) {
		case 'error': return '$(error)';
		case 'warning': return '$(warning)';
		case 'info': return '$(info)';
	}
}

export async function applyFinding(uri: vscode.Uri, finding: BugFinding): Promise<boolean> {
	if (!finding.fix) {
		return false;
	}
	const edit = new vscode.WorkspaceEdit();
	const start = new vscode.Position(finding.line - 1, 0);
	const document = await vscode.workspace.openTextDocument(uri);
	const endLineIdx = Math.min(finding.endLine - 1, document.lineCount - 1);
	const end = document.lineAt(endLineIdx).range.end;
	edit.replace(uri, new vscode.Range(start, end), finding.fix);
	return await vscode.workspace.applyEdit(edit);
}
