/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { log } from '../logger.js';

/** Bumped whenever the on-disk layout changes, which discards older indexes. */
const FORMAT_VERSION = 1;
const VECTORS_FILE = 'index.bin';
const METADATA_FILE = 'index.json';
/** Compacting costs a full copy, so only do it once tombstones are worth it. */
const COMPACT_RATIO = 0.2;

/** Where a chunk came from. The body itself is read back from the file on demand. */
export interface IChunkMeta {
	readonly file: string;
	readonly startLine: number;
	readonly endLine: number;
	readonly breadcrumb: string;
	readonly hash: string;
}

export interface ISearchHit extends IChunkMeta {
	/** Cosine similarity, in [-1, 1]. */
	readonly score: number;
}

interface IPersistedIndex {
	readonly formatVersion: number;
	readonly modelId: string;
	readonly dims: number;
	/** Workspace-relative path → digest of the file's contents when indexed. */
	readonly fileHashes: Record<string, string>;
	readonly chunks: IChunkMeta[];
}

/**
 * Flat in-memory vector index with brute-force cosine search.
 *
 * Vectors are L2-normalized on insertion, so similarity is a plain dot product.
 * At the ~100k chunks a large repository produces, a full scan is a few tens of
 * milliseconds — an ANN structure would only start paying for itself an order
 * of magnitude later, and would cost far more to keep correct under edits.
 */
export class VectorStore {

	private vectors: Float32Array;
	/** Parallel to slots; `undefined` marks a tombstone left by a removal. */
	private metas: (IChunkMeta | undefined)[] = [];
	private readonly slotsByFile = new Map<string, number[]>();
	private readonly fileHashes = new Map<string, string>();
	private tombstones = 0;

	constructor(
		readonly modelId: string,
		readonly dims: number,
		capacity = 1024,
	) {
		this.vectors = new Float32Array(capacity * dims);
	}

	get size(): number {
		return this.metas.length - this.tombstones;
	}

	get fileCount(): number {
		return this.fileHashes.size;
	}

	/** Digest recorded for `file` the last time it was indexed. */
	hashOf(file: string): string | undefined {
		return this.fileHashes.get(file);
	}

	indexedFiles(): Iterable<string> {
		return this.fileHashes.keys();
	}

	/** Replaces every chunk recorded for one file. */
	setFile(file: string, contentHash: string, chunks: readonly IChunkMeta[], vectors: readonly Float32Array[]): void {
		this.removeFile(file);
		const slots: number[] = [];
		for (let i = 0; i < chunks.length; i++) {
			slots.push(this.append(chunks[i], vectors[i]));
		}
		this.slotsByFile.set(file, slots);
		this.fileHashes.set(file, contentHash);
	}

	removeFile(file: string): void {
		const slots = this.slotsByFile.get(file);
		this.slotsByFile.delete(file);
		this.fileHashes.delete(file);
		if (!slots) {
			return;
		}
		for (const slot of slots) {
			if (this.metas[slot]) {
				this.metas[slot] = undefined;
				this.tombstones++;
			}
		}
		if (this.metas.length > 0 && this.tombstones / this.metas.length > COMPACT_RATIO) {
			this.compact();
		}
	}

	private append(meta: IChunkMeta, vector: Float32Array): number {
		const slot = this.metas.length;
		this.ensureCapacity(slot + 1);
		this.vectors.set(normalized(vector, this.dims), slot * this.dims);
		this.metas.push(meta);
		return slot;
	}

	private ensureCapacity(slots: number): void {
		const needed = slots * this.dims;
		if (needed <= this.vectors.length) {
			return;
		}
		let capacity = Math.max(this.vectors.length, this.dims);
		while (capacity < needed) {
			capacity *= 2;
		}
		const grown = new Float32Array(capacity);
		grown.set(this.vectors);
		this.vectors = grown;
	}

	/** Drops tombstoned slots and rebuilds the slot map. */
	private compact(): void {
		const live = new Float32Array(this.size * this.dims);
		const metas: (IChunkMeta | undefined)[] = [];
		const bySlot = new Map<string, number[]>();
		for (let slot = 0; slot < this.metas.length; slot++) {
			const meta = this.metas[slot];
			if (!meta) {
				continue;
			}
			const target = metas.length;
			live.set(this.vectors.subarray(slot * this.dims, (slot + 1) * this.dims), target * this.dims);
			metas.push(meta);
			const bucket = bySlot.get(meta.file);
			if (bucket) {
				bucket.push(target);
			} else {
				bySlot.set(meta.file, [target]);
			}
		}
		this.vectors = live;
		this.metas = metas;
		this.tombstones = 0;
		this.slotsByFile.clear();
		for (const [file, slots] of bySlot) {
			this.slotsByFile.set(file, slots);
		}
	}

	/** The `limit` closest chunks to `query`, best first. */
	search(query: Float32Array, limit: number, filter?: (meta: IChunkMeta) => boolean): ISearchHit[] {
		const probe = normalized(query, this.dims);
		const bestScores: number[] = [];
		const bestSlots: number[] = [];
		for (let slot = 0; slot < this.metas.length; slot++) {
			const meta = this.metas[slot];
			if (!meta || (filter && !filter(meta))) {
				continue;
			}
			const offset = slot * this.dims;
			let score = 0;
			for (let d = 0; d < this.dims; d++) {
				score += probe[d] * this.vectors[offset + d];
			}
			if (bestScores.length === limit && score <= bestScores[bestScores.length - 1]) {
				continue;
			}
			let at = bestScores.length;
			while (at > 0 && bestScores[at - 1] < score) {
				at--;
			}
			bestScores.splice(at, 0, score);
			bestSlots.splice(at, 0, slot);
			if (bestScores.length > limit) {
				bestScores.pop();
				bestSlots.pop();
			}
		}
		return bestSlots.map((slot, i) => ({ ...this.metas[slot]!, score: bestScores[i] }));
	}

	async save(dir: string): Promise<void> {
		this.compact();
		await fs.promises.mkdir(dir, { recursive: true });
		const payload: IPersistedIndex = {
			formatVersion: FORMAT_VERSION,
			modelId: this.modelId,
			dims: this.dims,
			fileHashes: Object.fromEntries(this.fileHashes),
			chunks: this.metas.filter((m): m is IChunkMeta => !!m),
		};
		// Write both halves to temporaries first: a crash between them would
		// otherwise leave metadata pointing at vectors that were never written.
		const vectorBytes = Buffer.from(this.vectors.buffer, 0, this.size * this.dims * Float32Array.BYTES_PER_ELEMENT);
		await fs.promises.writeFile(path.join(dir, `${VECTORS_FILE}.tmp`), vectorBytes);
		await fs.promises.writeFile(path.join(dir, `${METADATA_FILE}.tmp`), JSON.stringify(payload), 'utf8');
		await fs.promises.rename(path.join(dir, `${VECTORS_FILE}.tmp`), path.join(dir, VECTORS_FILE));
		await fs.promises.rename(path.join(dir, `${METADATA_FILE}.tmp`), path.join(dir, METADATA_FILE));
		log(`[semanticIndex] saved ${this.size} chunks from ${this.fileHashes.size} files`);
	}

	/**
	 * Reads a persisted index, or returns `undefined` when there is none and
	 * when the stored one was built by a different model or layout.
	 */
	static async load(dir: string, modelId: string, dims: number): Promise<VectorStore | undefined> {
		let payload: IPersistedIndex;
		let raw: Buffer;
		try {
			payload = JSON.parse(await fs.promises.readFile(path.join(dir, METADATA_FILE), 'utf8')) as IPersistedIndex;
			raw = await fs.promises.readFile(path.join(dir, VECTORS_FILE));
		} catch {
			return undefined;
		}
		if (payload.formatVersion !== FORMAT_VERSION || payload.modelId !== modelId || payload.dims !== dims) {
			log(`[semanticIndex] discarding index built by ${payload.modelId} (${payload.dims}d, v${payload.formatVersion})`);
			return undefined;
		}
		const expected = payload.chunks.length * dims * Float32Array.BYTES_PER_ELEMENT;
		if (raw.byteLength < expected) {
			log('[semanticIndex] discarding truncated index');
			return undefined;
		}
		const store = new VectorStore(modelId, dims, Math.max(payload.chunks.length, 1));
		store.vectors = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + expected));
		store.metas = payload.chunks.slice();
		for (let slot = 0; slot < store.metas.length; slot++) {
			const file = store.metas[slot]!.file;
			const bucket = store.slotsByFile.get(file);
			if (bucket) {
				bucket.push(slot);
			} else {
				store.slotsByFile.set(file, [slot]);
			}
		}
		for (const [file, hash] of Object.entries(payload.fileHashes)) {
			store.fileHashes.set(file, hash);
		}
		log(`[semanticIndex] loaded ${store.size} chunks from ${store.fileCount} files`);
		return store;
	}

	static async clear(dir: string): Promise<void> {
		await fs.promises.rm(path.join(dir, VECTORS_FILE), { force: true });
		await fs.promises.rm(path.join(dir, METADATA_FILE), { force: true });
	}

	/** Bytes the persisted index occupies, or 0 when nothing is stored. */
	static async sizeOnDisk(dir: string): Promise<number> {
		let total = 0;
		for (const name of [VECTORS_FILE, METADATA_FILE]) {
			try {
				total += (await fs.promises.stat(path.join(dir, name))).size;
			} catch {
				// not written yet
			}
		}
		return total;
	}
}

/** Unit-length copy of `vector`. A zero vector is returned unchanged. */
function normalized(vector: Float32Array, dims: number): Float32Array {
	const out = vector.length === dims ? new Float32Array(vector) : new Float32Array(dims);
	if (vector.length !== dims) {
		out.set(vector.subarray(0, Math.min(vector.length, dims)));
	}
	let sum = 0;
	for (let d = 0; d < dims; d++) {
		sum += out[d] * out[d];
	}
	const norm = Math.sqrt(sum);
	if (norm > 0) {
		for (let d = 0; d < dims; d++) {
			out[d] /= norm;
		}
	}
	return out;
}
