/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ByokStorage } from '../byokStorage.js';
import { LocalProvider } from './local.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import { GeminiProvider } from './gemini.js';
import { OllamaProvider } from './ollama.js';
import { MistralProvider } from './mistral.js';
import { GroqProvider } from './groq.js';
import { DeepSeekProvider } from './deepseek.js';
import { XAIProvider } from './xai.js';
import { VsgoProvider } from './vsgo.js';

export function registerAllProviders(storage: ByokStorage, local: LocalProvider): vscode.Disposable {
	const subs: vscode.Disposable[] = [];
	subs.push(vscode.lm.registerLanguageModelChatProvider('local', local));
	// A conta vsgo primeiro: é o caminho de quem não quer administrar chave de
	// provedor, e a ordem aqui é a ordem em que a paleta oferece.
	subs.push(vscode.lm.registerLanguageModelChatProvider('vsgo', new VsgoProvider('vsgo', storage)));
	subs.push(vscode.lm.registerLanguageModelChatProvider('anthropic', new AnthropicProvider('anthropic', storage)));
	subs.push(vscode.lm.registerLanguageModelChatProvider('openai', new OpenAIProvider('openai', storage)));
	subs.push(vscode.lm.registerLanguageModelChatProvider('gemini', new GeminiProvider('gemini', storage)));
	subs.push(vscode.lm.registerLanguageModelChatProvider('ollama', new OllamaProvider('ollama', storage)));
	subs.push(vscode.lm.registerLanguageModelChatProvider('mistral', new MistralProvider('mistral', storage)));
	subs.push(vscode.lm.registerLanguageModelChatProvider('groq', new GroqProvider('groq', storage)));
	subs.push(vscode.lm.registerLanguageModelChatProvider('deepseek', new DeepSeekProvider('deepseek', storage)));
	subs.push(vscode.lm.registerLanguageModelChatProvider('xai', new XAIProvider('xai', storage)));
	return vscode.Disposable.from(...subs);
}
