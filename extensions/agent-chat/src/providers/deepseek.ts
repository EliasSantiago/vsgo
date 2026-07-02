/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ModelSpec } from './base.js';
import { OAICompatProvider } from './oai-compat.js';

const FALLBACK: ModelSpec[] = [
	{ id: 'deepseek-chat', name: 'DeepSeek Chat (V3)', family: 'deepseek-chat', maxInputTokens: 65536, maxOutputTokens: 8192 },
	{ id: 'deepseek-reasoner', name: 'DeepSeek Reasoner (R1)', family: 'deepseek-reasoner', maxInputTokens: 65536, maxOutputTokens: 65536 },
];

export class DeepSeekProvider extends OAICompatProvider {
	protected override get chatEndpoint(): string { return 'https://api.deepseek.com/v1/chat/completions'; }
	protected override get modelsEndpoint(): string { return 'https://api.deepseek.com/v1/models'; }
	fallbackModels(): ModelSpec[] { return FALLBACK; }
}
