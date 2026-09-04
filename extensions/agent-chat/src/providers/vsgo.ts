/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ITokenLimits, ModelSpec, toAbort } from './base.js';
import { OAICompatProvider } from './oai-compat.js';
import { ByokStorage } from '../byokStorage.js';
import { VsgoAuthProvider, vsgoBaseUrl } from '../account/vsgoAuth.js';
import { log } from '../logger.js';

/**
 * A conta vsgo: uma credencial só, emitida por nós, que fala com todos os
 * provedores.
 *
 * É o contraponto ao BYOK dos outros nove provedores desta pasta. Ali a chave é
 * sua, a conta é sua e a fatura vem do provedor; aqui quem autentica é a conta
 * vsgo, o gateway resolve qual provedor atende cada modelo, e o consumo sai da
 * cota do plano. Os dois caminhos convivem: ter a conta não desativa a sua
 * chave.
 *
 * A credencial não é digitada: vem da sessão aberta em `account/vsgoAuth.ts`,
 * pelo navegador. Pedir a chave `tsk_…` na mão era transferir para a pessoa um
 * trabalho que o login resolve, e ainda deixava a chave passeando pela área de
 * transferência.
 *
 * O gateway fala o formato da OpenAI, então quase tudo vem de graça de
 * `OAICompatProvider`. O que esta classe acrescenta é a sessão, o endereço
 * configurável e o aproveitamento do catálogo, abaixo.
 */

/** Resposta de `GET /v1/models` do gateway, com as extensões do Tensoria. */
interface VsgoModelsResponse {
	data?: Array<{
		id: string;
		display_name?: string;
		context_window?: number;
		max_output_tokens?: number;
	}>;
}

export class VsgoProvider extends OAICompatProvider {

	private readonly _onDidChange = new vscode.EventEmitter<void>();

	/**
	 * Entrar e sair mudam a lista inteira de modelos, e o workbench só
	 * re-resolve um vendor quando a configuração dele muda — o que aqui nunca
	 * acontece, porque a credencial não está na configuração.
	 */
	readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;

	constructor(
		providerId: 'vsgo',
		storage: ByokStorage,
		private readonly auth: VsgoAuthProvider,
	) {
		super(providerId, storage);
	}

	/** Pede ao workbench a lista de modelos de novo (login, logout, upgrade). */
	refresh(): void {
		this._onDidChange.fire();
	}

	dispose(): void {
		this._onDidChange.dispose();
	}

	/**
	 * Endereço do gateway. Configurável porque o mesmo binário aponta para
	 * produção, para uma instância própria ou para o localhost de quem
	 * desenvolve — e porque quem hospeda o próprio Tensoria precisa disto.
	 */
	private get baseUrl(): string {
		return vsgoBaseUrl();
	}

	/**
	 * A credencial é a da conta conectada, nunca uma chave digitada.
	 *
	 * Sem sessão, devolver `undefined` faz a base responder com nenhum modelo —
	 * que é a resposta certa para quem ainda não entrou, e o que leva o seletor
	 * a mostrar a conta como não configurada em vez de oferecer modelos que
	 * responderiam 401.
	 */
	protected override async resolveCredential(): Promise<string | undefined> {
		return (await this.auth.currentSession())?.accessToken;
	}

	/**
	 * Recusa cedo, com o nome do comando que resolve.
	 *
	 * A base lançaria "Missing credential for vsgo", verdadeiro e inútil: quem
	 * lê está no meio de uma conversa e precisa saber que falta entrar na conta,
	 * não que falta uma variável.
	 */
	override async provideLanguageModelChatResponse(
		model: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
		token: vscode.CancellationToken,
	): Promise<void> {
		if (!await this.auth.currentSession()) {
			throw new Error('Entre na sua conta vsgo para usar estes modelos: comando "vsgo: Entrar na conta".');
		}
		return super.provideLanguageModelChatResponse(model, messages, options, progress, token);
	}

	protected override get chatEndpoint(): string {
		return `${this.baseUrl}/v1/chat/completions`;
	}

	protected override get modelsEndpoint(): string {
		return `${this.baseUrl}/v1/models`;
	}

	/**
	 * Vazio de propósito.
	 *
	 * Nos outros provedores o catálogo local existe porque a API deles lista
	 * quais modelos existem, quase nunca o tamanho do contexto de cada um. O
	 * gateway lista as duas coisas (`fetchAvailableModels` abaixo), então não há
	 * o que adivinhar — e sem conta não há modelo a oferecer, que é a resposta
	 * certa para quem ainda não assinou.
	 */
	fallbackModels(): ModelSpec[] {
		return [];
	}

	protected override get unknownModelLimits(): ITokenLimits {
		return { maxInputTokens: 128000, maxOutputTokens: 8192 };
	}

	/**
	 * Sobrescreve a descoberta da base porque o `/v1/models` do gateway carrega
	 * `context_window` e `max_output_tokens` por modelo — os números que o admin
	 * cadastrou no catálogo. É a única fonte exata que existe: qualquer palpite
	 * nosso seria pior, e errar para mais faz o servidor recusar o prompt
	 * inteiro.
	 */
	protected override async fetchAvailableModels(
		credential: string,
		token: vscode.CancellationToken,
	): Promise<ModelSpec[] | undefined> {
		try {
			const res = await fetch(this.modelsEndpoint, {
				headers: { 'Authorization': `Bearer ${credential}` },
				signal: toAbort(token),
			});
			if (!res.ok) {
				// Sem isto, chave recusada e gateway fora do ar ficam
				// indistinguíveis: os dois somem numa lista de modelos vazia.
				log(`[vsgo] ${this.modelsEndpoint} respondeu ${res.status}: ${(await res.text()).slice(0, 300)}`);
				// 401 aqui significa credencial que o servidor não aceita mais
				// (desconectada no painel, conta suspensa). Guardá-la só faria a
				// lista continuar vazia sem dizer por quê; descartada, a próxima
				// tentativa oferece entrar de novo.
				if (res.status === 401) {
					await this.auth.invalidate();
				}
				return undefined;
			}
			const data = await res.json() as VsgoModelsResponse;
			const models = (data.data ?? []).map(m => ({
				id: m.id,
				name: m.display_name || m.id,
				family: m.id,
				maxInputTokens: m.context_window ?? this.unknownModelLimits.maxInputTokens,
				maxOutputTokens: m.max_output_tokens ?? this.unknownModelLimits.maxOutputTokens,
			}));
			if (models.length === 0) {
				log('[vsgo] o gateway não liberou nenhum modelo para esta conta');
				return undefined;
			}
			return models;
		} catch (err) {
			log(`[vsgo] ${this.modelsEndpoint} falhou:`, err instanceof Error ? err.message : String(err));
			return undefined;
		}
	}
}
