/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { MemoryEntry, MemoryService } from './memoryService.js';

export class MemoryTreeProvider implements vscode.TreeDataProvider<MemoryEntry>, vscode.Disposable {

	private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly service: MemoryService) {
		this.disposables.push(service.onDidChange(() => this._onDidChangeTreeData.fire()));
	}

	dispose(): void {
		for (const d of this.disposables) {
			d.dispose();
		}
		this._onDidChangeTreeData.dispose();
	}

	getTreeItem(entry: MemoryEntry): vscode.TreeItem {
		const item = new vscode.TreeItem(entry.title, vscode.TreeItemCollapsibleState.None);
		item.description = entry.hook;
		item.tooltip = new vscode.MarkdownString(`**${entry.title}**\n\n${entry.hook}\n\n_${entry.file.fsPath}_`);
		item.resourceUri = entry.file;
		item.iconPath = new vscode.ThemeIcon('lightbulb');
		item.contextValue = 'agentMemoryEntry';
		item.command = {
			command: 'vscode.open',
			title: 'Open Memory',
			arguments: [entry.file],
		};
		return item;
	}

	async getChildren(): Promise<MemoryEntry[]> {
		return await this.service.list();
	}
}
