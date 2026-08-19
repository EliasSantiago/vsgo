/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { log } from '../logger.js';
import { BaseChatProvider, limitsForModel, ModelSpec, parseSSE, toAbort } from './base.js';

const CHAT_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const RESPONSES_ENDPOINT = 'https://api.openai.com/v1/responses';
const MODELS_ENDPOINT = 'https://api.openai.com/v1/models';

const FALLBACK: ModelSpec[] = [
	{ id: 'gpt-5', name: 'GPT-5', family: 'gpt-5', maxInputTokens: 400000, maxOutputTokens: 16384 },
	{ id: 'gpt-5-mini', name: 'GPT-5 mini', family: 'gpt-5-mini', maxInputTokens: 400000, maxOutputTokens: 16384 },
	{ id: 'gpt-5-codex', name: 'GPT-5 Codex', family: 'gpt-5-codex', maxInputTokens: 400000, maxOutputTokens: 16384 },
	{ id: 'gpt-4o', name: 'GPT-4o', family: 'gpt-4o', maxInputTokens: 128000, maxOutputTokens: 16384 },
	{ id: 'gpt-4o-mini', name: 'GPT-4o mini', family: 'gpt-4o-mini', maxInputTokens: 128000, maxOutputTokens: 16384 },
	{ id: 'o3', name: 'o3', family: 'o3', maxInputTokens: 200000, maxOutputTokens: 100000 },
	{ id: 'o3-mini', name: 'o3 mini', family: 'o3-mini', maxInputTokens: 200000, maxOutputTokens: 100000 },
	{ id: 'o1', name: 'o1', family: 'o1', maxInputTokens: 200000, maxOutputTokens: 100000 },
	{ id: 'o1-mini', name: 'o1 mini', family: 'o1-mini', maxInputTokens: 128000, maxOutputTokens: 65536 },
];

const RESPONSES_ONLY_PATTERNS: ReadonlyArray<RegExp> = [
	/^gpt-5.*-codex/,
	/^codex-/,
	/^o\d+(-pro)/,
];

const responsesOnlyCache = new Set<string>();

interface OpenAIModelsResponse {
	data?: Array<{ id: string; object?: string }>;
}

interface OAIToolCallAccum { id: string; name: string; arguments: string }

export class OpenAIProvider extends BaseChatProvider {
	fallbackModels(): ModelSpec[] { return FALLBACK; }

	protected override async fetchAvailableModels(credential: string, token: vscode.CancellationToken): Promise<ModelSpec[] | undefined> {
		const res = await fetch(MODELS_ENDPOINT, {
			headers: { 'Authorization': `Bearer ${credential}` },
			signal: toAbort(token),
		});
		if (!res.ok) {
			return undefined;
		}
		const data = await res.json() as OpenAIModelsResponse;
		const filtered = (data.data ?? [])
			.map(m => m.id)
			.filter(id => /^(gpt-|o\d|chatgpt-|codex-)/.test(id))
			.filter(id => !/embedding|whisper|tts|moderation|davinci|babbage|search|image|dall|audio|realtime|transcribe|computer-use/i.test(id));
		return filtered.map(id => ({
			id,
			name: prettifyName(id),
			family: id.replace(/-\d{4}-\d{2}-\d{2}$/, ''),
			...limitsForModel(id, FALLBACK, { maxInputTokens: estimateContextWindow(id), maxOutputTokens: 16384 }),
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
		if (this.requiresResponses(model.id)) {
			return await this.sendViaResponses(apiKey, model, messages, tools, progress, token);
		}
		try {
			await this.sendViaChatCompletions(apiKey, model, messages, tools, progress, token);
		} catch (err) {
			if (isResponsesRequiredError(err)) {
				log(`openai: model ${model.id} requires Responses API; retrying`);
				responsesOnlyCache.add(model.id);
				await this.sendViaResponses(apiKey, model, messages, tools, progress, token);
				return;
			}
			throw err;
		}
	}

	private requiresResponses(modelId: string): boolean {
		if (responsesOnlyCache.has(modelId)) {
			return true;
		}
		return RESPONSES_ONLY_PATTERNS.some(re => re.test(modelId));
	}

	private async sendViaChatCompletions(
		apiKey: string,
		model: ModelSpec,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		tools: readonly vscode.LanguageModelChatTool[] | undefined,
		progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
		token: vscode.CancellationToken,
	): Promise<void> {
		const body = toOpenAIMessages(messages);
		const response = await fetch(CHAT_ENDPOINT, {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${apiKey}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				model: model.id,
				messages: body,
				stream: true,
				tools: tools ? tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })) : undefined,
			}),
			signal: toAbort(token),
		});
		if (!response.ok) {
			throw new Error(`OpenAI ${response.status}: ${await response.text()}`);
		}

		const calls = new Map<number, OAIToolCallAccum>();
		for await (const evt of parseSSE(response, token)) {
			const e = evt as { choices?: Array<{ delta?: { content?: string; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string }> };
			const delta = e.choices?.[0]?.delta;
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
					if (tc.function?.name) { existing.name = tc.function.name; }
					if (tc.function?.arguments) { existing.arguments += tc.function.arguments; }
					calls.set(tc.index, existing);
				}
			}
			if (e.choices?.[0]?.finish_reason === 'tool_calls') {
				for (const c of calls.values()) {
					let input: object;
					try { input = c.arguments ? JSON.parse(c.arguments) : {}; }
					catch { input = {}; }
					progress.report(new vscode.LanguageModelToolCallPart(c.id, c.name, input));
				}
				calls.clear();
			}
		}
	}

	private async sendViaResponses(
		apiKey: string,
		model: ModelSpec,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		tools: readonly vscode.LanguageModelChatTool[] | undefined,
		progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
		token: vscode.CancellationToken,
	): Promise<void> {
		const input = toResponsesInput(messages);
		const response = await fetch(RESPONSES_ENDPOINT, {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${apiKey}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				model: model.id,
				input,
				stream: true,
				tools: tools ? tools.map(t => ({ type: 'function', name: t.name, description: t.description, parameters: t.inputSchema })) : undefined,
			}),
			signal: toAbort(token),
		});
		if (!response.ok) {
			throw new Error(`OpenAI ${response.status}: ${await response.text()}`);
		}

		const toolItems = new Map<string, { callId: string; name: string; args: string }>();
		for await (const evt of parseSSE(response, token)) {
			const e = evt as { type?: string; delta?: string; item_id?: string; item?: { type?: string; id?: string; call_id?: string; name?: string; arguments?: string } };
			switch (e.type) {
				case 'response.output_text.delta':
					if (e.delta) {
						progress.report(new vscode.LanguageModelTextPart(e.delta));
					}
					break;
				case 'response.output_item.added':
					if (e.item?.type === 'function_call' && e.item.id) {
						toolItems.set(e.item.id, {
							callId: e.item.call_id ?? e.item.id,
							name: e.item.name ?? '',
							args: e.item.arguments ?? '',
						});
					}
					break;
				case 'response.function_call_arguments.delta':
					if (e.item_id && e.delta) {
						const existing = toolItems.get(e.item_id);
						if (existing) {
							existing.args += e.delta;
						}
					}
					break;
				case 'response.output_item.done':
				case 'response.function_call_arguments.done':
					if (e.item_id) {
						const acc = toolItems.get(e.item_id);
						if (acc && acc.name) {
							let input: object;
							try { input = acc.args ? JSON.parse(acc.args) : {}; }
							catch { input = {}; }
							progress.report(new vscode.LanguageModelToolCallPart(acc.callId, acc.name, input));
							toolItems.delete(e.item_id);
						}
					}
					break;
			}
		}
	}
}

function isResponsesRequiredError(err: unknown): boolean {
	if (!(err instanceof Error)) {
		return false;
	}
	return /v1\/responses/.test(err.message) && /chat\/completions/.test(err.message);
}

function toOpenAIMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): unknown[] {
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
		const mediaParts: Array<{ type: 'image_url'; image_url: { url: string } }> = [];
		let plainText = '';
		const toolResults: Array<{ id: string; text: string }> = [];
		for (const p of m.content) {
			if (p instanceof vscode.LanguageModelTextPart) {
				plainText += p.value;
			} else if (p instanceof vscode.LanguageModelToolResultPart) {
				toolResults.push({ id: p.callId, text: textOfUnknown(p.content) });
			} else if (p instanceof vscode.LanguageModelDataPart && p.mimeType.startsWith('image/')) {
				const data = Buffer.from(p.data).toString('base64');
				mediaParts.push({ type: 'image_url', image_url: { url: `data:${p.mimeType};base64,${data}` } });
			}
		}
		for (const tr of toolResults) {
			out.push({ role: 'tool', tool_call_id: tr.id, content: tr.text });
		}
		if (mediaParts.length > 0) {
			const content: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [...mediaParts];
			if (plainText) {
				content.push({ type: 'text', text: plainText });
			}
			out.push({ role: 'user', content });
		} else if (plainText) {
			out.push({ role: 'user', content: plainText });
		}
	}
	return out;
}

function toResponsesInput(messages: readonly vscode.LanguageModelChatRequestMessage[]): unknown[] {
	const out: unknown[] = [];
	for (const m of messages) {
		if (m.role === vscode.LanguageModelChatMessageRole.System) {
			out.push({ role: 'system', content: textOf(m.content) });
			continue;
		}
		if (m.role === vscode.LanguageModelChatMessageRole.Assistant) {
			let text = '';
			const toolCalls: Array<{ callId: string; name: string; input: object }> = [];
			for (const p of m.content) {
				if (p instanceof vscode.LanguageModelTextPart) {
					text += p.value;
				} else if (p instanceof vscode.LanguageModelToolCallPart) {
					toolCalls.push({ callId: p.callId, name: p.name, input: p.input as object });
				}
			}
			if (text) {
				out.push({ role: 'assistant', content: text });
			}
			for (const tc of toolCalls) {
				out.push({ type: 'function_call', call_id: tc.callId, name: tc.name, arguments: JSON.stringify(tc.input) });
			}
			continue;
		}
		// User
		const inputContent: Array<{ type: 'input_text'; text: string } | { type: 'input_image'; image_url: string }> = [];
		const toolResults: Array<{ callId: string; text: string }> = [];
		for (const p of m.content) {
			if (p instanceof vscode.LanguageModelTextPart) {
				if (p.value) {
					inputContent.push({ type: 'input_text', text: p.value });
				}
			} else if (p instanceof vscode.LanguageModelToolResultPart) {
				toolResults.push({ callId: p.callId, text: textOfUnknown(p.content) });
			} else if (p instanceof vscode.LanguageModelDataPart && p.mimeType.startsWith('image/')) {
				const data = Buffer.from(p.data).toString('base64');
				inputContent.push({ type: 'input_image', image_url: `data:${p.mimeType};base64,${data}` });
			}
		}
		for (const tr of toolResults) {
			out.push({ type: 'function_call_output', call_id: tr.callId, output: tr.text });
		}
		if (inputContent.length > 0) {
			out.push({ role: 'user', content: inputContent });
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

function prettifyName(id: string): string {
	if (/^gpt-5(\.|-|$)/.test(id)) {
		return id.replace(/^gpt-5/, 'GPT-5');
	}
	if (/^gpt-4o(\.|-|$)/.test(id)) {
		return id.replace(/^gpt-4o/, 'GPT-4o');
	}
	if (/^gpt-4(\.|-|$)/.test(id)) {
		return id.replace(/^gpt-4/, 'GPT-4');
	}
	if (/^o(\d)(\.|-|$)/.test(id)) {
		return id;
	}
	if (id.startsWith('chatgpt-')) {
		return 'ChatGPT ' + id.slice('chatgpt-'.length);
	}
	if (id.startsWith('codex-')) {
		return 'Codex ' + id.slice('codex-'.length);
	}
	return id;
}

function estimateContextWindow(id: string): number {
	if (id.startsWith('gpt-5')) { return 400_000; }
	if (id.startsWith('o3') || id.startsWith('o1')) { return 200_000; }
	if (id.startsWith('gpt-4o')) { return 128_000; }
	if (id.startsWith('gpt-4')) { return 128_000; }
	if (id.startsWith('codex-')) { return 200_000; }
	return 128_000;
}
