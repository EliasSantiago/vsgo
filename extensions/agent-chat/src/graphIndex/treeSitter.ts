/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { log } from '../logger.js';

// Minimal shape of the bundled `@vscode/tree-sitter-wasm` module we rely on.

export interface TSNode {
	readonly type: string;
	readonly text: string;
	readonly startPosition: { row: number };
	readonly endPosition: { row: number };
	readonly namedChildren: TSNode[];
	childForFieldName(field: string): TSNode | null;
}

export interface TSTree {
	readonly rootNode: TSNode;
	delete(): void;
}

export interface TSParser {
	setLanguage(lang: unknown): void;
	parse(input: string): TSTree;
	delete(): void;
}

interface TSModule {
	Parser: { init(options: { locateFile(): string }): Promise<void>; new(): TSParser };
	Language: { load(bytes: Uint8Array): Promise<unknown> };
}

interface ILoadedGrammar {
	readonly module: TSModule;
	readonly language: unknown;
}

let loadPromise: Promise<ILoadedGrammar | undefined> | undefined;

/**
 * Loads the tree-sitter runtime and the TypeScript grammar, once per session.
 *
 * The module and its grammars ship with the app; Node resolves them from the
 * app's `node_modules` by walking up from the extension. Initializing the WASM
 * runtime twice would waste memory, so every consumer shares this one load and
 * only the lightweight parser instances are per-caller.
 */
async function loadTypeScriptGrammar(): Promise<ILoadedGrammar | undefined> {
	try {
		const treeSitter = require('@vscode/tree-sitter-wasm') as TSModule;
		const wasmDir = path.dirname(require.resolve('@vscode/tree-sitter-wasm'));
		await treeSitter.Parser.init({ locateFile: () => path.join(wasmDir, 'tree-sitter.wasm') });
		const grammar = await fs.promises.readFile(path.join(wasmDir, 'tree-sitter-typescript.wasm'));
		const language = await treeSitter.Language.load(new Uint8Array(grammar));
		log('[treeSitter] TypeScript grammar ready');
		return { module: treeSitter, language };
	} catch (err) {
		log('[treeSitter] initialization failed:', err instanceof Error ? err.message : String(err));
		return undefined;
	}
}

/**
 * A parser bound to the TypeScript grammar, or `undefined` when tree-sitter is
 * unavailable. Callers own the returned parser and must `delete()` it.
 */
export async function createTypeScriptParser(): Promise<TSParser | undefined> {
	if (!loadPromise) {
		loadPromise = loadTypeScriptGrammar();
	}
	const loaded = await loadPromise;
	if (!loaded) {
		return undefined;
	}
	const parser = new loaded.module.Parser();
	parser.setLanguage(loaded.language);
	return parser;
}
