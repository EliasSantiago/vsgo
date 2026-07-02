/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ModelSpec } from './base.js';
import { OAICompatProvider } from './oai-compat.js';

const FALLBACK: ModelSpec[] = [
	{ id: 'mistral-large-latest', name: 'Mistral Large', family: 'mistral-large', maxInputTokens: 131072, maxOutputTokens: 16384 },
	{ id: 'mistral-small-latest', name: 'Mistral Small', family: 'mistral-small', maxInputTokens: 131072, maxOutputTokens: 16384 },
	{ id: 'codestral-latest', name: 'Codestral', family: 'codestral', maxInputTokens: 262144, maxOutputTokens: 16384 },
	{ id: 'mistral-nemo', name: 'Mistral Nemo', family: 'mistral-nemo', maxInputTokens: 131072, maxOutputTokens: 16384 },
	{ id: 'open-mistral-7b', name: 'Mistral 7B', family: 'mistral-7b', maxInputTokens: 32768, maxOutputTokens: 8192 },
];

export class MistralProvider extends OAICompatProvider {
	protected override get chatEndpoint(): string { return 'https://api.mistral.ai/v1/chat/completions'; }
	protected override get modelsEndpoint(): string { return 'https://api.mistral.ai/v1/models'; }
	fallbackModels(): ModelSpec[] { return FALLBACK; }
}
