/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ByokStorage, PROVIDER_KEY_HINTS } from '../byokStorage.js';
import { isEmbeddingModel, resolveCatalog } from '../localModels/catalog.js';
import { ApiEmbeddingProvider, API_VENDORS, findVendor } from './apiEmbeddingProvider.js';
import { IEmbeddingProvider } from './embeddingProvider.js';
import { LocalEmbeddingProvider } from './localEmbeddingProvider.js';
import { ModelStore } from '../localModels/modelStore.js';
import { ServerManager } from '../localModels/serverManager.js';

const SECTION = 'agent-chat';
const PROVIDER_SETTING = 'semanticIndex.provider';
const API_MODEL_SETTING = 'semanticIndex.apiModel';
const API_BASE_URL_SETTING = 'semanticIndex.apiBaseUrl';
const LOCAL_MODEL_SETTING = 'semanticIndex.model';

/** Settings that change which vectors the index holds. */
export const PROVIDER_SETTINGS = [
	`${SECTION}.${PROVIDER_SETTING}`,
	`${SECTION}.${API_MODEL_SETTING}`,
	`${SECTION}.${API_BASE_URL_SETTING}`,
	`${SECTION}.${LOCAL_MODEL_SETTING}`,
];

export interface IProviderDependencies {
	readonly modelStore: ModelStore;
	readonly serverManager: ServerManager;
	readonly storage: ByokStorage;
	readonly memento: vscode.Memento;
}

/** True when the user has never made a choice. */
export function hasChosenProvider(): boolean {
	const inspected = vscode.workspace.getConfiguration(SECTION).inspect<string>(PROVIDER_SETTING);
	return inspected?.globalValue !== undefined || inspected?.workspaceValue !== undefined;
}

/**
 * Builds the provider the settings currently name.
 *
 * An unknown or unusable vendor id falls back to local rather than leaving the
 * index with nothing: the local path needs no credential and no network, so it
 * is the one choice that is always available.
 */
export function createEmbeddingProvider(deps: IProviderDependencies): IEmbeddingProvider {
	const config = vscode.workspace.getConfiguration(SECTION);
	const chosen = config.get<string>(PROVIDER_SETTING, 'local');
	if (chosen === 'local') {
		return new LocalEmbeddingProvider(deps.modelStore, deps.serverManager, deps.memento);
	}
	const vendor = findVendor(chosen);
	if (!vendor) {
		return new LocalEmbeddingProvider(deps.modelStore, deps.serverManager, deps.memento);
	}
	const model = config.get<string>(API_MODEL_SETTING, '').trim() || vendor.defaultModel;
	const baseUrl = config.get<string>(API_BASE_URL_SETTING, '').trim() || vendor.baseUrl;
	return new ApiEmbeddingProvider(vendor, model, baseUrl, deps.storage, deps.memento);
}

/**
 * Asks the user where embeddings should come from, and records the answer.
 *
 * Returns true when the selection changed, which the index reads as an order to
 * throw its vectors away — numbers from two providers are not comparable.
 */
export async function chooseEmbeddingProvider(storage: ByokStorage): Promise<boolean> {
	const config = vscode.workspace.getConfiguration(SECTION);
	const current = config.get<string>(PROVIDER_SETTING, 'local');

	interface IPick extends vscode.QuickPickItem { readonly value: string }
	const picks: IPick[] = [
		{
			value: 'local',
			label: '$(device-desktop) Local',
			description: current === 'local' ? 'em uso' : undefined,
			detail: 'Nada sai da sua máquina. É a opção mais lenta: horas para um projeto grande.',
		},
		...API_VENDORS.map((vendor): IPick => ({
			value: vendor.id,
			label: `$(cloud) ${vendor.label}`,
			description: current === vendor.id ? 'em uso' : undefined,
			detail: vendor.needsKey
				? 'Minutos em vez de horas, com melhor qualidade. Os trechos do seu código são enviados para o provedor.'
				: 'Roda no seu Ollama, com modelos maiores que a instância embutida.',
		})),
	];

	const chosen = await vscode.window.showQuickPick(picks, {
		title: 'De onde vêm os embeddings do índice semântico',
		placeHolder: 'Você pode trocar depois a qualquer momento',
		ignoreFocusOut: true,
	});
	if (!chosen) {
		return false;
	}

	const before = describeSelection();
	if (chosen.value === 'local') {
		if (!await pickLocalModel(config)) {
			return false;
		}
	} else if (!await configureVendor(config, chosen.value, storage)) {
		return false;
	}
	return describeSelection() !== before;
}

/** Stable string for the current selection, used to detect a real change. */
export function describeSelection(): string {
	const config = vscode.workspace.getConfiguration(SECTION);
	const provider = config.get<string>(PROVIDER_SETTING, 'local');
	if (provider === 'local') {
		return `local:${config.get<string>(LOCAL_MODEL_SETTING, '')}`;
	}
	return `${provider}:${config.get<string>(API_MODEL_SETTING, '')}:${config.get<string>(API_BASE_URL_SETTING, '')}`;
}

async function pickLocalModel(config: vscode.WorkspaceConfiguration): Promise<boolean> {
	const models = resolveCatalog().filter(isEmbeddingModel);
	const current = config.get<string>(LOCAL_MODEL_SETTING, '');
	const chosen = await vscode.window.showQuickPick(
		models.map(model => ({
			value: model.id,
			label: model.name,
			description: current === model.id ? 'em uso' : `${model.sizeMB} MB`,
			detail: model.description,
		})),
		{ title: 'Modelo de embeddings local', ignoreFocusOut: true },
	);
	if (!chosen) {
		return false;
	}
	await config.update(PROVIDER_SETTING, 'local', vscode.ConfigurationTarget.Global);
	await config.update(LOCAL_MODEL_SETTING, chosen.value, vscode.ConfigurationTarget.Global);
	return true;
}

async function configureVendor(config: vscode.WorkspaceConfiguration, vendorId: string, storage: ByokStorage): Promise<boolean> {
	const vendor = findVendor(vendorId);
	if (!vendor) {
		return false;
	}
	const model = await vscode.window.showQuickPick(
		[
			...vendor.suggestedModels.map(id => ({ label: id, value: id, detail: undefined as string | undefined })),
			{ label: '$(edit) Outro…', value: '', detail: 'Informar o id do modelo manualmente' },
		],
		{ title: `Modelo de embeddings — ${vendor.label}`, ignoreFocusOut: true },
	);
	if (!model) {
		return false;
	}
	let modelId = model.value;
	if (!modelId) {
		const typed = await vscode.window.showInputBox({
			title: `Modelo de embeddings — ${vendor.label}`,
			prompt: 'Id do modelo, exatamente como o provedor o nomeia',
			ignoreFocusOut: true,
		});
		if (!typed?.trim()) {
			return false;
		}
		modelId = typed.trim();
	}

	if (!vendor.needsKey) {
		const url = await vscode.window.showInputBox({
			title: `Endereço do ${vendor.label}`,
			value: config.get<string>(API_BASE_URL_SETTING, '') || vendor.baseUrl,
			prompt: 'Endpoint compatível com OpenAI, terminando em /v1',
			ignoreFocusOut: true,
		});
		if (!url?.trim()) {
			return false;
		}
		await config.update(API_BASE_URL_SETTING, url.trim(), vscode.ConfigurationTarget.Global);
	} else if (!await storage.get(vendor.id)) {
		const key = await vscode.window.showInputBox({
			title: `Chave de API — ${vendor.label}`,
			prompt: PROVIDER_KEY_HINTS[vendor.id],
			password: true,
			ignoreFocusOut: true,
		});
		if (!key?.trim()) {
			return false;
		}
		await storage.set(vendor.id, key.trim());
	}

	await config.update(PROVIDER_SETTING, vendor.id, vscode.ConfigurationTarget.Global);
	await config.update(API_MODEL_SETTING, modelId, vscode.ConfigurationTarget.Global);
	return true;
}
