/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { createHash } from 'crypto';
import * as fs from 'fs';
import { once } from 'events';
import * as path from 'path';
import { ICatalogModel } from './catalog.js';
import { log } from '../logger.js';

interface IHFSibling { rfilename: string }
interface IHFModelInfo { siblings?: IHFSibling[] }

/** Metadata written next to each downloaded weight file. */
interface IInstalledMetadata {
	readonly id: string;
	readonly name: string;
	readonly repo: string;
	readonly file: string;
	readonly sizeBytes: number;
	readonly sha256?: string;
	readonly contextLength: number;
	readonly gpuLayers: number;
	readonly installedAt: number;
}

export interface IInstalledModel extends IInstalledMetadata {
	/** Absolute path to the `.gguf` file. */
	readonly filePath: string;
}

export interface IDownloadProgress {
	readonly receivedBytes: number;
	readonly totalBytes: number;
}

/**
 * Owns the on-disk model directory: resolving files on Hugging Face,
 * downloading them with resume support, and listing what is installed.
 */
export class ModelStore {

	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChange = this._onDidChange.event;

	constructor(private readonly globalStorageUri: vscode.Uri) { }

	/** Directory handed to llama-server as `--models-dir`. */
	get modelsDir(): string {
		const configured = vscode.workspace.getConfiguration('agent-chat').get<string>('localModels.modelsDirectory', '');
		return configured.trim() ? configured.trim() : path.join(this.globalStorageUri.fsPath, 'models');
	}

	async ensureModelsDir(): Promise<string> {
		const dir = this.modelsDir;
		await fs.promises.mkdir(dir, { recursive: true });
		return dir;
	}

	async list(): Promise<IInstalledModel[]> {
		const dir = this.modelsDir;
		let entries: string[];
		try {
			entries = await fs.promises.readdir(dir);
		} catch {
			return [];
		}
		const out: IInstalledModel[] = [];
		for (const entry of entries) {
			if (!entry.endsWith('.json')) {
				continue;
			}
			try {
				const raw = await fs.promises.readFile(path.join(dir, entry), 'utf8');
				const meta = JSON.parse(raw) as IInstalledMetadata;
				const filePath = path.join(dir, meta.file);
				if (await exists(filePath)) {
					out.push({ ...meta, filePath });
				}
			} catch {
				// ignore unreadable sidecar
			}
		}
		return out.sort((a, b) => a.name.localeCompare(b.name));
	}

	async isInstalled(id: string): Promise<boolean> {
		return (await this.list()).some(m => m.id === id);
	}

	async remove(id: string): Promise<void> {
		const dir = this.modelsDir;
		const installed = (await this.list()).find(m => m.id === id);
		if (!installed) {
			return;
		}
		await fs.promises.rm(installed.filePath, { force: true });
		await fs.promises.rm(path.join(dir, `${id}.json`), { force: true });
		this._onDidChange.fire();
	}

	/**
	 * Finds the concrete `.gguf` filename for a catalog entry. The catalog only
	 * stores a quantization fragment so upstream renames do not break us.
	 */
	async resolveFileName(model: ICatalogModel, token: vscode.CancellationToken): Promise<string> {
		const res = await fetch(`https://huggingface.co/api/models/${model.repo}`, { signal: abortOf(token) });
		if (!res.ok) {
			throw hfError(res.status, model.repo, model.repo);
		}
		const info = await res.json() as IHFModelInfo;
		const ggufs = (info.siblings ?? [])
			.map(s => s.rfilename)
			.filter(name => name.toLowerCase().endsWith('.gguf'));
		if (ggufs.length === 0) {
			throw new Error(`Nenhum arquivo .gguf encontrado em ${model.repo}`);
		}
		const wanted = model.quant.toLowerCase();
		// Multi-part shards ("-00001-of-00003") need a different download flow
		// than a single file, so exclude them from automatic selection. Vision
		// projectors are excluded too: multimodal repositories name them after the
		// weights file they belong to ("mmproj-gemma-4-12b-it-qat-q4_0.gguf"), so
		// every quantization fragment that matches the weights matches the
		// projector as well and the pick would come down to listing order.
		const candidates = ggufs.filter(name =>
			!/-\d{5}-of-\d{5}\.gguf$/i.test(name) && !name.toLowerCase().includes('mmproj'));
		const match = candidates.find(name => name.toLowerCase().includes(wanted));
		if (!match) {
			throw new Error(`Nenhum arquivo correspondente a "${model.quant}" em ${model.repo}. Disponíveis: ${candidates.slice(0, 8).join(', ')}`);
		}
		return match;
	}

	/**
	 * Size and sha256 of a repository file, read from Hugging Face headers.
	 *
	 * Redirects are deliberately not followed: `x-linked-size` and
	 * `x-linked-etag` are set on the 302 from huggingface.co and are absent from
	 * the CDN response it points at.
	 */
	async probeFile(repo: string, file: string, token: vscode.CancellationToken): Promise<{ sizeBytes: number; sha256?: string }> {
		const res = await fetch(downloadUrl(repo, file), { method: 'HEAD', redirect: 'manual', signal: abortOf(token) });
		const redirected = res.status >= 300 && res.status < 400;
		if (!res.ok && !redirected) {
			throw hfError(res.status, repo, file);
		}
		const linkedSize = res.headers.get('x-linked-size');
		const sizeBytes = Number(linkedSize ?? res.headers.get('content-length') ?? 0);
		const etag = (res.headers.get('x-linked-etag') ?? '').replace(/"/g, '');
		return { sizeBytes, sha256: /^[0-9a-f]{64}$/i.test(etag) ? etag.toLowerCase() : undefined };
	}

	/**
	 * Downloads a model, resuming a previous partial transfer when one exists.
	 * Verifies the sha256 reported by Hugging Face before publishing the file.
	 */
	async download(
		model: ICatalogModel,
		gpuLayers: number,
		report: (progress: IDownloadProgress) => void,
		token: vscode.CancellationToken,
	): Promise<IInstalledModel> {
		const dir = await this.ensureModelsDir();
		const file = await this.resolveFileName(model, token);
		const { sizeBytes, sha256 } = await this.probeFile(model.repo, file, token);

		const finalPath = path.join(dir, file);
		const partPath = `${finalPath}.part`;
		const already = await sizeOf(partPath);
		const resume = already > 0 && already < sizeBytes;

		log(`[localModels] downloading ${model.id} (${file}, ${sizeBytes} bytes)${resume ? ` resuming at ${already}` : ''}`);

		const headers: Record<string, string> = {};
		if (resume) {
			headers.Range = `bytes=${already}-`;
		}
		const res = await fetch(downloadUrl(model.repo, file), { headers, redirect: 'follow', signal: abortOf(token) });
		if (!res.ok || !res.body) {
			throw hfError(res.status, model.repo, file);
		}
		// A server that ignores our Range header restarts the file from zero.
		const appending = resume && res.status === 206;
		const stream = fs.createWriteStream(partPath, { flags: appending ? 'a' : 'w' });
		// Write failures are surfaced by rejecting below; without this listener
		// they would also escape as an unhandled 'error' event on the stream.
		stream.on('error', () => { });
		let received = appending ? already : 0;

		const reader = res.body.getReader();
		try {
			while (true) {
				if (token.isCancellationRequested) {
					throw new vscode.CancellationError();
				}
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				received += value.byteLength;
				if (!stream.write(value)) {
					await once(stream, 'drain');
				}
				report({ receivedBytes: received, totalBytes: sizeBytes });
			}
			await closeStream(stream);
		} catch (err) {
			// Flush what arrived and keep the `.part` file so the next attempt
			// resumes from where this one stopped.
			await closeStream(stream);
			throw err;
		} finally {
			try { reader.releaseLock(); } catch { /* stream already closed */ }
		}

		if (sha256) {
			const actual = await hashFile(partPath, token);
			if (actual !== sha256) {
				await fs.promises.rm(partPath, { force: true });
				throw new Error(`Checksum divergente em ${file} — o download foi descartado.`);
			}
		}

		await fs.promises.rename(partPath, finalPath);
		const meta: IInstalledMetadata = {
			id: model.id,
			name: model.name,
			repo: model.repo,
			file,
			sizeBytes,
			sha256,
			contextLength: model.contextLength,
			gpuLayers,
			installedAt: Date.now(),
		};
		await fs.promises.writeFile(path.join(dir, `${model.id}.json`), JSON.stringify(meta, null, '\t'), 'utf8');
		this._onDidChange.fire();
		log(`[localModels] installed ${model.id} at ${finalPath}`);
		return { ...meta, filePath: finalPath };
	}

	dispose(): void {
		this._onDidChange.dispose();
	}
}

/**
 * Explains a failed Hugging Face response. Gated repositories answer 200 on the
 * metadata endpoint and only reject the file transfer, so a bare status code
 * shows up late in the download and reads as a network glitch.
 */
function hfError(status: number, repo: string, what: string): Error {
	if (status === 401 || status === 403) {
		return new Error(`O repositório ${repo} é restrito: o Hugging Face exige aceitar a licença do modelo e um token de acesso, que ainda não suportamos. Escolha um modelo de um repositório aberto.`);
	}
	if (status === 404) {
		return new Error(`Não encontrado no Hugging Face: ${what}`);
	}
	return new Error(`O Hugging Face retornou ${status} para ${what}`);
}

function downloadUrl(repo: string, file: string): string {
	return `https://huggingface.co/${repo}/resolve/main/${encodeURIComponent(file)}?download=true`;
}

async function exists(target: string): Promise<boolean> {
	try {
		await fs.promises.access(target);
		return true;
	} catch {
		return false;
	}
}

/** Ends a write stream and waits for the bytes to reach disk. */
async function closeStream(stream: fs.WriteStream): Promise<void> {
	if (stream.destroyed) {
		return;
	}
	await new Promise<void>(resolve => {
		stream.once('close', () => resolve());
		stream.end();
	});
}

async function sizeOf(target: string): Promise<number> {
	try {
		return (await fs.promises.stat(target)).size;
	} catch {
		return 0;
	}
}

async function hashFile(target: string, token: vscode.CancellationToken): Promise<string> {
	const hash = createHash('sha256');
	const stream = fs.createReadStream(target);
	for await (const chunk of stream) {
		if (token.isCancellationRequested) {
			stream.destroy();
			throw new vscode.CancellationError();
		}
		hash.update(chunk as Buffer);
	}
	return hash.digest('hex');
}

function abortOf(token: vscode.CancellationToken): AbortSignal {
	const controller = new AbortController();
	token.onCancellationRequested(() => controller.abort());
	return controller.signal;
}
