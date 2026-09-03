/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ITokenLimits, ModelSpec, toAbort } from './base.js';
import { OAICompatProvider } from './oai-compat.js';
import { log } from '../logger.js';

/**
 * A conta vsgo: uma chave só, emitida por nós, que fala com todos os provedores.
 *
 * É o contraponto ao BYOK dos outros nove provedores desta pasta. Ali a chave é
 * sua, a conta é sua e a fatura vem do provedor; aqui a chave é `tsk_…`, o
 * gateway resolve qual provedor atende cada modelo, e o consumo sai da cota do
 * plano. Os dois caminhos convivem: ter a conta não desativa a sua chave.
 *
 * O gateway fala o formato da OpenAI, então quase tudo vem de graça de
 * `OAICompatProvider`. O que esta classe acrescenta é o endereço configurável e
 * o aproveitamento do catálogo, abaixo.
 */

const DEFAULT_BASE_URL = 'https://vsgo.orkestrai.com.br';

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

	/**
	 * Endereço do gateway. Configurável porque o mesmo binário aponta para
	 * produção, para uma instância própria ou para o localhost de quem
	 * desenvolve — e porque quem hospeda o próprio Tensoria precisa disto.
	 */
	private get baseUrl(): string {
		const configured = vscode.workspace
			.getConfiguration('agentChat.vsgo')
			.get<string>('baseUrl');
		return (configured || DEFAULT_BASE_URL).replace(/\/$/, '');
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
