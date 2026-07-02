/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ByokStorage, ProviderId } from '../byokStorage.js';
import { log } from '../logger.js';

export interface ModelSpec {
	readonly id: string;
	readonly name: string;
	readonly family: string;
	readonly maxInputTokens: number;
	readonly maxOutputTokens: number;
}

/** Real token usage reported by a provider's streaming API. */
export interface IProviderUsage {
	readonly inputTokens: number;
	readonly outputTokens: number;
}

export abstract class BaseChatProvider implements vscode.LanguageModelChatProvider {
	protected cachedModels: ModelSpec[] | undefined;

	constructor(
		protected readonly providerId: ProviderId,
		protected readonly storage: ByokStorage,
	) { }

	protected get credentialKey(): string {
		return 'apiKey';
	}

	abstract fallbackModels(): ModelSpec[];

	protected async fetchAvailableModels(_credential: string, _token: vscode.CancellationToken): Promise<ModelSpec[] | undefined> {
		return undefined;
	}

	/**
	 * Sends the chat request and streams parts via `progress`. Returns the real
	 * token usage when the provider's API reports it, otherwise `void` (the base
	 * class then falls back to an estimate).
	 */
	abstract sendChat(
		credential: string,
		model: ModelSpec,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		tools: readonly vscode.LanguageModelChatTool[] | undefined,
		progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
		token: vscode.CancellationToken,
	): Promise<IProviderUsage | void>;

	async provideLanguageModelChatInformation(
		options: vscode.PrepareLanguageModelChatModelOptions,
		token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelChatInformation[]> {
		const credential = await this.resolveCredential(options);
		log(`[${this.providerId}] provideLanguageModelChatInformation: hasCredential=${!!credential}, hasOptionsConfig=${!!options.configuration}, configKeys=${Object.keys(options.configuration ?? {}).join(',')}`);
		if (!credential) {
			return [];
		}
		try {
			const fetched = await this.fetchAvailableModels(credential, token);
			if (fetched && fetched.length > 0) {
				this.cachedModels = fetched;
				log(`[${this.providerId}] fetched ${fetched.length} models from API`);
			} else {
				log(`[${this.providerId}] fetchAvailableModels returned ${fetched ? 'empty' : 'undefined'}; using fallback`);
			}
		} catch (err) {
			log(`[${this.providerId}] fetchAvailableModels threw:`, err instanceof Error ? err.message : String(err));
		}
		const models = this.cachedModels ?? this.fallbackModels();
		log(`[${this.providerId}] returning ${models.length} models: ${models.map(m => m.id).join(', ')}`);
		return models.map(spec => ({
			id: spec.id,
			name: spec.name,
			family: spec.family,
			vendor: this.providerId,
			version: '1.0',
			maxInputTokens: spec.maxInputTokens,
			maxOutputTokens: spec.maxOutputTokens,
			isUserSelectable: true,
			capabilities: { toolCalling: true },
		}));
	}

	async provideLanguageModelChatResponse(
		model: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
		token: vscode.CancellationToken,
	): Promise<void> {
		const credential = await this.resolveCredential(options);
		if (!credential) {
			throw new Error(`Missing credential for ${this.providerId}`);
		}
		const spec = (this.cachedModels ?? this.fallbackModels()).find(m => m.id === model.id)
			?? { id: model.id, name: model.name, family: model.family ?? model.id, maxInputTokens: model.maxInputTokens, maxOutputTokens: model.maxOutputTokens };
		const tools = (options as { tools?: readonly vscode.LanguageModelChatTool[] }).tools;

		// Accumulate streamed output so we can estimate output tokens when the
		// provider's API does not report real usage.
		let outputText = '';
		const meteredProgress: vscode.Progress<vscode.LanguageModelResponsePart2> = {
			report: part => {
				if (part instanceof vscode.LanguageModelTextPart) {
					outputText += part.value;
				}
				progress.report(part);
			},
		};

		const startedAt = Date.now();
		const usage = await this.sendChat(credential, spec, messages, tools, meteredProgress, token);
		this.reportUsage(spec, model, messages, outputText, usage, Date.now() - startedAt);
	}

	/** Reports token usage to the AI Usage meter (best-effort, never throws). */
	private reportUsage(spec: ModelSpec, model: vscode.LanguageModelChatInformation, messages: readonly vscode.LanguageModelChatRequestMessage[], outputText: string, usage: IProviderUsage | void, durationMs: number): void {
		try {
			const estimated = !usage;
			const inputTokens = usage ? usage.inputTokens : messages.reduce((sum, m) => sum + estimateTokens(messageText(m)), 0);
			const outputTokens = usage ? usage.outputTokens : estimateTokens(outputText);
			const graphEnabled = vscode.workspace.getConfiguration('agent-chat').get<boolean>('codeGraph.enabled', false);
			void vscode.commands.executeCommand('_vsgo.aiUsage.record', {
				timestamp: Date.now(),
				vendor: this.providerId,
				modelId: spec.id,
				modelName: model.name ?? spec.name,
				inputTokens,
				outputTokens,
				durationMs,
				estimated,
				tags: [graphEnabled ? 'code-graph:on' : 'code-graph:off'],
			});
		} catch (err) {
			log(`[${this.providerId}] reportUsage failed:`, err instanceof Error ? err.message : String(err));
		}
	}

	async provideTokenCount(
		_model: vscode.LanguageModelChatInformation,
		text: string | vscode.LanguageModelChatRequestMessage,
		_token: vscode.CancellationToken,
	): Promise<number> {
		const value = typeof text === 'string' ? text : extractText(text);
		return Math.ceil(value.length / 4);
	}

	private async resolveCredential(options: { readonly configuration?: { readonly [key: string]: any }; readonly modelConfiguration?: { readonly [key: string]: any } }): Promise<string | undefined> {
		const fromOptions = readCredential(options.modelConfiguration, this.credentialKey)
			?? readCredential(options.configuration, this.credentialKey);
		if (fromOptions) {
			// Mirror into the extension's SecretStorage so the command-based UI keeps working.
			await this.storage.set(this.providerId, fromOptions);
			return fromOptions;
		}
		return this.storage.get(this.providerId);
	}
}

function readCredential(config: { readonly [key: string]: any } | undefined, key: string): string | undefined {
	const value = config?.[key];
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function extractText(message: vscode.LanguageModelChatRequestMessage): string {
	let out = '';
	for (const part of message.content) {
		if (part instanceof vscode.LanguageModelTextPart) {
			out += part.value;
		}
	}
	return out;
}

/** Alias for readability at the usage-reporting call sites. */
function messageText(message: vscode.LanguageModelChatRequestMessage): string {
	return extractText(message);
}

/** Rough token estimate (~4 characters per token) used only as a fallback. */
function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

export async function* parseSSE(response: Response, token: vscode.CancellationToken): AsyncIterable<unknown> {
	if (!response.body) {
		return;
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	try {
		while (!token.isCancellationRequested) {
			const { value, done } = await reader.read();
			if (done) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			let idx: number;
			while ((idx = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, idx).trim();
				buffer = buffer.slice(idx + 1);
				if (!line || !line.startsWith('data:')) {
					continue;
				}
				const payload = line.slice(5).trim();
				if (payload === '[DONE]') {
					return;
				}
				try {
					yield JSON.parse(payload);
				} catch {
					// ignore malformed chunk
				}
			}
		}
	} finally {
		try { reader.releaseLock(); } catch { /* noop */ }
	}
}

export async function* parseJSONL(response: Response, token: vscode.CancellationToken): AsyncIterable<unknown> {
	if (!response.body) {
		return;
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	try {
		while (!token.isCancellationRequested) {
			const { value, done } = await reader.read();
			if (done) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			let idx: number;
			while ((idx = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, idx).trim();
				buffer = buffer.slice(idx + 1);
				if (!line) {
					continue;
				}
				try {
					yield JSON.parse(line);
				} catch {
					// ignore
				}
			}
		}
	} finally {
		try { reader.releaseLock(); } catch { /* noop */ }
	}
}

export function toAbort(token: vscode.CancellationToken): AbortSignal {
	const c = new AbortController();
	token.onCancellationRequested(() => c.abort());
	return c.signal;
}
