/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import { ICatalogModel, resolveCatalog } from '../localModels/catalog.js';
import { IInstalledModel, ModelStore } from '../localModels/modelStore.js';
import { freePort, ServerManager, signalTree, waitForHealth, withLibraryPath } from '../localModels/serverManager.js';
import { log } from '../logger.js';

/** Texts embedded per HTTP round trip. Kept under the server's batch size. */
const BATCH_SIZE = 16;
/** The process is torn down after this long without a request. */
const IDLE_SHUTDOWN_MS = 5 * 60 * 1000;

/**
 * Default embedding weights.
 *
 * Multilingual, so a codebase whose comments and documentation are written in
 * Portuguese stays reachable — an English-trained encoder leaves that content
 * in a part of the space neither an English nor a Portuguese query reaches.
 * The cost is measured, not estimated: 1.4 chunks/s against 9 for
 * `nomic-embed-text-v1.5` on the same CPU — six times slower, and 610MB rather
 * than 139. `nomic` stays the better pick for an all-English codebase, which is
 * why the model is a setting rather than a constant.
 *
 * The multilingual E5 conversions would have been smaller and faster, and both
 * had to be dropped — one is missing the BERT token-type metadata the runtime
 * requires, the other aborts during warm-up.
 */
export const DEFAULT_EMBEDDING_MODEL = 'qwen3-embedding-0.6b';

/** Where the running server's identity is parked so a later session can reap it. */
const RUNNING_SERVER_KEY = 'semanticIndex.runningServer';

interface IRunningServer {
	readonly pid: number;
	readonly port: number;
}

/** Whether the text being embedded is a search query or an indexed passage. */
export type EmbeddingRole = 'query' | 'document';

interface IEmbeddingsResponse {
	data?: { embedding: number[] | number[][]; index: number }[];
}

/**
 * A `llama-server` process dedicated to embeddings.
 *
 * The chat server serves exactly one model and has to restart to swap it, so
 * the index cannot borrow it — this owns a second, much smaller process
 * instead. It shares the runtime binary the Local Models manager already
 * installs, so enabling the index adds no new dependency, and it shuts itself
 * down when idle rather than holding weights for the whole session.
 */
export class EmbeddingServer {

	private process: ChildProcess | undefined;
	private baseUrl: string | undefined;
	private starting: Promise<boolean> | undefined;
	private active: IInstalledModel | undefined;
	private idleTimer: NodeJS.Timeout | undefined;
	private disposed = false;
	/**
	 * Latches when the server refuses to come up.
	 *
	 * Weights that llama.cpp cannot load fail in well under a second, and the
	 * indexer asks for a server once per file — without this, one bad GGUF turns
	 * into thousands of spawn attempts. Cleared by {@link resetStartFailure}
	 * when something that could change the outcome happens.
	 */
	private startFailed = false;

	constructor(
		private readonly store: ModelStore,
		private readonly serverManager: ServerManager,
		private readonly memento: vscode.Memento,
	) { }

	/** Id of the embedding model the index should be built with. */
	static configuredModelId(): string {
		const configured = vscode.workspace
			.getConfiguration('agent-chat')
			.get<string>('semanticIndex.model', DEFAULT_EMBEDDING_MODEL);
		return configured.trim() || DEFAULT_EMBEDDING_MODEL;
	}

	/** Catalog entry for the configured model, when there is one. */
	static configuredCatalogEntry(): ICatalogModel | undefined {
		const id = EmbeddingServer.configuredModelId();
		return resolveCatalog().find(m => m.id === id);
	}

	/** The installed weights the index will use, or `undefined` when not downloaded yet. */
	async resolveModel(): Promise<IInstalledModel | undefined> {
		const id = EmbeddingServer.configuredModelId();
		const installed = await this.store.listEmbeddingModels();
		return installed.find(m => m.id === id);
	}

	/** True once the runtime binary and the configured weights are both present. */
	async isProvisioned(): Promise<boolean> {
		return !!(await this.serverManager.findBinary()) && !!(await this.resolveModel());
	}

	/** Vector width of the configured model, from the catalog or the sidecar. */
	async dims(): Promise<number | undefined> {
		return EmbeddingServer.configuredCatalogEntry()?.dims ?? (await this.resolveModel())?.dims;
	}

	/** True when the server failed to start and no retry will be attempted. */
	get hasStartFailure(): boolean {
		return this.startFailed;
	}

	/** Allows another start attempt after a download, a model change or a rebuild. */
	resetStartFailure(): void {
		this.startFailed = false;
	}

	async ensureStarted(token: vscode.CancellationToken): Promise<boolean> {
		if (this.disposed || this.startFailed) {
			return false;
		}
		if (this.baseUrl) {
			return true;
		}
		if (!this.starting) {
			this.starting = this.doStart(token).finally(() => { this.starting = undefined; });
		}
		return this.starting;
	}

	private async doStart(token: vscode.CancellationToken): Promise<boolean> {
		const binary = await this.serverManager.findBinary();
		if (!binary) {
			log('[semanticIndex] llama-server is not installed');
			return false;
		}
		const model = await this.resolveModel();
		if (!model) {
			log(`[semanticIndex] embedding model ${EmbeddingServer.configuredModelId()} is not downloaded`);
			return false;
		}
		// From here on a failure is the weights or the runtime, not a missing
		// install, and retrying with the same inputs would fail the same way.
		this.startFailed = true;

		await this.reapPreviousServer();

		const port = await freePort();
		const baseUrl = `http://127.0.0.1:${port}`;
		const args = [
			'-m', model.filePath,
			'--embedding',
			...this.poolingArgs(),
			...this.contextArgs(model.contextLength),
			'-ngl', String(model.gpuLayers),
			'--host', '127.0.0.1',
			'--port', String(port),
		];

		log(`[semanticIndex] starting ${binary} ${args.join(' ')}`);
		const binDir = path.dirname(binary);
		const child = spawn(binary, args, {
			cwd: binDir,
			env: withLibraryPath(process.env, binDir),
			stdio: ['ignore', 'pipe', 'pipe'],
			// Its own process group, so `stop` can signal the whole tree. See the
			// equivalent note in ServerManager.
			detached: true,
		});
		this.process = child;
		child.stdout?.on('data', (chunk: Buffer) => log(`[llama-embed] ${chunk.toString().trimEnd()}`));
		child.stderr?.on('data', (chunk: Buffer) => log(`[llama-embed] ${chunk.toString().trimEnd()}`));
		child.on('exit', code => {
			log(`[semanticIndex] embedding server exited with code ${code}`);
			if (this.process === child) {
				this.process = undefined;
				this.baseUrl = undefined;
				this.active = undefined;
			}
		});

		if (!await waitForHealth(baseUrl, child, token)) {
			this.stop();
			log('[semanticIndex] embedding server did not become ready');
			return false;
		}
		this.baseUrl = baseUrl;
		this.active = model;
		this.startFailed = false;
		if (child.pid !== undefined) {
			await this.memento.update(RUNNING_SERVER_KEY, { pid: child.pid, port } satisfies IRunningServer);
		}
		this.armIdleTimer();
		return true;
	}

	/**
	 * Kills an embedding server left behind by a previous window.
	 *
	 * The process is spawned detached, so a host that goes away without running
	 * disposal leaves it holding its weights forever. Liveness alone is not
	 * enough to justify killing a recorded pid — the OS may have recycled it —
	 * so the port has to still answer as a llama-server before we signal it.
	 */
	private async reapPreviousServer(): Promise<void> {
		const previous = this.memento.get<IRunningServer>(RUNNING_SERVER_KEY);
		if (!previous) {
			return;
		}
		await this.memento.update(RUNNING_SERVER_KEY, undefined);
		try {
			const res = await fetch(`http://127.0.0.1:${previous.port}/health`, { signal: AbortSignal.timeout(1500) });
			if (!res.ok) {
				return;
			}
		} catch {
			return; // nothing is listening there; whatever holds that pid is not ours
		}
		for (const target of [-previous.pid, previous.pid]) {
			try {
				process.kill(target, 'SIGTERM');
				log(`[semanticIndex] reaped orphaned embedding server ${previous.pid}`);
				return;
			} catch {
				// try the bare pid, then give up
			}
		}
	}

	/**
	 * How the per-token states collapse into one vector.
	 *
	 * llama.cpp would fall back to whatever the GGUF declares; naming it keeps a
	 * mis-tagged conversion from silently returning vectors that mean nothing.
	 */
	private poolingArgs(): string[] {
		return ['--pooling', EmbeddingServer.configuredCatalogEntry()?.pooling ?? 'mean'];
	}

	/**
	 * Context and batching, which differ by architecture.
	 *
	 * An encoder keeps no KV cache, so one context wide enough for the longest
	 * input serves a whole batch. A causal embedder needs its own cache per
	 * sequence, and asking it to embed a batch against a single-sequence context
	 * fails outright with "Context size has been exceeded" — so it gets a slot
	 * per batch entry and a context sized for all of them.
	 */
	private contextArgs(perSequence: number): string[] {
		if (!EmbeddingServer.configuredCatalogEntry()?.causal) {
			// Physical batch as wide as the context, so the limit an over-long
			// input hits is the model's own rather than a smaller default.
			return ['-c', String(perSequence), '-b', String(perSequence), '-ub', String(perSequence)];
		}
		const total = perSequence * BATCH_SIZE;
		return ['-c', String(total), '-np', String(BATCH_SIZE), '-b', String(total), '-ub', String(perSequence)];
	}

	/**
	 * Embeds `texts`, starting the server if needed.
	 *
	 * `role` decides the prefix: the E5 and Nomic families are trained
	 * asymmetrically and lose a lot of accuracy when a query is embedded as
	 * though it were a passage.
	 */
	async embed(texts: readonly string[], role: EmbeddingRole, token: vscode.CancellationToken): Promise<(Float32Array | undefined)[] | undefined> {
		if (texts.length === 0) {
			return [];
		}
		if (!await this.ensureStarted(token)) {
			return undefined;
		}
		const entry = EmbeddingServer.configuredCatalogEntry();
		const prefix = (role === 'query' ? entry?.queryPrefix : entry?.documentPrefix) ?? '';
		const out: (Float32Array | undefined)[] = [];
		for (let i = 0; i < texts.length; i += BATCH_SIZE) {
			if (token.isCancellationRequested) {
				return undefined;
			}
			const batch = texts.slice(i, i + BATCH_SIZE).map(text => prefix + text);
			const vectors = await this.post(batch, token);
			out.push(...(vectors ?? await this.embedIndividually(batch, token)));
		}
		this.armIdleTimer();
		return out;
	}

	/**
	 * Fallback for a batch the server refused.
	 *
	 * Nearly always a single chunk that tokenized denser than the chunker's
	 * character budget assumed, so the rest of the batch is fine and only the
	 * offender needs shortening. Anything that still fails comes back as a hole
	 * rather than sinking the whole file.
	 */
	private async embedIndividually(batch: readonly string[], token: vscode.CancellationToken): Promise<(Float32Array | undefined)[]> {
		const out: (Float32Array | undefined)[] = [];
		for (const text of batch) {
			if (token.isCancellationRequested) {
				out.push(undefined);
				continue;
			}
			const single = await this.post([text], token)
				?? await this.post([shorten(text)], token);
			if (!single) {
				log('[semanticIndex] dropped a chunk the server would not embed');
			}
			out.push(single?.[0]);
		}
		return out;
	}

	private async post(batch: readonly string[], token: vscode.CancellationToken): Promise<Float32Array[] | undefined> {
		const baseUrl = this.baseUrl;
		if (!baseUrl) {
			return undefined;
		}
		try {
			const res = await fetch(`${baseUrl}/v1/embeddings`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ input: batch, model: this.active?.id ?? 'embedding' }),
				signal: abortOf(token),
			});
			if (!res.ok) {
				log(`[semanticIndex] embeddings request failed with ${res.status}`);
				return undefined;
			}
			const payload = await res.json() as IEmbeddingsResponse;
			const rows = (payload.data ?? []).slice().sort((a, b) => a.index - b.index);
			if (rows.length !== batch.length) {
				log(`[semanticIndex] expected ${batch.length} embeddings, got ${rows.length}`);
				return undefined;
			}
			return rows.map(row => {
				// With `--pooling none` llama.cpp nests one vector per token; guard
				// against a server started with different settings than we asked for.
				const values = Array.isArray(row.embedding[0]) ? row.embedding[0] as number[] : row.embedding as number[];
				return Float32Array.from(values);
			});
		} catch (err) {
			log('[semanticIndex] embeddings request threw:', err instanceof Error ? err.message : String(err));
			return undefined;
		}
	}

	private armIdleTimer(): void {
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
		}
		this.idleTimer = setTimeout(() => this.stop(), IDLE_SHUTDOWN_MS);
	}

	stop(): void {
		void this.memento.update(RUNNING_SERVER_KEY, undefined);
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
			this.idleTimer = undefined;
		}
		const child = this.process;
		this.process = undefined;
		this.baseUrl = undefined;
		this.active = undefined;
		if (!child) {
			return;
		}
		signalTree(child, 'SIGTERM');
		const timer = setTimeout(() => {
			if (child.exitCode === null) {
				signalTree(child, 'SIGKILL');
			}
		}, 3000);
		child.once('exit', () => clearTimeout(timer));
	}

	dispose(): void {
		this.disposed = true;
		this.stop();
	}
}

/** Fraction of an input kept when a batch is retried after being rejected. */
const RETRY_KEEP_RATIO = 0.6;

function shorten(text: string): string {
	return text.slice(0, Math.floor(text.length * RETRY_KEEP_RATIO));
}

function abortOf(token: vscode.CancellationToken): AbortSignal {
	const controller = new AbortController();
	token.onCancellationRequested(() => controller.abort());
	return controller.signal;
}
