/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ModelSpec } from './base.js';
import { OAICompatProvider } from './oai-compat.js';

const FALLBACK: ModelSpec[] = [
	{ id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B', family: 'llama-3.3', maxInputTokens: 131072, maxOutputTokens: 32768 },
	{ id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B', family: 'llama-3.1', maxInputTokens: 131072, maxOutputTokens: 8192 },
	{ id: 'llama3-70b-8192', name: 'Llama 3 70B', family: 'llama-3', maxInputTokens: 8192, maxOutputTokens: 8192 },
	{ id: 'mixtral-8x7b-32768', name: 'Mixtral 8x7B', family: 'mixtral', maxInputTokens: 32768, maxOutputTokens: 32768 },
	{ id: 'gemma2-9b-it', name: 'Gemma 2 9B', family: 'gemma-2', maxInputTokens: 8192, maxOutputTokens: 8192 },
];

export class GroqProvider extends OAICompatProvider {
	protected override get chatEndpoint(): string { return 'https://api.groq.com/openai/v1/chat/completions'; }
	protected override get modelsEndpoint(): string { return 'https://api.groq.com/openai/v1/models'; }

	protected override filterModelId(id: string): boolean {
		return !/(whisper|tts|embedding|guard)/i.test(id);
	}

	fallbackModels(): ModelSpec[] { return FALLBACK; }
}
