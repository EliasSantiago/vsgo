/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { evaluateFit, FitLevel, ICatalogModel, resolveCatalog } from './catalog.js';
import { describeHardware, detectHardware } from './hardware.js';
import { ModelStore } from './modelStore.js';
import { ServerManager, ServerState } from './serverManager.js';
import { log } from '../logger.js';

/**
 * Snapshot handed to the Local Models panel in the workbench.
 *
 * The panel lives in the renderer and cannot import anything from this
 * extension, so the whole state crosses the boundary as plain data. Every field
 * is pre-formatted for display: the panel renders, it does not compute.
 */
export interface ILocalModelsState {
	readonly hardwareSummary: string;
	readonly modelsDirectory: string;
	readonly runtime: {
		readonly installed: boolean;
		readonly path?: string;
		readonly state: ServerState;
		readonly baseUrl?: string;
		readonly message?: string;
		/** Name of the single model the running process is serving. */
		readonly modelName?: string;
		/** Present while the runtime archive is downloading. */
		readonly install?: { readonly message: string; readonly percent: number };
	};
	readonly models: readonly ILocalModelEntry[];
}

export interface ILocalModelEntry {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly params: string;
	readonly sizeLabel: string;
	readonly contextLabel: string;
	readonly fitLevel: FitLevel;
	readonly fitReason: string;
	readonly installed: boolean;
	readonly requiresPatchedRuntime: boolean;
	/** Present while this model is downloading. */
	readonly download?: { readonly percent: number; readonly label: string };
}

interface IActiveDownload {
	readonly source: vscode.CancellationTokenSource;
	percent: number;
	label: string;
}

/**
 * Backs the Local Models panel: turns the catalog, the hardware profile and the
 * on-disk state into one snapshot, and runs the download / runtime actions the
 * panel triggers.
 *
 * Downloads run detached from any UI so the panel can be closed and reopened
 * without interrupting them; progress is polled through {@link getState}.
 */
export class LocalModelsController {

	private readonly downloads = new Map<string, IActiveDownload>();
	private runtimeInstall: { message: string; percent: number } | undefined;

	constructor(
		private readonly store: ModelStore,
		private readonly server: ServerManager,
	) { }

	async getState(): Promise<ILocalModelsState> {
		const [hardware, installed, binary] = await Promise.all([
			detectHardware(),
			this.store.list(),
			this.server.findBinary(),
		]);
		const installedIds = new Set(installed.map(m => m.id));
		const status = this.server.currentStatus;

		const models = resolveCatalog().map(model => this.toEntry(model, hardware, installedIds.has(model.id)));
		// Best fit first, installed models pinned to the top.
		const rank: Record<FitLevel, number> = { ideal: 0, ok: 1, tight: 2, unsupported: 3 };
		models.sort((a, b) => {
			if (a.installed !== b.installed) {
				return a.installed ? -1 : 1;
			}
			return rank[a.fitLevel] - rank[b.fitLevel];
		});

		return {
			hardwareSummary: describeHardware(hardware),
			modelsDirectory: this.store.modelsDir,
			runtime: {
				installed: !!binary,
				path: binary,
				state: status.state,
				baseUrl: status.baseUrl,
				message: status.message,
				modelName: installed.find(m => m.id === this.server.pinnedModelId)?.name,
				install: this.runtimeInstall,
			},
			models,
		};
	}

	private toEntry(model: ICatalogModel, hardware: Parameters<typeof evaluateFit>[1], installed: boolean): ILocalModelEntry {
		const fit = evaluateFit(model, hardware);
		const active = this.downloads.get(model.id);
		return {
			id: model.id,
			name: model.name,
			description: model.description,
			params: model.params,
			sizeLabel: `${(model.sizeMB / 1024).toFixed(1)} GB`,
			contextLabel: `${Math.round(model.contextLength / 1024)}k`,
			fitLevel: fit.level,
			fitReason: fit.reason,
			installed,
			requiresPatchedRuntime: !!model.requiresPatchedRuntime,
			download: active ? { percent: active.percent, label: active.label } : undefined,
		};
	}

	/** Starts a download and returns immediately; progress shows up in {@link getState}. */
	startDownload(id: string): void {
		if (this.downloads.has(id)) {
			return;
		}
		const model = resolveCatalog().find(m => m.id === id);
		if (!model) {
			return;
		}
		const source = new vscode.CancellationTokenSource();
		const active: IActiveDownload = { source, percent: 0, label: '' };
		this.downloads.set(id, active);

		void (async () => {
			try {
				const hardware = await detectHardware();
				const fit = evaluateFit(model, hardware);
				await this.store.download(model, fit.gpuLayers, ({ receivedBytes, totalBytes }) => {
					active.percent = totalBytes > 0 ? (receivedBytes / totalBytes) * 100 : 0;
					active.label = `${(receivedBytes / 1073741824).toFixed(2)} / ${(totalBytes / 1073741824).toFixed(2)} GB`;
				}, source.token);
				vscode.window.showInformationMessage(`${model.name} está pronto. Selecione-o no seletor de modelos do chat.`);
			} catch (err) {
				if (err instanceof vscode.CancellationError) {
					vscode.window.showInformationMessage(`Download de ${model.name} pausado. Ao iniciar de novo, ele continua de onde parou.`);
				} else {
					const message = err instanceof Error ? err.message : String(err);
					log(`[localModels] download failed: ${message}`);
					vscode.window.showErrorMessage(`Falha ao baixar ${model.name}: ${message}`);
				}
			} finally {
				this.downloads.delete(id);
				source.dispose();
			}
		})();
	}

	cancelDownload(id: string): void {
		this.downloads.get(id)?.source.cancel();
	}

	async removeModel(id: string): Promise<void> {
		await this.store.remove(id);
		if (this.server.pinnedModelId === id) {
			this.server.stop();
		}
	}

	async installRuntime(): Promise<void> {
		if (this.runtimeInstall) {
			return;
		}
		this.runtimeInstall = { message: 'Iniciando…', percent: 0 };
		const source = new vscode.CancellationTokenSource();
		try {
			await this.server.installBinary((message, percent) => {
				this.runtimeInstall = { message, percent: percent ?? this.runtimeInstall?.percent ?? 0 };
			}, source.token);
			vscode.window.showInformationMessage('Runtime do llama.cpp instalado.');
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			log(`[localModels] runtime install failed: ${message}`);
			vscode.window.showErrorMessage(`Falha ao instalar o runtime do llama.cpp: ${message}`);
		} finally {
			this.runtimeInstall = undefined;
			source.dispose();
		}
	}

	async startServer(): Promise<void> {
		const source = new vscode.CancellationTokenSource();
		try {
			const status = await this.server.ensureStarted(source.token);
			if (status.state !== 'ready') {
				vscode.window.showErrorMessage(status.message ?? 'O servidor de modelos locais falhou ao iniciar.');
			}
		} finally {
			source.dispose();
		}
	}

	stopServer(): void {
		this.server.stop();
	}

	async openModelsFolder(): Promise<void> {
		const dir = await this.store.ensureModelsDir();
		await vscode.env.openExternal(vscode.Uri.file(dir));
	}

	dispose(): void {
		for (const active of this.downloads.values()) {
			active.source.cancel();
			active.source.dispose();
		}
		this.downloads.clear();
	}
}

/**
 * Exposes the controller to the workbench. These are internal plumbing
 * commands, not user-facing ones, so they are not contributed in package.json
 * and stay out of the command palette.
 */
export function registerLocalModelsCommands(controller: LocalModelsController): vscode.Disposable {
	const subs: vscode.Disposable[] = [
		vscode.commands.registerCommand('_vsgo.localModels.state', () => controller.getState()),
		vscode.commands.registerCommand('_vsgo.localModels.download', (id: string) => controller.startDownload(id)),
		vscode.commands.registerCommand('_vsgo.localModels.cancelDownload', (id: string) => controller.cancelDownload(id)),
		vscode.commands.registerCommand('_vsgo.localModels.remove', (id: string) => controller.removeModel(id)),
		vscode.commands.registerCommand('_vsgo.localModels.installRuntime', () => controller.installRuntime()),
		vscode.commands.registerCommand('_vsgo.localModels.startServer', () => controller.startServer()),
		vscode.commands.registerCommand('_vsgo.localModels.stopServer', () => controller.stopServer()),
		vscode.commands.registerCommand('_vsgo.localModels.openFolder', () => controller.openModelsFolder()),
	];
	return vscode.Disposable.from(...subs);
}
