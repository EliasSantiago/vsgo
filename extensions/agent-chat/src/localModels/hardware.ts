/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { exec } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import { promisify } from 'util';
import { log } from '../logger.js';

const execAsync = promisify(exec);

/** Inference backend a machine can use, ordered roughly by throughput. */
export type GpuBackend = 'cuda' | 'metal' | 'rocm' | 'vulkan' | 'cpu';

export interface IGpuInfo {
	readonly name: string;
	/** Dedicated video memory in MB. `0` when the amount could not be determined. */
	readonly vramMB: number;
	readonly backend: GpuBackend;
}

export interface IHardwareProfile {
	readonly platform: NodeJS.Platform;
	readonly arch: string;
	readonly cpuName: string;
	readonly cpuCores: number;
	readonly totalRamMB: number;
	readonly freeRamMB: number;
	/**
	 * RAM that can be handed out right now without swapping, which is what a
	 * model actually has to fit into — unlike {@link totalRamMB}, most of which
	 * is normally already spoken for by the desktop and the editor.
	 */
	readonly availableRamMB: number;
	readonly gpu: IGpuInfo | undefined;
	/** True on Apple Silicon, where CPU and GPU share one memory pool. */
	readonly unifiedMemory: boolean;
}

/** Only the GPU probe is cached: it spawns external processes, and its answer
 * does not change while the window is open. Memory is re-read on every call
 * because the whole point of {@link IHardwareProfile.availableRamMB} is to
 * reflect what is free at the moment the question is asked. */
let cachedGpu: { readonly gpu: IGpuInfo | undefined } | undefined;

/**
 * Inspects the machine so the model catalog can be filtered to what actually
 * runs here.
 */
export async function detectHardware(refresh = false): Promise<IHardwareProfile> {
	const cpus = os.cpus();
	const platform = os.platform();
	const arch = os.arch();
	const unifiedMemory = platform === 'darwin' && arch === 'arm64';
	const totalRamMB = Math.round(os.totalmem() / (1024 * 1024));

	const firstProbe = !cachedGpu || refresh;
	const probed = firstProbe
		? cachedGpu = { gpu: await detectGpu(platform, unifiedMemory, totalRamMB) }
		: cachedGpu!;

	const profile: IHardwareProfile = {
		platform,
		arch,
		cpuName: cpus[0]?.model.trim() ?? 'Unknown CPU',
		cpuCores: cpus.length,
		totalRamMB,
		freeRamMB: Math.round(os.freemem() / (1024 * 1024)),
		availableRamMB: await availableRamMB(totalRamMB),
		gpu: probed.gpu,
		unifiedMemory,
	};
	if (firstProbe) {
		log(`[localModels] hardware: ${describeHardware(profile)}`);
	}
	return profile;
}

/**
 * Memory obtainable without swapping.
 *
 * `os.freemem` is not that number on Linux: it reports only wholly unused
 * pages, so a machine with gigabytes of reclaimable page cache looks nearly
 * full — measured here at 0.3 GB free against 7.2 GB actually available. The
 * kernel publishes its own estimate, which accounts for what it can reclaim.
 */
async function availableRamMB(totalRamMB: number): Promise<number> {
	if (os.platform() === 'linux') {
		try {
			const meminfo = await fs.promises.readFile('/proc/meminfo', 'utf8');
			const match = /^MemAvailable:\s+(?<kb>\d+) kB$/m.exec(meminfo);
			if (match?.groups) {
				return Math.round(Number(match.groups.kb) / 1024);
			}
		} catch {
			// fall through to the portable estimate
		}
	}
	// Elsewhere `os.freemem` is the closest portable answer. Capped at the total
	// so a bogus reading cannot inflate the budget.
	return Math.min(totalRamMB, Math.round(os.freemem() / (1024 * 1024)));
}

async function detectGpu(platform: NodeJS.Platform, unifiedMemory: boolean, totalRamMB: number): Promise<IGpuInfo | undefined> {
	// Apple Silicon: the GPU shares system memory. macOS caps what the GPU may
	// map at roughly 75% of physical RAM, which is the practical VRAM budget.
	if (unifiedMemory) {
		let name = 'Apple GPU';
		try {
			const { stdout } = await execAsync('sysctl -n machdep.cpu.brand_string', { timeout: 3000 });
			name = stdout.trim() || name;
		} catch {
			// keep the generic name
		}
		return { name, vramMB: Math.floor(totalRamMB * 0.75), backend: 'metal' };
	}

	const nvidia = await detectNvidia();
	if (nvidia) {
		return nvidia;
	}
	if (platform === 'linux') {
		return await detectLinuxGpu();
	}
	if (platform === 'win32') {
		return await detectWindowsGpu();
	}
	return undefined;
}

async function detectNvidia(): Promise<IGpuInfo | undefined> {
	try {
		const { stdout } = await execAsync(
			'nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits',
			{ timeout: 5000 },
		);
		const line = stdout.split('\n').map(l => l.trim()).find(l => l.length > 0);
		if (!line) {
			return undefined;
		}
		const [name, vram] = line.split(',').map(part => part.trim());
		const vramMB = Number.parseInt(vram, 10);
		return { name: name || 'NVIDIA GPU', vramMB: Number.isFinite(vramMB) ? vramMB : 0, backend: 'cuda' };
	} catch {
		return undefined;
	}
}

async function detectLinuxGpu(): Promise<IGpuInfo | undefined> {
	// AMD: rocm-smi reports VRAM in bytes when present.
	try {
		const { stdout } = await execAsync('rocm-smi --showmeminfo vram --csv', { timeout: 5000 });
		const match = /(\d{6,})/.exec(stdout);
		if (match) {
			return { name: 'AMD GPU', vramMB: Math.round(Number(match[1]) / (1024 * 1024)), backend: 'rocm' };
		}
	} catch {
		// rocm-smi not installed
	}
	// Anything with a DRM render node can still use the Vulkan backend, but we
	// cannot size its memory, so callers fall back to the system RAM budget.
	try {
		const { stdout } = await execAsync('lspci | grep -Ei "vga|3d controller|display controller"', { timeout: 5000 });
		const line = stdout.split('\n').map(l => l.trim()).find(l => l.length > 0);
		if (line) {
			return { name: cleanPciName(line), vramMB: 0, backend: 'vulkan' };
		}
	} catch {
		// lspci unavailable
	}
	return undefined;
}

async function detectWindowsGpu(): Promise<IGpuInfo | undefined> {
	try {
		const { stdout } = await execAsync(
			'powershell -NoProfile -Command "Get-CimInstance Win32_VideoController | Select-Object -First 1 -ExpandProperty Name"',
			{ timeout: 8000 },
		);
		const name = stdout.trim();
		if (!name) {
			return undefined;
		}
		// Win32_VideoController.AdapterRAM is a 32-bit field and reports garbage
		// above 4 GB, so we deliberately do not read it. Without a VRAM figure
		// the fit calculation falls back to the system RAM budget.
		return { name, vramMB: 0, backend: 'vulkan' };
	} catch {
		return undefined;
	}
}

/**
 * Reduces an `lspci` line such as
 * `00:02.0 VGA compatible controller: Intel Corporation Alder Lake-UP3 GT2 [Iris Xe Graphics] (rev 0c)`
 * to just the adapter name.
 */
function cleanPciName(line: string): string {
	const afterClass = line.split(/:\s(?=[^:]*$)/).pop() ?? line;
	return afterClass.replace(/\s*\(rev [^)]*\)\s*$/i, '').trim() || line.trim();
}

/** One-line human summary used in the picker header and logs. */
export function describeHardware(profile: IHardwareProfile): string {
	const ram = `${(profile.totalRamMB / 1024).toFixed(1)} GB RAM`;
	if (!profile.gpu) {
		return `${profile.cpuName} · ${profile.cpuCores} núcleos · ${ram} · somente CPU`;
	}
	const vram = profile.gpu.vramMB > 0
		? `${(profile.gpu.vramMB / 1024).toFixed(1)} GB ${profile.unifiedMemory ? 'unified' : 'VRAM'}`
		: 'VRAM unknown';
	return `${profile.cpuName} · ${ram} · ${profile.gpu.name} (${vram})`;
}

/**
 * Memory the model may occupy, in MB. On dedicated GPUs this is video memory;
 * otherwise it is the share of system RAM we consider safe to hand to the
 * runtime while leaving the OS and the editor room to breathe.
 */
export function memoryBudgetMB(profile: IHardwareProfile): { budgetMB: number; onGpu: boolean } {
	if (profile.gpu && profile.gpu.vramMB > 0) {
		return { budgetMB: Math.floor(profile.gpu.vramMB * 0.9), onGpu: true };
	}
	return { budgetMB: Math.floor(profile.totalRamMB * 0.7), onGpu: false };
}
