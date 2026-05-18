/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { log } from '../logger.js';

export interface MemoryEntry {
	readonly slug: string;
	readonly title: string;
	readonly hook: string;
	readonly file: vscode.Uri;
}

const MEMORY_DIR = '.agents/memory';
const INDEX_FILE = 'MEMORY.md';
const INDEX_LINE_RE = /^-\s*\[([^\]]+)\]\(([^)]+)\)\s*(?:—\s*(.*))?$/;

export class MemoryService implements vscode.Disposable {

	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChange = this._onDidChange.event;

	private readonly watcher: vscode.FileSystemWatcher;

	constructor() {
		this.watcher = vscode.workspace.createFileSystemWatcher(`**/${MEMORY_DIR}/**/*.md`);
		this.watcher.onDidChange(() => this._onDidChange.fire());
		this.watcher.onDidCreate(() => this._onDidChange.fire());
		this.watcher.onDidDelete(() => this._onDidChange.fire());
	}

	dispose(): void {
		this.watcher.dispose();
		this._onDidChange.dispose();
	}

	async list(): Promise<MemoryEntry[]> {
		const folder = this.primaryFolder();
		if (!folder) {
			return [];
		}
		const indexUri = vscode.Uri.joinPath(folder.uri, MEMORY_DIR, INDEX_FILE);
		const indexText = await this.readFileOrEmpty(indexUri);
		if (!indexText) {
			return [];
		}
		const entries: MemoryEntry[] = [];
		for (const line of indexText.split(/\r?\n/)) {
			const m = INDEX_LINE_RE.exec(line.trim());
			if (!m) {
				continue;
			}
			const [, title, target, hook] = m;
			const slug = target.replace(/\.md$/i, '');
			entries.push({
				slug,
				title: title.trim(),
				hook: (hook ?? '').trim(),
				file: vscode.Uri.joinPath(folder.uri, MEMORY_DIR, target),
			});
		}
		return entries;
	}

	async readBody(entry: MemoryEntry): Promise<string> {
		return await this.readFileOrEmpty(entry.file);
	}

	async add(slug: string, title: string, hook: string, body: string): Promise<MemoryEntry> {
		const folder = this.primaryFolder();
		if (!folder) {
			throw new Error('No workspace folder is open.');
		}
		const sanitized = sanitizeSlug(slug);
		const file = vscode.Uri.joinPath(folder.uri, MEMORY_DIR, `${sanitized}.md`);
		await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(body.trim() + '\n'));

		const indexUri = vscode.Uri.joinPath(folder.uri, MEMORY_DIR, INDEX_FILE);
		const existing = await this.readFileOrEmpty(indexUri);
		const newLine = formatIndexLine(title, sanitized, hook);
		const updated = existing
			? existing.replace(/\s*$/, '') + '\n' + newLine + '\n'
			: newLine + '\n';
		await vscode.workspace.fs.writeFile(indexUri, new TextEncoder().encode(updated));

		this._onDidChange.fire();
		return { slug: sanitized, title, hook, file };
	}

	async forget(slug: string): Promise<void> {
		const folder = this.primaryFolder();
		if (!folder) {
			return;
		}
		const file = vscode.Uri.joinPath(folder.uri, MEMORY_DIR, `${slug}.md`);
		try {
			await vscode.workspace.fs.delete(file);
		} catch (err) {
			log(`memory: delete failed ${file.fsPath}: ${err instanceof Error ? err.message : String(err)}`);
		}

		const indexUri = vscode.Uri.joinPath(folder.uri, MEMORY_DIR, INDEX_FILE);
		const existing = await this.readFileOrEmpty(indexUri);
		if (!existing) {
			this._onDidChange.fire();
			return;
		}
		const kept = existing
			.split(/\r?\n/)
			.filter(line => {
				const m = INDEX_LINE_RE.exec(line.trim());
				return !m || m[2].replace(/\.md$/i, '') !== slug;
			})
			.join('\n');
		await vscode.workspace.fs.writeFile(indexUri, new TextEncoder().encode(kept));
		this._onDidChange.fire();
	}

	primaryFolder(): vscode.WorkspaceFolder | undefined {
		return vscode.workspace.workspaceFolders?.[0];
	}

	private async readFileOrEmpty(uri: vscode.Uri): Promise<string> {
		try {
			const bytes = await vscode.workspace.fs.readFile(uri);
			return new TextDecoder().decode(bytes);
		} catch {
			return '';
		}
	}
}

export function sanitizeSlug(input: string): string {
	return input
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 60) || 'memory';
}

function formatIndexLine(title: string, slug: string, hook: string): string {
	const escapedTitle = title.replace(/[\[\]]/g, '');
	const hookPart = hook.trim() ? ` — ${hook.trim()}` : '';
	return `- [${escapedTitle}](${slug}.md)${hookPart}`;
}
