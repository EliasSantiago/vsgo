/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ByokStorage } from '../byokStorage.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import { GeminiProvider } from './gemini.js';
import { OllamaProvider } from './ollama.js';

export function registerAllProviders(storage: ByokStorage): vscode.Disposable {
	const subs: vscode.Disposable[] = [];
	subs.push(vscode.lm.registerLanguageModelChatProvider('anthropic', new AnthropicProvider('anthropic', storage)));
	subs.push(vscode.lm.registerLanguageModelChatProvider('openai', new OpenAIProvider('openai', storage)));
	subs.push(vscode.lm.registerLanguageModelChatProvider('gemini', new GeminiProvider('gemini', storage)));
	subs.push(vscode.lm.registerLanguageModelChatProvider('ollama', new OllamaProvider('ollama', storage)));
	return vscode.Disposable.from(...subs);
}
