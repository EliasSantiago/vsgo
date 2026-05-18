/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

interface ReadFileInput { path: string; }
interface WriteFileInput { path: string; content: string; }
interface ListDirInput { path?: string; }
interface RunCommandInput { command: string; cwd?: string; }

export function registerTools(): vscode.Disposable {
	const subs: vscode.Disposable[] = [];
	subs.push(vscode.lm.registerTool('agent_read_file', new ReadFileTool()));
	subs.push(vscode.lm.registerTool('agent_write_file', new WriteFileTool()));
	subs.push(vscode.lm.registerTool('agent_list_dir', new ListDirTool()));
	subs.push(vscode.lm.registerTool('agent_run_command', new RunCommandTool()));
	return vscode.Disposable.from(...subs);
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
		return { invocationMessage: `Reading \`${options.input.path}\`` };
	}
}

class WriteFileTool implements vscode.LanguageModelTool<WriteFileInput> {
	async invoke(options: vscode.LanguageModelToolInvocationOptions<WriteFileInput>, _token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
		const uri = resolveUri(options.input.path);
		const data = Buffer.from(options.input.content, 'utf8');
		await vscode.workspace.fs.writeFile(uri, data);
		return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(`Wrote ${data.byteLength} bytes to ${options.input.path}`)]);
	}

	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<WriteFileInput>): Promise<vscode.PreparedToolInvocation> {
		return {
			invocationMessage: `Writing \`${options.input.path}\``,
			confirmationMessages: {
				title: 'Write file',
				message: new vscode.MarkdownString(`The assistant wants to write to \`${options.input.path}\`. Continue?`),
			},
		};
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
		return { invocationMessage: `Listing \`${options.input.path ?? '.'}\`` };
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
			const out = [stdout, stderr].filter(Boolean).join('\n').trim() || '(no output)';
			return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(out)]);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(`Command failed: ${message}`)]);
		}
	}

	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<RunCommandInput>): Promise<vscode.PreparedToolInvocation> {
		const danger = classifyCommand(options.input.command);
		if (danger) {
			const message = new vscode.MarkdownString(
				`### ⚠️ Dangerous command\n\nThe assistant wants to run:\n\n\`\`\`\n${options.input.command}\n\`\`\`\n\n**Reason flagged:** ${danger.reason}\n\nThis operation can be destructive or irreversible. Continue only if you fully understand the effect.`,
			);
			message.supportThemeIcons = true;
			return {
				invocationMessage: `⚠️ Running dangerous command \`${options.input.command}\``,
				confirmationMessages: {
					title: 'Dangerous shell command',
					message,
				},
			};
		}
		return {
			invocationMessage: `Running \`${options.input.command}\``,
			confirmationMessages: {
				title: 'Run shell command',
				message: new vscode.MarkdownString(`The assistant wants to run:\n\n\`\`\`\n${options.input.command}\n\`\`\`\n\nContinue?`),
			},
		};
	}
}

function resolveUri(p: string): vscode.Uri {
	if (p.startsWith('/') || /^[A-Za-z]:[/\\]/.test(p)) {
		return vscode.Uri.file(p);
	}
	const folders = vscode.workspace.workspaceFolders ?? [];
	if (folders.length === 0) {
		throw new Error('No workspace folder is open');
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
