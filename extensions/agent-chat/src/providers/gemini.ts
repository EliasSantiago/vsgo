/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { BaseChatProvider, ModelSpec, parseSSE, toAbort } from './base.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const FALLBACK: ModelSpec[] = [
	{ id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', family: 'gemini-2.5-pro', maxInputTokens: 2097152, maxOutputTokens: 8192 },
	{ id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', family: 'gemini-2.5-flash', maxInputTokens: 1048576, maxOutputTokens: 8192 },
	{ id: 'gemini-2.0-flash-exp', name: 'Gemini 2.0 Flash (exp)', family: 'gemini-2.0-flash', maxInputTokens: 1048576, maxOutputTokens: 8192 },
	{ id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro', family: 'gemini-1.5-pro', maxInputTokens: 2097152, maxOutputTokens: 8192 },
];

interface GeminiModelsResponse {
	models?: Array<{ name: string; displayName?: string; inputTokenLimit?: number; outputTokenLimit?: number; supportedGenerationMethods?: string[] }>;
}

export class GeminiProvider extends BaseChatProvider {
	fallbackModels(): ModelSpec[] { return FALLBACK; }

	protected override async fetchAvailableModels(credential: string, token: vscode.CancellationToken): Promise<ModelSpec[] | undefined> {
		const res = await fetch(`${BASE}?key=${encodeURIComponent(credential)}`, { signal: toAbort(token) });
		if (!res.ok) {
			return undefined;
		}
		const data = await res.json() as GeminiModelsResponse;
		const filtered = (data.models ?? [])
			.filter(m => m.supportedGenerationMethods?.includes('generateContent'))
			.filter(m => /^models\/gemini-/.test(m.name));
		return filtered.map(m => {
			const id = m.name.replace(/^models\//, '');
			return {
				id,
				name: m.displayName ?? id,
				family: id.replace(/-(latest|preview-\d+)$/, ''),
				maxInputTokens: m.inputTokenLimit ?? 1_048_576,
				maxOutputTokens: m.outputTokenLimit ?? 8192,
			};
		});
	}

	async sendChat(
		apiKey: string,
		model: ModelSpec,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		tools: readonly vscode.LanguageModelChatTool[] | undefined,
		progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
		token: vscode.CancellationToken,
	): Promise<void> {
		const { systemInstruction, contents } = toGeminiMessages(messages);
		const url = `${BASE}/${encodeURIComponent(model.id)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;
		const body: Record<string, unknown> = { contents };
		if (systemInstruction) {
			body.systemInstruction = { parts: [{ text: systemInstruction }] };
		}
		if (tools && tools.length > 0) {
			body.tools = [{ functionDeclarations: tools.map(t => ({ name: t.name, description: t.description, parameters: t.inputSchema })) }];
		}

		const response = await fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
			signal: toAbort(token),
		});
		if (!response.ok) {
			throw new Error(`Gemini ${response.status}: ${await response.text()}`);
		}

		for await (const evt of parseSSE(response, token)) {
			const e = evt as { candidates?: Array<{ content?: { parts?: Array<{ text?: string; functionCall?: { name: string; args: object } }> } }> };
			const parts = e.candidates?.[0]?.content?.parts;
			if (!parts) {
				continue;
			}
			for (const p of parts) {
				if (p.text) {
					progress.report(new vscode.LanguageModelTextPart(p.text));
				}
				if (p.functionCall) {
					const id = `${p.functionCall.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
					progress.report(new vscode.LanguageModelToolCallPart(id, p.functionCall.name, p.functionCall.args ?? {}));
				}
			}
		}
	}
}

function toGeminiMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): { systemInstruction: string; contents: unknown[] } {
	let systemInstruction = '';
	const contents: unknown[] = [];
	for (const m of messages) {
		if (m.role === vscode.LanguageModelChatMessageRole.System) {
			for (const p of m.content) {
				if (p instanceof vscode.LanguageModelTextPart) {
					systemInstruction += (systemInstruction ? '\n\n' : '') + p.value;
				}
			}
			continue;
		}
		const role = m.role === vscode.LanguageModelChatMessageRole.Assistant ? 'model' : 'user';
		const parts: unknown[] = [];
		for (const p of m.content) {
			if (p instanceof vscode.LanguageModelTextPart) {
				if (p.value) {
					parts.push({ text: p.value });
				}
			} else if (p instanceof vscode.LanguageModelToolCallPart) {
				parts.push({ functionCall: { name: p.name, args: p.input } });
			} else if (p instanceof vscode.LanguageModelToolResultPart) {
				parts.push({ functionResponse: { name: p.callId, response: { content: toolText(p.content) } } });
			} else if (p instanceof vscode.LanguageModelDataPart) {
				if (p.mimeType.startsWith('image/') || p.mimeType === 'application/pdf') {
					parts.push({ inlineData: { mimeType: p.mimeType, data: Buffer.from(p.data).toString('base64') } });
				}
			}
		}
		if (parts.length === 0) {
			parts.push({ text: '' });
		}
		contents.push({ role, parts });
	}
	return { systemInstruction, contents };
}

function toolText(parts: readonly unknown[]): string {
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
