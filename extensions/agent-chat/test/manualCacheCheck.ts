/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Teste manual do prompt caching contra a API real (gasta alguns centavos):
//   ANTHROPIC_API_KEY=sk-ant-... node extensions/agent-chat/test/manualCacheCheck.ts
// Opcional: MODEL=claude-sonnet-5-5 (padrão claude-opus-5-5).
//
// Manda duas chamadas seguidas com o mesmo contexto, montadas pelo mesmo código
// do provider, e mostra o `usage` de cada uma. A segunda tem que vir com
// cache_read_input_tokens > 0.

import { buildAnthropicRequest, cacheHitRate } from '../src/providers/anthropicCache.ts';
import type { IAnthropicUsage } from '../src/providers/anthropicCache.ts';

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
	console.error('Defina ANTHROPIC_API_KEY.');
	process.exit(1);
}
const model = process.env.MODEL ?? 'claude-opus-5-5';

// Prompt de sistema com ~5 mil tokens: acima do mínimo cacheável de qualquer modelo.
const systemPrompt = Array.from({ length: 250 }, (_, i) => `Regra ${i + 1}: responda de forma breve e objetiva, citando arquivos pelo caminho relativo.`).join('\n');
const tools = [{ name: 'agent_read_file', description: 'Lê um arquivo do workspace.', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }];

async function call(label: string): Promise<IAnthropicUsage> {
	const body = buildAnthropicRequest({
		model,
		maxTokens: 64,
		system: '',
		messages: [
			{ role: 'user', content: [{ type: 'text', text: systemPrompt }] },
			{ role: 'user', content: [{ type: 'text', text: 'Diga apenas "ok".' }] },
		],
		tools,
		ttl: '5m',
	});
	const res = await fetch('https://api.anthropic.com/v1/messages', {
		method: 'POST',
		headers: { 'x-api-key': apiKey!, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
		body: JSON.stringify({ ...body, stream: false }),
	});
	if (!res.ok) {
		throw new Error(`${label}: HTTP ${res.status} ${await res.text()}`);
	}
	const usage = (await res.json() as { usage: IAnthropicUsage }).usage;
	const rate = cacheHitRate(usage);
	console.log(`${label}: input=${usage.input_tokens} cache_creation=${usage.cache_creation_input_tokens} cache_read=${usage.cache_read_input_tokens} hit=${rate === undefined ? 'n/a' : (rate * 100).toFixed(1) + '%'}`);
	return usage;
}

await call('1ª chamada');
const second = await call('2ª chamada');
if ((second.cache_read_input_tokens ?? 0) > 0) {
	console.log('OK: a 2ª chamada leu do cache.');
} else {
	console.error('FALHOU: a 2ª chamada não leu nada do cache.');
	process.exit(1);
}
