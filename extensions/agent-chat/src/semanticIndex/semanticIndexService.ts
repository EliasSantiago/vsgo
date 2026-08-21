/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import { chunkFile, ICodeChunk } from './chunker.js';
import { EmbeddingServer } from './embeddingServer.js';
import { IEmbeddingProvider } from './embeddingProvider.js';
import { LocalEmbeddingProvider } from './localEmbeddingProvider.js';
import { chooseEmbeddingProvider, createEmbeddingProvider, describeSelection, hasChosenProvider, IProviderDependencies, PROVIDER_SETTINGS } from './providerSelection.js';
import { IChunkMeta, ISearchHit, VectorStore } from './vectorStore.js';
import { evaluateFit } from '../localModels/catalog.js';
import { detectHardware } from '../localModels/hardware.js';
import { log, showLog as revealLog } from '../logger.js';

const DEFAULT_INCLUDE = '**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,py,go,rs,java,cs,rb,php,c,h,cc,cpp,hpp,swift,kt,scala,sh,sql,vue,svelte,md}';
/**
 * Everything the index refuses to look at.
 *
 * The hidden-directory arm matters as much as `node_modules`: a git worktree
 * parked under `.claude/` or `.vscode-test/` is a second full copy of the
 * repository, and indexing it buries the real sources under duplicates that
 * score just as well.
 */
const DEFAULT_EXCLUDE = '{**/node_modules/**,**/out/**,**/out-*/**,**/dist/**,**/build/**,**/vendor/**,**/target/**,**/coverage/**,**/__pycache__/**,**/.*/**}';
const DEFAULT_MAX_FILES = 5000;

/** Skip files larger than ~1MB: minified bundles and fixtures poison the index. */
const MAX_FILE_SIZE = 1_000_000;
/**
 * Above this average line length a file is generated, not written.
 *
 * Exclude globs only catch the build directories someone thought to name;
 * a bundle committed anywhere else still reads as source. Minified output has
 * no meaning to retrieve and each chunk of it displaces a real one.
 */
const MAX_AVERAGE_LINE_LENGTH = 200;
/** Persist every so many files so a crash mid-run does not throw the work away. */
const SAVE_EVERY_FILES = 200;
/** Candidates pulled from the vector search before reranking trims them. */
const CANDIDATE_MULTIPLIER = 5;
const MIN_CANDIDATES = 50;
/** At most this many chunks from any one file, so one big file cannot fill the answer. */
const MAX_HITS_PER_FILE = 2;
const WATCH_DEBOUNCE_MS = 2000;

const DISMISSED_SETUP_KEY = 'semanticIndex.setupDismissed';

export interface IIndexStats {
	readonly enabled: boolean;
	readonly provisioned: boolean;
	readonly ready: boolean;
	/** The index is usable but still being filled in. */
	readonly indexing: boolean;
	/** Human-readable description of where the vectors come from. */
	readonly provider: string;
	readonly dims: number | undefined;
	readonly chunks: number;
	readonly files: number;
	readonly bytesOnDisk: number;
}

/**
 * Builds and serves a semantic index of the workspace.
 *
 * Everything runs on the machine: chunking uses the bundled tree-sitter grammar
 * and the vectors come from a local `llama-server`. The index lives in the
 * extension's workspace storage, is diffed against file timestamps on startup,
 * and is patched per-file as edits land — a full rebuild only happens when the
 * embedding model changes.
 */
export class SemanticIndexService {

	private embeddings: IEmbeddingProvider;
	private store: VectorStore | undefined;
	private readyPromise: Promise<boolean> | undefined;
	private watcher: vscode.FileSystemWatcher | undefined;
	private readonly dirtyFiles = new Set<string>();
	private debounce: NodeJS.Timeout | undefined;
	/** Serializes indexing work so a save during a rebuild cannot interleave. */
	private queue: Promise<void> = Promise.resolve();
	private disposed = false;
	private reportedUnavailable = false;
	/** True while the first pass over the workspace is still running. */
	private indexing = false;
	/** What the settings said when the current provider was built. */
	private selection: string;
	private readonly configListener: vscode.Disposable;

	constructor(
		private readonly storageUri: vscode.Uri | undefined,
		private readonly globalState: vscode.Memento,
		private readonly deps: IProviderDependencies,
	) {
		this.embeddings = createEmbeddingProvider(deps);
		this.selection = describeSelection();
		// The picker is not the only way in: someone editing settings.json by hand
		// must get the same rebuild, or the index would keep serving vectors from
		// a provider that is no longer selected.
		this.configListener = vscode.workspace.onDidChangeConfiguration(event => {
			if (PROVIDER_SETTINGS.some(setting => event.affectsConfiguration(setting)) && describeSelection() !== this.selection) {
				void this.applyProviderChange();
			}
		});
	}

	private get indexDir(): string | undefined {
		return this.storageUri ? path.join(this.storageUri.fsPath, 'semanticIndex') : undefined;
	}

	static isEnabled(): boolean {
		return vscode.workspace.getConfiguration('agent-chat').get<boolean>('semanticIndex.enabled', true);
	}

	private static includeGlob(): string {
		return vscode.workspace.getConfiguration('agent-chat').get<string>('semanticIndex.include', DEFAULT_INCLUDE) || DEFAULT_INCLUDE;
	}

	private static excludeGlob(): string {
		return vscode.workspace.getConfiguration('agent-chat').get<string>('semanticIndex.exclude', DEFAULT_EXCLUDE) || DEFAULT_EXCLUDE;
	}

	private static maxFiles(): number {
		return vscode.workspace.getConfiguration('agent-chat').get<number>('semanticIndex.maxFiles', DEFAULT_MAX_FILES);
	}

	/**
	 * Brings the index up to date, downloading nothing.
	 *
	 * Returns false when the index cannot serve queries — disabled by setting,
	 * no workspace, or the runtime and weights are not installed yet.
	 */
	async ensureReady(token: vscode.CancellationToken): Promise<boolean> {
		if (this.disposed || !SemanticIndexService.isEnabled() || !this.indexDir) {
			return false;
		}
		if (!this.readyPromise) {
			this.readyPromise = this.load(token).catch(err => {
				log('[semanticIndex] initialization failed:', err instanceof Error ? err.message : String(err));
				return false;
			});
		}
		return this.readyPromise;
	}

	private async load(token: vscode.CancellationToken): Promise<boolean> {
		const status = await this.embeddings.status();
		if (!status.ready) {
			log(`[semanticIndex] ${status.label} is not usable: ${status.problem ?? 'unknown reason'}`);
			return false;
		}
		const dims = await this.embeddings.dims(token);
		const dir = this.indexDir;
		if (!dims || !dir) {
			log('[semanticIndex] could not determine the vector width');
			return false;
		}
		const key = this.embeddings.indexKey;
		this.store = await VectorStore.load(dir, key, dims) ?? new VectorStore(key, dims);
		this.installWatcher();
		// Deliberately not awaited. A first pass over a large workspace runs for
		// minutes, and holding every search until it finished would block the tool
		// exactly when someone is most likely to reach for it. Searching a partial
		// index returns worse answers than searching a complete one; searching one
		// that never answers is worse than both.
		this.indexing = true;
		void this.enqueue(() => this.sync(token))
			.catch(err => log('[semanticIndex] sync failed:', err instanceof Error ? err.message : String(err)))
			.finally(() => { this.indexing = false; });
		return true;
	}

	/** Label of whatever is currently producing vectors. */
	private get providerLabel(): string {
		return this.embeddings.kind === 'local' ? 'O servidor de embeddings local' : 'O provedor de embeddings';
	}

	/**
	 * Proves vectors can actually be produced before a long run starts.
	 *
	 * For the local provider that means the process comes up — weights the
	 * runtime cannot load fail in milliseconds, and finding out once beats
	 * finding out per file.
	 */
	private async canEmbed(token: vscode.CancellationToken): Promise<boolean> {
		if (this.embeddings instanceof LocalEmbeddingProvider) {
			return this.embeddings.ensureStarted(token);
		}
		return (await this.embeddings.status()).ready;
	}

	/**
	 * Walks the user through choosing where embeddings come from.
	 *
	 * Asked once, on the first workspace that would be indexed, because the
	 * answer decides whether a few hundred megabytes get downloaded or whether
	 * chunks of the code get sent to a third party. Neither is a reasonable
	 * default to assume — hence a question rather than a setting nobody finds.
	 */
	async promptForSetup(): Promise<void> {
		if (this.disposed || !SemanticIndexService.isEnabled() || !this.indexDir) {
			return;
		}
		if (this.globalState.get<boolean>(DISMISSED_SETUP_KEY, false)) {
			return;
		}
		if ((await this.embeddings.status()).ready) {
			return;
		}

		if (!hasChosenProvider()) {
			const choose = 'Escolher';
			const never = 'Não perguntar mais';
			const answer = await vscode.window.showInformationMessage(
				'A busca semântica indexa este projeto para que o agente encontre código por significado. Escolha se os embeddings são calculados na sua máquina ou por um provedor.',
				choose,
				'Agora não',
				never,
			);
			if (answer === never) {
				await this.globalState.update(DISMISSED_SETUP_KEY, true);
				return;
			}
			if (answer !== choose) {
				return;
			}
			if (!await chooseEmbeddingProvider(this.deps.storage)) {
				return;
			}
			await this.applyProviderChange();
			return;
		}

		// A provider is chosen but unusable. Local means the weights are missing,
		// which we can offer to fix; anything else needs the user's own action.
		if (!(this.embeddings instanceof LocalEmbeddingProvider)) {
			const status = await this.embeddings.status();
			const change = 'Trocar provedor';
			const answer = await vscode.window.showWarningMessage(
				`Busca semântica indisponível: ${status.problem ?? status.label}`,
				change,
			);
			if (answer === change) {
				await this.changeProvider();
			}
			return;
		}
		const entry = EmbeddingServer.configuredCatalogEntry();
		if (!entry) {
			return;
		}
		const setUp = 'Baixar';
		const change = 'Trocar provedor';
		const choice = await vscode.window.showInformationMessage(
			`A busca semântica local precisa baixar o modelo ${entry.name} (~${entry.sizeMB} MB). Tudo roda na sua máquina.`,
			setUp,
			change,
			'Agora não',
		);
		if (choice === change) {
			await this.changeProvider();
			return;
		}
		if (choice !== setUp) {
			return;
		}
		if (await this.provision()) {
			await this.applyProviderChange();
		}
	}

	/**
	 * Re-asks where embeddings come from, and rebuilds when the answer changes.
	 *
	 * Vectors from two providers are not comparable, so the old index is worth
	 * nothing the moment the provider changes.
	 */
	async changeProvider(): Promise<void> {
		if (!await chooseEmbeddingProvider(this.deps.storage)) {
			return;
		}
		await this.applyProviderChange();
	}

	/** Rebuilds the provider from settings and starts the index over. */
	private async applyProviderChange(): Promise<void> {
		const previous = this.embeddings;
		this.embeddings = createEmbeddingProvider(this.deps);
		this.selection = describeSelection();
		previous.dispose();
		log(`[semanticIndex] embeddings now come from ${this.embeddings.indexKey}`);
		this.reportedUnavailable = false;
		const source = new vscode.CancellationTokenSource();
		try {
			await this.rebuild(source.token);
		} finally {
			source.dispose();
		}
	}

	private async provision(): Promise<boolean> {
		const entry = EmbeddingServer.configuredCatalogEntry();
		if (!entry) {
			return false;
		}
		return vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: 'Preparando a busca semântica',
			cancellable: true,
		}, async (progress, token) => {
			try {
				if (!await this.deps.serverManager.findBinary()) {
					await this.deps.serverManager.installBinary((message: string) => progress.report({ message }), token);
				}
				const profile = await detectHardware();
				const fit = evaluateFit(entry, profile);
				progress.report({ message: `Baixando ${entry.name}…` });
				await this.deps.modelStore.download(entry, fit.gpuLayers, ({ receivedBytes, totalBytes }: { receivedBytes: number; totalBytes: number }) => {
					const mb = (receivedBytes / 1048576).toFixed(0);
					const totalMb = (totalBytes / 1048576).toFixed(0);
					progress.report({ message: `Baixando ${entry.name} — ${mb} / ${totalMb} MB` });
				}, token);
				return true;
			} catch (err) {
				if (err instanceof vscode.CancellationError) {
					return false;
				}
				const message = err instanceof Error ? err.message : String(err);
				log(`[semanticIndex] provisioning failed: ${message}`);
				vscode.window.showErrorMessage(`Não foi possível preparar a busca semântica: ${message}`);
				return false;
			}
		});
	}

	/** Walks the workspace and re-embeds whatever changed since the last run. */
	private async sync(token: vscode.CancellationToken): Promise<void> {
		const store = this.store;
		const dir = this.indexDir;
		if (!store || !dir) {
			return;
		}
		const uris = await vscode.workspace.findFiles(
			SemanticIndexService.includeGlob(),
			SemanticIndexService.excludeGlob(),
			SemanticIndexService.maxFiles(),
		);
		if (uris.length === 0) {
			return;
		}

		const seen = new Set<string>();
		const pending: { uri: vscode.Uri; file: string; hash: string }[] = [];
		for (const uri of uris) {
			const file = vscode.workspace.asRelativePath(uri, false);
			seen.add(file);
			const hash = await stamp(uri);
			if (!hash) {
				continue;
			}
			if (store.hashOf(file) !== hash) {
				pending.push({ uri, file, hash });
			}
		}
		for (const file of [...store.indexedFiles()]) {
			if (!seen.has(file)) {
				store.removeFile(file);
			}
		}
		if (pending.length === 0) {
			log(`[semanticIndex] up to date: ${store.size} chunks from ${store.fileCount} files`);
			return;
		}
		// Prove the server comes up before walking thousands of files. Weights
		// llama.cpp cannot load fail in milliseconds, and finding that out once
		// beats finding it out per file.
		if (!await this.canEmbed(token)) {
			this.reportUnavailable();
			return;
		}

		// A handful of changed files after an edit is not worth a progress bar;
		// a first run over thousands of them very much is.
		const showProgress = pending.length > 25;
		const run = async (report?: (done: number) => void) => {
			let done = 0;
			for (const item of pending) {
				if (token.isCancellationRequested) {
					break;
				}
				await this.indexOne(item.uri, item.file, item.hash, token);
				done++;
				report?.(done);
				if (done % SAVE_EVERY_FILES === 0) {
					await store.save(dir);
				}
			}
		};

		if (showProgress) {
			await vscode.window.withProgress({
				location: vscode.ProgressLocation.Window,
				title: 'Indexando o projeto para busca semântica',
			}, async progress => {
				await run(done => progress.report({ message: `${done}/${pending.length} arquivos` }));
			});
		} else {
			await run();
		}
		await store.save(dir);
	}

	/**
	 * Tells the user once that the index is dead, instead of only the log.
	 *
	 * A model the runtime cannot load leaves the tool silently answering
	 * "unavailable" forever, which looks like the feature simply not working.
	 */
	private reportUnavailable(): void {
		if (this.reportedUnavailable) {
			return;
		}
		this.reportedUnavailable = true;
		const showLog = 'Ver o log';
		void vscode.window.showErrorMessage(
			`${this.providerLabel} não conseguiu gerar embeddings. A busca semântica ficará indisponível nesta sessão.`,
			showLog,
		).then(choice => {
			if (choice === showLog) {
				revealLog();
			}
		});
	}

	private async indexOne(uri: vscode.Uri, file: string, hash: string, token: vscode.CancellationToken): Promise<void> {
		const store = this.store;
		if (!store) {
			return;
		}
		let source: string;
		try {
			const bytes = await vscode.workspace.fs.readFile(uri);
			if (bytes.byteLength > MAX_FILE_SIZE) {
				return;
			}
			source = Buffer.from(bytes).toString('utf8');
		} catch {
			return;
		}
		if (looksGenerated(source)) {
			store.setFile(file, hash, [], []);
			return;
		}
		const chunks = await chunkFile(file, source);
		if (chunks.length === 0) {
			// Record the stamp anyway, or an empty file is re-read on every sync.
			store.setFile(file, hash, [], []);
			return;
		}
		const vectors = await this.embeddings.embed(chunks.map(c => c.text), 'document', token);
		if (!vectors || vectors.length !== chunks.length) {
			// The server is gone or the run was cancelled. Leaving the stamp
			// unrecorded is what makes the next sync pick this file up again.
			return;
		}
		const metas: IChunkMeta[] = [];
		const embedded: Float32Array[] = [];
		for (let i = 0; i < chunks.length; i++) {
			const vector = vectors[i];
			if (vector) {
				metas.push(toMeta(chunks[i]));
				embedded.push(vector);
			}
		}
		store.setFile(file, hash, metas, embedded);
	}

	/** The `limit` chunks most relevant to `query`, best first. */
	async search(query: string, limit: number, pathFilter: string | undefined, token: vscode.CancellationToken): Promise<ISearchHit[] | undefined> {
		if (!await this.ensureReady(token)) {
			return undefined;
		}
		const store = this.store;
		if (!store || store.size === 0) {
			return [];
		}
		const probe = (await this.embeddings.embed([query], 'query', token))?.[0];
		if (!probe) {
			return undefined;
		}
		const needle = pathFilter?.trim().toLowerCase();
		const candidates = store.search(
			probe,
			Math.max(MIN_CANDIDATES, limit * CANDIDATE_MULTIPLIER),
			needle ? meta => meta.file.toLowerCase().includes(needle) : undefined,
		);
		return rerank(candidates, limit);
	}

	async stats(token: vscode.CancellationToken): Promise<IIndexStats> {
		const dir = this.indexDir;
		return {
			enabled: SemanticIndexService.isEnabled(),
			provisioned: (await this.embeddings.status()).ready,
			ready: !!this.store,
			indexing: this.indexing,
			provider: (await this.embeddings.status()).label,
			dims: await this.embeddings.dims(token),
			chunks: this.store?.size ?? 0,
			files: this.store?.fileCount ?? 0,
			bytesOnDisk: dir ? await VectorStore.sizeOnDisk(dir) : 0,
		};
	}

	/** Throws the index away and builds it again from scratch. */
	async rebuild(token: vscode.CancellationToken): Promise<void> {
		const dir = this.indexDir;
		if (!dir) {
			return;
		}
		await this.enqueue(async () => {
			await VectorStore.clear(dir);
			this.store = undefined;
			this.readyPromise = undefined;
			this.reportedUnavailable = false;
			if (this.embeddings instanceof LocalEmbeddingProvider) {
				this.embeddings.resetStartFailure();
			}
		});
		await this.ensureReady(token);
	}

	private installWatcher(): void {
		if (this.watcher) {
			return;
		}
		this.watcher = vscode.workspace.createFileSystemWatcher(SemanticIndexService.includeGlob());
		this.watcher.onDidCreate(uri => this.markDirty(uri));
		this.watcher.onDidChange(uri => this.markDirty(uri));
		this.watcher.onDidDelete(uri => {
			this.store?.removeFile(vscode.workspace.asRelativePath(uri, false));
			this.scheduleFlush();
		});
	}

	private markDirty(uri: vscode.Uri): void {
		this.dirtyFiles.add(uri.toString());
		this.scheduleFlush();
	}

	private scheduleFlush(): void {
		if (this.debounce) {
			clearTimeout(this.debounce);
		}
		this.debounce = setTimeout(() => {
			this.debounce = undefined;
			void this.enqueue(() => this.flushDirty());
		}, WATCH_DEBOUNCE_MS);
	}

	private async flushDirty(): Promise<void> {
		const store = this.store;
		const dir = this.indexDir;
		if (!store || !dir) {
			this.dirtyFiles.clear();
			return;
		}
		const pending = [...this.dirtyFiles];
		this.dirtyFiles.clear();
		const source = new vscode.CancellationTokenSource();
		try {
			for (const raw of pending) {
				const uri = vscode.Uri.parse(raw);
				const file = vscode.workspace.asRelativePath(uri, false);
				const hash = await stamp(uri);
				if (!hash || store.hashOf(file) === hash) {
					continue;
				}
				await this.indexOne(uri, file, hash, source.token);
				log(`[semanticIndex] reindexed ${file}`);
			}
			await store.save(dir);
		} finally {
			source.dispose();
		}
	}

	private enqueue(work: () => Promise<void>): Promise<void> {
		this.queue = this.queue.then(work, work);
		return this.queue;
	}

	dispose(): void {
		this.disposed = true;
		if (this.debounce) {
			clearTimeout(this.debounce);
			this.debounce = undefined;
		}
		this.configListener.dispose();
		this.watcher?.dispose();
		this.watcher = undefined;
		this.embeddings.dispose();
		this.store = undefined;
	}
}

/** True for minified or otherwise machine-written text. */
function looksGenerated(source: string): boolean {
	const newlines = source.split('\n').length;
	return source.length / newlines > MAX_AVERAGE_LINE_LENGTH;
}

function toMeta(chunk: ICodeChunk): IChunkMeta {
	return {
		file: chunk.file,
		startLine: chunk.startLine,
		endLine: chunk.endLine,
		breadcrumb: chunk.breadcrumb,
		hash: chunk.hash,
	};
}

/**
 * Cheap change detector.
 *
 * Hashing the contents of every file on every startup would cost far more IO
 * than it saves; size and mtime move together on any real edit.
 */
async function stamp(uri: vscode.Uri): Promise<string | undefined> {
	try {
		const stat = await vscode.workspace.fs.stat(uri);
		if (stat.size > MAX_FILE_SIZE) {
			return undefined;
		}
		return `${stat.mtime}:${stat.size}`;
	} catch {
		return undefined;
	}
}

const TEST_PATH = /(^|\/)(test|tests|__tests__|spec)\/|\.(test|spec)\.[a-z]+$/i;

/**
 * Reorders raw cosine hits into something worth showing.
 *
 * Pure similarity tends to surface the tests that describe a behaviour ahead of
 * the code that implements it, and to spend every slot on one large file.
 */
function rerank(hits: readonly ISearchHit[], limit: number): ISearchHit[] {
	const activeDir = vscode.window.activeTextEditor
		? path.posix.dirname(vscode.workspace.asRelativePath(vscode.window.activeTextEditor.document.uri, false))
		: undefined;

	const adjusted = hits.map(hit => {
		let score = hit.score;
		if (TEST_PATH.test(hit.file)) {
			score *= 0.85;
		}
		if (activeDir && activeDir !== '.' && path.posix.dirname(hit.file) === activeDir) {
			score += 0.03;
		}
		return { ...hit, score };
	}).sort((a, b) => b.score - a.score);

	const perFile = new Map<string, number>();
	const picked: ISearchHit[] = [];
	const overflow: ISearchHit[] = [];
	for (const hit of adjusted) {
		const used = perFile.get(hit.file) ?? 0;
		if (used >= MAX_HITS_PER_FILE) {
			overflow.push(hit);
			continue;
		}
		perFile.set(hit.file, used + 1);
		picked.push(hit);
		if (picked.length === limit) {
			return picked;
		}
	}
	// A small workspace may not have `limit` distinct files; fall back rather
	// than returning fewer results than asked for.
	return [...picked, ...overflow].slice(0, limit);
}
