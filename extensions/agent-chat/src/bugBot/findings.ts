/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type BugSeverity = 'error' | 'warning' | 'info';

export interface BugFinding {
	readonly line: number;
	readonly endLine: number;
	readonly severity: BugSeverity;
	readonly message: string;
	readonly fix?: string;
}

export function parseFindings(raw: string, maxLine: number): BugFinding[] {
	const json = extractJsonArray(raw);
	if (!json) {
		return [];
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) {
		return [];
	}
	const out: BugFinding[] = [];
	for (const item of parsed) {
		if (!item || typeof item !== 'object') {
			continue;
		}
		const f = item as { line?: unknown; endLine?: unknown; severity?: unknown; message?: unknown; fix?: unknown };
		const line = toLine(f.line, maxLine);
		if (line === undefined) {
			continue;
		}
		const endLine = toLine(f.endLine, maxLine) ?? line;
		if (endLine < line) {
			continue;
		}
		const severity = toSeverity(f.severity);
		const message = typeof f.message === 'string' ? f.message.trim() : '';
		if (!message) {
			continue;
		}
		const fix = typeof f.fix === 'string' && f.fix.length > 0 ? f.fix : undefined;
		out.push({ line, endLine, severity, message, fix });
	}
	return out;
}

function extractJsonArray(raw: string): string | undefined {
	const trimmed = raw.trim();
	if (trimmed.startsWith('[')) {
		return trimmed;
	}
	const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
	if (fenced) {
		const inner = fenced[1].trim();
		if (inner.startsWith('[')) {
			return inner;
		}
	}
	const arrayMatch = /\[[\s\S]*\]/.exec(trimmed);
	return arrayMatch?.[0];
}

function toLine(value: unknown, max: number): number | undefined {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return undefined;
	}
	const n = Math.floor(value);
	if (n < 1 || n > max) {
		return undefined;
	}
	return n;
}

function toSeverity(value: unknown): BugSeverity {
	if (value === 'error' || value === 'warning' || value === 'info') {
		return value;
	}
	return 'warning';
}

export function severityWeight(s: BugSeverity): number {
	switch (s) {
		case 'error': return 2;
		case 'warning': return 1;
		case 'info': return 0;
	}
}
