/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Quando a conversa do agente deve encolher, em tokens estimados.
 *
 * O teto da janela do modelo protege contra estouro, não contra custo: com um
 * modelo de 200k tokens a conversa chegava a ~180k antes de qualquer resumo, e
 * cada chamada até lá reenviava o histórico inteiro. Os limites suaves disparam
 * a mesma limpeza bem antes disso, para reduzir o que cada requisição carrega.
 *
 * Sem dependência de `vscode`, para ser testado direto no Node.
 */
export interface ICompactionThresholds {
	/** Acima disto o servidor recusa a requisição: tudo vale para caber, inclusive descartar mensagens. */
	readonly hardLimit: number;
	/** Acima disto os resultados antigos de ferramentas são esvaziados. */
	readonly toolResultLimit: number;
	/** Acima disto a parte antiga da conversa é resumida. */
	readonly compactLimit: number;
}

/** Os dois limites configuráveis; `0` desliga o limite e deixa só o teto da janela. */
export interface ICompactionSettings {
	readonly toolResultThresholdTokens: number;
	readonly thresholdTokens: number;
}

export const DEFAULT_COMPACTION_SETTINGS: ICompactionSettings = {
	toolResultThresholdTokens: 40_000,
	thresholdTokens: 80_000,
};

export function compactionThresholds(hardLimit: number, settings: ICompactionSettings): ICompactionThresholds {
	const soft = (value: number) => Number.isFinite(value) && value > 0 ? Math.min(value, hardLimit) : hardLimit;
	return {
		hardLimit,
		toolResultLimit: soft(settings.toolResultThresholdTokens),
		compactLimit: soft(settings.thresholdTokens),
	};
}

/**
 * Quanto abaixo do limite suave a limpeza de resultados de ferramentas desce.
 *
 * Parar logo abaixo do limite faria a conversa voltar a passar dele no turno
 * seguinte, e cada limpeza reescreve mensagens antigas — o que invalida o cache
 * de prompt (Anthropic, OpenAI, DeepSeek) dali em diante. Descer até a metade
 * agrupa as limpezas: uma de vez em quando em vez de uma por turno.
 */
const EVICTION_HEADROOM = 0.5;

/**
 * Até quantos tokens os resultados antigos de ferramentas devem ser esvaziados,
 * ou `undefined` quando a conversa ainda não precisa disso.
 */
export function evictionTarget(promptTokens: number, thresholds: ICompactionThresholds): number | undefined {
	if (thresholds.toolResultLimit < thresholds.hardLimit && promptTokens > thresholds.toolResultLimit) {
		return Math.floor(thresholds.toolResultLimit * EVICTION_HEADROOM);
	}
	// Só o teto da janela: o bastante para caber, como sempre foi. Um modelo de
	// janela pequena precisa de cada resultado que ainda couber.
	if (promptTokens > thresholds.hardLimit) {
		return thresholds.hardLimit;
	}
	return undefined;
}

/** Por que a conversa vai ser resumida agora. */
export type CompactionTrigger = 'overflow' | 'threshold';

/**
 * Decide se a conversa é resumida antes da próxima chamada.
 *
 * - `overflow`: não cabe na janela. Resume sempre que houver o que resumir.
 * - `threshold`: cabe, mas passou do limite de custo. Só resume quando a parte
 *   que seria resumida (`headTokens`) pesa pelo menos metade do limite. Sem essa
 *   folga, uma cauda recente grande — que nunca é resumida — deixaria a conversa
 *   acima do limite logo depois do resumo, e cada turno pagaria outro resumo
 *   para ganhar quase nada.
 * - Uma tentativa por limite que já falhou nesta requisição não se repete: o
 *   resumidor custa uma chamada inteira, e falhar a cada turno sairia mais caro
 *   do que o histórico que ele tentava poupar.
 */
export function compactionTrigger(
	promptTokens: number,
	headTokens: number,
	thresholds: ICompactionThresholds,
	thresholdAttemptFailed: boolean,
): CompactionTrigger | undefined {
	if (promptTokens > thresholds.hardLimit) {
		return 'overflow';
	}
	if (promptTokens > thresholds.compactLimit && !thresholdAttemptFailed && headTokens >= thresholds.compactLimit / 2) {
		return 'threshold';
	}
	return undefined;
}
