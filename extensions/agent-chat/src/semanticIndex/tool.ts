/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { SemanticIndexService } from './semanticIndexService.js';
import { ISearchHit } from './vectorStore.js';

export interface CodebaseSearchInput {
	query: string;
	limit?: number;
	path?: string;
}

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;
/** Lines of a hit shown to the model before it is cut. */
const MAX_SNIPPET_LINES = 40;

/**
 * Retrieves code by meaning rather than by spelling.
 *
 * Complements `agent_search`: that one wins whenever the model already knows
 * the identifier, this one wins when it only knows the intent.
 */
export class CodebaseSearchTool implements vscode.LanguageModelTool<CodebaseSearchInput> {

	constructor(private readonly index: SemanticIndexService) { }

	async invoke(options: vscode.LanguageModelToolInvocationOptions<CodebaseSearchInput>, token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
		const { query } = options.input;
		if (!query?.trim()) {
			return text('Informe uma consulta em linguagem natural.');
		}
		const limit = Math.min(Math.max(options.input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
		const hits = await this.index.search(query, limit, options.input.path, token);
		if (!hits) {
			return text('Busca semântica indisponível: o índice ainda não foi construído. Use `agent_search` para busca textual.');
		}
		if (hits.length === 0) {
			return text(`Nenhum trecho relevante para "${query}".`);
		}
		const blocks = await Promise.all(hits.map(hit => render(hit)));
		return text(blocks.join('\n\n'));
	}

	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<CodebaseSearchInput>): Promise<vscode.PreparedToolInvocation> {
		return { invocationMessage: `Busca semântica: \`${options.input.query}\`` };
	}
}

/**
 * Reads the hit's lines back from disk.
 *
 * The index stores only locations, so a chunk whose file moved on since it was
 * embedded shows up as a location without a body rather than as stale code.
 */
async function render(hit: ISearchHit): Promise<string> {
	const location = `${hit.file}:${hit.startLine}-${hit.endLine}`;
	const heading = hit.breadcrumb ? `${location} — ${hit.breadcrumb}` : location;
	let body: string;
	try {
		const uri = await resolve(hit.file);
		if (!uri) {
			return heading;
		}
		const source = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
		const lines = source.split(/\r?\n/).slice(hit.startLine - 1, hit.endLine);
		body = lines.slice(0, MAX_SNIPPET_LINES).join('\n');
		if (lines.length > MAX_SNIPPET_LINES) {
			body += '\n…';
		}
	} catch {
		return heading;
	}
	return `${heading}\n\`\`\`\n${body}\n\`\`\``;
}

async function resolve(file: string): Promise<vscode.Uri | undefined> {
	for (const folder of vscode.workspace.workspaceFolders ?? []) {
		const candidate = vscode.Uri.joinPath(folder.uri, file);
		try {
			await vscode.workspace.fs.stat(candidate);
			return candidate;
		} catch {
			// try the next folder
		}
	}
	return undefined;
}

function text(value: string): vscode.LanguageModelToolResult {
	return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(value)]);
}
