/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ByokStorage } from '../byokStorage.js';
import { DegenerateOutputGuard } from '../localModels/degenerateOutput.js';
import { ModelStore } from '../localModels/modelStore.js';
import { serverModelId, ServerManager } from '../localModels/serverManager.js';
import { log } from '../logger.js';
import { IProviderUsage, ModelSpec } from './base.js';
import { flattenToAlternating, IWireMessage, OAICompatProvider } from './oai-compat.js';

/**
 * Serves the models downloaded through the Local Models manager.
 *
 * Models are listed straight from disk so they appear in the picker without
 * booting anything; the `llama-server` process is started lazily on the first
 * request. It speaks the OpenAI wire format, so everything except discovery
 * and startup is inherited from {@link OAICompatProvider}.
 */
export class LocalProvider extends OAICompatProvider {

	private readonly _onDidChange = new vscode.EventEmitter<void>();

	/**
	 * Signals the workbench to ask for our model list again.
	 *
	 * A vendor is otherwise only re-resolved when one of its credential
	 * configurations changes, and this one has no credentials at all — so
	 * without this event a model downloaded after startup would stay invisible
	 * in the picker until the window was reloaded.
	 */
	readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;

	constructor(
		providerId: 'local',
		storage: ByokStorage,
		private readonly store: ModelStore,
		private readonly server: ServerManager,
	) {
		super(providerId, storage);
	}

	/** Asks the workbench to re-read the installed models. */
	refresh(): void {
		this._onDidChange.fire();
	}

	dispose(): void {
		this._onDidChange.dispose();
	}

	protected override get requiresCredential(): boolean {
		return false;
	}

	protected override get chatEndpoint(): string {
		return `${this.server.baseUrl ?? ''}/v1/chat/completions`;
	}

	/**
	 * Near-greedy decoding, because every tool call from these models arrives as
	 * plain text to be recovered rather than as a structured call, and that text
	 * only parses when the model stays on the exact JSON shape. At llama.cpp's
	 * default of 0.8 a quarter of the calls came back as prose instead. Not a
	 * flat zero: small models fall into repetition loops when decoding is fully
	 * greedy, and a loop costs a whole turn on CPU inference.
	 */
	protected override get samplingOptions(): Record<string, number> {
		return { temperature: 0.1, top_p: 0.9 };
	}

	/**
	 * Turns off the explicit reasoning phase of models that have one, unless the
	 * user asks for it back.
	 *
	 * Gemma 4 thinks by default, and on CPU that is the difference between a
	 * usable agent and an unusable one: the same request that answers in 17
	 * generated tokens with thinking off spends several times that on the thought
	 * alone, and every agent turn pays it again. Measured on this hardware the
	 * tool call was correct either way. Templates with no reasoning mode ignore
	 * the flag, so it is safe to send to every local model.
	 */
	protected override get extraRequestBody(): Record<string, unknown> {
		const thinking = vscode.workspace.getConfiguration('agent-chat').get<boolean>('localModels.thinking', false);
		return { chat_template_kwargs: { enable_thinking: thinking } };
	}

	protected override async fetchAvailableModels(_credential: string, _token: vscode.CancellationToken): Promise<ModelSpec[] | undefined> {
		const installed = await this.store.listChatModels();
		if (installed.length === 0) {
			// Drop the cached list too: the base class keeps the previous models
			// when a fetch comes back empty, which would leave a model the user
			// just deleted sitting in the picker.
			this.cachedModels = undefined;
			return undefined;
		}
		return installed.map(model => ({
			id: serverModelId(model),
			name: model.name,
			family: 'local',
			// Reserve a slice of the context window for the response so long
			// conversations do not get truncated mid-answer by the server.
			maxInputTokens: Math.max(2048, model.contextLength - 2048),
			maxOutputTokens: 2048,
		}));
	}

	override fallbackModels(): ModelSpec[] {
		return [];
	}

	override async sendChat(
		_credential: string,
		model: ModelSpec,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		tools: readonly vscode.LanguageModelChatTool[] | undefined,
		progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
		token: vscode.CancellationToken,
	): Promise<IProviderUsage | void> {
		await this.ensureServing(model, token);

		// The runtime can collapse into generating one token forever, and the
		// process stays poisoned afterwards. Stop reporting the garbage as soon as
		// it is recognisable, cut the request short, and replace the server so the
		// next attempt starts clean.
		const guard = new DegenerateOutputGuard();
		const abort = new vscode.CancellationTokenSource();
		const cancelled = token.onCancellationRequested(() => abort.cancel());
		const watched: vscode.Progress<vscode.LanguageModelResponsePart2> = {
			report: part => {
				const text = generatedText(part);
				if (text !== undefined && guard.accept(text)) {
					abort.cancel();
					return;
				}
				progress.report(part);
			},
		};

		let usage: IProviderUsage | void = undefined;
		try {
			usage = await super.sendChat('local', model, messages, tools, watched, abort.token);
		} catch (err) {
			// Cutting the request off surfaces as a cancellation, which would
			// otherwise be reported as if the user had pressed stop.
			if (!guard.tripped) {
				throw err;
			}
		} finally {
			cancelled.dispose();
			abort.dispose();
		}

		// Also reached when the collapse ran to the token ceiling on its own: the
		// output was suppressed either way, so the turn has no usable answer in it.
		if (guard.tripped) {
			log(`[localModels] ${model.id} collapsed into repeated output; restarting llama-server`);
			const restart = new vscode.CancellationTokenSource();
			try {
				await this.server.restart(restart.token);
			} catch (err) {
				// Reported through the message below either way: what the user needs
				// to know is that this turn is lost, not how the restart went.
				log(`[localModels] restart after collapse failed: ${err instanceof Error ? err.message : String(err)}`);
			} finally {
				restart.dispose();
			}
			throw new Error(`O modelo ${model.name} travou repetindo o mesmo trecho — um bug conhecido do llama.cpp. Reiniciei o servidor; envie a mensagem de novo.`);
		}
		return usage;
	}

	/**
	 * Brings the runtime up for `model`.
	 *
	 * One process serves one model, so picking a different one in the chat means
	 * restarting: the running server is stopped — freeing the weights it held —
	 * and the new one comes up on the model that was chosen. Nothing is loaded
	 * alongside it.
	 */
	private async ensureServing(model: ModelSpec, token: vscode.CancellationToken): Promise<void> {
		const installed = (await this.store.list()).find(m => serverModelId(m) === model.id);
		if (installed) {
			this.server.setPreferredModel(installed.id);
		}

		const needsRestart = this.server.currentStatus.state === 'ready'
			&& this.server.pinnedModelId !== undefined
			&& installed !== undefined
			&& this.server.pinnedModelId !== installed.id;

		if (needsRestart) {
			log(`[localModels] switching to ${model.name}: restarting the server to release the previous weights`);
		}
		const status = needsRestart
			? await this.server.restart(token)
			: await this.server.ensureStarted(token);

		if (status.state !== 'ready') {
			throw new Error(status.message ?? 'O servidor de modelos locais não está rodando.');
		}

		// Read before the request is built: toWireMessages needs the answer and
		// cannot wait on it.
		await this.server.ensureTemplateCaps(model.id, token);
	}

	/**
	 * Folds tool traffic into plain turns for models whose chat template cannot
	 * render it. Left untouched otherwise, so models that do carry a tool section
	 * — Qwen, Gemma 4 — keep the structured protocol the runtime parses for us.
	 */
	protected override toWireMessages(messages: readonly vscode.LanguageModelChatRequestMessage[], model: ModelSpec): IWireMessage[] {
		const wire = super.toWireMessages(messages, model);
		const caps = this.server.cachedTemplateCaps(model.id);
		return caps && !caps.supportsTools ? flattenToAlternating(wire) : wire;
	}
}

/** Text a response part contributes to the generated stream, if any. */
function generatedText(part: vscode.LanguageModelResponsePart2): string | undefined {
	if (part instanceof vscode.LanguageModelTextPart) {
		return part.value;
	}
	if (part instanceof vscode.LanguageModelThinkingPart) {
		return typeof part.value === 'string' ? part.value : part.value.join('');
	}
	return undefined;
}
