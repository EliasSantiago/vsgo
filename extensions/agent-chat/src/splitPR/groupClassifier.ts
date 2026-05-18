/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { FileChange } from './changes.js';

export interface SuggestedGroup {
	readonly title: string;
	readonly description: string;
	readonly suggestedBranch: string;
	readonly files: readonly string[];
}

const SYSTEM_PROMPT = [
	'You are a code reviewer helping split a tangled working tree into focused pull requests.',
	'Given a list of changed files (with short diff previews), group them by feature/concern.',
	'',
	'Rules:',
	'- Each file appears in exactly one group.',
	'- Prefer fewer groups (2-5) over many tiny ones; only split when changes are clearly unrelated.',
	'- Each group should land independently — no group should depend on another.',
	'- "title" is a short PR-style title, present tense, lowercase verb (e.g. "fix auth redirect").',
	'- "description" is 1-2 sentences explaining what the group does.',
	'- "suggestedBranch" is kebab-case, < 40 chars, no leading slashes.',
	'',
	'Output ONLY a JSON array of groups. No markdown fences, no commentary.',
	'Each group has: { "title": string, "description": string, "suggestedBranch": string, "files": string[] }',
].join('\n');

export async function suggestGroups(changes: readonly FileChange[], model: vscode.LanguageModelChat, token: vscode.CancellationToken): Promise<SuggestedGroup[]> {
	if (changes.length === 0) {
		return [];
	}
	const user = buildUserPrompt(changes);
	const messages: vscode.LanguageModelChatMessage[] = [
		vscode.LanguageModelChatMessage.User(SYSTEM_PROMPT),
		vscode.LanguageModelChatMessage.User(user),
	];
	const response = await model.sendRequest(messages, {}, token);
	let buf = '';
	for await (const part of response.stream) {
		if (part instanceof vscode.LanguageModelTextPart) {
			buf += part.value;
		}
	}
	return parseGroups(buf, changes);
}

export function parseGroups(raw: string, changes: readonly FileChange[]): SuggestedGroup[] {
	const json = extractJsonArray(raw);
	if (!json) {
		return [];
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) {
		return [];
	}
	const validPaths = new Set(changes.map(c => c.path));
	const claimed = new Set<string>();
	const out: SuggestedGroup[] = [];
	for (const item of parsed) {
		if (!item || typeof item !== 'object') {
			continue;
		}
		const g = item as { title?: unknown; description?: unknown; suggestedBranch?: unknown; files?: unknown };
		const title = typeof g.title === 'string' ? g.title.trim() : '';
		if (!title) {
			continue;
		}
		const description = typeof g.description === 'string' ? g.description.trim() : '';
		const suggestedBranch = typeof g.suggestedBranch === 'string' ? sanitizeBranch(g.suggestedBranch) : sanitizeBranch(title);
		const files = Array.isArray(g.files)
			? g.files.filter((f): f is string => typeof f === 'string' && validPaths.has(f) && !claimed.has(f))
			: [];
		if (files.length === 0) {
			continue;
		}
		for (const f of files) {
			claimed.add(f);
		}
		out.push({ title, description, suggestedBranch, files });
	}
	const leftover = changes.filter(c => !claimed.has(c.path)).map(c => c.path);
	if (leftover.length > 0) {
		out.push({
			title: 'misc',
			description: 'Files the classifier did not assign to a group.',
			suggestedBranch: 'split-misc',
			files: leftover,
		});
	}
	return out;
}

function buildUserPrompt(changes: readonly FileChange[]): string {
	const lines: string[] = [`Changed files (${changes.length}):`, ''];
	for (const c of changes) {
		lines.push(`### ${c.kind.toUpperCase()}: ${c.path}${c.oldPath ? ` (from ${c.oldPath})` : ''}`);
		if (c.diffPreview) {
			lines.push('```diff');
			lines.push(c.diffPreview);
			lines.push('```');
		}
		lines.push('');
	}
	return lines.join('\n');
}

function extractJsonArray(raw: string): string | undefined {
	const trimmed = raw.trim();
	if (trimmed.startsWith('[')) {
		return trimmed;
	}
	const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
	if (fenced && fenced[1].trim().startsWith('[')) {
		return fenced[1].trim();
	}
	const match = /\[[\s\S]*\]/.exec(trimmed);
	return match?.[0];
}

export function sanitizeBranch(input: string): string {
	const s = input
		.trim()
		.toLowerCase()
		.replace(/^(refs\/heads\/|origin\/)/, '')
		.replace(/[^a-z0-9\/-]+/g, '-')
		.replace(/--+/g, '-')
		.replace(/^[-/]+|[-/]+$/g, '')
		.slice(0, 60);
	return s || 'split-group';
}
