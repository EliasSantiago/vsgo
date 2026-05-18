/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface DiffFile {
	readonly path: string;
	readonly oldPath?: string;
	readonly hunks: readonly DiffHunk[];
	readonly binary: boolean;
}

export interface DiffHunk {
	readonly oldStart: number;
	readonly newStart: number;
	readonly lines: readonly DiffLine[];
}

export interface DiffLine {
	readonly kind: 'context' | 'added' | 'removed';
	readonly oldLine?: number;
	readonly newLine?: number;
	readonly text: string;
}

const FILE_HEADER_RE = /^diff --git a\/(.+) b\/(.+)$/;
const HUNK_RE = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;

export function parseUnifiedDiff(diff: string): DiffFile[] {
	const files: DiffFile[] = [];
	const lines = diff.split(/\r?\n/);
	let i = 0;
	while (i < lines.length) {
		const fileMatch = FILE_HEADER_RE.exec(lines[i]);
		if (!fileMatch) {
			i++;
			continue;
		}
		const oldPath = fileMatch[1];
		const newPath = fileMatch[2];
		i++;
		let binary = false;
		while (i < lines.length && !lines[i].startsWith('@@') && !FILE_HEADER_RE.test(lines[i])) {
			if (lines[i].startsWith('Binary files') || lines[i].startsWith('GIT binary patch')) {
				binary = true;
			}
			i++;
		}
		const hunks: DiffHunk[] = [];
		while (i < lines.length && lines[i].startsWith('@@')) {
			const h = HUNK_RE.exec(lines[i]);
			if (!h) {
				i++;
				continue;
			}
			const oldStart = parseInt(h[1], 10);
			const newStart = parseInt(h[3], 10);
			i++;
			const hunkLines: DiffLine[] = [];
			let oldCursor = oldStart;
			let newCursor = newStart;
			while (i < lines.length && !lines[i].startsWith('@@') && !FILE_HEADER_RE.test(lines[i])) {
				const raw = lines[i];
				const prefix = raw[0];
				const text = raw.slice(1);
				if (prefix === '+') {
					hunkLines.push({ kind: 'added', newLine: newCursor, text });
					newCursor++;
				} else if (prefix === '-') {
					hunkLines.push({ kind: 'removed', oldLine: oldCursor, text });
					oldCursor++;
				} else if (prefix === ' ' || prefix === undefined) {
					hunkLines.push({ kind: 'context', oldLine: oldCursor, newLine: newCursor, text });
					oldCursor++;
					newCursor++;
				}
				i++;
			}
			hunks.push({ oldStart, newStart, lines: hunkLines });
		}
		files.push({ path: newPath, oldPath: oldPath !== newPath ? oldPath : undefined, hunks, binary });
	}
	return files;
}

export function diffSizeBytes(diff: string): number {
	return Buffer.byteLength(diff, 'utf8');
}

export function truncateDiff(diff: string, maxBytes: number): { diff: string; truncated: boolean } {
	if (diffSizeBytes(diff) <= maxBytes) {
		return { diff, truncated: false };
	}
	const sliced = diff.slice(0, maxBytes);
	const lastFile = sliced.lastIndexOf('\ndiff --git');
	const clipAt = lastFile > maxBytes / 2 ? lastFile : sliced.length;
	return { diff: sliced.slice(0, clipAt), truncated: true };
}
