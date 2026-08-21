/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ByokStorage, ProviderId } from '../byokStorage.js';
import { EmbeddingRole, IEmbeddingProvider, IEmbeddingProviderStatus } from './embeddingProvider.js';
import { log } from '../logger.js';

/** Texts per request. Well inside every vendor's cap, and worth a round trip. */
const BATCH_SIZE = 96;
/** Requests in flight. The wall-clock win here is almost entirely concurrency. */
const CONCURRENCY = 4;
/** Cached vector widths, so a probe is not spent on every window that opens. */
const DIMS_KEY = 'semanticIndex.apiDims';

/** Vendors that answer the OpenAI-shaped `/v1/embeddings`. */
export interface IApiVendor {
	readonly id: ProviderId;
	readonly label: string;
	readonly baseUrl: string;
	/** Sensible embedding model, offered as the default in the picker. */
	readonly defaultModel: string;
	/** Models worth suggesting; the user may type any id instead. */
	readonly suggestedModels: readonly string[];
	/** False for a local server that takes no key. */
	readonly needsKey: boolean;
}

export const API_VENDORS: readonly IApiVendor[] = [
	{
		id: 'openai',
		label: 'OpenAI',
		baseUrl: 'https://api.openai.com/v1',
		defaultModel: 'text-embedding-3-small',
		suggestedModels: ['text-embedding-3-small', 'text-embedding-3-large'],
		needsKey: true,
	},
	{
		id: 'mistral',
		label: 'Mistral',
		baseUrl: 'https://api.mistral.ai/v1',
		defaultModel: 'mistral-embed',
		suggestedModels: ['mistral-embed'],
		needsKey: true,
	},
	{
		id: 'ollama',
		label: 'Ollama (na sua máquina ou na sua rede)',
		baseUrl: 'http://localhost:11434/v1',
		defaultModel: 'nomic-embed-text',
		suggestedModels: ['nomic-embed-text', 'mxbai-embed-large', 'bge-m3'],
		needsKey: false,
	},
];

export function findVendor(id: string): IApiVendor | undefined {
	return API_VENDORS.find(v => v.id === id);
}

interface IEmbeddingsResponse {
	data?: { embedding: number[]; index: number }[];
	error?: { message?: string };
}

/**
 * Embeddings from a hosted (or self-hosted) OpenAI-compatible endpoint.
 *
 * This is the fast path: the vendors parallelise far better than one local
 * process, so a workspace that takes hours on CPU finishes in minutes. The
 * trade-off is not performance but confidentiality — the chunks are sent to
 * whoever owns the endpoint — which is why choosing it is an explicit act.
 */
export class ApiEmbeddingProvider implements IEmbeddingProvider {

	readonly kind = 'api' as const;

	private cachedDims: number | undefined;

	constructor(
		private readonly vendor: IApiVendor,
		private readonly model: string,
		private readonly baseUrl: string,
		private readonly storage: ByokStorage,
		private readonly memento: vscode.Memento,
	) { }

	get indexKey(): string {
		return `${this.vendor.id}:${this.model}`;
	}

	async status(): Promise<IEmbeddingProviderStatus> {
		const label = `${this.vendor.label} · ${this.model}`;
		if (this.vendor.needsKey && !await this.storage.get(this.vendor.id)) {
			return { ready: false, label, problem: `Nenhuma chave de API configurada para ${this.vendor.label}.` };
		}
		return { ready: true, label };
	}

	/**
	 * Vector width, discovered by embedding one short probe.
	 *
	 * Hardcoding widths per model would rot every time a vendor ships one, and
	 * an Ollama user can serve anything at all — asking the endpoint is the only
	 * answer that stays true. The result is cached per model.
	 */
	async dims(token: vscode.CancellationToken): Promise<number | undefined> {
		if (this.cachedDims) {
			return this.cachedDims;
		}
		const cache = this.memento.get<Record<string, number>>(DIMS_KEY, {});
		const remembered = cache[this.indexKey];
		if (remembered) {
			this.cachedDims = remembered;
			return remembered;
		}
		const probe = await this.post(['dimension probe'], token);
		const width = probe?.[0]?.length;
		if (!width) {
			return undefined;
		}
		this.cachedDims = width;
		await this.memento.update(DIMS_KEY, { ...cache, [this.indexKey]: width });
		log(`[semanticIndex] ${this.indexKey} produces ${width}-dimensional vectors`);
		return width;
	}

	/**
	 * Embeds in parallel batches.
	 *
	 * `role` is ignored: the hosted models in the picker are trained
	 * symmetrically, unlike the local E5 and Nomic weights that need a prefix
	 * telling them whether they are reading a question or a passage.
	 */
	async embed(texts: readonly string[], _role: EmbeddingRole, token: vscode.CancellationToken): Promise<(Float32Array | undefined)[] | undefined> {
		if (texts.length === 0) {
			return [];
		}
		if (!(await this.status()).ready) {
			return undefined;
		}
		const batches: string[][] = [];
		for (let i = 0; i < texts.length; i += BATCH_SIZE) {
			batches.push(texts.slice(i, i + BATCH_SIZE));
		}
		const results = new Array<(Float32Array | undefined)[] | undefined>(batches.length);
		let next = 0;
		let aborted = false;
		const worker = async () => {
			while (!aborted) {
				const mine = next++;
				if (mine >= batches.length) {
					return;
				}
				if (token.isCancellationRequested) {
					aborted = true;
					return;
				}
				const vectors = await this.post(batches[mine], token);
				if (!vectors) {
					aborted = true;
					return;
				}
				results[mine] = vectors;
			}
		};
		await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));
		if (aborted) {
			return undefined;
		}
		return results.flatMap(batch => batch ?? []);
	}

	private async post(batch: readonly string[], token: vscode.CancellationToken): Promise<Float32Array[] | undefined> {
		const headers: Record<string, string> = { 'content-type': 'application/json' };
		if (this.vendor.needsKey) {
			const key = await this.storage.get(this.vendor.id);
			if (!key) {
				return undefined;
			}
			headers.authorization = `Bearer ${key}`;
		}
		try {
			const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/embeddings`, {
				method: 'POST',
				headers,
				body: JSON.stringify({ input: batch, model: this.model }),
				signal: abortOf(token),
			});
			const payload = await res.json() as IEmbeddingsResponse;
			if (!res.ok) {
				log(`[semanticIndex] ${this.vendor.label} returned ${res.status}: ${payload.error?.message ?? ''}`);
				return undefined;
			}
			const rows = (payload.data ?? []).slice().sort((a, b) => a.index - b.index);
			if (rows.length !== batch.length) {
				log(`[semanticIndex] expected ${batch.length} embeddings, got ${rows.length}`);
				return undefined;
			}
			return rows.map(row => Float32Array.from(row.embedding));
		} catch (err) {
			log(`[semanticIndex] ${this.vendor.label} embeddings request failed:`, err instanceof Error ? err.message : String(err));
			return undefined;
		}
	}

	release(): void {
		// Nothing is held between calls.
	}

	dispose(): void {
		// Nothing to dispose.
	}
}

function abortOf(token: vscode.CancellationToken): AbortSignal {
	const controller = new AbortController();
	token.onCancellationRequested(() => controller.abort());
	return controller.signal;
}
