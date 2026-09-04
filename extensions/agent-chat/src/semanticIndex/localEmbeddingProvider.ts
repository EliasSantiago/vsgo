/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { EmbeddingServer } from './embeddingServer.js';
import { EmbeddingRole, IEmbeddingProvider, IEmbeddingProviderStatus } from './embeddingProvider.js';
import { ModelStore } from '../localModels/modelStore.js';
import { ServerManager } from '../localModels/serverManager.js';

/**
 * Embeddings from a `llama-server` on this machine.
 *
 * Slower than any hosted endpoint by a wide margin, and the only option that
 * keeps the source code on the workstation.
 */
export class LocalEmbeddingProvider implements IEmbeddingProvider {

	readonly kind = 'local' as const;

	private readonly server: EmbeddingServer;

	constructor(modelStore: ModelStore, serverManager: ServerManager, memento: vscode.Memento) {
		this.server = new EmbeddingServer(modelStore, serverManager, memento);
	}

	get indexKey(): string {
		return `local:${EmbeddingServer.configuredModelId()}`;
	}

	/** The weights this provider wants, whether or not they are downloaded. */
	get modelId(): string {
		return EmbeddingServer.configuredModelId();
	}

	async dims(): Promise<number | undefined> {
		return this.server.dims();
	}

	async status(): Promise<IEmbeddingProviderStatus> {
		const entry = EmbeddingServer.configuredCatalogEntry();
		const label = `Local · ${entry?.name ?? EmbeddingServer.configuredModelId()}`;
		if (this.server.hasStartFailure) {
			return { ready: false, label, problem: 'O servidor de embeddings não conseguiu iniciar com estes pesos.' };
		}
		if (!await this.server.isProvisioned()) {
			return { ready: false, label, problem: 'O modelo de embeddings ainda não foi baixado.' };
		}
		return { ready: true, label };
	}

	async embed(texts: readonly string[], role: EmbeddingRole, token: vscode.CancellationToken): Promise<(Float32Array | undefined)[] | undefined> {
		return this.server.embed(texts, role, token);
	}

	/** True once the runtime binary and the configured weights are both present. */
	isProvisioned(): Promise<boolean> {
		return this.server.isProvisioned();
	}

	resetStartFailure(): void {
		this.server.resetStartFailure();
	}

	/** Proves the server comes up, so a caller can fail fast before a long run. */
	ensureStarted(token: vscode.CancellationToken): Promise<boolean> {
		return this.server.ensureStarted(token);
	}

	release(): void {
		this.server.stop();
	}

	dispose(): void {
		this.server.dispose();
	}
}
