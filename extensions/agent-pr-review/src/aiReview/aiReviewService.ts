/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { log } from '../logger.js';
import { DiffFile, parseUnifiedDiff, truncateDiff } from './diffParser.js';

export type ReviewSeverity = 'nit' | 'suggestion' | 'concern' | 'blocker';

export interface ReviewFinding {
	readonly path: string;
	readonly line: number;
	readonly side: 'LEFT' | 'RIGHT';
	readonly severity: ReviewSeverity;
	readonly comment: string;
}

export interface ReviewResult {
	readonly summary: string;
	readonly findings: readonly ReviewFinding[];
	readonly truncated: boolean;
	readonly files: readonly DiffFile[];
}

const SYSTEM_PROMPT = [
	'You are an experienced code reviewer reviewing a GitHub pull request diff.',
	'',
	'Rules:',
	'- Comment only on lines that appear in the diff (added or context lines).',
	'- Be specific: name the function, variable, or pattern. Avoid generic advice.',
	'- Prefer fewer, higher-quality findings over many trivial ones.',
	'- Severity: "blocker" (must fix), "concern" (should fix), "suggestion" (improvement), "nit" (style/taste).',
	'- For each finding, include the file path EXACTLY as it appears in the diff and the line number from the NEW file.',
	'',
	'Return JSON ONLY (no markdown fences):',
	'{',
	'  "summary": "one paragraph overview",',
	'  "findings": [',
	'    {"path": "src/foo.ts", "line": 42, "side": "RIGHT", "severity": "concern", "comment": "..."},',
	'    ...',
	'  ]',
	'}',
].join('\n');

export class AiReviewService {

	async review(diff: string, prTitle: string, prBody: string, token: vscode.CancellationToken): Promise<ReviewResult> {
		const cfg = vscode.workspace.getConfiguration();
		const maxBytes = cfg.get<number>('agent-pr-review.maxDiffBytes', 200_000);
		const { diff: trimmed, truncated } = truncateDiff(diff, maxBytes);
		const files = parseUnifiedDiff(trimmed);

		const model = await this.resolveModel();
		if (!model) {
			throw new Error('No language model is configured. Add an API key in Agent Chat.');
		}

		const messages: vscode.LanguageModelChatMessage[] = [
			vscode.LanguageModelChatMessage.User(SYSTEM_PROMPT),
			vscode.LanguageModelChatMessage.User(buildUserPrompt(prTitle, prBody, trimmed, truncated)),
		];

		const response = await model.sendRequest(messages, {}, token);
		let buf = '';
		for await (const part of response.stream) {
			if (part instanceof vscode.LanguageModelTextPart) {
				buf += part.value;
			}
		}
		const { summary, findings } = parseReview(buf, files);
		return { summary, findings, truncated, files };
	}

	private async resolveModel(): Promise<vscode.LanguageModelChat | undefined> {
		const pref = vscode.workspace.getConfiguration().get<string>('agent-pr-review.model', '');
		if (pref) {
			const [vendor, family] = pref.split('/', 2);
			const matches = await vscode.lm.selectChatModels(family ? { vendor, family } : { vendor });
			if (matches.length > 0) {
				return matches[0];
			}
		}
		const candidates: Array<{ vendor: string; family: string }> = [
			{ vendor: 'anthropic', family: 'claude-sonnet' },
			{ vendor: 'anthropic', family: 'claude-opus' },
			{ vendor: 'openai', family: 'gpt-5' },
			{ vendor: 'gemini', family: 'gemini-2.5-pro' },
		];
		for (const c of candidates) {
			const matches = await vscode.lm.selectChatModels(c);
			if (matches.length > 0) {
				return matches[0];
			}
		}
		const any = await vscode.lm.selectChatModels();
		return any[0];
	}
}

function buildUserPrompt(title: string, body: string, diff: string, truncated: boolean): string {
	const sections = [`# PR: ${title}`];
	if (body) {
		sections.push('## Description\n\n' + body.trim());
	}
	if (truncated) {
		sections.push('_Note: the diff was truncated to fit context. Some files may be missing._');
	}
	sections.push('## Diff\n\n```diff\n' + diff + '\n```');
	return sections.join('\n\n');
}

export function parseReview(raw: string, files: readonly DiffFile[]): { summary: string; findings: ReviewFinding[] } {
	const json = extractJson(raw);
	if (!json) {
		log('aiReview: no JSON found in model output');
		return { summary: '', findings: [] };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch (err) {
		log(`aiReview: JSON parse failed: ${err instanceof Error ? err.message : String(err)}`);
		return { summary: '', findings: [] };
	}
	if (!parsed || typeof parsed !== 'object') {
		return { summary: '', findings: [] };
	}
	const r = parsed as { summary?: unknown; findings?: unknown };
	const summary = typeof r.summary === 'string' ? r.summary.trim() : '';
	const findings = Array.isArray(r.findings)
		? r.findings.map(f => toFinding(f, files)).filter((f): f is ReviewFinding => !!f)
		: [];
	return { summary, findings };
}

function toFinding(raw: unknown, files: readonly DiffFile[]): ReviewFinding | undefined {
	if (!raw || typeof raw !== 'object') {
		return undefined;
	}
	const r = raw as { path?: unknown; line?: unknown; side?: unknown; severity?: unknown; comment?: unknown };
	const path = typeof r.path === 'string' ? r.path : '';
	const line = typeof r.line === 'number' ? Math.floor(r.line) : NaN;
	const comment = typeof r.comment === 'string' ? r.comment.trim() : '';
	if (!path || !comment || !Number.isFinite(line) || line < 1) {
		return undefined;
	}
	const side: 'LEFT' | 'RIGHT' = r.side === 'LEFT' ? 'LEFT' : 'RIGHT';
	const severity = toSeverity(r.severity);
	const file = files.find(f => f.path === path);
	if (!file) {
		return undefined;
	}
	if (!lineIsInDiff(file, line, side)) {
		return undefined;
	}
	return { path, line, side, severity, comment };
}

function toSeverity(raw: unknown): ReviewSeverity {
	if (raw === 'nit' || raw === 'suggestion' || raw === 'concern' || raw === 'blocker') {
		return raw;
	}
	return 'suggestion';
}

function lineIsInDiff(file: DiffFile, line: number, side: 'LEFT' | 'RIGHT'): boolean {
	for (const hunk of file.hunks) {
		for (const l of hunk.lines) {
			if (side === 'RIGHT' && (l.kind === 'added' || l.kind === 'context') && l.newLine === line) {
				return true;
			}
			if (side === 'LEFT' && (l.kind === 'removed' || l.kind === 'context') && l.oldLine === line) {
				return true;
			}
		}
	}
	return false;
}

function extractJson(raw: string): string | undefined {
	const trimmed = raw.trim();
	if (trimmed.startsWith('{')) {
		return trimmed;
	}
	const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
	if (fenced && fenced[1].trim().startsWith('{')) {
		return fenced[1].trim();
	}
	const m = /\{[\s\S]*\}/.exec(trimmed);
	return m?.[0];
}
