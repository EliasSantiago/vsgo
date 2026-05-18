/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { log } from '../logger.js';
import { BugBotProvider } from './bugBotProvider.js';
import { BugFinding, BugSeverity, parseFindings } from './findings.js';

const CONFIG_SECTION = 'agent-chat.bugBot';
const DEBOUNCE_MS = 3000;
const MAX_LINES = 500;
const MAX_BYTES = 64 * 1024;
const MIN_INTERVAL_PER_FILE_MS = 5000;
const MAX_REQUESTS_PER_MINUTE = 30;

const EXCLUDED_PATH_RE = /(?:^|\/)(?:node_modules|\.git|out|dist|build|\.vscode-test|\.next|target)\//;
const EXCLUDED_SCHEMES = new Set(['git', 'vscode', 'output', 'comment', 'vscode-userdata', 'vscode-scm']);

const SYSTEM_PROMPT = [
	'You are a focused code reviewer. Review the file the user sends.',
	'Only report real bugs, security issues, obvious mistakes, or correctness problems.',
	'Do NOT report style preferences, missing comments, formatting, or speculative concerns.',
	'Return ONLY a JSON array. Empty array if nothing real to flag.',
	'',
	'Each finding has:',
	'- "line": 1-indexed line number',
	'- "endLine": optional 1-indexed end line (inclusive). Omit if single line.',
	'- "severity": "error" | "warning" | "info"',
	'- "message": one-sentence explanation',
	'- "fix": optional. The exact replacement text for lines [line..endLine].',
	'  Include the same indentation as the original; this string replaces those lines verbatim.',
	'',
	'Output ONLY the JSON array, no markdown fences, no commentary.',
].join('\n');

export class BugBotService implements vscode.Disposable {

	private readonly disposables: vscode.Disposable[] = [];
	private readonly pending = new Map<string, NodeJS.Timeout>();
	private readonly lastRunAt = new Map<string, number>();
	private readonly lastHash = new Map<string, string>();
	private readonly runWindow: number[] = [];
	private inflight = new Set<string>();
	private model: vscode.LanguageModelChat | undefined;
	private resolvingModel: Promise<vscode.LanguageModelChat | undefined> | undefined;

	constructor(private readonly provider: BugBotProvider) {
		this.disposables.push(
			vscode.window.onDidChangeActiveTextEditor(editor => this.schedule(editor?.document)),
			vscode.workspace.onDidChangeTextDocument(e => this.schedule(e.document)),
			vscode.workspace.onDidCloseTextDocument(doc => this.provider.clear(doc.uri)),
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration(CONFIG_SECTION)) {
					this.model = undefined;
					if (!this.isEnabled()) {
						this.provider.clearAll();
					}
				}
			}),
		);
		if (this.isEnabled() && vscode.window.activeTextEditor) {
			this.schedule(vscode.window.activeTextEditor.document);
		}
	}

	dispose(): void {
		for (const t of this.pending.values()) {
			clearTimeout(t);
		}
		this.pending.clear();
		for (const d of this.disposables) {
			d.dispose();
		}
	}

	private isEnabled(): boolean {
		return vscode.workspace.getConfiguration().get<boolean>(`${CONFIG_SECTION}.enabled`, false);
	}

	private minSeverity(): BugSeverity {
		const v = vscode.workspace.getConfiguration().get<string>(`${CONFIG_SECTION}.minSeverity`, 'warning');
		return v === 'error' || v === 'info' ? v : 'warning';
	}

	private schedule(doc: vscode.TextDocument | undefined): void {
		if (!doc || !this.isEnabled() || !this.shouldAnalyze(doc)) {
			return;
		}
		const key = doc.uri.toString();
		const existing = this.pending.get(key);
		if (existing) {
			clearTimeout(existing);
		}
		const handle = setTimeout(() => {
			this.pending.delete(key);
			void this.analyze(doc);
		}, DEBOUNCE_MS);
		this.pending.set(key, handle);
	}

	private shouldAnalyze(doc: vscode.TextDocument): boolean {
		if (EXCLUDED_SCHEMES.has(doc.uri.scheme)) {
			return false;
		}
		if (doc.isUntitled) {
			return false;
		}
		if (EXCLUDED_PATH_RE.test(doc.uri.path)) {
			return false;
		}
		if (doc.lineCount > MAX_LINES) {
			return false;
		}
		const text = doc.getText();
		if (text.length > MAX_BYTES) {
			return false;
		}
		if (looksBinary(text)) {
			return false;
		}
		return true;
	}

	private async analyze(doc: vscode.TextDocument): Promise<void> {
		const key = doc.uri.toString();
		if (this.inflight.has(key)) {
			return;
		}
		const now = Date.now();
		const lastRun = this.lastRunAt.get(key) ?? 0;
		if (now - lastRun < MIN_INTERVAL_PER_FILE_MS) {
			return;
		}
		this.trimRunWindow(now);
		if (this.runWindow.length >= MAX_REQUESTS_PER_MINUTE) {
			log('bugBot: rate limit reached, skipping');
			return;
		}
		const text = doc.getText();
		const hash = hashContent(text);
		if (this.lastHash.get(key) === hash) {
			return;
		}

		const model = await this.resolveModel();
		if (!model) {
			return;
		}

		this.inflight.add(key);
		this.lastRunAt.set(key, now);
		this.runWindow.push(now);

		try {
			const findings = await this.requestFindings(model, doc, text);
			this.lastHash.set(key, hash);
			if (vscode.window.activeTextEditor?.document.uri.toString() === key) {
				this.provider.render(doc.uri, findings, this.minSeverity());
			}
		} catch (err) {
			log(`bugBot: analysis failed for ${doc.uri.fsPath}: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			this.inflight.delete(key);
		}
	}

	private trimRunWindow(now: number): void {
		const cutoff = now - 60_000;
		while (this.runWindow.length > 0 && this.runWindow[0] < cutoff) {
			this.runWindow.shift();
		}
	}

	private async requestFindings(model: vscode.LanguageModelChat, doc: vscode.TextDocument, text: string): Promise<BugFinding[]> {
		const messages: vscode.LanguageModelChatMessage[] = [
			vscode.LanguageModelChatMessage.User(SYSTEM_PROMPT),
			vscode.LanguageModelChatMessage.User(buildUserPrompt(doc, text)),
		];
		const source = new vscode.CancellationTokenSource();
		const timer = setTimeout(() => source.cancel(), 30_000);
		try {
			const response = await model.sendRequest(messages, {}, source.token);
			let buf = '';
			for await (const part of response.stream) {
				if (part instanceof vscode.LanguageModelTextPart) {
					buf += part.value;
				}
			}
			return parseFindings(buf, doc.lineCount);
		} finally {
			clearTimeout(timer);
			source.dispose();
		}
	}

	private async resolveModel(): Promise<vscode.LanguageModelChat | undefined> {
		if (this.model) {
			return this.model;
		}
		if (!this.resolvingModel) {
			this.resolvingModel = this.pickModel();
		}
		this.model = await this.resolvingModel;
		this.resolvingModel = undefined;
		return this.model;
	}

	private async pickModel(): Promise<vscode.LanguageModelChat | undefined> {
		const pref = vscode.workspace.getConfiguration().get<string>(`${CONFIG_SECTION}.model`, '');
		if (pref) {
			const [vendor, family] = pref.split('/', 2);
			const matches = await vscode.lm.selectChatModels(family ? { vendor, family } : { vendor });
			if (matches.length > 0) {
				log(`bugBot: using ${matches[0].vendor}/${matches[0].family}`);
				return matches[0];
			}
		}
		const candidates: Array<{ vendor: string; family: string }> = [
			{ vendor: 'anthropic', family: 'claude-haiku' },
			{ vendor: 'gemini', family: 'gemini-2.5-flash' },
			{ vendor: 'openai', family: 'gpt-4o-mini' },
			{ vendor: 'openai', family: 'gpt-5-mini' },
		];
		for (const c of candidates) {
			const matches = await vscode.lm.selectChatModels(c);
			if (matches.length > 0) {
				log(`bugBot: using ${matches[0].vendor}/${matches[0].family}`);
				return matches[0];
			}
		}
		const any = await vscode.lm.selectChatModels();
		if (any.length > 0) {
			log(`bugBot: falling back to ${any[0].vendor}/${any[0].family}`);
		}
		return any[0];
	}
}

function buildUserPrompt(doc: vscode.TextDocument, text: string): string {
	return [
		`File: ${doc.uri.fsPath}`,
		`Language: ${doc.languageId}`,
		'',
		'```' + (doc.languageId || ''),
		text,
		'```',
	].join('\n');
}

function looksBinary(text: string): boolean {
	const slice = text.slice(0, 2048);
	let nonText = 0;
	for (let i = 0; i < slice.length; i++) {
		const c = slice.charCodeAt(i);
		if (c === 0) {
			return true;
		}
		if (c < 9 || (c > 13 && c < 32)) {
			nonText++;
		}
	}
	return nonText / Math.max(slice.length, 1) > 0.05;
}

function hashContent(text: string): string {
	let h1 = 0xdeadbeef ^ 0;
	let h2 = 0x41c6ce57 ^ 0;
	for (let i = 0; i < text.length; i++) {
		const ch = text.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
	h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
	h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return ((h2 >>> 0).toString(16) + (h1 >>> 0).toString(16));
}
