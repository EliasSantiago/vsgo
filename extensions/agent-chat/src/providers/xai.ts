/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ITokenLimits, ModelSpec } from './base.js';
import { OAICompatProvider } from './oai-compat.js';

/**
 * Só entra em cena quando o /models não responde. A lista anterior era a da
 * geração Grok 2/3, toda aposentada desde então: quem caísse no fallback via
 * uma lista de modelos que o endpoint de chat recusa. Vale manter curta e
 * conferida contra docs.x.ai/docs/models — a descoberta ao vivo é o caminho
 * normal.
 */
const FALLBACK: ModelSpec[] = [
	{ id: 'grok-4.6', name: 'Grok 4.6', family: 'grok-4.6', maxInputTokens: 500000, maxOutputTokens: 32768 },
	{ id: 'grok-4.5', name: 'Grok 4.5', family: 'grok-4.5', maxInputTokens: 500000, maxOutputTokens: 32768 },
	{ id: 'grok-4.3', name: 'Grok 4.3', family: 'grok-4.3', maxInputTokens: 1000000, maxOutputTokens: 32768 },
	{ id: 'grok-build-0.1', name: 'Grok Build 0.1', family: 'grok-build', maxInputTokens: 262144, maxOutputTokens: 32768 },
];

export class XAIProvider extends OAICompatProvider {
	protected override get chatEndpoint(): string { return 'https://api.x.ai/v1/chat/completions'; }
	protected override get modelsEndpoint(): string { return 'https://api.x.ai/v1/models'; }

	protected override filterModelId(id: string): boolean {
		return id.startsWith('grok-');
	}

	fallbackModels(): ModelSpec[] { return FALLBACK; }

	// Every Grok in the catalog is 262k or wider, so an unlisted one is very
	// unlikely to be narrower than the smallest of them.
	protected override get unknownModelLimits(): ITokenLimits {
		return { maxInputTokens: 262144, maxOutputTokens: 32768 };
	}
}
