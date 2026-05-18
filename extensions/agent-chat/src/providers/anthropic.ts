/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { BaseChatProvider, ModelSpec, parseSSE, toAbort } from './base.js';

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const MODELS_ENDPOINT = 'https://api.anthropic.com/v1/models';
const VERSION = '2023-06-01';

const FALLBACK: ModelSpec[] = [
	{ id: 'claude-opus-4-7', name: 'Claude Opus 4.7', family: 'claude-opus', maxInputTokens: 200000, maxOutputTokens: 8192 },
	{ id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', family: 'claude-sonnet', maxInputTokens: 200000, maxOutputTokens: 8192 },
	{ id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', family: 'claude-haiku', maxInputTokens: 200000, maxOutputTokens: 8192 },
];

interface AnthropicModelsResponse {
	data?: Array<{ id: string; display_name?: string }>;
}

export class AnthropicProvider extends BaseChatProvider {
	fallbackModels(): ModelSpec[] { return FALLBACK; }

	protected override async fetchAvailableModels(credential: string, token: vscode.CancellationToken): Promise<ModelSpec[] | undefined> {
		const res = await fetch(MODELS_ENDPOINT, {
			headers: { 'x-api-key': credential, 'anthropic-version': VERSION },
			signal: toAbort(token),
		});
		if (!res.ok) {
			return undefined;
		}
		const data = await res.json() as AnthropicModelsResponse;
		const items = (data.data ?? []).filter(m => /^claude-/.test(m.id));
		return items.map(m => ({
			id: m.id,
			name: m.display_name ?? m.id,
			family: m.id.replace(/-\d{8}$/, ''),
			maxInputTokens: 200000,
			maxOutputTokens: 8192,
		}));
	}

	async sendChat(
		apiKey: string,
		model: ModelSpec,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		tools: readonly vscode.LanguageModelChatTool[] | undefined,
		progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
		token: vscode.CancellationToken,
	): Promise<void> {
		const { system, messages: body } = toAnthropicMessages(messages);
		const response = await fetch(ENDPOINT, {
			method: 'POST',
			headers: {
				'x-api-key': apiKey,
				'anthropic-version': VERSION,
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				model: model.id,
				max_tokens: model.maxOutputTokens,
				stream: true,
				system: system || undefined,
				messages: body,
				tools: tools ? tools.map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema })) : undefined,
			}),
			signal: toAbort(token),
		});
		if (!response.ok) {
			throw new Error(`Anthropic ${response.status}: ${await response.text()}`);
		}

		const currentToolCall: { id?: string; name?: string; jsonBuf: string } = { jsonBuf: '' };
		for await (const evt of parseSSE(response, token)) {
			const e = evt as { type?: string; index?: number; delta?: { type?: string; text?: string; partial_json?: string }; content_block?: { type?: string; id?: string; name?: string } };
			if (e.type === 'content_block_start' && e.content_block?.type === 'tool_use') {
				currentToolCall.id = e.content_block.id;
				currentToolCall.name = e.content_block.name;
				currentToolCall.jsonBuf = '';
			} else if (e.type === 'content_block_delta') {
				if (e.delta?.type === 'text_delta' && e.delta.text) {
					progress.report(new vscode.LanguageModelTextPart(e.delta.text));
				} else if (e.delta?.type === 'input_json_delta' && e.delta.partial_json !== undefined) {
					currentToolCall.jsonBuf += e.delta.partial_json;
				}
			} else if (e.type === 'content_block_stop') {
				if (currentToolCall.id && currentToolCall.name) {
					let input: object;
					try { input = currentToolCall.jsonBuf ? JSON.parse(currentToolCall.jsonBuf) : {}; }
					catch { input = {}; }
					progress.report(new vscode.LanguageModelToolCallPart(currentToolCall.id, currentToolCall.name, input));
					currentToolCall.id = undefined;
					currentToolCall.name = undefined;
					currentToolCall.jsonBuf = '';
				}
			}
		}
	}
}

function toAnthropicMessages(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
): { system: string; messages: Array<{ role: 'user' | 'assistant'; content: unknown[] }> } {
	let system = '';
	const out: Array<{ role: 'user' | 'assistant'; content: unknown[] }> = [];
	for (const m of messages) {
		if (m.role === vscode.LanguageModelChatMessageRole.System) {
			for (const p of m.content) {
				if (p instanceof vscode.LanguageModelTextPart) {
					system += (system ? '\n\n' : '') + p.value;
				}
			}
			continue;
		}
		const role: 'user' | 'assistant' = m.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user';
		const content: unknown[] = [];
		for (const p of m.content) {
			if (p instanceof vscode.LanguageModelTextPart) {
				if (p.value) {
					content.push({ type: 'text', text: p.value });
				}
			} else if (p instanceof vscode.LanguageModelToolCallPart) {
				content.push({ type: 'tool_use', id: p.callId, name: p.name, input: p.input });
			} else if (p instanceof vscode.LanguageModelToolResultPart) {
				content.push({ type: 'tool_result', tool_use_id: p.callId, content: toAnthropicToolResult(p.content) });
			} else if (p instanceof vscode.LanguageModelDataPart) {
				const data = Buffer.from(p.data).toString('base64');
				if (p.mimeType.startsWith('image/')) {
					content.push({ type: 'image', source: { type: 'base64', media_type: p.mimeType, data } });
				} else if (p.mimeType === 'application/pdf') {
					content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } });
				}
			}
		}
		if (content.length === 0) {
			content.push({ type: 'text', text: '' });
		}
		out.push({ role, content });
	}
	return { system, messages: out };
}

function toAnthropicToolResult(content: unknown[]): unknown {
	const text: string[] = [];
	for (const p of content) {
		if (p instanceof vscode.LanguageModelTextPart) {
			text.push(p.value);
		} else if (typeof p === 'string') {
			text.push(p);
		}
	}
	return text.join('\n');
}
