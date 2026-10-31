/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Roda direto no Node (>= 22.18 / 24), sem compilar:
//   node --test extensions/agent-chat/test/anthropicCache.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildAnthropicRequest, cacheHitRate, mergeUsage, parseCacheTtl } from '../src/providers/anthropicCache.ts';
import type { IAnthropicMessage, IAnthropicTool } from '../src/providers/anthropicCache.ts';

const SYSTEM_AS_USER = 'You are an AI coding assistant... (prompt de sistema longo)';

const TOOLS: IAnthropicTool[] = [
	{ name: 'agent_search', description: 'search', input_schema: { type: 'object', properties: {} } },
	{ name: 'agent_read_file', description: 'read', input_schema: { type: 'object', properties: { path: { type: 'string' } } } },
	{ name: 'mcp_github_issue', description: 'mcp', input_schema: { type: 'object' } },
];

function user(text: string): IAnthropicMessage {
	return { role: 'user', content: [{ type: 'text', text }] };
}

function assistant(text: string): IAnthropicMessage {
	return { role: 'assistant', content: [{ type: 'text', text }] };
}

/** Uma requisição do agente: prompt de sistema na 1ª mensagem, tools, pedido do usuário. */
function agentRequest(history: IAnthropicMessage[], tools: IAnthropicTool[] = TOOLS) {
	return buildAnthropicRequest({
		model: 'claude-opus-5-5',
		maxTokens: 8192,
		system: '',
		messages: [user(SYSTEM_AS_USER), ...history],
		tools,
		ttl: '5m',
	});
}

/** Quantos `cache_control` a requisição carrega, contando o automático do topo. */
function countBreakpoints(body: object): number {
	return (JSON.stringify(body).match(/"cache_control"/g) ?? []).length;
}

/** O corpo sem nenhum `cache_control`: o marcador muda de lugar, o prefixo não. */
function stripCacheControl(body: object): string {
	return JSON.stringify(body, (key, value) => key === 'cache_control' ? undefined : value);
}

test('agente: cache automático no topo + breakpoint no fim do prompt de sistema', () => {
	const body = agentRequest([user('corrija a função X')]);
	assert.deepEqual(body.cache_control, { type: 'ephemeral' });
	assert.deepEqual(body.messages[0].content[0].cache_control, { type: 'ephemeral' });
	assert.equal(body.messages[1].content[0].cache_control, undefined, 'o pedido do usuário fica para o automático');
	assert.equal(body.system, undefined);
	assert.equal(countBreakpoints(body), 2);
});

test('agente: tools sempre na mesma ordem, qualquer que seja a de registro', () => {
	const a = agentRequest([user('oi')], TOOLS);
	const b = agentRequest([user('oi')], [...TOOLS].reverse());
	assert.deepEqual(a.tools!.map(t => t.name), ['agent_read_file', 'agent_search', 'mcp_github_issue']);
	assert.equal(JSON.stringify(a.tools), JSON.stringify(b.tools));
});

test('agente: o prefixo da chamada anterior reaparece idêntico na seguinte', () => {
	const history1 = [user('corrija a função X')];
	const history2 = [
		user('corrija a função X'),
		{ role: 'assistant' as const, content: [{ type: 'tool_use', id: 't1', name: 'agent_search', input: { query: 'X' } }] },
		{ role: 'user' as const, content: [{ type: 'tool_result', tool_use_id: 't1', content: 'src/x.ts:10' }] },
	];
	const first = agentRequest(history1);
	const second = agentRequest(history2);

	// Tools e sistema byte a byte iguais.
	assert.equal(JSON.stringify(first.tools), JSON.stringify(second.tools));
	assert.equal(JSON.stringify(first.messages[0]), JSON.stringify(second.messages[0]));

	// As mensagens da 1ª chamada são prefixo das da 2ª (sem os marcadores).
	const firstMessages = JSON.parse(stripCacheControl(first)).messages as unknown[];
	const secondMessages = JSON.parse(stripCacheControl(second)).messages as unknown[];
	assert.deepEqual(secondMessages.slice(0, firstMessages.length), firstMessages);
});

test('duas montagens seguidas do mesmo contexto geram exatamente os mesmos bytes', () => {
	assert.equal(JSON.stringify(agentRequest([user('oi')])), JSON.stringify(agentRequest([user('oi')])));
});

test('conversa sem tools (já há resposta do modelo) também usa o automático', () => {
	const body = buildAnthropicRequest({
		model: 'claude-sonnet-5-5', maxTokens: 8192, system: '',
		messages: [user(SYSTEM_AS_USER), user('pergunta'), assistant('resposta'), user('e agora?')],
		tools: undefined, ttl: '5m',
	});
	assert.deepEqual(body.cache_control, { type: 'ephemeral' });
	assert.equal(body.tools, undefined);
});

test('chamada avulsa com system: breakpoint só no fim do system, sem automático', () => {
	const body = buildAnthropicRequest({
		model: 'claude-opus-5-5', maxTokens: 8192, system: 'Você é um revisor de segurança...',
		messages: [user('conteúdo do arquivo que muda a cada chamada')],
		tools: undefined, ttl: '5m',
	});
	assert.equal(body.cache_control, undefined);
	assert.deepEqual(body.system, [{ type: 'text', text: 'Você é um revisor de segurança...', cache_control: { type: 'ephemeral' } }]);
	assert.equal(body.messages[0].content[0].cache_control, undefined);
	assert.equal(countBreakpoints(body), 1);
});

test('chamada avulsa sem system (Bug Bot, PR Review): nenhum breakpoint', () => {
	const body = buildAnthropicRequest({
		model: 'claude-haiku-5-5', maxTokens: 8192, system: '',
		messages: [user('SYSTEM_PROMPT curto'), user('documento')],
		tools: undefined, ttl: '5m',
	});
	assert.equal(countBreakpoints(body), 0);
	assert.equal(body.system, undefined);
});

test('TTL de 1h vai igual no breakpoint explícito e no automático', () => {
	const body = buildAnthropicRequest({
		model: 'claude-opus-5-5', maxTokens: 8192, system: 'sistema',
		messages: [user('oi')], tools: TOOLS, ttl: '1h',
	});
	assert.deepEqual(body.cache_control, { type: 'ephemeral', ttl: '1h' });
	assert.deepEqual(body.system![0].cache_control, { type: 'ephemeral', ttl: '1h' });
});

test('configuração inválida do TTL cai no padrão de 5 minutos', () => {
	assert.equal(parseCacheTtl('1h'), '1h');
	assert.equal(parseCacheTtl('5m'), '5m');
	assert.equal(parseCacheTtl(undefined), '5m');
	assert.equal(parseCacheTtl('2h'), '5m');
});

test('nunca marca bloco de texto vazio (a API recusa)', () => {
	const body = buildAnthropicRequest({
		model: 'claude-opus-5-5', maxTokens: 8192, system: '',
		messages: [{ role: 'user', content: [{ type: 'text', text: '' }] }, user('oi')],
		tools: TOOLS, ttl: '5m',
	});
	assert.equal(body.messages[0].content[0].cache_control, undefined);
	assert.deepEqual(body.cache_control, { type: 'ephemeral' });
});

test('no máximo 4 breakpoints por requisição', () => {
	const body = buildAnthropicRequest({
		model: 'claude-opus-5-5', maxTokens: 8192, system: 'sistema',
		messages: [user(SYSTEM_AS_USER), user('a'), assistant('b'), user('c')],
		tools: TOOLS, ttl: '5m',
	});
	assert.ok(countBreakpoints(body) <= 4);
});

test('taxa de acerto: cache_read / (cache_read + cache_creation + input)', () => {
	assert.equal(cacheHitRate({ input_tokens: 100, cache_creation_input_tokens: 100, cache_read_input_tokens: 800 }), 0.8);
	assert.equal(cacheHitRate({}), undefined);
	const merged = mergeUsage({ input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 1 }, { output_tokens: 50 });
	assert.deepEqual(merged, { input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: undefined, output_tokens: 50 });
});

test('providers que não são da Anthropic (llama-server, OpenAI, vsgo...) não enviam cache_control', () => {
	const dir = join(import.meta.dirname, '..', 'src', 'providers');
	const offenders = readdirSync(dir)
		.filter(file => file.endsWith('.ts') && !file.startsWith('anthropic'))
		.filter(file => readFileSync(join(dir, file), 'utf8').includes('cache_control'));
	assert.deepEqual(offenders, []);
});
