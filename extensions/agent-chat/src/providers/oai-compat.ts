/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { BaseChatProvider, IProviderUsage, ModelSpec, parseSSE, toAbort } from './base.js';

interface OAIToolCallAccum { id: string; name: string; arguments: string }

interface OAIModelsResponse {
	data?: Array<{ id: string; object?: string }>;
}

/**
 * Base class for providers that implement the OpenAI chat completions API format.
 * Mistral, Groq, DeepSeek, xAI, and others use this same wire protocol.
 */
export abstract class OAICompatProvider extends BaseChatProvider {

	protected abstract get chatEndpoint(): string;

	/** Optional: URL for the /models endpoint. Return undefined to skip live model discovery. */
	protected get modelsEndpoint(): string | undefined { return undefined; }

	/** Optional: filter model IDs from the /models response. Return true to include the model. */
	protected filterModelId(_id: string): boolean { return true; }

	protected override async fetchAvailableModels(credential: string, token: vscode.CancellationToken): Promise<ModelSpec[] | undefined> {
		const endpoint = this.modelsEndpoint;
		if (!endpoint) {
			return undefined;
		}
		try {
			const res = await fetch(endpoint, {
				headers: { 'Authorization': `Bearer ${credential}` },
				signal: toAbort(token),
			});
			if (!res.ok) {
				return undefined;
			}
			const data = await res.json() as OAIModelsResponse;
			const ids = (data.data ?? []).map(m => m.id).filter(id => this.filterModelId(id));
			if (ids.length === 0) {
				return undefined;
			}
			return ids.map(id => ({
				id,
				name: id,
				family: id.replace(/-\d{4}-\d{2}-\d{2}$/, ''),
				maxInputTokens: 128000,
				maxOutputTokens: 8192,
			}));
		} catch {
			return undefined;
		}
	}

	async sendChat(
		credential: string,
		model: ModelSpec,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		tools: readonly vscode.LanguageModelChatTool[] | undefined,
		progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
		token: vscode.CancellationToken,
	): Promise<IProviderUsage | void> {
		const response = await fetch(this.chatEndpoint, {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${credential}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				model: model.id,
				messages: toOAIMessages(messages),
				stream: true,
				// Ask OpenAI-compatible APIs to include a final usage chunk.
				stream_options: { include_usage: true },
				tools: tools ? tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })) : undefined,
			}),
			signal: toAbort(token),
		});

		if (!response.ok) {
			throw new Error(`${this.providerId} ${response.status}: ${await response.text()}`);
		}

		const calls = new Map<number, OAIToolCallAccum>();
		let usage: IProviderUsage | undefined;
		for await (const evt of parseSSE(response, token)) {
			const e = evt as { choices?: Array<{ delta?: { content?: string; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>; finish_reason?: string }; finish_reason?: string }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
			if (e.usage) {
				usage = { inputTokens: e.usage.prompt_tokens ?? 0, outputTokens: e.usage.completion_tokens ?? 0 };
			}
			const choice = e.choices?.[0];
			const delta = choice?.delta;
			if (!delta) {
				continue;
			}
			if (delta.content) {
				progress.report(new vscode.LanguageModelTextPart(delta.content));
			}
			if (delta.tool_calls) {
				for (const tc of delta.tool_calls) {
					const existing = calls.get(tc.index) ?? { id: '', name: '', arguments: '' };
					if (tc.id) { existing.id = tc.id; }
					if (tc.function?.name) { existing.name += tc.function.name; }
					if (tc.function?.arguments) { existing.arguments += tc.function.arguments; }
					calls.set(tc.index, existing);
				}
			}
			const finishReason = choice?.finish_reason ?? delta.finish_reason;
			if (finishReason === 'tool_calls' || finishReason === 'stop') {
				for (const c of calls.values()) {
					if (!c.name) { continue; }
					let input: object;
					try { input = c.arguments ? JSON.parse(c.arguments) : {}; }
					catch { input = {}; }
					progress.report(new vscode.LanguageModelToolCallPart(c.id, c.name, input));
				}
				calls.clear();
			}
		}
		// Flush any accumulated tool calls at end of stream
		for (const c of calls.values()) {
			if (!c.name) { continue; }
			let input: object;
			try { input = c.arguments ? JSON.parse(c.arguments) : {}; }
			catch { input = {}; }
			progress.report(new vscode.LanguageModelToolCallPart(c.id, c.name, input));
		}
		return usage;
	}
}

function toOAIMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): unknown[] {
	const out: unknown[] = [];
	for (const m of messages) {
		if (m.role === vscode.LanguageModelChatMessageRole.System) {
			out.push({ role: 'system', content: textOf(m.content) });
			continue;
		}
		if (m.role === vscode.LanguageModelChatMessageRole.Assistant) {
			const toolCalls: unknown[] = [];
			let text = '';
			for (const p of m.content) {
				if (p instanceof vscode.LanguageModelTextPart) {
					text += p.value;
				} else if (p instanceof vscode.LanguageModelToolCallPart) {
					toolCalls.push({ id: p.callId, type: 'function', function: { name: p.name, arguments: JSON.stringify(p.input) } });
				}
			}
			const entry: Record<string, unknown> = { role: 'assistant', content: text || null };
			if (toolCalls.length > 0) {
				entry.tool_calls = toolCalls;
			}
			out.push(entry);
			continue;
		}
		// User
		let plainText = '';
		const toolResults: Array<{ id: string; text: string }> = [];
		for (const p of m.content) {
			if (p instanceof vscode.LanguageModelTextPart) {
				plainText += p.value;
			} else if (p instanceof vscode.LanguageModelToolResultPart) {
				toolResults.push({ id: p.callId, text: textOfUnknown(p.content) });
			}
		}
		for (const tr of toolResults) {
			out.push({ role: 'tool', tool_call_id: tr.id, content: tr.text });
		}
		if (plainText) {
			out.push({ role: 'user', content: plainText });
		}
	}
	return out;
}

function textOf(parts: readonly unknown[]): string {
	let out = '';
	for (const p of parts) {
		if (p instanceof vscode.LanguageModelTextPart) {
			out += p.value;
		}
	}
	return out;
}

function textOfUnknown(parts: readonly unknown[]): string {
	let out = '';
	for (const p of parts) {
		if (p instanceof vscode.LanguageModelTextPart) {
			out += p.value;
		} else if (typeof p === 'string') {
			out += p;
		}
	}
	return out;
}
