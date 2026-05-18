/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { log } from '../logger.js';
import { Rule, ResolvedRules } from './types.js';

const RULES_GLOB = '.agents/rules/**/*.md';
const AGENTS_MD = 'AGENTS.md';

export class RulesLoader implements vscode.Disposable {

	private readonly cache = new Map<string, Rule>();
	private readonly rootAgentsMd = new Map<string, string>();
	private readonly disposables: vscode.Disposable[] = [];
	private loaded = false;
	private loadPromise: Promise<void> | undefined;

	constructor() {
		const rulesWatcher = vscode.workspace.createFileSystemWatcher(`**/${RULES_GLOB}`);
		rulesWatcher.onDidChange(uri => this.refreshRule(uri));
		rulesWatcher.onDidCreate(uri => this.refreshRule(uri));
		rulesWatcher.onDidDelete(uri => this.cache.delete(uri.toString()));
		this.disposables.push(rulesWatcher);

		const agentsWatcher = vscode.workspace.createFileSystemWatcher(`**/${AGENTS_MD}`);
		agentsWatcher.onDidChange(uri => this.refreshAgentsMd(uri));
		agentsWatcher.onDidCreate(uri => this.refreshAgentsMd(uri));
		agentsWatcher.onDidDelete(uri => this.rootAgentsMd.delete(uri.toString()));
		this.disposables.push(agentsWatcher);
	}

	dispose(): void {
		for (const d of this.disposables) {
			d.dispose();
		}
		this.cache.clear();
		this.rootAgentsMd.clear();
	}

	async ensureLoaded(): Promise<void> {
		if (this.loaded) {
			return;
		}
		if (!this.loadPromise) {
			this.loadPromise = this.loadAll();
		}
		await this.loadPromise;
	}

	async reload(): Promise<number> {
		this.cache.clear();
		this.rootAgentsMd.clear();
		this.loaded = false;
		this.loadPromise = this.loadAll();
		await this.loadPromise;
		return this.cache.size;
	}

	async resolve(activeFile: vscode.Uri | undefined): Promise<ResolvedRules> {
		await this.ensureLoaded();
		const always: Rule[] = [];
		const matched: Rule[] = [];

		const folder = activeFile ? vscode.workspace.getWorkspaceFolder(activeFile) : undefined;
		const relative = activeFile && folder ? relativeFromFolder(folder, activeFile) : undefined;

		for (const rule of this.cache.values()) {
			if (rule.alwaysApply) {
				always.push(rule);
				continue;
			}
			if (!relative || rule.globs.length === 0) {
				continue;
			}
			if (rule.globs.some(g => matchGlob(g, relative))) {
				matched.push(rule);
			}
		}

		const rootAgentsMd = folder ? this.rootAgentsMd.get(vscode.Uri.joinPath(folder.uri, AGENTS_MD).toString()) : undefined;

		return { always, matched, rootAgentsMd };
	}

	private async loadAll(): Promise<void> {
		try {
			const ruleUris = await vscode.workspace.findFiles(RULES_GLOB, '**/node_modules/**');
			await Promise.all(ruleUris.map(uri => this.refreshRule(uri)));

			const agentsUris = await vscode.workspace.findFiles(AGENTS_MD, '**/node_modules/**');
			await Promise.all(agentsUris.map(uri => this.refreshAgentsMd(uri)));

			this.loaded = true;
			log(`rules: loaded ${this.cache.size} rule(s), ${this.rootAgentsMd.size} AGENTS.md`);
		} catch (err) {
			log(`rules: load failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private async refreshRule(uri: vscode.Uri): Promise<void> {
		try {
			const bytes = await vscode.workspace.fs.readFile(uri);
			const text = new TextDecoder().decode(bytes);
			const rule = parseRule(uri, text);
			this.cache.set(uri.toString(), rule);
		} catch (err) {
			log(`rules: failed to load ${uri.fsPath}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private async refreshAgentsMd(uri: vscode.Uri): Promise<void> {
		try {
			const bytes = await vscode.workspace.fs.readFile(uri);
			const text = new TextDecoder().decode(bytes).trim();
			if (text) {
				this.rootAgentsMd.set(uri.toString(), text);
			} else {
				this.rootAgentsMd.delete(uri.toString());
			}
		} catch (err) {
			log(`rules: failed to load AGENTS.md ${uri.fsPath}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}

export function parseRule(uri: vscode.Uri, text: string): Rule {
	const id = uri.path.split('/').slice(-1)[0].replace(/\.md$/, '');
	const fm = extractFrontmatter(text);
	return {
		id,
		uri,
		description: fm.fields['description'] as string | undefined,
		globs: normalizeGlobs(fm.fields['globs']),
		alwaysApply: parseBool(fm.fields['alwaysApply']) ?? false,
		body: fm.body.trim(),
	};
}

interface Frontmatter {
	readonly fields: Record<string, unknown>;
	readonly body: string;
}

function extractFrontmatter(text: string): Frontmatter {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
	if (!match) {
		return { fields: {}, body: text };
	}
	return { fields: parseYamlSubset(match[1]), body: match[2] ?? '' };
}

function parseYamlSubset(src: string): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	const lines = src.split(/\r?\n/);
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (!line.trim() || line.trimStart().startsWith('#')) {
			i++;
			continue;
		}
		const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
		if (!m) {
			i++;
			continue;
		}
		const key = m[1];
		const inline = m[2].trim();
		if (inline === '') {
			const items: string[] = [];
			i++;
			while (i < lines.length && /^\s+-\s+/.test(lines[i])) {
				items.push(lines[i].replace(/^\s+-\s+/, '').trim().replace(/^["']|["']$/g, ''));
				i++;
			}
			out[key] = items;
			continue;
		}
		if (inline.startsWith('[') && inline.endsWith(']')) {
			out[key] = inline
				.slice(1, -1)
				.split(',')
				.map(s => s.trim().replace(/^["']|["']$/g, ''))
				.filter(s => s.length > 0);
		} else {
			out[key] = inline.replace(/^["']|["']$/g, '');
		}
		i++;
	}
	return out;
}

function normalizeGlobs(value: unknown): readonly string[] {
	if (Array.isArray(value)) {
		return value.map(v => String(v)).filter(s => s.length > 0);
	}
	if (typeof value === 'string' && value.trim()) {
		return [value.trim()];
	}
	return [];
}

function parseBool(value: unknown): boolean | undefined {
	if (typeof value === 'boolean') {
		return value;
	}
	if (typeof value === 'string') {
		const v = value.trim().toLowerCase();
		if (v === 'true') {
			return true;
		}
		if (v === 'false') {
			return false;
		}
	}
	return undefined;
}

function relativeFromFolder(folder: vscode.WorkspaceFolder, uri: vscode.Uri): string | undefined {
	const folderPath = folder.uri.path.replace(/\/$/, '');
	const filePath = uri.path;
	if (!filePath.startsWith(folderPath + '/')) {
		return undefined;
	}
	return filePath.slice(folderPath.length + 1);
}

export function matchGlob(pattern: string, path: string): boolean {
	return globToRegex(pattern).test(path);
}

function globToRegex(pattern: string): RegExp {
	let re = '';
	let i = 0;
	while (i < pattern.length) {
		const c = pattern[i];
		if (c === '*') {
			if (pattern[i + 1] === '*') {
				if (pattern[i + 2] === '/') {
					re += '(?:.*/)?';
					i += 3;
				} else {
					re += '.*';
					i += 2;
				}
			} else {
				re += '[^/]*';
				i++;
			}
		} else if (c === '?') {
			re += '[^/]';
			i++;
		} else if (c === '.' || c === '+' || c === '(' || c === ')' || c === '|' || c === '^' || c === '$' || c === '\\') {
			re += '\\' + c;
			i++;
		} else if (c === '[') {
			const end = pattern.indexOf(']', i);
			if (end === -1) {
				re += '\\[';
				i++;
			} else {
				re += pattern.slice(i, end + 1);
				i = end + 1;
			}
		} else {
			re += c;
			i++;
		}
	}
	return new RegExp('^' + re + '$');
}
