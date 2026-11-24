/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Roda direto no Node (>= 22.18 / 24), sem compilar:
//   node --test extensions/agent-chat/test/compactionPolicy.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactionThresholds, compactionTrigger, DEFAULT_COMPACTION_SETTINGS, evictionTarget } from '../src/compactionPolicy.ts';

/** Janela de um modelo hospedado grande: 200k tokens, 90% para as mensagens. */
const LARGE = compactionThresholds(180_000, DEFAULT_COMPACTION_SETTINGS);

/** Qwen3-8B do Estado de Goiás: a janela inteira fica abaixo dos limites suaves. */
const SMALL = compactionThresholds(17_000, DEFAULT_COMPACTION_SETTINGS);

test('limites suaves valem abaixo da janela; zero ou janela menor deixam só o teto', () => {
	assert.deepStrictEqual(
		{
			large: LARGE,
			small: SMALL,
			disabled: compactionThresholds(180_000, { toolResultThresholdTokens: 0, thresholdTokens: 0 }),
		},
		{
			large: { hardLimit: 180_000, toolResultLimit: 40_000, compactLimit: 80_000 },
			small: { hardLimit: 17_000, toolResultLimit: 17_000, compactLimit: 17_000 },
			disabled: { hardLimit: 180_000, toolResultLimit: 180_000, compactLimit: 180_000 },
		},
	);
});

test('limpeza de ferramentas desce até a metade do limite suave, ou só até caber na janela', () => {
	assert.deepStrictEqual(
		{
			belowSoft: evictionTarget(39_000, LARGE),
			aboveSoft: evictionTarget(41_000, LARGE),
			smallFits: evictionTarget(16_000, SMALL),
			smallOverflow: evictionTarget(18_000, SMALL),
		},
		{
			belowSoft: undefined,
			aboveSoft: 20_000,
			smallFits: undefined,
			smallOverflow: 17_000,
		},
	);
});

test('resumo dispara no limite de custo só quando a parte antiga pesa, e nunca repete uma falha', () => {
	assert.deepStrictEqual(
		{
			belowThreshold: compactionTrigger(79_000, 70_000, LARGE, false),
			threshold: compactionTrigger(85_000, 60_000, LARGE, false),
			// Logo depois de um resumo: o que sobrou é quase todo cauda recente.
			heavyTail: compactionTrigger(85_000, 5_000, LARGE, false),
			afterFailure: compactionTrigger(85_000, 60_000, LARGE, true),
			// Estourar a janela resume sempre, mesmo depois de falha no limite.
			overflow: compactionTrigger(190_000, 1_000, LARGE, true),
		},
		{
			belowThreshold: undefined,
			threshold: 'threshold',
			heavyTail: undefined,
			afterFailure: undefined,
			overflow: 'overflow',
		},
	);
});
