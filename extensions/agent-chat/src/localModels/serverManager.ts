/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ChildProcess, exec, spawn } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { detectHardware, IHardwareProfile } from './hardware.js';
import { IInstalledModel, ModelStore } from './modelStore.js';
import { log } from '../logger.js';

const execAsync = promisify(exec);

// A list rather than `/releases/latest`: llama.cpp cuts a release every few
// hours and its ~25 binaries upload over the following minutes, so the newest
// release is regularly present with none of the assets we need yet.
const RELEASES_API = 'https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=10';
const BINARY_NAME = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';

export type ServerState = 'stopped' | 'installing' | 'starting' | 'ready' | 'error';

export interface IServerStatus {
	readonly state: ServerState;
	readonly baseUrl?: string;
	readonly message?: string;
}

interface IGitHubAsset { name: string; browser_download_url: string; size: number }
interface IGitHubRelease { tag_name: string; draft?: boolean; assets?: IGitHubAsset[] }

interface IPropsResponse { chat_template_caps?: { supports_tools?: boolean; supports_system_role?: boolean } }

/**
 * Batch size large enough that an agent prompt is submitted in one piece.
 *
 * llama.cpp defaults to a 512-token micro-batch, and an agent turn — system
 * prompt plus tool schemas — runs past 1600 tokens, so every request is split.
 * That split is the documented trigger for a family of upstream bugs where the
 * model then generates one token forever: `<unused49>` on Gemma 4
 * (ggml-org/llama.cpp#26088, #26239) and a repeated `<` on DeepSeek (#26471).
 * Once it happens the slot stays poisoned and even a two-word prompt comes back
 * as garbage.
 *
 * Measured on this hardware: no cost to pay for it. A full agent request took
 * 1.3s with these sizes, against 1.9s at the default.
 */
const BATCH_TOKENS = 4096;

/** Where the last model the user actually chatted with is remembered. */
const LAST_USED_MODEL_KEY = 'localModels.lastUsed';

/** What a model's own chat template is able to render, as the server reports it. */
export interface IChatTemplateCaps {
	/** False for templates such as Gemma's, which raise on a `tool` role. */
	readonly supportsTools: boolean;
	readonly supportsSystemRole: boolean;
}

/**
 * Owns the local `llama-server` process: locating or installing the binary,
 * launching it over one model's weights, and reporting readiness.
 *
 * Exactly one model is resident at a time. llama.cpp can front the whole model
 * directory from a single process and swap models on demand, but that keeps the
 * previous model mapped: the pages compete for the same page cache and every
 * token starts faulting them back off disk. Serving one model per process makes
 * a switch a restart, and the old weights are freed by the old process dying —
 * which is the whole point on a machine that has no memory to spare.
 */
export class ServerManager {

	private readonly _onDidChangeStatus = new vscode.EventEmitter<IServerStatus>();
	readonly onDidChangeStatus = this._onDidChangeStatus.event;

	private process: ChildProcess | undefined;
	private status: IServerStatus = { state: 'stopped' };
	private starting: Promise<IServerStatus> | undefined;
	private activeModelId: string | undefined;
	private preferredModelId: string | undefined;
	private readonly templateCaps = new Map<string, IChatTemplateCaps>();

	constructor(
		private readonly globalStorageUri: vscode.Uri,
		private readonly store: ModelStore,
		private readonly memento: vscode.Memento,
	) {
		this.preferredModelId = memento.get<string>(LAST_USED_MODEL_KEY);
	}

	get currentStatus(): IServerStatus {
		return this.status;
	}

	get baseUrl(): string | undefined {
		return this.status.state === 'ready' ? this.status.baseUrl : undefined;
	}

	private get runtimeDir(): string {
		return path.join(this.globalStorageUri.fsPath, 'runtime');
	}

	/**
	 * Locates a usable `llama-server`: the configured path first, then a copy we
	 * installed previously, then one already on the user's PATH.
	 */
	async findBinary(): Promise<string | undefined> {
		const configured = vscode.workspace.getConfiguration('agent-chat').get<string>('localModels.serverPath', '').trim();
		if (configured && await isExecutable(configured)) {
			return configured;
		}
		const managed = await findRecursively(this.runtimeDir, BINARY_NAME);
		if (managed) {
			return managed;
		}
		return await findOnPath(BINARY_NAME);
	}

	/**
	 * Downloads the official llama.cpp release build for this machine. Called
	 * only when {@link findBinary} comes up empty, so users who already have
	 * llama.cpp installed are never asked to download anything.
	 */
	async installBinary(report: (message: string, percent?: number) => void, token: vscode.CancellationToken): Promise<string> {
		this.setStatus({ state: 'installing' });
		const hardware = await detectHardware();
		report('Procurando o lançamento mais recente do llama.cpp…');

		const res = await fetch(RELEASES_API, {
			headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'vsgo' },
			signal: abortOf(token),
		});
		if (!res.ok) {
			throw new Error(`O GitHub retornou ${res.status} ao listar os lançamentos do llama.cpp.`);
		}
		const releases = await res.json() as IGitHubRelease[];
		const candidates = assetCandidates(hardware);
		const found = pickRelease(releases, candidates);
		if (!found) {
			const tried = releases.length > 0 ? ` Procurei nos últimos ${releases.length} lançamentos por: ${candidates.join(', ')}.` : '';
			throw new Error(`Não há binário pronto do llama.cpp para ${hardware.platform}/${hardware.arch}.${tried} Aponte "agent-chat.localModels.serverPath" para uma build compilada por você.`);
		}
		const { release, asset } = found;

		await fs.promises.mkdir(this.runtimeDir, { recursive: true });
		const archivePath = path.join(this.runtimeDir, asset.name);
		report(`Baixando ${asset.name} (${(asset.size / 1048576).toFixed(0)} MB)…`, 0);
		await downloadTo(asset.browser_download_url, archivePath, asset.size, (pct, mb) => {
			report(`Baixando ${asset.name} — ${mb} MB`, pct);
		}, token);

		report('Extraindo…');
		await extract(archivePath, this.runtimeDir);
		await fs.promises.rm(archivePath, { force: true });

		const binary = await findRecursively(this.runtimeDir, BINARY_NAME);
		if (!binary) {
			throw new Error(`Extraí ${asset.name}, mas não encontrei ${BINARY_NAME} lá dentro.`);
		}
		if (process.platform !== 'win32') {
			await fs.promises.chmod(binary, 0o755);
			// Binaries downloaded on macOS are quarantined; clear the flag so
			// Gatekeeper does not kill the process on launch.
			if (process.platform === 'darwin') {
				try {
					await execAsync(`xattr -dr com.apple.quarantine ${JSON.stringify(path.dirname(binary))}`, { timeout: 15000 });
				} catch {
					// non-fatal: the user may still be prompted by Gatekeeper
				}
			}
		}
		log(`[localModels] installed runtime ${release.tag_name} at ${binary}`);
		this.setStatus({ state: 'stopped' });
		return binary;
	}

	/** Starts the server if it is not already running. Safe to call repeatedly. */
	async ensureStarted(token: vscode.CancellationToken): Promise<IServerStatus> {
		if (this.status.state === 'ready') {
			return this.status;
		}
		if (!this.starting) {
			this.starting = this.doStart(token).finally(() => { this.starting = undefined; });
		}
		return this.starting;
	}

	private async doStart(token: vscode.CancellationToken): Promise<IServerStatus> {
		const binary = await this.findBinary();
		if (!binary) {
			return this.setStatus({ state: 'error', message: 'O llama-server ainda não está instalado.' });
		}
		const installed = await this.store.list();
		if (installed.length === 0) {
			return this.setStatus({ state: 'error', message: 'Nenhum modelo local baixado ainda.' });
		}

		this.setStatus({ state: 'starting' });
		const port = await freePort();
		const baseUrl = `http://127.0.0.1:${port}`;
		const pinned = installed.find(m => m.id === this.preferredModelId) ?? installed[0];
		const args = this.singleModelArgs(port, pinned);

		log(`[localModels] starting ${binary} ${args.join(' ')}`);
		const binDir = path.dirname(binary);
		const child = spawn(binary, args, {
			cwd: binDir,
			env: withLibraryPath(process.env, binDir),
			stdio: ['ignore', 'pipe', 'pipe'],
			// Its own process group, so `stop` can signal whatever llama-server
			// leaves behind as a unit rather than only the root — anything missed
			// stays resident holding gigabytes for the rest of the session. Without
			// `detached` that group would be the extension host's, which we must
			// never kill.
			detached: true,
		});
		this.process = child;
		this.activeModelId = pinned.id;

		child.stdout?.on('data', (chunk: Buffer) => log(`[llama-server] ${chunk.toString().trimEnd()}`));
		child.stderr?.on('data', (chunk: Buffer) => log(`[llama-server] ${chunk.toString().trimEnd()}`));
		child.on('exit', code => {
			log(`[localModels] llama-server exited with code ${code}`);
			this.process = undefined;
			if (this.status.state !== 'stopped') {
				this.setStatus({ state: 'error', message: `llama-server exited with code ${code}.` });
			}
		});

		const ready = await waitForHealth(baseUrl, child, token);
		if (!ready) {
			this.stop();
			return this.setStatus({ state: 'error', message: 'O llama-server não ficou pronto. Veja o canal de saída do Agent Chat.' });
		}
		return this.setStatus({ state: 'ready', baseUrl });
	}

	/**
	 * Command line for a process serving exactly `model`.
	 *
	 * A micro-batch wider than the whole context is never submitted, and
	 * llama.cpp still sizes its compute buffers for it, so the batch is capped at
	 * the context this model declared.
	 */
	private singleModelArgs(port: number, model: IInstalledModel): string[] {
		const batch = Math.min(BATCH_TOKENS, model.contextLength);
		return [
			'-m', model.filePath,
			// The name the server answers to. Without it llama.cpp advertises the
			// weights by path, while the workbench sends back the id derived from
			// the filename — the same one the picker listed.
			'-a', serverModelId(model),
			'-c', String(model.contextLength),
			'-ngl', String(model.gpuLayers),
			'-b', String(batch), '-ub', String(batch),
			'--host', '127.0.0.1',
			'--port', String(port),
			// Required for the model's own chat template, and therefore for
			// OpenAI-style tool calls to be parsed out of the response.
			'--jinja',
		];
	}

	/**
	 * Model this process is serving, or `undefined` while nothing is running.
	 * Switching models means restarting: see {@link restart}.
	 */
	get pinnedModelId(): string | undefined {
		return this.activeModelId;
	}

	/**
	 * Reads and caches what `modelId`'s chat template can render. Asked once per
	 * model per server lifetime, so callers can consult {@link cachedTemplateCaps}
	 * synchronously while building a request.
	 *
	 * The model is named in the query even though the process serves only one:
	 * the parameter is harmless where it is redundant, and it keeps the answer
	 * unambiguous about which weights it describes.
	 */
	async ensureTemplateCaps(modelId: string, token: vscode.CancellationToken): Promise<void> {
		const baseUrl = this.baseUrl;
		if (!baseUrl || this.templateCaps.has(modelId)) {
			return;
		}
		try {
			const res = await fetch(`${baseUrl}/props?model=${encodeURIComponent(modelId)}`, { signal: abortOf(token) });
			if (!res.ok) {
				return;
			}
			const caps = (await res.json() as IPropsResponse).chat_template_caps;
			if (!caps) {
				return;
			}
			this.templateCaps.set(modelId, {
				supportsTools: caps.supports_tools === true,
				supportsSystemRole: caps.supports_system_role !== false,
			});
			log(`[localModels] template caps for ${modelId}: tools=${caps.supports_tools} system=${caps.supports_system_role}`);
		} catch {
			// Leave it unknown: callers send the unmodified conversation, which is
			// what every template but the strict ones wants anyway.
		}
	}

	/** Capabilities already read for `modelId`, or `undefined` while unknown. */
	cachedTemplateCaps(modelId: string): IChatTemplateCaps | undefined {
		return this.templateCaps.get(modelId);
	}

	/**
	 * Model the next start serves, and the one {@link preload} warms on the next
	 * window. Remembered across sessions because a first request that has to load
	 * the weights costs far more than the request itself.
	 *
	 * Setting it does not move a running server: the caller decides whether the
	 * switch is worth a restart.
	 */
	setPreferredModel(id: string): void {
		this.preferredModelId = id;
		void this.memento.update(LAST_USED_MODEL_KEY, id);
	}

	/** Installed model with this catalog id, if it is present on disk. */
	async installedModel(id: string): Promise<IInstalledModel | undefined> {
		return (await this.store.list()).find(m => m.id === id);
	}

	/**
	 * Model to warm on startup: the one the user reached for last, or the only
	 * one they have. With several installed and no history there is nothing to
	 * go on, and loading the wrong few gigabytes is worse than loading none.
	 */
	async lastUsedModel(): Promise<IInstalledModel | undefined> {
		const installed = await this.store.list();
		if (installed.length === 0) {
			return undefined;
		}
		const remembered = installed.find(m => m.id === this.preferredModelId);
		return remembered ?? (installed.length === 1 ? installed[0] : undefined);
	}

	/**
	 * Loads a model's weights before the user asks anything of it.
	 *
	 * Starting the process is most of the work, since it maps the weights it was
	 * launched with. The one-token completion on top pays for the rest — the
	 * compute buffers and the first KV cache — which on CPU is still seconds the
	 * first message would otherwise spend with nothing on screen to explain it.
	 * The completion itself is discarded.
	 */
	async preload(model: IInstalledModel, token: vscode.CancellationToken): Promise<void> {
		// Or the process would come up on whichever model was preferred before.
		this.setPreferredModel(model.id);
		const status = await this.ensureStarted(token);
		if (status.state !== 'ready' || !status.baseUrl) {
			return;
		}
		const startedAt = Date.now();
		try {
			const res = await fetch(`${status.baseUrl}/v1/chat/completions`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					model: serverModelId(model),
					messages: [{ role: 'user', content: 'ok' }],
					max_tokens: 1,
				}),
				signal: abortOf(token),
			});
			if (!res.ok) {
				log(`[localModels] preload of ${model.name} returned ${res.status}`);
				return;
			}
			await res.arrayBuffer();
			log(`[localModels] preloaded ${model.name} in ${Math.round((Date.now() - startedAt) / 1000)}s`);
		} catch (err) {
			// Best effort: the first real request will load the weights itself.
			log(`[localModels] preload of ${model.name} failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	stop(): void {
		const child = this.process;
		this.process = undefined;
		this.activeModelId = undefined;
		// The next process may serve different weights under the same model id.
		this.templateCaps.clear();
		this.setStatus({ state: 'stopped' });
		if (!child) {
			return;
		}
		signalTree(child, 'SIGTERM');
		// Give it a moment to shut down cleanly before forcing the issue. The check
		// has to be on `exitCode`: `killed` only records that a signal was sent, so
		// it is already true here and would skip the escalation entirely.
		const timer = setTimeout(() => {
			if (child.exitCode === null) {
				signalTree(child, 'SIGKILL');
			}
		}, 3000);
		child.once('exit', () => clearTimeout(timer));
	}

	async restart(token: vscode.CancellationToken): Promise<IServerStatus> {
		this.stop();
		return this.ensureStarted(token);
	}

	private setStatus(status: IServerStatus): IServerStatus {
		this.status = status;
		this._onDidChangeStatus.fire(status);
		return status;
	}

	dispose(): void {
		this.stop();
		this._onDidChangeStatus.dispose();
	}
}

/**
 * Name the server is launched under and answers to, which is the model's
 * filename without the extension. Also what the workbench sends back as
 * `model`, so both sides have to derive it the same way.
 */
export function serverModelId(model: Pick<IInstalledModel, 'file'>): string {
	return model.file.replace(/\.gguf$/i, '');
}

/**
 * Asset name fragments for this machine, best first.
 *
 * GPU builds deliberately prefer Vulkan over CUDA/HIP: it covers NVIDIA, AMD
 * and Intel with a single archive and needs no vendor runtime installed
 * alongside it. CUDA is faster, but on Windows it also requires a separate
 * cudart download, and llama.cpp ships no CUDA build for Linux at all. The
 * plain CPU build is always the last resort so a machine with an unusable GPU
 * still gets something that runs.
 */
function assetCandidates(hardware: IHardwareProfile): string[] {
	const arch = hardware.arch === 'arm64' ? 'arm64' : 'x64';
	const hasGpu = !!hardware.gpu && hardware.gpu.backend !== 'cpu';

	if (hardware.platform === 'darwin') {
		return [`bin-macos-${arch}`];
	}
	if (hardware.platform === 'win32') {
		const candidates = hasGpu && arch === 'x64' ? ['bin-win-vulkan-x64'] : [];
		candidates.push(`bin-win-cpu-${arch}`);
		return candidates;
	}
	const candidates = hasGpu ? [`bin-ubuntu-vulkan-${arch}`] : [];
	// `bin-ubuntu-x64` must not match `bin-ubuntu-vulkan-x64` and friends, so it
	// is matched against the archive suffix rather than as a bare substring.
	candidates.push(`bin-ubuntu-${arch}`);
	return candidates;
}

/**
 * Newest release that actually carries a binary for this machine. Skips drafts
 * and releases whose upload is still in flight.
 */
function pickRelease(
	releases: readonly IGitHubRelease[],
	candidates: readonly string[],
): { release: IGitHubRelease; asset: IGitHubAsset } | undefined {
	for (const release of releases) {
		if (release.draft) {
			continue;
		}
		for (const fragment of candidates) {
			const asset = (release.assets ?? []).find(a => matchesFragment(a.name, fragment));
			if (asset) {
				return { release, asset };
			}
		}
	}
	return undefined;
}

/** Matches `llama-b1234-bin-ubuntu-x64.tar.gz` against `bin-ubuntu-x64` exactly. */
function matchesFragment(assetName: string, fragment: string): boolean {
	return assetName.includes(`-${fragment}.`);
}

/**
 * Signals the whole process group `child` leads instead of `child` alone.
 *
 * `spawn` starts it detached precisely so this group exists: any process
 * llama-server spawns of its own holds the same mapped weights, and it would
 * survive a signal aimed only at the root — resident, for the rest of the
 * session. Falls back to the root alone when the group is already gone, so a
 * second call after the tree exited is harmless.
 */
function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
	const pid = child.pid;
	if (pid === undefined) {
		return;
	}
	try {
		process.kill(-pid, signal);
	} catch {
		try {
			child.kill(signal);
		} catch {
			// already reaped
		}
	}
}

async function waitForHealth(baseUrl: string, child: ChildProcess, token: vscode.CancellationToken): Promise<boolean> {
	const deadline = Date.now() + 180_000;
	while (Date.now() < deadline) {
		if (token.isCancellationRequested || child.exitCode !== null) {
			return false;
		}
		try {
			const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
			if (res.ok) {
				return true;
			}
		} catch {
			// not listening yet
		}
		await delay(500);
	}
	return false;
}

/**
 * llama.cpp release archives ship shared libraries next to the executable, so
 * the loader needs to be pointed at that directory.
 */
function withLibraryPath(env: NodeJS.ProcessEnv, binDir: string): NodeJS.ProcessEnv {
	const key = process.platform === 'darwin' ? 'DYLD_LIBRARY_PATH'
		: process.platform === 'win32' ? 'PATH'
			: 'LD_LIBRARY_PATH';
	const existing = env[key];
	return { ...env, [key]: existing ? `${binDir}${path.delimiter}${existing}` : binDir };
}

async function downloadTo(
	url: string,
	target: string,
	expectedBytes: number,
	report: (percent: number, receivedMB: string) => void,
	token: vscode.CancellationToken,
): Promise<void> {
	const res = await fetch(url, { redirect: 'follow', signal: abortOf(token) });
	if (!res.ok || !res.body) {
		throw new Error(`Falha no download: HTTP ${res.status}`);
	}
	const total = Number(res.headers.get('content-length') ?? expectedBytes);
	const stream = fs.createWriteStream(target);
	// Failures are reported by rejecting this function; the listener keeps them
	// from also escaping as an unhandled 'error' event on the stream.
	stream.on('error', () => { });
	const reader = res.body.getReader();
	let received = 0;
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
				await new Promise<void>(resolve => stream.once('drain', () => resolve()));
			}
			report(total > 0 ? (received / total) * 100 : 0, (received / 1048576).toFixed(0));
		}
	} finally {
		if (!stream.destroyed) {
			await new Promise<void>(resolve => {
				stream.once('close', () => resolve());
				stream.end();
			});
		}
		try { reader.releaseLock(); } catch { /* already released */ }
	}
}

/**
 * Unpacks a llama.cpp release archive. `tar` handles both `.tar.gz` and, on
 * Windows 10+ and macOS, `.zip`; `unzip` covers Linux distributions where the
 * bundled tar is GNU tar and cannot read zip archives.
 */
async function extract(archive: string, destination: string): Promise<void> {
	const quotedArchive = JSON.stringify(archive);
	const quotedDestination = JSON.stringify(destination);
	const attempts = archive.endsWith('.zip')
		? [
			`tar -xf ${quotedArchive} -C ${quotedDestination}`,
			`unzip -o ${quotedArchive} -d ${quotedDestination}`,
			`powershell -NoProfile -Command "Expand-Archive -Force -Path ${archive} -DestinationPath ${destination}"`,
		]
		: [`tar -xzf ${quotedArchive} -C ${quotedDestination}`];

	let lastError: unknown;
	for (const command of attempts) {
		try {
			await execAsync(command, { timeout: 300_000, maxBuffer: 8 * 1024 * 1024 });
			return;
		} catch (err) {
			lastError = err;
		}
	}
	throw new Error(`Não foi possível extrair ${path.basename(archive)}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function findRecursively(root: string, fileName: string): Promise<string | undefined> {
	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(root, { withFileTypes: true });
	} catch {
		return undefined;
	}
	const directories: string[] = [];
	for (const entry of entries) {
		const full = path.join(root, entry.name);
		if (entry.isFile() && entry.name === fileName) {
			return full;
		}
		if (entry.isDirectory()) {
			directories.push(full);
		}
	}
	for (const dir of directories) {
		const found = await findRecursively(dir, fileName);
		if (found) {
			return found;
		}
	}
	return undefined;
}

async function findOnPath(binary: string): Promise<string | undefined> {
	const command = process.platform === 'win32' ? `where ${binary}` : `which ${binary}`;
	try {
		const { stdout } = await execAsync(command, { timeout: 5000 });
		const first = stdout.split('\n').map(l => l.trim()).find(l => l.length > 0);
		return first && await isExecutable(first) ? first : undefined;
	} catch {
		return undefined;
	}
}

async function isExecutable(target: string): Promise<boolean> {
	try {
		await fs.promises.access(target, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			const port = typeof address === 'object' && address ? address.port : 0;
			server.close(() => port ? resolve(port) : reject(new Error('Não foi possível alocar uma porta.')));
		});
	});
}

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function abortOf(token: vscode.CancellationToken): AbortSignal {
	const controller = new AbortController();
	token.onCancellationRequested(() => controller.abort());
	return controller.signal;
}

/** Exposed for the status UI. */
export function defaultRuntimeHint(): string {
	return os.platform() === 'darwin'
		? 'brew install llama.cpp'
		: 'https://github.com/ggml-org/llama.cpp/releases';
}
