/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Prompt caching da Anthropic, isolado do resto do provider para poder ser
 * testado sem o host de extensões (nada aqui importa `vscode`).
 *
 * O cache é um casamento de prefixo na ordem `tools` → `system` → `messages`:
 * qualquer byte diferente invalida tudo o que vem depois. Por isso este módulo
 * só decide ONDE ficam os breakpoints e deixa as tools numa ordem fixa; o
 * conteúdo do prompt não muda.
 *
 * - Conversa (há tools ou já há resposta do modelo no histórico): cache
 *   automático no topo da requisição, que avança o breakpoint conforme a
 *   conversa cresce, mais um breakpoint explícito no fim do prompt de sistema
 *   para que tools + sistema sejam reaproveitados entre conversas diferentes.
 * - Chamada avulsa (prompt fixo + entrada única): só o breakpoint explícito no
 *   fim do `system`. O automático cairia na entrada que muda e pagaria a
 *   gravação toda vez sem nunca ler.
 *
 * Prefixos abaixo do mínimo do modelo (512 a 4.096 tokens) simplesmente não são
 * gravados pela API, sem erro e sem custo; não há o que checar aqui.
 */

export type AnthropicCacheTtl = '5m' | '1h';

export interface IAnthropicCacheControl {
	readonly type: 'ephemeral';
	readonly ttl?: '1h';
}

export interface IAnthropicTextBlock {
	readonly type: 'text';
	readonly text: string;
	cache_control?: IAnthropicCacheControl;
}

export interface IAnthropicMessage {
	readonly role: 'user' | 'assistant';
	readonly content: Array<{ readonly type: string; cache_control?: IAnthropicCacheControl;[key: string]: unknown }>;
}

export interface IAnthropicTool {
	readonly name: string;
	readonly description: string;
	readonly input_schema: unknown;
}

export interface IAnthropicRequestBody {
	readonly model: string;
	readonly max_tokens: number;
	readonly stream: true;
	cache_control?: IAnthropicCacheControl;
	system?: IAnthropicTextBlock[];
	readonly messages: IAnthropicMessage[];
	tools?: IAnthropicTool[];
}

export interface IBuildRequestInput {
	readonly model: string;
	readonly maxTokens: number;
	readonly system: string;
	readonly messages: IAnthropicMessage[];
	readonly tools: readonly IAnthropicTool[] | undefined;
	readonly ttl: AnthropicCacheTtl;
}

export function cacheControlFor(ttl: AnthropicCacheTtl): IAnthropicCacheControl {
	// Sem `ttl` é o padrão de 5 minutos; mandar `ttl: '5m'` explícito seria o
	// mesmo, mas manter o corpo como antes evita surpresa em proxies antigos.
	return ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
}

/** Lê o valor da configuração, tratando qualquer coisa inesperada como o padrão. */
export function parseCacheTtl(value: unknown): AnthropicCacheTtl {
	return value === '1h' ? '1h' : '5m';
}

/** Monta o corpo de `/v1/messages` com os breakpoints de cache no lugar. */
export function buildAnthropicRequest(input: IBuildRequestInput): IAnthropicRequestBody {
	const control = cacheControlFor(input.ttl);
	// Ordem fixa por nome: a ordem de registro em `vscode.lm.tools` (e a dos
	// servidores MCP que subiram primeiro) varia entre sessões, e as tools são
	// o começo do prefixo.
	const tools = input.tools && input.tools.length > 0
		? [...input.tools].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
		: undefined;
	const conversational = !!tools || input.messages.some(m => m.role === 'assistant');

	const body: IAnthropicRequestBody = {
		model: input.model,
		max_tokens: input.maxTokens,
		stream: true,
		messages: input.messages,
	};
	if (input.system) {
		body.system = [{ type: 'text', text: input.system, cache_control: control }];
	}
	if (tools) {
		body.tools = tools;
	}
	if (conversational) {
		if (!input.system && input.messages.length > 1) {
			// Quem não usa `system` põe o prompt de sistema na 1ª mensagem
			// (agente principal e subagentes). É o fim do trecho estável.
			markLastBlock(input.messages[0], control);
		}
		body.cache_control = control;
	}
	return body;
}

function markLastBlock(message: IAnthropicMessage, control: IAnthropicCacheControl): void {
	const last = message.content[message.content.length - 1];
	if (!last) {
		return;
	}
	// A API recusa `cache_control` em bloco de texto vazio.
	if (last.type === 'text' && !last.text) {
		return;
	}
	last.cache_control = control;
}

/** O bloco `usage` da Anthropic, que divide o prompt em três contadores. */
export interface IAnthropicUsage {
	readonly input_tokens?: number;
	readonly output_tokens?: number;
	readonly cache_read_input_tokens?: number;
	readonly cache_creation_input_tokens?: number;
}

/**
 * Fração do prompt servida pelo cache:
 * `cache_read / (cache_read + cache_creation + input)`.
 * `undefined` quando a API não informou nada.
 */
export function cacheHitRate(usage: IAnthropicUsage): number | undefined {
	const read = usage.cache_read_input_tokens ?? 0;
	const total = read + (usage.cache_creation_input_tokens ?? 0) + (usage.input_tokens ?? 0);
	return total > 0 ? read / total : undefined;
}

/** Une o `usage` do `message_start` com os campos que o `message_delta` atualiza. */
export function mergeUsage(base: IAnthropicUsage, update: IAnthropicUsage | undefined): IAnthropicUsage {
	if (!update) {
		return base;
	}
	return {
		input_tokens: update.input_tokens ?? base.input_tokens,
		output_tokens: update.output_tokens ?? base.output_tokens,
		cache_read_input_tokens: update.cache_read_input_tokens ?? base.cache_read_input_tokens,
		cache_creation_input_tokens: update.cache_creation_input_tokens ?? base.cache_creation_input_tokens,
	};
}

/** Linha de log de uma chamada, com a taxa da chamada e a acumulada na sessão. */
export function formatUsageLine(model: string, usage: IAnthropicUsage, session: IAnthropicUsage): string {
	const pct = (rate: number | undefined) => rate === undefined ? 'n/a' : `${(rate * 100).toFixed(1)}%`;
	return `[anthropic] usage model=${model}`
		+ ` input=${usage.input_tokens ?? 0}`
		+ ` cache_creation=${usage.cache_creation_input_tokens ?? 0}`
		+ ` cache_read=${usage.cache_read_input_tokens ?? 0}`
		+ ` output=${usage.output_tokens ?? 0}`
		+ ` hit=${pct(cacheHitRate(usage))}`
		+ ` session_hit=${pct(cacheHitRate(session))}`;
}

/** Soma de duas leituras de `usage`, para o acumulado da sessão. */
export function addUsage(a: IAnthropicUsage, b: IAnthropicUsage): IAnthropicUsage {
	return {
		input_tokens: (a.input_tokens ?? 0) + (b.input_tokens ?? 0),
		output_tokens: (a.output_tokens ?? 0) + (b.output_tokens ?? 0),
		cache_read_input_tokens: (a.cache_read_input_tokens ?? 0) + (b.cache_read_input_tokens ?? 0),
		cache_creation_input_tokens: (a.cache_creation_input_tokens ?? 0) + (b.cache_creation_input_tokens ?? 0),
	};
}
