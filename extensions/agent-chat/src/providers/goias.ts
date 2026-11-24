/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { log } from '../logger.js';
import { IProviderUsage, ITokenLimits, ModelSpec } from './base.js';
import { OAICompatProvider } from './oai-compat.js';

/** Servidor OAuth2 do Estado de Goiás que troca as credenciais da aplicação por um token. */
const TOKEN_ENDPOINT = 'https://ssolab.go.gov.br/oauth2/token';

/** Gateway do modelo on-premise. A versão faz parte do caminho publicado pelo gateway. */
const API_BASE = 'https://api.ia.go.gov.br/qwen3-8b/1.1.0/v1';

/**
 * Renova o token um pouco antes do vencimento, para que uma requisição longa
 * não comece com um token que expira no meio do streaming.
 */
const EXPIRY_MARGIN_MS = 60_000;

/** Usado quando o servidor OAuth não informa `expires_in`. */
const DEFAULT_TOKEN_LIFETIME_S = 3600;

/**
 * O servidor publica `max_model_len` de 32768 para o Qwen3-8B. A janela é
 * repartida entre entrada e saída porque o vLLM recusa a requisição inteira
 * quando as duas somadas passam do limite.
 */
const FALLBACK: ModelSpec[] = [
	{ id: 'qwen3-8b', name: 'Qwen3 8B (Goiás)', family: 'qwen3', maxInputTokens: 24576, maxOutputTokens: 8192 },
];

interface ITokenResponse {
	access_token?: string;
	expires_in?: number;
}

interface IIssuedToken {
	/** `consumerKey:consumerSecret` que originou o token. */
	readonly clientCredential: string;
	readonly accessToken: string;
	readonly expiresAt: number;
}

/**
 * Modelo Qwen3-8B hospedado pelo Estado de Goiás.
 *
 * Diferente dos outros provedores, a credencial configurada não é a que vai no
 * cabeçalho das chamadas: o par Consumer Key / Consumer Secret da aplicação é
 * trocado por um access token no fluxo OAuth2 `client_credentials`, e é esse
 * token — válido por uma hora — que autentica `/models` e `/chat/completions`.
 * O token fica em memória e é renovado sozinho quando vence ou quando a API o
 * recusa.
 */
export class GoiasProvider extends OAICompatProvider {

	private issued: IIssuedToken | undefined;
	private pending: { readonly clientCredential: string; readonly promise: Promise<string> } | undefined;

	protected override get chatEndpoint(): string { return `${API_BASE}/chat/completions`; }
	protected override get modelsEndpoint(): string { return `${API_BASE}/models`; }

	/**
	 * O gateway lista o mesmo modelo também pelo caminho interno
	 * (`publishers/qwen3-8b/models/qwen3-8b`), que apareceria duplicado no seletor.
	 */
	protected override filterModelId(id: string): boolean {
		return !id.includes('/');
	}

	fallbackModels(): ModelSpec[] { return FALLBACK; }

	protected override get unknownModelLimits(): ITokenLimits {
		return { maxInputTokens: 24576, maxOutputTokens: 8192 };
	}

	/**
	 * O vLLM do gateway não tem o parser de ferramentas ligado. Com
	 * `tool_choice: auto` ele descarta do streaming o texto da chamada
	 * (`<tool_call>{...}</tool_call>`) e a resposta chega vazia; com `none` o
	 * texto vem inteiro e o perfil compacto do agente recupera a chamada dele.
	 */
	protected override get toolChoice(): string | undefined {
		return 'none';
	}

	/**
	 * O Qwen3 pensa por padrão, e num modelo de 8B com 32k de janela o raciocínio
	 * custa mais do que rende: um "bom dia" gerou milhares de caracteres de
	 * pensamento antes da resposta, e cada turno do agente pagaria isso de novo.
	 */
	protected override get extraRequestBody(): Record<string, unknown> {
		const thinking = vscode.workspace.getConfiguration('agent-chat').get<boolean>('goias.thinking', false);
		return { chat_template_kwargs: { enable_thinking: thinking } };
	}

	/**
	 * Devolve o access token em vez da credencial guardada: é ele que as chamadas
	 * de `/models` e `/chat/completions` herdadas da classe base colocam no
	 * cabeçalho `Authorization: Bearer`.
	 */
	protected override async resolveCredential(options: { readonly configuration?: { readonly [key: string]: any }; readonly modelConfiguration?: { readonly [key: string]: any } }): Promise<string | undefined> {
		const clientCredential = await this.resolveClientCredential(options);
		if (!clientCredential) {
			return undefined;
		}
		return this.accessTokenFor(clientCredential);
	}

	/** Uma recusa por token vencido ou revogado ganha uma segunda tentativa com token novo. */
	override async sendChat(
		credential: string,
		model: ModelSpec,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		tools: readonly vscode.LanguageModelChatTool[] | undefined,
		progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
		token: vscode.CancellationToken,
	): Promise<IProviderUsage | void> {
		try {
			return await super.sendChat(credential, model, messages, tools, progress, token);
		} catch (err) {
			const clientCredential = this.issued?.accessToken === credential ? this.issued.clientCredential : undefined;
			if (!clientCredential || !(err instanceof Error) || !err.message.startsWith(`${this.providerId} 401:`)) {
				throw err;
			}
			log(`[${this.providerId}] token recusado pela API; pedindo outro`);
			this.issued = undefined;
			const fresh = await this.accessTokenFor(clientCredential);
			return super.sendChat(fresh, model, messages, tools, progress, token);
		}
	}

	private async resolveClientCredential(options: { readonly configuration?: { readonly [key: string]: any }; readonly modelConfiguration?: { readonly [key: string]: any } }): Promise<string | undefined> {
		const key = readField(options.modelConfiguration, 'consumerKey') ?? readField(options.configuration, 'consumerKey');
		const secret = readField(options.modelConfiguration, 'consumerSecret') ?? readField(options.configuration, 'consumerSecret');
		if (key && secret) {
			const combined = `${key}:${secret}`;
			// Espelhado no SecretStorage da extensão, como fazem os outros provedores,
			// para que os comandos de chave continuem enxergando a configuração.
			if (await this.storage.get(this.providerId) !== combined) {
				await this.storage.set(this.providerId, combined);
			}
			return combined;
		}
		return (await this.storage.get(this.providerId))?.trim() || undefined;
	}

	private accessTokenFor(clientCredential: string): Promise<string> {
		const issued = this.issued;
		if (issued && issued.clientCredential === clientCredential && Date.now() < issued.expiresAt - EXPIRY_MARGIN_MS) {
			return Promise.resolve(issued.accessToken);
		}
		// A descoberta de modelos e a primeira mensagem costumam pedir o token ao
		// mesmo tempo; uma única troca atende as duas.
		if (this.pending?.clientCredential === clientCredential) {
			return this.pending.promise;
		}
		const promise = this.requestAccessToken(clientCredential).finally(() => {
			if (this.pending?.promise === promise) {
				this.pending = undefined;
			}
		});
		this.pending = { clientCredential, promise };
		return promise;
	}

	private async requestAccessToken(clientCredential: string): Promise<string> {
		const separator = clientCredential.indexOf(':');
		if (separator <= 0 || separator === clientCredential.length - 1) {
			throw new Error('Credencial do Estado de Goiás incompleta: informe o Consumer Key e o Consumer Secret da aplicação.');
		}
		const response = await fetch(TOKEN_ENDPOINT, {
			method: 'POST',
			headers: {
				'Authorization': `Basic ${Buffer.from(clientCredential, 'utf8').toString('base64')}`,
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: 'grant_type=client_credentials',
		});
		if (!response.ok) {
			const detail = (await response.text()).slice(0, 300);
			log(`[${this.providerId}] ${TOKEN_ENDPOINT} respondeu ${response.status}: ${detail}`);
			throw new Error(`Não foi possível obter o token de acesso do Estado de Goiás (HTTP ${response.status}). Confira o Consumer Key e o Consumer Secret. ${detail}`);
		}
		const data = await response.json() as ITokenResponse;
		if (!data.access_token) {
			throw new Error('O servidor OAuth do Estado de Goiás respondeu sem access_token.');
		}
		const lifetime = typeof data.expires_in === 'number' && data.expires_in > 0 ? data.expires_in : DEFAULT_TOKEN_LIFETIME_S;
		this.issued = { clientCredential, accessToken: data.access_token, expiresAt: Date.now() + lifetime * 1000 };
		log(`[${this.providerId}] token obtido, válido por ${lifetime}s`);
		return data.access_token;
	}
}

function readField(config: { readonly [key: string]: any } | undefined, key: string): string | undefined {
	const value = config?.[key];
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
