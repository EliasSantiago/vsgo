/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';

export const IAIUsageService = createDecorator<IAIUsageService>('aiUsageService');

/**
 * A single language model request accounted for by the token meter.
 */
export interface IAIUsageEntry {
	/** Epoch milliseconds when the request completed. */
	readonly timestamp: number;
	/** Provider vendor (e.g. `anthropic`, `openai`). */
	readonly vendor: string;
	/** Model identifier used for the request. */
	readonly modelId: string;
	/** Human-readable model name, when available. */
	readonly modelName?: string;
	/** Estimated or reported prompt tokens. */
	readonly inputTokens: number;
	/** Estimated or reported completion tokens. */
	readonly outputTokens: number;
	/** Wall-clock duration of the request in milliseconds. */
	readonly durationMs?: number;
	/**
	 * Whether the token counts are estimated (heuristic) rather than reported
	 * by the provider's API. Real usage is preferred when available.
	 */
	readonly estimated?: boolean;
	/**
	 * Free-form tags used to compare feature configurations, e.g.
	 * `code-graph:on` vs `code-graph:off`.
	 */
	readonly tags?: readonly string[];
}

/**
 * Validates and normalizes an untrusted usage entry (e.g. one crossing the
 * extension-host RPC boundary). Returns `undefined` when the payload is invalid.
 */
export function coerceUsageEntry(raw: unknown): IAIUsageEntry | undefined {
	if (typeof raw !== 'object' || raw === null) {
		return undefined;
	}
	const obj = raw as Record<string, unknown>;
	const inputTokens = Number(obj.inputTokens);
	const outputTokens = Number(obj.outputTokens);
	if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) {
		return undefined;
	}
	const tags = Array.isArray(obj.tags) ? obj.tags.filter((t): t is string => typeof t === 'string') : undefined;
	return {
		timestamp: Number.isFinite(Number(obj.timestamp)) ? Number(obj.timestamp) : Date.now(),
		vendor: typeof obj.vendor === 'string' ? obj.vendor : 'unknown',
		modelId: typeof obj.modelId === 'string' ? obj.modelId : 'unknown',
		modelName: typeof obj.modelName === 'string' ? obj.modelName : undefined,
		inputTokens: Math.max(0, Math.round(inputTokens)),
		outputTokens: Math.max(0, Math.round(outputTokens)),
		durationMs: Number.isFinite(Number(obj.durationMs)) ? Number(obj.durationMs) : undefined,
		estimated: obj.estimated === true,
		tags: tags && tags.length > 0 ? tags : undefined,
	};
}

/** Aggregated totals across a set of {@link IAIUsageEntry entries}. */
export interface IAIUsageTotals {
	readonly requests: number;
	readonly inputTokens: number;
	readonly outputTokens: number;
}

/** Time granularity for grouping usage. */
export type AIUsageGranularity = 'day' | 'month' | 'year';

/** Filter applied when querying usage. All conditions are combined with AND. */
export interface IAIUsageFilter {
	/** Only entries at or after this epoch millisecond. */
	readonly from?: number;
	/** Only entries strictly before this epoch millisecond. */
	readonly to?: number;
	/** Only these vendors (case-insensitive). */
	readonly vendors?: readonly string[];
	/** Only these model ids. */
	readonly modelIds?: readonly string[];
	/** Only entries carrying at least one of these tags. */
	readonly tags?: readonly string[];
}

/** A bucket of usage for one time period (e.g. a single day). */
export interface IAIUsagePeriodTotals extends IAIUsageTotals {
	/** Stable key for the period, e.g. `2026-07-01`, `2026-07`, `2026`. */
	readonly period: string;
}

export interface IAIUsageService {
	readonly _serviceBrand: undefined;

	/** Fires whenever an entry is recorded or the history is cleared. */
	readonly onDidChangeUsage: Event<void>;

	/** All recorded entries, most recent last. */
	readonly entries: readonly IAIUsageEntry[];

	/** Record a completed request. */
	record(entry: IAIUsageEntry): void;

	/** Entries matching the given filter, most recent last. */
	query(filter?: IAIUsageFilter): IAIUsageEntry[];

	/** Totals across every entry matching the filter. */
	getTotals(filter?: IAIUsageFilter): IAIUsageTotals;

	/** Totals grouped by model id. */
	getTotalsByModel(filter?: IAIUsageFilter): Map<string, IAIUsageTotals>;

	/** Totals grouped by time period, most recent period first. */
	getTotalsByPeriod(granularity: AIUsageGranularity, filter?: IAIUsageFilter): IAIUsagePeriodTotals[];

	/** Distinct vendors seen so far (for building filter UI). */
	getVendors(): string[];

	/** Distinct model ids seen so far (for building filter UI). */
	getModelIds(): string[];

	/** Clear all recorded usage. */
	clear(): void;
}

const STORAGE_KEY = 'chat.aiUsage.entries';
const MAX_ENTRIES = 1000;

export class AIUsageService extends Disposable implements IAIUsageService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeUsage = this._register(new Emitter<void>());
	readonly onDidChangeUsage = this._onDidChangeUsage.event;

	private _entries: IAIUsageEntry[];

	constructor(
		@IStorageService private readonly _storageService: IStorageService,
	) {
		super();
		this._entries = this._load();
	}

	get entries(): readonly IAIUsageEntry[] {
		return this._entries;
	}

	record(entry: IAIUsageEntry): void {
		this._entries.push(entry);
		if (this._entries.length > MAX_ENTRIES) {
			this._entries.splice(0, this._entries.length - MAX_ENTRIES);
		}
		this._save();
		this._onDidChangeUsage.fire();
	}

	query(filter?: IAIUsageFilter): IAIUsageEntry[] {
		if (!filter) {
			return this._entries.slice();
		}
		const vendors = filter.vendors?.map(v => v.toLowerCase());
		return this._entries.filter(entry => {
			if (filter.from !== undefined && entry.timestamp < filter.from) {
				return false;
			}
			if (filter.to !== undefined && entry.timestamp >= filter.to) {
				return false;
			}
			if (vendors && vendors.length > 0 && !vendors.includes(entry.vendor.toLowerCase())) {
				return false;
			}
			if (filter.modelIds && filter.modelIds.length > 0 && !filter.modelIds.includes(entry.modelId)) {
				return false;
			}
			if (filter.tags && filter.tags.length > 0 && !filter.tags.some(tag => entry.tags?.includes(tag))) {
				return false;
			}
			return true;
		});
	}

	getTotals(filter?: IAIUsageFilter): IAIUsageTotals {
		return totalsOf(this.query(filter));
	}

	getTotalsByModel(filter?: IAIUsageFilter): Map<string, IAIUsageTotals> {
		const byModel = groupBy(this.query(filter), entry => entry.modelId);
		const result = new Map<string, IAIUsageTotals>();
		for (const [modelId, group] of byModel) {
			result.set(modelId, totalsOf(group));
		}
		return result;
	}

	getTotalsByPeriod(granularity: AIUsageGranularity, filter?: IAIUsageFilter): IAIUsagePeriodTotals[] {
		const byPeriod = groupBy(this.query(filter), entry => periodKey(entry.timestamp, granularity));
		const result: IAIUsagePeriodTotals[] = [];
		for (const [period, group] of byPeriod) {
			result.push({ period, ...totalsOf(group) });
		}
		// Most recent period first.
		result.sort((a, b) => b.period.localeCompare(a.period));
		return result;
	}

	getVendors(): string[] {
		return Array.from(new Set(this._entries.map(entry => entry.vendor))).sort();
	}

	getModelIds(): string[] {
		return Array.from(new Set(this._entries.map(entry => entry.modelId))).sort();
	}

	clear(): void {
		if (this._entries.length === 0) {
			return;
		}
		this._entries = [];
		this._save();
		this._onDidChangeUsage.fire();
	}

	private _load(): IAIUsageEntry[] {
		const raw = this._storageService.get(STORAGE_KEY, StorageScope.PROFILE);
		if (!raw) {
			return [];
		}
		try {
			const parsed = JSON.parse(raw);
			return Array.isArray(parsed) ? parsed : [];
		} catch {
			return [];
		}
	}

	private _save(): void {
		this._storageService.store(STORAGE_KEY, JSON.stringify(this._entries), StorageScope.PROFILE, StorageTarget.MACHINE);
	}
}

function totalsOf(entries: readonly IAIUsageEntry[]): IAIUsageTotals {
	let inputTokens = 0;
	let outputTokens = 0;
	for (const entry of entries) {
		inputTokens += entry.inputTokens;
		outputTokens += entry.outputTokens;
	}
	return { requests: entries.length, inputTokens, outputTokens };
}

function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
	const map = new Map<string, T[]>();
	for (const item of items) {
		const key = keyOf(item);
		const bucket = map.get(key);
		if (bucket) {
			bucket.push(item);
		} else {
			map.set(key, [item]);
		}
	}
	return map;
}

/** Builds a zero-padded, lexicographically sortable period key from a timestamp. */
function periodKey(timestamp: number, granularity: AIUsageGranularity): string {
	const date = new Date(timestamp);
	const year = String(date.getFullYear());
	if (granularity === 'year') {
		return year;
	}
	const month = String(date.getMonth() + 1).padStart(2, '0');
	if (granularity === 'month') {
		return `${year}-${month}`;
	}
	const day = String(date.getDate()).padStart(2, '0');
	return `${year}-${month}-${day}`;
}
