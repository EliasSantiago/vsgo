/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ModelSpec } from './base.js';
import { OAICompatProvider } from './oai-compat.js';

const FALLBACK: ModelSpec[] = [
	{ id: 'grok-3', name: 'Grok 3', family: 'grok-3', maxInputTokens: 131072, maxOutputTokens: 131072 },
	{ id: 'grok-3-mini', name: 'Grok 3 Mini', family: 'grok-3-mini', maxInputTokens: 131072, maxOutputTokens: 131072 },
	{ id: 'grok-2', name: 'Grok 2', family: 'grok-2', maxInputTokens: 131072, maxOutputTokens: 131072 },
	{ id: 'grok-2-mini', name: 'Grok 2 Mini', family: 'grok-2-mini', maxInputTokens: 131072, maxOutputTokens: 131072 },
];

export class XAIProvider extends OAICompatProvider {
	protected override get chatEndpoint(): string { return 'https://api.x.ai/v1/chat/completions'; }
	protected override get modelsEndpoint(): string { return 'https://api.x.ai/v1/models'; }

	protected override filterModelId(id: string): boolean {
		return id.startsWith('grok-');
	}

	fallbackModels(): ModelSpec[] { return FALLBACK; }
}
