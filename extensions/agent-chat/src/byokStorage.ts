/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export type ProviderId = 'vsgo' | 'anthropic' | 'openai' | 'gemini' | 'ollama' | 'local' | 'mistral' | 'groq' | 'deepseek' | 'xai';

export const PROVIDER_LABELS: Record<ProviderId, string> = {
	vsgo: 'Conta vsgo',
	anthropic: 'Anthropic',
	openai: 'OpenAI',
	gemini: 'Google Gemini',
	ollama: 'Ollama (local)',
	local: 'Local Models (llama.cpp)',
	mistral: 'Mistral AI',
	groq: 'Groq',
	deepseek: 'DeepSeek',
	xai: 'xAI (Grok)',
};

export const PROVIDER_KEY_HINTS: Record<ProviderId, string> = {
	vsgo: 'tsk_... (chave da sua conta vsgo)',
	anthropic: 'sk-ant-...',
	openai: 'sk-...',
	gemini: 'AIza...',
	ollama: 'http://localhost:11434 (URL, not a key)',
	local: 'No key needed — models run on this machine',
	mistral: 'API key from console.mistral.ai',
	groq: 'API key from console.groq.com',
	deepseek: 'API key from platform.deepseek.com',
	xai: 'API key from console.x.ai',
};

const STORAGE_PREFIX = 'agent-chat.apikey.';

export class ByokStorage {
	private readonly _onChange = new vscode.EventEmitter<ProviderId>();
	readonly onChange = this._onChange.event;

	constructor(private readonly secrets: vscode.SecretStorage) { }

	async get(provider: ProviderId): Promise<string | undefined> {
		return this.secrets.get(STORAGE_PREFIX + provider);
	}

	async set(provider: ProviderId, value: string): Promise<void> {
		await this.secrets.store(STORAGE_PREFIX + provider, value);
		this._onChange.fire(provider);
	}

	async delete(provider: ProviderId): Promise<void> {
		await this.secrets.delete(STORAGE_PREFIX + provider);
		this._onChange.fire(provider);
	}

	async list(): Promise<ProviderId[]> {
		const all: ProviderId[] = ['vsgo', 'anthropic', 'openai', 'gemini', 'ollama', 'local', 'mistral', 'groq', 'deepseek', 'xai'];
		const found: ProviderId[] = [];
		for (const p of all) {
			const value = await this.get(p);
			if (value) {
				found.push(p);
			}
		}
		return found;
	}
}
