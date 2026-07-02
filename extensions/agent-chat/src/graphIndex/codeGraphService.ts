/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { log } from '../logger.js';

/** A code symbol definition located by the graph. */
export interface SymbolInfo {
	readonly name: string;
	readonly kind: 'function' | 'class' | 'interface' | 'type' | 'enum';
	/** Workspace-relative path. */
	readonly file: string;
	/** 1-based line number of the definition. */
	readonly line: number;
}

// Minimal shape of the bundled `@vscode/tree-sitter-wasm` module we rely on.
interface TSNode {
	readonly type: string;
	readonly text: string;
	readonly startPosition: { row: number };
	readonly namedChildren: TSNode[];
	childForFieldName(field: string): TSNode | null;
}
interface TSTree { readonly rootNode: TSNode; delete(): void }
interface TSParser { setLanguage(lang: unknown): void; parse(input: string): TSTree; delete(): void }
interface TSModule {
	Parser: { init(options: { locateFile(): string }): Promise<void>; new(): TSParser };
	Language: { load(bytes: Uint8Array): Promise<unknown> };
}

const NODE_TYPE_TO_KIND: ReadonlyMap<string, SymbolInfo['kind']> = new Map([
	['function_declaration', 'function'],
	['generator_function_declaration', 'function'],
	['class_declaration', 'class'],
	['abstract_class_declaration', 'class'],
	['interface_declaration', 'interface'],
	['type_alias_declaration', 'type'],
	['enum_declaration', 'enum'],
]);

const MAX_FILES = 5000;
const MAX_FILE_SIZE = 1_000_000; // Skip files larger than ~1MB.
const MAX_RESULTS = 50;

/**
 * Builds and maintains an in-memory code knowledge graph of the workspace using
 * tree-sitter (the TypeScript grammar bundled with the app). Purely local, costs
 * no tokens, and is exposed to the agent through the `agent_code_graph` tool.
 */
export class CodeGraphService {

	private parser: TSParser | undefined;
	private available = false;
	private initPromise: Promise<boolean> | undefined;
	private indexPromise: Promise<void> | undefined;
	/** True once a workspace scan has actually found files (guards against caching an empty startup index). */
	private fullyIndexed = false;

	/** Lowercased symbol name → definitions. */
	private readonly byName = new Map<string, SymbolInfo[]>();
	/** Workspace-relative file → its definitions (for incremental updates). */
	private readonly byFile = new Map<string, SymbolInfo[]>();

	private watcher: vscode.FileSystemWatcher | undefined;

	/** Loads tree-sitter (once) and indexes the workspace. Returns availability. */
	async ensureReady(): Promise<boolean> {
		if (!this.initPromise) {
			this.initPromise = this.init();
		}
		const ok = await this.initPromise;
		if (!ok) {
			return false;
		}
		// `findFiles` returns nothing when called too early at startup (before the
		// file search service has walked the workspace). Since parser init is memoized,
		// an empty index would otherwise stick forever — so index lazily and retry while
		// we still have no symbols. The first real tool invocation then populates it.
		if (!this.fullyIndexed) {
			if (!this.indexPromise) {
				this.indexPromise = this.indexWorkspace().finally(() => { this.indexPromise = undefined; });
			}
			await this.indexPromise;
		}
		return true;
	}

	private async init(): Promise<boolean> {
		try {
			// The module and its grammars ship with the app; Node resolves them
			// from the app's node_modules (walking up from the extension).
			const treeSitter = require('@vscode/tree-sitter-wasm') as TSModule;
			const wasmDir = path.dirname(require.resolve('@vscode/tree-sitter-wasm'));
			await treeSitter.Parser.init({ locateFile: () => path.join(wasmDir, 'tree-sitter.wasm') });
			const grammar = await fs.promises.readFile(path.join(wasmDir, 'tree-sitter-typescript.wasm'));
			const language = await treeSitter.Language.load(new Uint8Array(grammar));
			this.parser = new treeSitter.Parser();
			this.parser.setLanguage(language);
			this.available = true;
			this.installWatcher();
			log('[codeGraph] parser ready');
			return true;
		} catch (err) {
			log('[codeGraph] initialization failed:', err instanceof Error ? err.message : String(err));
			this.available = false;
			return false;
		}
	}

	private async indexWorkspace(): Promise<void> {
		const files = await vscode.workspace.findFiles('**/*.ts', '**/node_modules/**', MAX_FILES);
		for (const uri of files) {
			await this.indexFile(uri);
		}
		if (files.length > 0) {
			this.fullyIndexed = true;
		}
		log('[codeGraph] indexed', String(this.byFile.size), 'files with symbols from', String(files.length), 'ts files');
	}

	private async indexFile(uri: vscode.Uri): Promise<void> {
		if (!this.parser) {
			return;
		}
		const rel = vscode.workspace.asRelativePath(uri, false);
		try {
			const bytes = await vscode.workspace.fs.readFile(uri);
			if (bytes.byteLength > MAX_FILE_SIZE) {
				return;
			}
			const symbols = this.extractSymbols(Buffer.from(bytes).toString('utf8'), rel);
			this.setFileSymbols(rel, symbols);
		} catch (err) {
			log('[codeGraph] failed to index', rel, err instanceof Error ? err.message : String(err));
		}
	}

	private extractSymbols(source: string, file: string): SymbolInfo[] {
		const tree = this.parser!.parse(source);
		const symbols: SymbolInfo[] = [];
		try {
			const stack: TSNode[] = [tree.rootNode];
			while (stack.length > 0) {
				const node = stack.pop()!;
				const kind = NODE_TYPE_TO_KIND.get(node.type);
				if (kind) {
					const name = node.childForFieldName('name')?.text;
					if (name) {
						symbols.push({ name, kind, file, line: node.startPosition.row + 1 });
					}
				}
				for (const child of node.namedChildren) {
					stack.push(child);
				}
			}
		} finally {
			tree.delete();
		}
		return symbols;
	}

	/** Replaces the symbols recorded for a file and updates the name index. */
	private setFileSymbols(file: string, symbols: SymbolInfo[]): void {
		this.removeFile(file);
		if (symbols.length === 0) {
			return;
		}
		this.byFile.set(file, symbols);
		for (const symbol of symbols) {
			const key = symbol.name.toLowerCase();
			const bucket = this.byName.get(key);
			if (bucket) {
				bucket.push(symbol);
			} else {
				this.byName.set(key, [symbol]);
			}
		}
	}

	private removeFile(file: string): void {
		const existing = this.byFile.get(file);
		if (!existing) {
			return;
		}
		this.byFile.delete(file);
		for (const symbol of existing) {
			const key = symbol.name.toLowerCase();
			const bucket = this.byName.get(key);
			if (!bucket) {
				continue;
			}
			const remaining = bucket.filter(s => s.file !== file);
			if (remaining.length > 0) {
				this.byName.set(key, remaining);
			} else {
				this.byName.delete(key);
			}
		}
	}

	private installWatcher(): void {
		this.watcher = vscode.workspace.createFileSystemWatcher('**/*.ts');
		this.watcher.onDidCreate(uri => this.indexFile(uri));
		this.watcher.onDidChange(uri => this.indexFile(uri));
		this.watcher.onDidDelete(uri => this.removeFile(vscode.workspace.asRelativePath(uri, false)));
	}

	/** Finds definitions whose name matches (case-insensitive substring). */
	querySymbols(query: string, kind?: SymbolInfo['kind']): SymbolInfo[] {
		const needle = query.trim().toLowerCase();
		if (!needle) {
			return [];
		}
		const results: SymbolInfo[] = [];
		for (const [name, bucket] of this.byName) {
			if (!name.includes(needle)) {
				continue;
			}
			for (const symbol of bucket) {
				if (!kind || symbol.kind === kind) {
					results.push(symbol);
				}
			}
			if (results.length >= MAX_RESULTS * 4) {
				break;
			}
		}
		// Exact matches first, then shorter names (closer matches), then by file.
		results.sort((a, b) => {
			const aExact = a.name.toLowerCase() === needle ? 0 : 1;
			const bExact = b.name.toLowerCase() === needle ? 0 : 1;
			return aExact - bExact || a.name.length - b.name.length || a.file.localeCompare(b.file);
		});
		return results.slice(0, MAX_RESULTS);
	}

	get isAvailable(): boolean {
		return this.available;
	}

	dispose(): void {
		this.watcher?.dispose();
		this.byName.clear();
		this.byFile.clear();
		try {
			this.parser?.delete();
		} catch {
			// WASM memory may already be freed.
		}
		this.parser = undefined;
		this.available = false;
	}
}
