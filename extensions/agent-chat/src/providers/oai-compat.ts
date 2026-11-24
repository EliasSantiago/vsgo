/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { BaseChatProvider, IProviderUsage, ITokenLimits, limitsForModel, ModelSpec, parseSSE, toAbort } from './base.js';
import { log } from '../logger.js';
import { IToolResultImage, looksVisionCapable, splitToolResult, toolImagesCaption } from './toolResultContent.js';

interface OAIToolCallAccum { id: string; name: string; arguments: string }

interface IWireToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }

/** A piece of a multimodal user message in the OpenAI chat completions format. */
type WireContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

/** One message in the OpenAI chat completions wire format. */
export interface IWireMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	/** A list of parts only on a user message that carries images. */
	content: string | null | WireContentPart[];
	tool_calls?: IWireToolCall[];
	tool_call_id?: string;
}

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

	/**
	 * Window assumed for a listed model this provider has no catalog entry for.
	 *
	 * Stated per provider because the lineups differ by an order of magnitude,
	 * and a wrong guess is not symmetric: too small only trims the conversation
	 * early, too large has the server reject the request outright.
	 */
	protected get unknownModelLimits(): ITokenLimits {
		return { maxInputTokens: 128000, maxOutputTokens: 8192 };
	}

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
				// Sem isto o fallback entra em silêncio e a lista de modelos fica
				// parecendo a real: uma chave recusada e um endpoint fora do ar
				// dão exatamente o mesmo resultado visível.
				log(`[${this.providerId}] ${endpoint} respondeu ${res.status}: ${(await res.text()).slice(0, 300)}`);
				return undefined;
			}
			const data = await res.json() as OAIModelsResponse;
			const ids = (data.data ?? []).map(m => m.id).filter(id => this.filterModelId(id));
			if (ids.length === 0) {
				log(`[${this.providerId}] ${endpoint} devolveu ${(data.data ?? []).length} modelos, nenhum sobreviveu ao filtro`);
				return undefined;
			}
			const catalog = this.fallbackModels();
			return ids.map(id => ({
				id,
				name: id,
				family: id.replace(/-\d{4}-\d{2}-\d{2}$/, ''),
				...limitsForModel(id, catalog, this.unknownModelLimits),
			}));
		} catch (err) {
			log(`[${this.providerId}] ${endpoint} falhou:`, err instanceof Error ? err.message : String(err));
			return undefined;
		}
	}

	/**
	 * Sampling parameters merged into the request body.
	 *
	 * Empty for hosted APIs, whose defaults are tuned for the models they serve.
	 * Local runtimes are the ones that need it: llama.cpp defaults to a
	 * temperature of 0.8, high enough that a small model regularly drifts into
	 * describing a tool call in prose instead of emitting one.
	 */
	protected get samplingOptions(): Record<string, number> {
		return {};
	}

	/**
	 * Extra fields merged into the request body, for anything that is not a
	 * sampling knob — a runtime-specific switch such as llama.cpp's
	 * `chat_template_kwargs`, which is handed to the model's own chat template.
	 */
	protected get extraRequestBody(): Record<string, unknown> {
		return {};
	}

	/**
	 * `tool_choice` sent alongside the tools, or `undefined` to leave it to the
	 * server. Only an endpoint whose tool parser is broken or missing needs it.
	 */
	protected get toolChoice(): string | undefined {
		return undefined;
	}

	/**
	 * The conversation in the shape the endpoint expects. Overridable because a
	 * runtime that renders the model's own chat template can only accept what
	 * that template knows how to write.
	 */
	protected toWireMessages(messages: readonly vscode.LanguageModelChatRequestMessage[], model: ModelSpec): IWireMessage[] {
		return toOAIMessages(messages, this.supportsImageInput(model));
	}

	/**
	 * These endpoints publish no capability flags, so vision is judged by the
	 * model id, and an id that is not recognised stays text-only: an image sent
	 * to a model that cannot read it fails the whole request.
	 */
	protected override supportsImageInput(spec: ModelSpec): boolean {
		return looksVisionCapable(spec.id);
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
				messages: this.toWireMessages(messages, model),
				stream: true,
				// Ask OpenAI-compatible APIs to include a final usage chunk.
				stream_options: { include_usage: true },
				tools: tools ? tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })) : undefined,
				tool_choice: tools?.length ? this.toolChoice : undefined,
				...this.samplingOptions,
				...this.extraRequestBody,
			}),
			signal: toAbort(token),
		});

		if (!response.ok) {
			throw new Error(`${this.providerId} ${response.status}: ${await response.text()}`);
		}

		const calls = new Map<number, OAIToolCallAccum>();
		let usage: IProviderUsage | undefined;
		for await (const evt of parseSSE(response, token)) {
			const e = evt as { choices?: Array<{ delta?: { content?: string; reasoning_content?: string; reasoning?: string; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>; finish_reason?: string }; finish_reason?: string }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
			if (e.usage) {
				usage = { inputTokens: e.usage.prompt_tokens ?? 0, outputTokens: e.usage.completion_tokens ?? 0 };
			}
			const choice = e.choices?.[0];
			const delta = choice?.delta;
			if (!delta) {
				continue;
			}
			// A reasoning model puts its whole turn here and leaves `content` empty
			// until the answer itself starts, so dropping this means reporting
			// nothing at all while it works — the request looks frozen for as long
			// as the reasoning takes, which on CPU inference is minutes. Recent vLLM
			// releases renamed the field to `reasoning`.
			const reasoning = delta.reasoning_content ?? delta.reasoning;
			if (reasoning) {
				progress.report(new vscode.LanguageModelThinkingPart(reasoning));
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

/**
 * Rewrites a conversation for chat templates that only know how to render
 * alternating user/assistant turns.
 *
 * Gemma's template is the case that forced this: it raises on a `tool` role and
 * on two turns of the same role in a row, so an agent conversation — which is
 * mostly assistant/tool ping-pong — fails to render at all and the server
 * answers 400 before generating anything. Tool traffic is folded into the
 * surrounding turns as plain text, which these models read fine; it is only the
 * structured form they cannot express.
 */
export function flattenToAlternating(wire: readonly IWireMessage[]): IWireMessage[] {
	const toolNames = new Map<string, string>();
	for (const m of wire) {
		for (const call of m.tool_calls ?? []) {
			toolNames.set(call.id, call.function.name);
		}
	}

	const rewritten: IWireMessage[] = [];
	for (const m of wire) {
		if (m.role === 'tool') {
			const name = m.tool_call_id ? toolNames.get(m.tool_call_id) : undefined;
			const label = name ? `[resultado de ${name}]` : '[resultado da ferramenta]';
			rewritten.push({ role: 'user', content: `${label}\n${m.content ?? ''}` });
			continue;
		}
		if (m.role === 'assistant' && m.tool_calls?.length) {
			const described = m.tool_calls.map(c => `${c.function.name}(${c.function.arguments})`).join('\n');
			rewritten.push({ role: 'assistant', content: [m.content, described].filter(Boolean).join('\n') });
			continue;
		}
		rewritten.push(m);
	}

	// A leading assistant turn breaks the same alternation check that the tool
	// role does, and there is no earlier turn left to merge it into.
	const firstUser = rewritten.findIndex(m => m.role === 'user');
	const body = firstUser < 0 ? [] : rewritten.slice(firstUser);
	const out = [...rewritten.filter(m => m.role === 'system'), ...body.filter(m => m.role !== 'system')];

	// Collapse what the rewrite left adjacent — a tool result followed by the
	// user's next message is now two user turns.
	const merged: IWireMessage[] = [];
	for (const m of out) {
		const previous = merged[merged.length - 1];
		if (previous && previous.role === m.role && m.role !== 'system') {
			previous.content = [previous.content, m.content].filter(Boolean).join('\n\n');
			continue;
		}
		merged.push({ ...m });
	}
	return merged;
}

/**
 * The conversation in the chat completions format. With `includeImages`, images
 * — the user's attachments and those a tool returned — go out as `image_url`
 * parts; tool messages are text only in this format, so a tool's images ride in
 * the user message right after them. Without it, images are left out.
 */
export function toOAIMessages(messages: readonly vscode.LanguageModelChatRequestMessage[], includeImages = false): IWireMessage[] {
	const out: IWireMessage[] = [];
	for (const m of messages) {
		if (m.role === vscode.LanguageModelChatMessageRole.System) {
			out.push({ role: 'system', content: textOf(m.content) });
			continue;
		}
		if (m.role === vscode.LanguageModelChatMessageRole.Assistant) {
			const toolCalls: IWireToolCall[] = [];
			let text = '';
			for (const p of m.content) {
				if (p instanceof vscode.LanguageModelTextPart) {
					text += p.value;
				} else if (p instanceof vscode.LanguageModelToolCallPart) {
					toolCalls.push({ id: p.callId, type: 'function', function: { name: p.name, arguments: JSON.stringify(p.input) } });
				}
			}
			const entry: IWireMessage = { role: 'assistant', content: text || null };
			if (toolCalls.length > 0) {
				entry.tool_calls = toolCalls;
			}
			out.push(entry);
			continue;
		}
		// User
		let plainText = '';
		const toolResults: Array<{ id: string; text: string }> = [];
		const toolImages: IToolResultImage[] = [];
		const attachedImages: IToolResultImage[] = [];
		for (const p of m.content) {
			if (p instanceof vscode.LanguageModelTextPart) {
				plainText += p.value;
			} else if (p instanceof vscode.LanguageModelToolResultPart) {
				const result = splitToolResult(p.content);
				toolResults.push({ id: p.callId, text: result.text });
				toolImages.push(...result.images);
			} else if (p instanceof vscode.LanguageModelDataPart) {
				attachedImages.push(...splitToolResult([p]).images);
			}
		}
		for (const tr of toolResults) {
			out.push({ role: 'tool', tool_call_id: tr.id, content: tr.text });
		}
		const imageParts = (images: readonly IToolResultImage[]): WireContentPart[] =>
			images.map(image => ({ type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.base64}` } }));
		const parts: WireContentPart[] = [];
		if (includeImages && toolImages.length > 0) {
			parts.push({ type: 'text', text: toolImagesCaption(toolImages.length) }, ...imageParts(toolImages));
		}
		if (includeImages) {
			parts.push(...imageParts(attachedImages));
		}
		if (parts.length > 0) {
			if (plainText) {
				parts.push({ type: 'text', text: plainText });
			}
			out.push({ role: 'user', content: parts });
		} else if (plainText) {
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
