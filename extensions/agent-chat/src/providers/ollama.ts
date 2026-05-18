/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { BaseChatProvider, ModelSpec, parseJSONL, toAbort } from './base.js';

interface OllamaTagsResponse { models?: Array<{ name: string }>; }

const DEFAULT_BASE_URL = 'http://localhost:11434';

const FALLBACK: ModelSpec[] = [
	{ id: 'llama3.1', name: 'llama3.1', family: 'llama', maxInputTokens: 32768, maxOutputTokens: 4096 },
];

export class OllamaProvider extends BaseChatProvider {
	protected override get credentialKey(): string { return 'baseUrl'; }

	fallbackModels(): ModelSpec[] { return FALLBACK; }

	protected override async fetchAvailableModels(credential: string, token: vscode.CancellationToken): Promise<ModelSpec[] | undefined> {
		const baseUrl = (credential || DEFAULT_BASE_URL).replace(/\/$/, '');
		const res = await fetch(`${baseUrl}/api/tags`, { signal: toAbort(token) });
		if (!res.ok) {
			return undefined;
		}
		const data = await res.json() as OllamaTagsResponse;
		return (data.models ?? []).map(m => ({
			id: m.name,
			name: m.name,
			family: 'ollama',
			maxInputTokens: 32768,
			maxOutputTokens: 4096,
		}));
	}

	async sendChat(
		baseUrl: string,
		model: ModelSpec,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		tools: readonly vscode.LanguageModelChatTool[] | undefined,
		progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
		token: vscode.CancellationToken,
	): Promise<void> {
		const url = (baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '') + '/api/chat';
		const body = toOllamaMessages(messages);
		const response = await fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				model: model.id,
				messages: body,
				stream: true,
				tools: tools ? tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })) : undefined,
			}),
			signal: toAbort(token),
		});
		if (!response.ok) {
			throw new Error(`Ollama ${response.status}: ${await response.text()}`);
		}

		for await (const evt of parseJSONL(response, token)) {
			const e = evt as { message?: { content?: string; tool_calls?: Array<{ function: { name: string; arguments: object } }> }; done?: boolean };
			if (e.message?.content) {
				progress.report(new vscode.LanguageModelTextPart(e.message.content));
			}
			if (e.message?.tool_calls) {
				for (const tc of e.message.tool_calls) {
					const id = `${tc.function.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
					progress.report(new vscode.LanguageModelToolCallPart(id, tc.function.name, tc.function.arguments ?? {}));
				}
			}
		}
	}
}

function toOllamaMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): unknown[] {
	const out: unknown[] = [];
	for (const m of messages) {
		const role = m.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant'
			: m.role === vscode.LanguageModelChatMessageRole.System ? 'system' : 'user';
		let text = '';
		const toolCalls: unknown[] = [];
		const toolResults: string[] = [];
		for (const p of m.content) {
			if (p instanceof vscode.LanguageModelTextPart) {
				text += p.value;
			} else if (p instanceof vscode.LanguageModelToolCallPart) {
				toolCalls.push({ function: { name: p.name, arguments: p.input } });
			} else if (p instanceof vscode.LanguageModelToolResultPart) {
				let buf = '';
				for (const c of p.content) {
					if (c instanceof vscode.LanguageModelTextPart) { buf += c.value; }
					else if (typeof c === 'string') { buf += c; }
				}
				toolResults.push(buf);
			}
		}
		if (toolResults.length > 0) {
			for (const tr of toolResults) {
				out.push({ role: 'tool', content: tr });
			}
		}
		if (text || toolCalls.length > 0) {
			const entry: Record<string, unknown> = { role, content: text };
			if (toolCalls.length > 0) {
				entry.tool_calls = toolCalls;
			}
			out.push(entry);
		} else if (toolResults.length === 0) {
			out.push({ role, content: '' });
		}
	}
	return out;
}
