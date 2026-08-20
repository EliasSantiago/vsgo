/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { exec, execFile, spawn, type ChildProcess } from 'child_process';
import { resolve, sep } from 'path';
import { promisify } from 'util';
import { CodeGraphService, SymbolInfo } from './graphIndex/codeGraphService.js';
import { SemanticIndexService } from './semanticIndex/semanticIndexService.js';
import { CodebaseSearchTool } from './semanticIndex/tool.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export interface ReadFileInput { path: string; offset?: number; limit?: number }
export interface OpenFileInput { path: string; line?: number }
interface WriteFileInput { path: string; content: string }
interface ListDirInput { path?: string }
interface RunCommandInput { command: string; cwd?: string; background?: boolean }
interface ReadTerminalInput { terminalId?: string; waitSeconds?: number }
interface SearchInput { query: string; isRegex?: boolean; path?: string }
interface FindFilesInput { name: string; path?: string }
export interface EditFileInput { path: string; oldText: string; newText: string; replaceAll?: boolean }
export interface DiagnosticsInput { path?: string; severity?: 'error' | 'warning' | 'all' }
export interface MultiEditInput { path: string; edits: Array<{ oldText: string; newText: string; replaceAll?: boolean }> }
export interface GitInput { path?: string }
export interface GitDiffInput { path?: string; staged?: boolean }

export function registerTools(semanticIndex: SemanticIndexService): vscode.Disposable {
	const subs: vscode.Disposable[] = [];
	subs.push(vscode.lm.registerTool('agent_read_file', new ReadFileTool()));
	subs.push(vscode.lm.registerTool('agent_open_file', new OpenFileTool()));
	subs.push(vscode.lm.registerTool('agent_write_file', new WriteFileTool()));
	subs.push(vscode.lm.registerTool('agent_edit_file', new EditFileTool()));
	subs.push(vscode.lm.registerTool('agent_multi_edit', new MultiEditTool()));
	subs.push(vscode.lm.registerTool('agent_list_dir', new ListDirTool()));
	subs.push(vscode.lm.registerTool('agent_search', new SearchTool()));
	subs.push(vscode.lm.registerTool('agent_find_files', new FindFilesTool()));
	subs.push(vscode.lm.registerTool('agent_diagnostics', new DiagnosticsTool()));
	subs.push(vscode.lm.registerTool('agent_git_status', new GitStatusTool()));
	subs.push(vscode.lm.registerTool('agent_git_diff', new GitDiffTool()));
	subs.push(vscode.lm.registerTool('agent_run_command', new RunCommandTool()));
	subs.push(vscode.lm.registerTool('agent_read_terminal', new ReadTerminalTool()));
	subs.push({ dispose: () => stopBackgroundWork() });
	// A terminal the user closed by hand must not be disposed again later. The
	// record survives so a pending read still returns the tail it captured.
	subs.push(vscode.window.onDidCloseTerminal(terminal => {
		for (const record of agentTerminals.values()) {
			if (record.terminal === terminal) {
				record.closed = true;
				wakeTerminalWaiters(record);
			}
		}
		pruneAgentTerminals();
	}));

	// Browser automation is provided by the workbench's Integrated Browser tools
	// (`open_browser_page`, `read_page`, …), which drive an Electron WebContentsView
	// through Playwright over CDP. Nothing to register here — the chat handler picks
	// them up from `vscode.lm.tools` and honours `agent-chat.browser.enabled`.

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

	// Semantic search, gated the same way. The index itself belongs to the
	// extension host so it can outlive any one tool registration.
	let searchToolReg: vscode.Disposable | undefined;
	const syncSearchTool = () => {
		const enabled = SemanticIndexService.isEnabled();
		if (enabled && !searchToolReg) {
			searchToolReg = vscode.lm.registerTool('agent_codebase_search', new CodebaseSearchTool(semanticIndex));
		} else if (!enabled && searchToolReg) {
			searchToolReg.dispose();
			searchToolReg = undefined;
		}
	};
	syncSearchTool();
	subs.push(vscode.workspace.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration('agent-chat.semanticIndex.enabled')) {
			syncSearchTool();
		}
	}));
	subs.push({ dispose: () => searchToolReg?.dispose() });

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

/** Budget for a read made outside the agent loop, which carries no profile. */
const DEFAULT_READ_BUDGET = 100_000;

/**
 * Reads a file, or a range of its lines, within a character budget.
 *
 * The budget is the reason this takes a range at all. A compact-profile model
 * gets 8000 characters per tool result, so a large file used to come back
 * truncated with no way to ask for the rest — the tail was simply unreachable,
 * whatever the model did. Cutting on a line boundary and naming the offset that
 * continues the file turns that dead end into a second call.
 *
 * Deliberately returns the text unnumbered: `agent_edit_file` matches on exact
 * file content, and a model that copies a line number into `oldText` produces
 * an edit that can never match.
 */
export async function readFileForModel(input: ReadFileInput, maxChars: number): Promise<string> {
	const uri = resolveUri(input.path);
	let text: string;
	try {
		text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
	} catch (err) {
		return `Erro ao ler: ${err instanceof Error ? err.message : String(err)}`;
	}

	const lines = text.split('\n');
	const total = lines.length;
	// 1-based, matching how every editor and every stack trace counts lines.
	const from = Math.max(1, Math.floor(input.offset ?? 1));
	if (from > total) {
		return `${input.path} tem ${total} linhas, então a linha ${from} não existe.`;
	}
	const requested = input.limit !== undefined ? Math.max(1, Math.floor(input.limit)) : total;
	const sliceEnd = Math.min(total, from - 1 + requested);

	const selected: string[] = [];
	let used = 0;
	let cut = false;
	for (let i = from - 1; i < sliceEnd; i++) {
		const cost = lines[i].length + 1;
		// Always take one line, or a file whose first line alone overflows the
		// budget would come back with no content at all.
		if (used + cost > maxChars && selected.length > 0) {
			cut = true;
			break;
		}
		selected.push(lines[i]);
		used += cost;
	}

	const lastShown = from - 1 + selected.length;
	const whole = from === 1 && lastShown === total;
	const header = whole
		? `${input.path} (${total} linhas)`
		: `${input.path} — linhas ${from} a ${lastShown} de ${total}`;
	const more = lastShown < total
		? `\n…[continua] Para ler a partir daqui, chame de novo com "offset": ${lastShown + 1}.`
		: '';
	const why = cut && lastShown < total ? ' O resultado foi cortado no limite de tamanho.' : '';
	return `${header}${why}\n${selected.join('\n')}${more}`;
}

class ReadFileTool implements vscode.LanguageModelTool<ReadFileInput> {
	async invoke(options: vscode.LanguageModelToolInvocationOptions<ReadFileInput>, _token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
		const text = await readFileForModel(options.input, DEFAULT_READ_BUDGET);
		return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
	}

	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<ReadFileInput>): Promise<vscode.PreparedToolInvocation> {
		return { invocationMessage: `Lendo \`${options.input.path}\`` };
	}
}

class OpenFileTool implements vscode.LanguageModelTool<OpenFileInput> {
	async invoke(options: vscode.LanguageModelToolInvocationOptions<OpenFileInput>, _token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
		return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(await openFileInEditor(options.input))]);
	}

	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<OpenFileInput>): Promise<vscode.PreparedToolInvocation> {
		return { invocationMessage: `Abrindo \`${options.input.path}\`` };
	}
}

/** Shows `path` in the editor, optionally scrolled to a line. */
export async function openFileInEditor(input: OpenFileInput): Promise<string> {
	try {
		const selection = input.line !== undefined
			? new vscode.Range(new vscode.Position(Math.max(0, input.line - 1), 0), new vscode.Position(Math.max(0, input.line - 1), 0))
			: undefined;
		// `preview: false` so opening several files in a row stacks them as tabs
		// instead of each one replacing the last.
		await vscode.window.showTextDocument(resolveUri(input.path), { preview: false, selection });
		return `Aberto no editor: ${input.path}`;
	} catch (err) {
		return `Erro ao abrir: ${err instanceof Error ? err.message : String(err)}`;
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

/**
 * Outcome of a targeted edit. `content` is absent when the edit could not be
 * applied, and `message` always explains what happened in terms the model can
 * act on.
 */
export interface IEditOutcome {
	readonly content?: string;
	readonly message: string;
}

/**
 * Replaces one exact stretch of a file, leaving everything else untouched.
 *
 * The alternative already available — rewriting the whole file with
 * `agent_write_file` — costs the model a full copy of the file in generated
 * tokens. On CPU inference that is minutes for a file of any size, and every
 * token is another chance to drop a line that was never meant to change. Here
 * the model emits only the part it wants different.
 *
 * A match that is not unique is refused rather than guessed at: replacing the
 * wrong one of three identical lines is a silent corruption, and the model can
 * always widen `oldText` until it is unambiguous.
 */
export async function computeFileEdit(input: EditFileInput): Promise<IEditOutcome> {
	const text = await readForEdit(input.path);
	if (text === undefined) {
		return { message: `Não consegui ler ${input.path}. Confirme o caminho com \`agent_find_files\` antes de editar.` };
	}
	const applied = applyReplacement(text, input, input.path);
	return applied.content === undefined
		? applied
		: { content: applied.content, message: `${applied.message} em ${input.path}.` };
}

async function readForEdit(path: string): Promise<string | undefined> {
	try {
		return Buffer.from(await vscode.workspace.fs.readFile(resolveUri(path))).toString('utf8');
	} catch {
		return undefined;
	}
}

/**
 * One replacement against text already in hand. Split out from
 * {@link computeFileEdit} so {@link computeMultiFileEdit} can chain several
 * against the same buffer without writing between them.
 *
 * `where` only ever appears in failure messages, and naming the file there is
 * what lets a batch say which of its edits went wrong.
 */
function applyReplacement(text: string, edit: EditFileInput, where: string): IEditOutcome {
	if (!edit.oldText) {
		return { message: 'O campo `oldText` veio vazio. Ele precisa ser o trecho exato que será substituído.' };
	}
	if (edit.oldText === edit.newText) {
		return { message: '`oldText` e `newText` são idênticos, então não há nada a mudar.' };
	}
	const occurrences = countOccurrences(text, edit.oldText);
	if (occurrences === 0) {
		return {
			message: `Não encontrei esse trecho em ${where}. O texto precisa bater caractere por caractere, incluindo indentação. Leia o arquivo com \`agent_read_file\` e copie o trecho de lá.`,
		};
	}
	if (occurrences > 1 && !edit.replaceAll) {
		return {
			message: `Esse trecho aparece ${occurrences} vezes em ${where}, então não dá para saber qual você quer. Inclua mais linhas em \`oldText\` até ficar único, ou passe \`"replaceAll": true\` para trocar todas.`,
		};
	}
	const content = edit.replaceAll
		? text.split(edit.oldText).join(edit.newText)
		: text.replace(edit.oldText, edit.newText);
	return { content, message: `${edit.replaceAll ? occurrences : 1} trecho(s) substituído(s)` };
}

/**
 * Applies several replacements to one file in a single call.
 *
 * The compact profile makes one tool call per turn, so a change touching three
 * places used to cost three turns of a budget of thirty-two. Each edit is
 * matched against the result of the previous one, which is what lets a batch
 * rename something and then edit a line that contains the new name.
 *
 * All or nothing: a batch that fails halfway would leave the file in a state
 * neither the model nor the user asked for, and the model cannot see the file
 * to know what happened. On failure nothing is written and the message says
 * which edit failed and why, so the next attempt is a corrected batch rather
 * than a repair job.
 */
export async function computeMultiFileEdit(input: MultiEditInput): Promise<IEditOutcome> {
	const text = await readForEdit(input.path);
	if (text === undefined) {
		return { message: `Não consegui ler ${input.path}. Confirme o caminho com \`agent_find_files\` antes de editar.` };
	}
	if (!Array.isArray(input.edits) || input.edits.length === 0) {
		return { message: 'O campo `edits` veio vazio. Ele precisa ser uma lista de {oldText, newText}.' };
	}

	let current = text;
	let changed = 0;
	for (const [index, edit] of input.edits.entries()) {
		const step = applyReplacement(current, { ...edit, path: input.path }, input.path);
		if (step.content === undefined) {
			return {
				message: `Edição ${index + 1} de ${input.edits.length} falhou, então NENHUMA foi aplicada e o arquivo segue intacto. ${step.message}`,
			};
		}
		current = step.content;
		changed++;
	}
	return { content: current, message: `${changed} edição(ões) aplicada(s) em ${input.path}.` };
}

class MultiEditTool implements vscode.LanguageModelTool<MultiEditInput> {
	async invoke(options: vscode.LanguageModelToolInvocationOptions<MultiEditInput>, _token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
		const outcome = await computeMultiFileEdit(options.input);
		if (outcome.content !== undefined) {
			await vscode.workspace.fs.writeFile(resolveUri(options.input.path), Buffer.from(outcome.content, 'utf8'));
		}
		return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(outcome.message)]);
	}

	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<MultiEditInput>): Promise<vscode.PreparedToolInvocation> {
		return { invocationMessage: `Editando \`${options.input.path}\`` };
	}
}

function countOccurrences(haystack: string, needle: string): number {
	let count = 0;
	let index = haystack.indexOf(needle);
	while (index !== -1) {
		count++;
		index = haystack.indexOf(needle, index + needle.length);
	}
	return count;
}

class EditFileTool implements vscode.LanguageModelTool<EditFileInput> {
	async invoke(options: vscode.LanguageModelToolInvocationOptions<EditFileInput>, _token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
		const outcome = await computeFileEdit(options.input);
		if (outcome.content !== undefined) {
			await vscode.workspace.fs.writeFile(resolveUri(options.input.path), Buffer.from(outcome.content, 'utf8'));
		}
		return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(outcome.message)]);
	}

	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<EditFileInput>): Promise<vscode.PreparedToolInvocation> {
		return { invocationMessage: `Editando \`${options.input.path}\`` };
	}
}

/** Ceiling on a diff handed to the model, before the profile's own budget. */
const MAX_DIFF_CHARS = 20_000;

/**
 * Working tree state, in the short form.
 *
 * Available through `agent_run_command` too, but only if the model gets the
 * flags right and then parses the result — two things a small model spends a
 * turn each getting wrong. A dedicated tool costs one call and returns
 * something already shaped for reading.
 */
export async function gitStatus(input: GitInput): Promise<string> {
	const cwd = input.path ? resolveFsPath(input.path) : workspaceRootPath();
	try {
		const { stdout } = await execFileAsync('git', ['status', '--porcelain=v1', '--branch'], { cwd, maxBuffer: 4 * 1024 * 1024 });
		const lines = stdout.split('\n').filter(Boolean);
		if (lines.length <= 1) {
			return `${lines[0] ?? ''}\nNada modificado — a árvore de trabalho está limpa.`.trim();
		}
		return lines.join('\n');
	} catch (err) {
		return gitError(err);
	}
}

/** Changes in the working tree, or those already staged. */
export async function gitDiff(input: GitDiffInput): Promise<string> {
	const cwd = workspaceRootPath();
	const args = ['diff', '--no-color'];
	if (input.staged) {
		args.push('--staged');
	}
	if (input.path) {
		args.push('--', input.path);
	}
	try {
		const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 8 * 1024 * 1024 });
		if (!stdout.trim()) {
			const what = input.staged ? 'no índice (staged)' : 'na árvore de trabalho';
			return `Nenhuma diferença ${what}${input.path ? ` para ${input.path}` : ''}.`;
		}
		return stdout.length > MAX_DIFF_CHARS
			? `${stdout.slice(0, MAX_DIFF_CHARS)}\n…[diff cortado] Use \`path\` para ver um arquivo de cada vez.`
			: stdout;
	} catch (err) {
		return gitError(err);
	}
}

function gitError(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	return /not a git repository/i.test(message)
		? 'Este workspace não é um repositório git.'
		: `Erro ao executar o git: ${message}`;
}

class GitStatusTool implements vscode.LanguageModelTool<GitInput> {
	async invoke(options: vscode.LanguageModelToolInvocationOptions<GitInput>, _token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
		return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(await gitStatus(options.input))]);
	}

	async prepareInvocation(): Promise<vscode.PreparedToolInvocation> {
		return { invocationMessage: 'Lendo o status do git' };
	}
}

class GitDiffTool implements vscode.LanguageModelTool<GitDiffInput> {
	async invoke(options: vscode.LanguageModelToolInvocationOptions<GitDiffInput>, _token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
		return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(await gitDiff(options.input))]);
	}

	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<GitDiffInput>): Promise<vscode.PreparedToolInvocation> {
		return { invocationMessage: options.input.path ? `Lendo o diff de \`${options.input.path}\`` : 'Lendo o diff do git' };
	}
}

const MAX_DIAGNOSTICS = 60;

const SEVERITY_LABEL: Record<number, string> = {
	[vscode.DiagnosticSeverity.Error]: 'erro',
	[vscode.DiagnosticSeverity.Warning]: 'aviso',
	[vscode.DiagnosticSeverity.Information]: 'info',
	[vscode.DiagnosticSeverity.Hint]: 'dica',
};

/**
 * Problems the language servers already know about, as the Problems panel
 * shows them.
 *
 * This is what closes the edit loop. Without it the only way to find out that
 * a change did not compile is to run a build through `agent_run_command` —
 * tens of seconds, sometimes minutes, and on a project with no build script no
 * way at all. The type checker has already done the work by the time the model
 * asks.
 */
export async function collectDiagnostics(input: DiagnosticsInput): Promise<string> {
	// The language server reanalyses on change, and a call made the instant an
	// edit lands reads the state from before it.
	await new Promise<void>(resolve => setTimeout(resolve, 300));

	const wanted = input.severity === 'warning'
		? [vscode.DiagnosticSeverity.Error, vscode.DiagnosticSeverity.Warning]
		: input.severity === 'all'
			? [vscode.DiagnosticSeverity.Error, vscode.DiagnosticSeverity.Warning, vscode.DiagnosticSeverity.Information, vscode.DiagnosticSeverity.Hint]
			: [vscode.DiagnosticSeverity.Error];

	const only = input.path ? resolveUri(input.path).fsPath : undefined;
	const root = workspaceRootPath();
	const rows: string[] = [];
	let total = 0;

	for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
		if (only && uri.fsPath !== only) {
			continue;
		}
		for (const d of diagnostics) {
			if (!wanted.includes(d.severity)) {
				continue;
			}
			total++;
			if (rows.length >= MAX_DIAGNOSTICS) {
				continue;
			}
			const relative = uri.fsPath.startsWith(root) ? uri.fsPath.slice(root.length).replace(/^\//, '') : uri.fsPath;
			const source = d.source ? ` [${d.source}]` : '';
			rows.push(`${relative}:${d.range.start.line + 1}: ${SEVERITY_LABEL[d.severity] ?? '?'}${source}: ${d.message.replace(/\s+/g, ' ')}`);
		}
	}

	if (total === 0) {
		const scope = input.path ? ` em ${input.path}` : ' no workspace';
		const level = input.severity === 'warning' ? 'erro ou aviso' : input.severity === 'all' ? 'problema' : 'erro';
		return `Nenhum ${level}${scope}. Atenção: só aparecem aqui os arquivos que já foram abertos ou analisados pelo servidor de linguagem — se o arquivo que você mudou não estiver nessa lista, abra-o com \`agent_open_file\` e consulte de novo.`;
	}
	const header = total > rows.length
		? `${total} problema(s), mostrando os primeiros ${rows.length}:`
		: `${total} problema(s):`;
	return `${header}\n${rows.join('\n')}`;
}

class DiagnosticsTool implements vscode.LanguageModelTool<DiagnosticsInput> {
	async invoke(options: vscode.LanguageModelToolInvocationOptions<DiagnosticsInput>, _token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
		return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(await collectDiagnostics(options.input))]);
	}

	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<DiagnosticsInput>): Promise<vscode.PreparedToolInvocation> {
		return { invocationMessage: options.input.path ? `Verificando problemas em \`${options.input.path}\`` : 'Verificando problemas do workspace' };
	}
}

/**
 * Directories holding dependencies or build output. Listing one floods the
 * agent's context with thousands of irrelevant entries, so they are surfaced in
 * a parent listing but never expanded.
 */
const IGNORED_DIR_NAMES: ReadonlySet<string> = new Set([
	'node_modules', '.git', '.hg', '.svn', 'dist', 'out', 'build', '.next',
	'.nuxt', '.cache', '.turbo', 'coverage', '__pycache__', '.venv', 'venv', 'target',
	// Committed by plenty of projects, so `.gitignore` alone does not hide them.
	'vendor', '.angular',
]);

const MAX_DIR_ENTRIES = 200;

/**
 * List a workspace directory as text for the model, skipping dependency and
 * build directories and capping the result so one call cannot exhaust the
 * agent's context.
 */
export async function listDirectory(path: string | undefined): Promise<string> {
	const folders = vscode.workspace.workspaceFolders ?? [];
	if (!path && folders.length > 1) {
		const lines = folders.map(f => `📁 ${f.name}/  (root: ${f.uri.fsPath})`);
		return `Workspace has ${folders.length} root folders. Pass the folder name as the first path segment to scope a listing (e.g. "${folders[0].name}/src").\n\n${lines.join('\n')}`;
	}

	const target = path ?? '.';
	const ignored = target.split(/[/\\]/).find(segment => IGNORED_DIR_NAMES.has(segment));
	if (ignored) {
		return `"${target}" is inside \`${ignored}\`, which holds dependencies or build output. Listing it is never useful — read the project's own sources instead.`;
	}

	let entries: [string, vscode.FileType][];
	try {
		entries = await vscode.workspace.fs.readDirectory(resolveUri(target));
	} catch (err) {
		return `Erro: ${err instanceof Error ? err.message : String(err)}`;
	}

	const lines = entries
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, kind]) => {
			if (kind !== vscode.FileType.Directory) {
				return `📄 ${name}`;
			}
			return IGNORED_DIR_NAMES.has(name) ? `📁 ${name}  (not worth listing)` : `📁 ${name}`;
		});

	if (lines.length > MAX_DIR_ENTRIES) {
		return `${lines.slice(0, MAX_DIR_ENTRIES).join('\n')}\n…and ${lines.length - MAX_DIR_ENTRIES} more entries (listing truncated).`;
	}
	return lines.join('\n') || '(empty)';
}

class ListDirTool implements vscode.LanguageModelTool<ListDirInput> {
	async invoke(options: vscode.LanguageModelToolInvocationOptions<ListDirInput>, _token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
		const text = await listDirectory(options.input.path);
		return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
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
			return noContentMatch(query);
		}
		// ripgrep missing — fall back to grep.
		try {
			const grepArgs = ['-rn', input.isRegex ? '-E' : '-F', '--', query, '.'];
			const { stdout } = await execFileAsync('grep', grepArgs, { cwd, maxBuffer: 4 * 1024 * 1024 });
			return formatSearchOutput(stdout, query);
		} catch (grepErr) {
			if (isNoMatchExit(grepErr)) {
				return noContentMatch(query);
			}
			const message = grepErr instanceof Error ? grepErr.message : String(grepErr);
			return `Erro na busca: ${message}`;
		}
	}
}

function isNoMatchExit(err: unknown): boolean {
	return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 1;
}

/**
 * Empty content search, phrased so it reads as a step rather than a verdict.
 *
 * A bare "no results" is what stalls the agent: the model treats it as proof the
 * thing is absent and stops. Naming the one thing the search did not cover — the
 * filenames themselves — is what turns the dead end back into a next call, and
 * it matters most when the query was a filename all along, which content search
 * can never match.
 */
function noContentMatch(query: string): string {
	const looksLikeFilename = /\.[A-Za-z0-9]{1,6}$/.test(query) || query.includes('/');
	const hint = looksLikeFilename
		? `"${query}" parece um nome de arquivo, e esta busca só olha DENTRO dos arquivos. Use \`agent_find_files\` com \`name\` para procurar pelo nome.`
		: 'Esta busca só olha dentro dos arquivos. Tente um termo mais curto ou parcial, procure pelo nome do arquivo com `agent_find_files`, ou liste o diretório com `agent_list_dir`.';
	return `Nenhum resultado para "${query}". Isso NÃO significa que não existe — apenas que nenhum arquivo contém esse texto exato. ${hint}`;
}

function formatSearchOutput(stdout: string, query: string): string {
	const lines = stdout.split('\n').filter(Boolean);
	if (lines.length === 0) {
		return noContentMatch(query);
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

const MAX_FILE_MATCHES = 100;

/**
 * ripgrep exclusions for the dependency and build directories, which
 * `.gitignore` alone does not cover: plenty of projects commit their `vendor/`
 * tree, and a bundled `node_modules` under `public/assets` is tracked like any
 * other asset. Searching a monorepo for `app` returned 315 files, nearly all of
 * them third-party — and against the compact profile's 8000-character cap the
 * real answer is cut off before the model ever sees it.
 */
function excludeDependencyGlobs(): string[] {
	return [...IGNORED_DIR_NAMES].flatMap(dir => ['--glob', `!**/${dir}/**`]);
}

/**
 * Finds files by name anywhere in the workspace.
 *
 * Separate from {@link searchWorkspace}, which only ever looks inside files: a
 * model asked where the routing lives reaches for the filename first, and
 * grepping the contents for `app-routing.module.ts` finds nothing whatsoever.
 * Without this the only route to a nested file was one `agent_list_dir` per
 * directory level, which a small model abandons long before it arrives.
 */
export async function findFiles(input: FindFilesInput): Promise<string> {
	const cwd = input.path ? resolveFsPath(input.path) : workspaceRootPath();
	const name = input.name?.trim();
	if (!name) {
		return 'Nome de arquivo vazio.';
	}
	// A bare name is the common case and is meant as "ends with this", so it is
	// widened to a glob. Anything already carrying glob syntax is passed through.
	const isGlob = /[*?[\]]/.test(name);
	const glob = isGlob ? name : `**/*${name}*`;
	try {
		const { stdout } = await execFileAsync('rg', ['--files', '--glob', glob, ...excludeDependencyGlobs()], { cwd, maxBuffer: 4 * 1024 * 1024 });
		const matches = formatFileMatches(stdout, name);
		return matches ?? await widenSearch(cwd, name, isGlob);
	} catch (rgErr) {
		if (isNoMatchExit(rgErr)) {
			return await widenSearch(cwd, name, isGlob);
		}
		// ripgrep missing. `find` takes a name pattern rather than a path glob, so
		// the leading `**/` is dropped and the rest matched against the basename.
		try {
			const pattern = glob.replace(/^\*\*\//, '');
			const { stdout } = await execFileAsync(
				'find', ['.', '-type', 'f', '-not', '-path', '*/node_modules/*', '-not', '-path', '*/.git/*', '-name', pattern],
				{ cwd, maxBuffer: 4 * 1024 * 1024 },
			);
			return formatFileMatches(stdout, name) ?? `Nenhum arquivo com nome parecido com "${name}".`;
		} catch (findErr) {
			const message = findErr instanceof Error ? findErr.message : String(findErr);
			return `Erro ao procurar arquivos: ${message}`;
		}
	}
}

/**
 * Second attempt for a name that matched nothing, splitting it into its parts
 * and matching any of them.
 *
 * The miss is usually a convention the caller guessed wrong rather than a file
 * that is absent — `app-routing.module.ts` in a project that calls it
 * `app.routes.ts`. Retrying here instead of reporting the miss is what keeps a
 * small model moving: told to try a shorter fragment it typically gives up and
 * answers from nothing, and the widened list contains the real file often
 * enough to be worth one extra call.
 */
async function widenSearch(cwd: string, name: string, isGlob: boolean): Promise<string> {
	const miss = `Nenhum arquivo com nome parecido com "${name}".`;
	// A glob is a deliberate pattern; taking it apart would answer a question
	// nobody asked.
	if (isGlob) {
		return miss;
	}
	const words = name
		.replace(/\.[A-Za-z0-9]{1,6}$/, '')
		.split(/[^A-Za-z0-9]+/)
		.filter(word => word.length >= 3);
	if (words.length < 2) {
		return miss;
	}
	const globs = words.flatMap(word => ['--glob', `**/*${word}*`]);
	try {
		const { stdout } = await execFileAsync('rg', ['--files', ...globs, ...excludeDependencyGlobs()], { cwd, maxBuffer: 4 * 1024 * 1024 });
		const matches = formatFileMatches(stdout, words.join('", "'));
		return matches
			? `${miss} Ampliei a busca para os termos "${words.join('", "')}" — veja se o arquivo que você procura está aqui:\n${matches}`
			: miss;
	} catch {
		return miss;
	}
}

/** Formatted match list, or `undefined` when nothing matched. */
function formatFileMatches(stdout: string, name: string): string | undefined {
	const lines = stdout.split('\n').map(l => l.replace(/^\.\//, '').trim()).filter(Boolean);
	if (lines.length === 0) {
		return undefined;
	}
	// Shallowest first. A file the project owns sits near the top of the tree,
	// while an incidental name match is usually buried inside something vendored
	// — and only the first entries survive the truncation the model reads under.
	lines.sort((a, b) => depthOf(a) - depthOf(b) || a.length - b.length || a.localeCompare(b));
	const trimmed = lines.slice(0, MAX_FILE_MATCHES);
	const header = lines.length > MAX_FILE_MATCHES
		? `${lines.length} arquivos com nome parecido com "${name}" (mostrando os primeiros ${MAX_FILE_MATCHES}):`
		: `${trimmed.length} arquivo(s) com nome parecido com "${name}":`;
	return `${header}\n${trimmed.join('\n')}`;
}

function depthOf(relativePath: string): number {
	return relativePath.split('/').length;
}

class FindFilesTool implements vscode.LanguageModelTool<FindFilesInput> {
	async invoke(options: vscode.LanguageModelToolInvocationOptions<FindFilesInput>, _token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
		const text = await findFiles(options.input);
		return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
	}

	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<FindFilesInput>): Promise<vscode.PreparedToolInvocation> {
		return { invocationMessage: `Procurando arquivo \`${options.input.name}\`` };
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

/** How long a background command is observed before the tool reports back. */
const BACKGROUND_GRACE_MS = 4000;

/** Foreground commands are killed after this so a server can never hang the agent forever. */
const FOREGROUND_TIMEOUT_MS = 120_000;

/** Max characters of early output captured from a background process. */
const BACKGROUND_OUTPUT_LIMIT = 8000;

/** How long to wait for shell integration to activate on a freshly created terminal. */
const SHELL_INTEGRATION_TIMEOUT_MS = 5000;

/** Longest command shown in a terminal's name before it is elided. */
const TERMINAL_NAME_LIMIT = 40;

/**
 * Banner shown at the top of every terminal the agent opens, so a process the
 * user did not start themselves is never mistaken for one they did. Needs CRLF
 * because it is written to the terminal directly rather than through a shell.
 */
const AGENT_TERMINAL_BANNER = [
	'\u001b[1;35m▶ Terminal do agente\u001b[0m',
	'\u001b[2mComando iniciado pelo chat do vsgo. Você pode acompanhar a saída,',
	'digitar aqui ou interromper com Ctrl+C a qualquer momento.\u001b[0m',
	'',
].join('\r\n');

/** Long-running commands started by the agent, killed when the extension deactivates. */
const backgroundProcesses = new Set<ChildProcess>();

/** Output kept per agent terminal. Older output is dropped as new output arrives. */
const TERMINAL_BUFFER_LIMIT = 64_000;

/** Most characters one `agent_read_terminal` call hands back to the model. */
const TERMINAL_READ_LIMIT = 16_000;

/** Longest an `agent_read_terminal` call may block waiting for new output. */
const MAX_TERMINAL_WAIT_MS = 30_000;

/** Terminal sessions retained. Beyond this, the oldest finished ones are forgotten. */
const MAX_RETAINED_TERMINALS = 20;

/**
 * A command the agent started in a visible terminal, plus everything written to
 * it. The shell integration stream only yields data from the moment `read()` is
 * first called, so it is drained for the whole life of the command — reading it
 * on demand later is impossible, and without this the agent would only ever see
 * the first seconds of a dev server and miss the error that follows.
 */
interface IAgentTerminal {
	readonly id: string;
	readonly terminal: vscode.Terminal;
	readonly command: string;
	/** Raw tail of the output, capped at {@link TERMINAL_BUFFER_LIMIT}. */
	buffer: string;
	/** Characters ever written, so a read can tell how much it missed. */
	written: number;
	/** Absolute offset already handed to the model. */
	delivered: number;
	exited: boolean;
	exitCode: number | undefined;
	/** The user closed the terminal; it must not be disposed again. */
	closed: boolean;
	/** Parked `agent_read_terminal` calls, woken by new output or by the exit. */
	readonly waiters: Set<() => void>;
	readonly disposables: vscode.Disposable[];
}

/** Terminals opened for background commands, closed when the extension deactivates. */
const agentTerminals = new Map<string, IAgentTerminal>();

let nextTerminalId = 1;

/**
 * Escape sequences the shell writes for colour, cursor control and OSC titles,
 * plus stray control characters. They are worthless to the model and would be
 * paid for in tokens. Tab, newline and carriage return are deliberately kept.
 */
const ANSI_ESCAPES = /\u001b\[[0-9;?]*[ -\/]*[@-~]|\u001b\][^\u0007]*?(?:\u0007|\u001b\\)|\u001b[()][A-B0-2]|[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;

function stripAnsi(text: string): string {
	return text.replace(ANSI_ESCAPES, '');
}

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Append terminal output to its rolling buffer. Escape sequences are kept raw
 * here and stripped on read, so a sequence split across two chunks is not turned
 * into visible garbage.
 */
function appendTerminalOutput(record: IAgentTerminal, chunk: string): void {
	if (!chunk) {
		return;
	}
	record.written += chunk.length;
	record.buffer = (record.buffer + chunk).slice(-TERMINAL_BUFFER_LIMIT);
	wakeTerminalWaiters(record);
}

function wakeTerminalWaiters(record: IAgentTerminal): void {
	for (const wake of [...record.waiters]) {
		wake();
	}
}

function markTerminalExited(record: IAgentTerminal, exitCode: number | undefined): void {
	if (record.exited) {
		return;
	}
	record.exited = true;
	record.exitCode = exitCode;
	wakeTerminalWaiters(record);
}

/**
 * Hand back everything written since the previous read. Output lost to the
 * buffer cap is reported rather than silently skipped, so the model never treats
 * a gap as "nothing happened".
 */
function readTerminalOutput(record: IAgentTerminal): { text: string; skipped: number } {
	const bufferStart = record.written - record.buffer.length;
	const from = Math.max(record.delivered, bufferStart);
	const skipped = Math.max(0, bufferStart - record.delivered);
	record.delivered = record.written;

	let text = record.buffer.slice(from - bufferStart);
	if (text.length > TERMINAL_READ_LIMIT) {
		text = text.slice(-TERMINAL_READ_LIMIT);
	}
	return { text: stripAnsi(text).trim(), skipped };
}

/** Park until there is something new to read, the command ends, or time runs out. */
async function waitForTerminalOutput(record: IAgentTerminal, ms: number, token: vscode.CancellationToken): Promise<void> {
	if (record.written > record.delivered || record.exited || record.closed || token.isCancellationRequested) {
		return;
	}
	await new Promise<void>(resolve => {
		const finish = () => {
			record.waiters.delete(finish);
			clearTimeout(timer);
			cancelSub.dispose();
			resolve();
		};
		const timer = setTimeout(finish, ms);
		const cancelSub = token.onCancellationRequested(finish);
		record.waiters.add(finish);
	});
}

/** Describes what the terminal is doing right now, for the model. */
function terminalStatus(record: IAgentTerminal): string {
	if (record.exited) {
		return record.exitCode !== undefined ? `finished with exit code ${record.exitCode}` : 'finished with an unknown exit code';
	}
	return record.closed ? 'the user closed this terminal; the command is gone' : 'still running';
}

/** Drops the oldest finished sessions once too many have piled up. */
function pruneAgentTerminals(): void {
	for (const [id, record] of agentTerminals) {
		if (agentTerminals.size <= MAX_RETAINED_TERMINALS) {
			return;
		}
		if (record.exited || record.closed) {
			agentTerminals.delete(id);
		}
	}
}

/**
 * Wait for a terminal's shell integration to come up. Resolves `undefined` when
 * the shell never activates it — a broken or unsupported shell profile — so the
 * caller can fall back to a captured subprocess.
 */
async function waitForShellIntegration(terminal: vscode.Terminal): Promise<vscode.TerminalShellIntegration | undefined> {
	if (terminal.shellIntegration) {
		return terminal.shellIntegration;
	}
	return new Promise(resolve => {
		const disposables: vscode.Disposable[] = [];
		const finish = (result: vscode.TerminalShellIntegration | undefined) => {
			for (const disposable of disposables) {
				disposable.dispose();
			}
			resolve(result);
		};
		const timer = setTimeout(() => finish(undefined), SHELL_INTEGRATION_TIMEOUT_MS);
		disposables.push({ dispose: () => clearTimeout(timer) });
		disposables.push(vscode.window.onDidChangeTerminalShellIntegration(e => {
			if (e.terminal === terminal) {
				finish(e.shellIntegration);
			}
		}));
	});
}

/**
 * Run a long-running command in a real terminal so the user can watch it, take
 * it over, or stop it. Returns the output seen during the grace window, or
 * `undefined` when shell integration is unavailable and the output could not be
 * read back — the caller then falls back to a captured subprocess.
 */
async function runInTerminal(command: string, cwd: string): Promise<string | undefined> {
	const label = command.length > TERMINAL_NAME_LIMIT ? `${command.slice(0, TERMINAL_NAME_LIMIT)}…` : command;
	const terminal = vscode.window.createTerminal({
		name: `Agente: ${label}`,
		cwd,
		iconPath: new vscode.ThemeIcon('robot'),
		color: new vscode.ThemeColor('terminal.ansiMagenta'),
		// Written straight to the terminal before the command runs, so it never
		// reaches the model's output stream — it is a banner for the user only.
		message: AGENT_TERMINAL_BANNER,
		// The process is gone after a reload, so there is nothing to restore.
		isTransient: true,
	});
	terminal.show(true);

	const integration = await waitForShellIntegration(terminal);
	if (!integration) {
		terminal.dispose();
		return undefined;
	}

	const record: IAgentTerminal = {
		id: `term-${nextTerminalId++}`,
		terminal,
		command,
		buffer: '',
		written: 0,
		delivered: 0,
		exited: false,
		exitCode: undefined,
		closed: false,
		waiters: new Set(),
		disposables: [],
	};
	agentTerminals.set(record.id, record);
	pruneAgentTerminals();

	// All synchronous: `read` only sees data written after its first call, so
	// nothing may await between executing the command and starting the stream.
	const execution = integration.executeCommand(command);
	const stream = execution.read();

	const endSub = vscode.window.onDidEndTerminalShellExecution(e => {
		if (e.execution === execution) {
			markTerminalExited(record, e.exitCode);
		}
	});
	record.disposables.push(endSub);

	// Drained for the whole life of the command, not just the grace window: this
	// buffer is the only copy the agent can still read afterwards.
	const drain = (async () => {
		try {
			for await (const chunk of stream) {
				appendTerminalOutput(record, chunk);
			}
		} catch {
			// A terminal killed mid-stream is a normal end, not an error to report.
		}
		// A closed stream means the command is over even when the shell never
		// reported an exit code (a Ctrl+C, or a shell integration script that
		// misbehaves), so it must not be announced as still running.
		markTerminalExited(record, record.exitCode);
	})();

	const first = await Promise.race([drain.then(() => 'ended' as const), delay(BACKGROUND_GRACE_MS).then(() => 'timeout' as const)]);
	if (first === 'ended') {
		// The stream closes when the command finishes, which can beat the end
		// event by a tick. Give that event a moment so the exit code is reported
		// rather than mistaking a crashed server for a running one.
		for (let i = 0; i < 10 && record.exitCode === undefined; i++) {
			await delay(20);
		}
	}

	const { text } = readTerminalOutput(record);
	const seen = text || '(no output)';
	const where = `Terminal "${terminal.name}" (id: ${record.id})`;
	if (record.exited) {
		const code = record.exitCode !== undefined ? `code ${record.exitCode}` : 'an unknown exit code';
		return `The command already finished with ${code} — nothing is running now. ${where} stays open for the user.\n\n${seen}`;
	}
	return `Started in ${where}, where the user can watch and stop it, and still running after ${BACKGROUND_GRACE_MS / 1000}s.\n` +
		`This is only the output so far. Call agent_read_terminal with terminalId "${record.id}" to see what it prints next — a server that logs "ready" can still fail seconds later.\n\nOutput so far:\n\n${seen}`;
}

/**
 * Start a long-running command (dev server, watcher) without waiting for it to
 * exit. The process is observed briefly so the model learns the port it bound to
 * or the error it died from, then left running in its own process group.
 */
async function runInBackground(command: string, cwd: string): Promise<string> {
	const child = spawn(command, { cwd, shell: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
	backgroundProcesses.add(child);

	let output = '';
	const capture = (chunk: Buffer) => {
		if (output.length < BACKGROUND_OUTPUT_LIMIT) {
			output += chunk.toString();
		}
	};
	child.stdout?.on('data', capture);
	child.stderr?.on('data', capture);

	const exit = await new Promise<{ code: number | null } | undefined>(resolve => {
		const timer = setTimeout(() => resolve(undefined), BACKGROUND_GRACE_MS);
		child.once('exit', code => {
			clearTimeout(timer);
			resolve({ code });
		});
		child.once('error', err => {
			clearTimeout(timer);
			output += `\n${err.message}`;
			resolve({ code: null });
		});
	});

	const seen = output.trim() || '(no output)';
	if (exit) {
		backgroundProcesses.delete(child);
		return `The command exited immediately with code ${exit.code ?? 'unknown'} — nothing is running now.\n\n${seen}`;
	}
	child.once('exit', () => backgroundProcesses.delete(child));
	child.unref();
	return `Started in the background (pid ${child.pid}) and still running after ${BACKGROUND_GRACE_MS / 1000}s.\nOutput so far:\n\n${seen}`;
}

/** Stop everything the agent left running: captured subprocesses and terminals. */
function stopBackgroundWork(): void {
	for (const record of agentTerminals.values()) {
		for (const disposable of record.disposables) {
			disposable.dispose();
		}
		wakeTerminalWaiters(record);
		if (!record.closed) {
			record.terminal.dispose();
		}
	}
	agentTerminals.clear();
	killBackgroundProcesses();
}

/** Kill every background command started by the agent, including its child processes. */
function killBackgroundProcesses(): void {
	for (const child of backgroundProcesses) {
		try {
			// `detached` puts the shell in its own group, so the negative pid takes
			// down the server and anything it spawned rather than just the shell.
			if (child.pid !== undefined) {
				process.kill(-child.pid, 'SIGTERM');
			}
		} catch {
			// Already gone — nothing to clean up.
		}
	}
	backgroundProcesses.clear();
}

class RunCommandTool implements vscode.LanguageModelTool<RunCommandInput> {
	async invoke(options: vscode.LanguageModelToolInvocationOptions<RunCommandInput>, _token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
		const cwd = options.input.cwd ? resolveFsPath(options.input.cwd) : workspaceRootPath();
		if (options.input.background) {
			// A visible terminal is preferred so the user can watch and stop the
			// process; without shell integration its output cannot be read back,
			// so a captured subprocess takes over.
			const text = await runInTerminal(options.input.command, cwd) ?? await runInBackground(options.input.command, cwd);
			return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
		}
		try {
			const { stdout, stderr } = await execAsync(options.input.command, { cwd, maxBuffer: 4 * 1024 * 1024, timeout: FOREGROUND_TIMEOUT_MS });
			const out = [stdout, stderr].filter(Boolean).join('\n').trim() || '(sem saída)';
			return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(out)]);
		} catch (err) {
			const killed = typeof err === 'object' && err !== null && (err as { killed?: boolean }).killed === true;
			if (killed) {
				return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
					`The command was still running after ${FOREGROUND_TIMEOUT_MS / 1000}s and was killed. If it is a server, watcher, or anything else that does not exit on its own, call this tool again with "background": true.`,
				)]);
			}
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

/**
 * Reads back what a terminal the agent opened has printed since the last read.
 * Without this the agent only ever sees the first seconds of a long-running
 * command and cannot tell a server that started from one that started and then
 * crashed.
 */
class ReadTerminalTool implements vscode.LanguageModelTool<ReadTerminalInput> {
	async invoke(options: vscode.LanguageModelToolInvocationOptions<ReadTerminalInput>, token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
		const { terminalId } = options.input;
		const record = terminalId ? agentTerminals.get(terminalId) : latestAgentTerminal();
		if (!record) {
			const known = [...agentTerminals.values()].map(t => `${t.id} (${t.command})`);
			const text = known.length > 0
				? `No terminal with id "${terminalId}". Open terminals: ${known.join(', ')}.`
				: 'You have not started any command in a terminal yet. Use agent_run_command with "background": true first.';
			return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
		}

		const waitMs = Math.min(Math.max((options.input.waitSeconds ?? 0) * 1000, 0), MAX_TERMINAL_WAIT_MS);
		if (waitMs > 0) {
			await waitForTerminalOutput(record, waitMs, token);
		}

		const { text, skipped } = readTerminalOutput(record);
		const lines = [`Terminal "${record.terminal.name}" (id: ${record.id}) running \`${record.command}\` — ${terminalStatus(record)}.`];
		if (skipped > 0) {
			lines.push(`[${skipped} characters of older output were dropped before this point]`);
		}
		lines.push('', text || '[no new output since your last read]');
		return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(lines.join('\n'))]);
	}

	async prepareInvocation(_options: vscode.LanguageModelToolInvocationPrepareOptions<ReadTerminalInput>): Promise<vscode.PreparedToolInvocation> {
		return { invocationMessage: 'Lendo a saída do terminal' };
	}
}

/** The terminal the agent started most recently, which is what a bare read means. */
function latestAgentTerminal(): IAgentTerminal | undefined {
	let latest: IAgentTerminal | undefined;
	for (const record of agentTerminals.values()) {
		latest = record;
	}
	return latest;
}

/**
 * Whether the agent may touch files outside the open folders. Off by default:
 * an absolute path is far more often a mistaken or injected one than a real
 * need, and nothing else in the agent's path checks for it.
 */
function allowsPathsOutsideWorkspace(): boolean {
	return vscode.workspace.getConfiguration('agent-chat').get<boolean>('allowPathsOutsideWorkspace', false);
}

/**
 * Reject a path that lands outside every workspace root. This is the one choke
 * point the chat handler, the registered tools and the sub-agent all share, so
 * it covers reading, writing and listing alike.
 *
 * The check is lexical: it stops absolute paths and `../` escapes, but still
 * follows a symlink inside the workspace that points outside. Closing that would
 * need `realpath` on every call, which cannot run synchronously here.
 */
function assertInsideWorkspace(fsPath: string, original: string): void {
	if (allowsPathsOutsideWorkspace()) {
		return;
	}
	const folders = vscode.workspace.workspaceFolders ?? [];
	if (folders.length === 0) {
		return;
	}
	const normalize = (value: string) => {
		const resolved = resolve(value);
		return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
	};
	const target = normalize(fsPath);
	const inside = folders.some(folder => {
		const root = normalize(folder.uri.fsPath);
		return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);
	});
	if (!inside) {
		throw new Error(
			`Path "${original}" is outside the workspace. Only files inside the open folders can be accessed. ` +
			'If this is genuinely needed, the user must enable "agent-chat.allowPathsOutsideWorkspace".',
		);
	}
}

export function resolveUri(p: string): vscode.Uri {
	const uri = resolveUriUnchecked(p);
	assertInsideWorkspace(uri.fsPath, p);
	return uri;
}

function resolveUriUnchecked(p: string): vscode.Uri {
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
	const resolved = resolveFsPathUnchecked(p);
	assertInsideWorkspace(resolved, p);
	return resolved;
}

function resolveFsPathUnchecked(p: string): string {
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
