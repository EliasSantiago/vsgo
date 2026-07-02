/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import { CodeGraphService, SymbolInfo } from './graphIndex/codeGraphService.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

interface ReadFileInput { path: string }
interface WriteFileInput { path: string; content: string }
interface ListDirInput { path?: string }
interface RunCommandInput { command: string; cwd?: string }
interface SearchInput { query: string; isRegex?: boolean; path?: string }

export function registerTools(): vscode.Disposable {
	const subs: vscode.Disposable[] = [];
	subs.push(vscode.lm.registerTool('agent_read_file', new ReadFileTool()));
	subs.push(vscode.lm.registerTool('agent_write_file', new WriteFileTool()));
	subs.push(vscode.lm.registerTool('agent_list_dir', new ListDirTool()));
	subs.push(vscode.lm.registerTool('agent_search', new SearchTool()));
	subs.push(vscode.lm.registerTool('agent_run_command', new RunCommandTool()));

	// Code graph tool, gated behind the `agent-chat.codeGraph.enabled` setting so
	// it can be toggled on/off (and A/B compared via the AI Usage meter).
	const graph = new CodeGraphService();
	subs.push({ dispose: () => graph.dispose() });
	let graphToolReg: vscode.Disposable | undefined;
	const syncGraphTool = () => {
		const enabled = vscode.workspace.getConfiguration('agent-chat').get<boolean>('codeGraph.enabled', false);
		if (enabled && !graphToolReg) {
			graphToolReg = vscode.lm.registerTool('agent_code_graph', new CodeGraphTool(graph));
			void graph.ensureReady();
		} else if (!enabled && graphToolReg) {
			graphToolReg.dispose();
			graphToolReg = undefined;
		}
	};
	syncGraphTool();
	subs.push(vscode.workspace.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration('agent-chat.codeGraph.enabled')) {
			syncGraphTool();
		}
	}));
	subs.push({ dispose: () => graphToolReg?.dispose() });

	return vscode.Disposable.from(...subs);
}

interface CodeGraphInput { query: string; kind?: SymbolInfo['kind'] }

class CodeGraphTool implements vscode.LanguageModelTool<CodeGraphInput> {
	constructor(private readonly graph: CodeGraphService) { }

	async invoke(options: vscode.LanguageModelToolInvocationOptions<CodeGraphInput>, _token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
		const ready = await this.graph.ensureReady();
		if (!ready) {
			return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('Code graph unavailable (tree-sitter failed to load).')]);
		}
		const { query, kind } = options.input;
		const results = this.graph.querySymbols(query, kind);
		if (results.length === 0) {
			return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(`No symbols found for "${query}".`)]);
		}
		const lines = results.map(s => `${s.kind} ${s.name} — ${s.file}:${s.line}`);
		return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(lines.join('\n'))]);
	}

	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<CodeGraphInput>): Promise<vscode.PreparedToolInvocation> {
		return { invocationMessage: `Consultando grafo de código: \`${options.input.query}\`` };
	}
}

class ReadFileTool implements vscode.LanguageModelTool<ReadFileInput> {
	async invoke(options: vscode.LanguageModelToolInvocationOptions<ReadFileInput>, _token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
		const uri = resolveUri(options.input.path);
		const bytes = await vscode.workspace.fs.readFile(uri);
		const text = Buffer.from(bytes).toString('utf8');
		const truncated = text.length > 100_000 ? text.slice(0, 100_000) + '\n…[truncated]' : text;
		return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(truncated)]);
	}

	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<ReadFileInput>): Promise<vscode.PreparedToolInvocation> {
		return { invocationMessage: `Lendo \`${options.input.path}\`` };
	}
}

class WriteFileTool implements vscode.LanguageModelTool<WriteFileInput> {
	async invoke(options: vscode.LanguageModelToolInvocationOptions<WriteFileInput>, _token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
		const uri = resolveUri(options.input.path);
		const data = Buffer.from(options.input.content, 'utf8');
		await vscode.workspace.fs.writeFile(uri, data);
		return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(`Escreveu ${data.byteLength} bytes em ${options.input.path}`)]);
	}

	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<WriteFileInput>): Promise<vscode.PreparedToolInvocation> {
		return { invocationMessage: `Escrevendo \`${options.input.path}\`` };
	}
}

class ListDirTool implements vscode.LanguageModelTool<ListDirInput> {
	async invoke(options: vscode.LanguageModelToolInvocationOptions<ListDirInput>, _token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
		const path = options.input.path;
		const folders = vscode.workspace.workspaceFolders ?? [];
		if (!path && folders.length > 1) {
			const lines = folders.map(f => `📁 ${f.name}/  (root: ${f.uri.fsPath})`);
			return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
				`Workspace has ${folders.length} root folders. Pass the folder name as the first path segment to scope a listing (e.g. "${folders[0].name}/src").\n\n${lines.join('\n')}`,
			)]);
		}
		const uri = resolveUri(path ?? '.');
		const entries = await vscode.workspace.fs.readDirectory(uri);
		const lines = entries
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([name, kind]) => `${kind === vscode.FileType.Directory ? '📁' : '📄'} ${name}`);
		return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(lines.join('\n') || '(empty)')]);
	}

	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<ListDirInput>): Promise<vscode.PreparedToolInvocation> {
		return { invocationMessage: `Listando \`${options.input.path ?? '.'}\`` };
	}
}

const MAX_SEARCH_MATCHES = 100;

/**
 * Search file contents across the workspace. Uses ripgrep when available and
 * falls back to `grep -rn`. Returns matches as `relativePath:line: text`.
 */
export async function searchWorkspace(input: SearchInput): Promise<string> {
	const cwd = input.path ? resolveFsPath(input.path) : workspaceRootPath();
	const query = input.query;
	if (!query) {
		return 'Consulta de busca vazia.';
	}
	try {
		const args = [
			'--line-number',
			'--no-heading',
			'--color', 'never',
			'--max-count', String(MAX_SEARCH_MATCHES),
			input.isRegex ? '--regexp' : '--fixed-strings',
			query,
			'.',
		];
		const { stdout } = await execFileAsync('rg', args, { cwd, maxBuffer: 4 * 1024 * 1024 });
		return formatSearchOutput(stdout, query);
	} catch (rgErr) {
		// ripgrep returns exit code 1 when there are no matches — not an error.
		if (isNoMatchExit(rgErr)) {
			return `Nenhum resultado para "${query}".`;
		}
		// ripgrep missing — fall back to grep.
		try {
			const grepArgs = ['-rn', input.isRegex ? '-E' : '-F', '--', query, '.'];
			const { stdout } = await execFileAsync('grep', grepArgs, { cwd, maxBuffer: 4 * 1024 * 1024 });
			return formatSearchOutput(stdout, query);
		} catch (grepErr) {
			if (isNoMatchExit(grepErr)) {
				return `Nenhum resultado para "${query}".`;
			}
			const message = grepErr instanceof Error ? grepErr.message : String(grepErr);
			return `Erro na busca: ${message}`;
		}
	}
}

function isNoMatchExit(err: unknown): boolean {
	return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 1;
}

function formatSearchOutput(stdout: string, query: string): string {
	const lines = stdout.split('\n').filter(Boolean);
	if (lines.length === 0) {
		return `Nenhum resultado para "${query}".`;
	}
	const trimmed = lines.slice(0, MAX_SEARCH_MATCHES).map(line => line.length > 240 ? line.slice(0, 240) + '…' : line);
	const header = lines.length > MAX_SEARCH_MATCHES
		? `${MAX_SEARCH_MATCHES}+ resultados para "${query}" (mostrando os primeiros ${MAX_SEARCH_MATCHES}):`
		: `${trimmed.length} resultado(s) para "${query}":`;
	return `${header}\n${trimmed.join('\n')}`;
}

class SearchTool implements vscode.LanguageModelTool<SearchInput> {
	async invoke(options: vscode.LanguageModelToolInvocationOptions<SearchInput>, _token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
		const text = await searchWorkspace(options.input);
		return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
	}

	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<SearchInput>): Promise<vscode.PreparedToolInvocation> {
		return { invocationMessage: `Buscando \`${options.input.query}\`` };
	}
}

const DANGEROUS_PATTERNS: ReadonlyArray<{ re: RegExp; reason: string }> = [
	{ re: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\b/, reason: 'recursive force delete (rm -rf)' },
	{ re: /\bgit\s+push\s+.*(-f\b|--force\b)/, reason: 'force push' },
	{ re: /\bgit\s+reset\s+--hard\b/, reason: 'git reset --hard discards changes' },
	{ re: /\bgit\s+clean\s+-[a-zA-Z]*f/, reason: 'git clean -f deletes untracked files' },
	{ re: /\bgit\s+checkout\s+--\s+\./, reason: 'discards working tree' },
	{ re: /\bsudo\b/, reason: 'sudo escalation' },
	{ re: /\b(curl|wget)\s+[^|]*\|\s*(bash|sh|zsh)\b/, reason: 'pipe-to-shell from network' },
	{ re: /\b(npm|pnpm|yarn)\s+(uninstall|remove)\b/, reason: 'package removal' },
	{ re: /\bdd\s+if=/, reason: 'dd writes raw bytes' },
	{ re: /\bmkfs(\.|\b)/, reason: 'filesystem format' },
	{ re: />\s*\/dev\/sd[a-z]/, reason: 'write to raw block device' },
	{ re: /\bchmod\s+(-R\s+)?777\b/, reason: 'chmod 777 (world-writable)' },
];

function classifyCommand(command: string): { reason: string } | undefined {
	for (const { re, reason } of DANGEROUS_PATTERNS) {
		if (re.test(command)) {
			return { reason };
		}
	}
	return undefined;
}

class RunCommandTool implements vscode.LanguageModelTool<RunCommandInput> {
	async invoke(options: vscode.LanguageModelToolInvocationOptions<RunCommandInput>, _token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
		const cwd = options.input.cwd ? resolveFsPath(options.input.cwd) : workspaceRootPath();
		try {
			const { stdout, stderr } = await execAsync(options.input.command, { cwd, maxBuffer: 4 * 1024 * 1024 });
			const out = [stdout, stderr].filter(Boolean).join('\n').trim() || '(sem saída)';
			return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(out)]);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(`Comando falhou: ${message}`)]);
		}
	}

	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<RunCommandInput>): Promise<vscode.PreparedToolInvocation> {
		const danger = classifyCommand(options.input.command);
		if (danger) {
			const autoApprove = vscode.workspace.getConfiguration('agent-chat').get<boolean>('autoApproveTools', true);
			if (!autoApprove) {
				const message = new vscode.MarkdownString(
					`### ⚠️ Comando perigoso\n\nO assistente quer executar:\n\n\`\`\`\n${options.input.command}\n\`\`\`\n\n**Motivo:** ${danger.reason}\n\nEsta operação pode ser destrutiva ou irreversível. Continue somente se entender o efeito.`,
				);
				message.supportThemeIcons = true;
				return {
					invocationMessage: `⚠️ Executando comando perigoso \`${options.input.command}\``,
					confirmationMessages: {
						title: 'Comando shell perigoso',
						message,
					},
				};
			}
			return { invocationMessage: `⚠️ Executando \`${options.input.command}\` (${danger.reason})` };
		}
		return { invocationMessage: `Executando \`${options.input.command}\`` };
	}
}

export function resolveUri(p: string): vscode.Uri {
	if (p.startsWith('/') || /^[A-Za-z]:[/\\]/.test(p)) {
		return vscode.Uri.file(p);
	}
	const folders = vscode.workspace.workspaceFolders ?? [];
	if (folders.length === 0) {
		throw new Error('Nenhuma pasta de workspace está aberta');
	}
	const folder = matchFolderByPrefix(folders, p);
	if (folder) {
		const rest = p.slice(folder.name.length).replace(/^\//, '');
		return rest ? vscode.Uri.joinPath(folder.uri, rest) : folder.uri;
	}
	if (folders.length > 1) {
		const names = folders.map(f => f.name).join(', ');
		throw new Error(`Path "${p}" is ambiguous in a multi-root workspace. Prefix with one of: ${names}.`);
	}
	return vscode.Uri.joinPath(folders[0].uri, p);
}

function resolveFsPath(p: string): string {
	if (p.startsWith('/') || /^[A-Za-z]:[/\\]/.test(p)) {
		return p;
	}
	const folders = vscode.workspace.workspaceFolders ?? [];
	const folder = matchFolderByPrefix(folders, p);
	if (folder) {
		const rest = p.slice(folder.name.length).replace(/^\//, '');
		return rest ? `${folder.uri.fsPath}/${rest}` : folder.uri.fsPath;
	}
	const root = workspaceRootPath();
	return root ? `${root}/${p}` : p;
}

function matchFolderByPrefix(folders: readonly vscode.WorkspaceFolder[], p: string): vscode.WorkspaceFolder | undefined {
	const firstSeg = p.split('/')[0];
	return folders.find(f => f.name === firstSeg);
}

function workspaceRootPath(): string {
	return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
}
