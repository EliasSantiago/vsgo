/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IAgentSession } from './agentSession.js';
import { AgentSessionsStore } from './agentSessionsStore.js';

export class AgentSessionsTreeProvider implements vscode.TreeDataProvider<IAgentSession>, vscode.Disposable {

	private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly store: AgentSessionsStore) {
		this.disposables.push(this.store.onDidChange(() => this._onDidChangeTreeData.fire()));
	}

	dispose(): void {
		for (const d of this.disposables) {
			d.dispose();
		}
		this._onDidChangeTreeData.dispose();
	}

	getTreeItem(session: IAgentSession): vscode.TreeItem {
		const item = new vscode.TreeItem(session.name, vscode.TreeItemCollapsibleState.None);
		item.description = describeSession(session);
		item.tooltip = new vscode.MarkdownString(buildTooltip(session));
		item.iconPath = iconForStatus(session.status);
		item.contextValue = `agentSession-${session.status}`;
		item.resourceUri = vscode.Uri.file(session.worktreePath);
		return item;
	}

	getChildren(): IAgentSession[] {
		return [...this.store.all()];
	}
}

function describeSession(session: IAgentSession): string {
	const parts: string[] = [session.branch];
	if (session.diffSummary && session.diffSummary.filesChanged > 0) {
		const { filesChanged, insertions, deletions } = session.diffSummary;
		parts.push(`${filesChanged}f +${insertions}/-${deletions}`);
	}
	return parts.join(' · ');
}

function buildTooltip(session: IAgentSession): string {
	const lines = [
		`**${session.name}**  _${session.status}_`,
		'',
		`Branch: \`${session.branch}\``,
		`Worktree: \`${session.worktreePath}\``,
		`Base repo: \`${session.baseRepoPath}\``,
	];
	if (session.prompt) {
		lines.push('', `> ${session.prompt}`);
	}
	if (session.lastError) {
		lines.push('', `**Error:** ${session.lastError}`);
	}
	return lines.join('\n');
}

function iconForStatus(status: IAgentSession['status']): vscode.ThemeIcon {
	switch (status) {
		case 'running': return new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.blue'));
		case 'error': return new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
		case 'done': return new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'));
		case 'idle':
		default: return new vscode.ThemeIcon('circle-outline');
	}
}
