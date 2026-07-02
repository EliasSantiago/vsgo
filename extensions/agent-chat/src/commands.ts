/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import { ByokStorage, ProviderId, PROVIDER_LABELS, PROVIDER_KEY_HINTS } from './byokStorage.js';
import { RulesLoader } from './rules/rulesLoader.js';
import { MemoryEntry, MemoryService, sanitizeSlug } from './memory/memoryService.js';
import { AgentSessionsService } from './agentsWindow/agentSessionsService.js';
import { AgentSessionsStore } from './agentsWindow/agentSessionsStore.js';
import { IAgentSession } from './agentsWindow/agentSession.js';
import { applyFinding, BugBotProvider } from './bugBot/bugBotProvider.js';
import { collectChanges } from './splitPR/changes.js';
import { suggestGroups, SuggestedGroup } from './splitPR/groupClassifier.js';
import { SplitService } from './splitPR/splitService.js';

export function registerCommands(
	storage: ByokStorage,
	rulesLoader: RulesLoader,
	memoryService: MemoryService,
	agentSessionsStore: AgentSessionsStore,
	agentSessionsService: AgentSessionsService,
	bugBotProvider: BugBotProvider,
): vscode.Disposable {
	const subs: vscode.Disposable[] = [];

	subs.push(vscode.commands.registerCommand('agent-chat.reloadRules', async () => {
		const count = await rulesLoader.reload();
		vscode.window.showInformationMessage(`Agent rules reloaded (${count} rule${count === 1 ? '' : 's'}).`);
	}));

	subs.push(vscode.commands.registerCommand('agent-chat.addMemory', async () => {
		if (!memoryService.primaryFolder()) {
			vscode.window.showWarningMessage('Open a folder to use Agent Memory.');
			return;
		}
		const title = await vscode.window.showInputBox({
			title: 'New memory — title',
			placeHolder: 'e.g. Build commands',
			ignoreFocusOut: true,
		});
		if (!title) {
			return;
		}
		const hook = await vscode.window.showInputBox({
			title: 'New memory — one-line hook',
			placeHolder: 'Short description that helps future-you remember what this is',
			ignoreFocusOut: true,
		}) ?? '';
		const slug = sanitizeSlug(title);
		const body = `# ${title}\n\n`;
		const entry = await memoryService.add(slug, title, hook, body);
		const doc = await vscode.workspace.openTextDocument(entry.file);
		await vscode.window.showTextDocument(doc);
	}));

	subs.push(vscode.commands.registerCommand('agent-chat.forgetMemory', async (target?: MemoryEntry) => {
		let entry = target;
		if (!entry) {
			const all = await memoryService.list();
			if (all.length === 0) {
				vscode.window.showInformationMessage('No memories to forget.');
				return;
			}
			const pick = await vscode.window.showQuickPick(
				all.map(e => ({ label: e.title, description: e.hook, entry: e })),
				{ placeHolder: 'Forget which memory?', ignoreFocusOut: true },
			);
			entry = pick?.entry;
		}
		if (!entry) {
			return;
		}
		const confirm = await vscode.window.showWarningMessage(
			`Forget "${entry.title}"? This deletes the memory file and removes the entry from MEMORY.md.`,
			{ modal: true },
			'Forget',
		);
		if (confirm !== 'Forget') {
			return;
		}
		await memoryService.forget(entry.slug);
		vscode.window.showInformationMessage(`Forgot "${entry.title}".`);
	}));

	subs.push(vscode.commands.registerCommand('agent-chat.newAgent', async () => {
		if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
			vscode.window.showWarningMessage('Open a folder before creating an agent session.');
			return;
		}
		const name = await vscode.window.showInputBox({
			title: 'New agent — name',
			placeHolder: 'e.g. Refactor auth module',
			ignoreFocusOut: true,
		});
		if (!name) {
			return;
		}
		const defaultBranch = `agent/${slugify(name)}-${shortToken()}`;
		const branch = await vscode.window.showInputBox({
			title: 'New agent — branch name',
			value: defaultBranch,
			ignoreFocusOut: true,
			validateInput: v => /^[\w./\-_]+$/.test(v) ? null : 'Branch name contains invalid characters.',
		});
		if (!branch) {
			return;
		}
		const prompt = await vscode.window.showInputBox({
			title: 'New agent — initial task',
			placeHolder: 'Describe what the agent should do',
			ignoreFocusOut: true,
		}) ?? '';
		try {
			const session = await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: `Creating agent "${name}"…` },
				() => agentSessionsService.create({ name, branch, prompt }),
			);
			vscode.window.showInformationMessage(`Agent "${session.name}" created at ${session.worktreePath}.`);
		} catch (err) {
			vscode.window.showErrorMessage(`Failed to create agent: ${err instanceof Error ? err.message : String(err)}`);
		}
	}));

	subs.push(vscode.commands.registerCommand('agent-chat.promoteAgent', async (session?: IAgentSession) => {
		const target = session ?? await pickSession(agentSessionsStore, 'Promote which agent to foreground?');
		if (!target) {
			return;
		}
		await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target.worktreePath), { forceNewWindow: false });
	}));

	subs.push(vscode.commands.registerCommand('agent-chat.deleteAgent', async (session?: IAgentSession) => {
		const target = session ?? await pickSession(agentSessionsStore, 'Delete which agent?');
		if (!target) {
			return;
		}
		const confirm = await vscode.window.showWarningMessage(
			`Delete agent "${target.name}"? This removes the worktree at ${target.worktreePath}. The branch will remain.`,
			{ modal: true },
			'Delete',
		);
		if (confirm !== 'Delete') {
			return;
		}
		await agentSessionsService.delete(target.id);
	}));

	subs.push(vscode.commands.registerCommand('agent-chat.refreshAgentDiff', async (session?: IAgentSession) => {
		const target = session ?? await pickSession(agentSessionsStore, 'Refresh diff for which agent?');
		if (!target) {
			return;
		}
		await agentSessionsService.refreshDiff(target.id);
	}));

	subs.push(vscode.commands.registerCommand('agent-chat.bugBot.applyFix', async (thread?: vscode.CommentThread) => {
		if (!thread) {
			return;
		}
		const finding = bugBotProvider.findingForThread(thread);
		if (!finding || !finding.fix) {
			vscode.window.showInformationMessage('This finding has no suggested fix.');
			return;
		}
		const ok = await applyFinding(thread.uri, finding);
		if (ok) {
			thread.dispose();
		} else {
			vscode.window.showWarningMessage('Failed to apply the suggested fix.');
		}
	}));

	subs.push(vscode.commands.registerCommand('agent-chat.bugBot.dismiss', (thread?: vscode.CommentThread) => {
		thread?.dispose();
	}));

	subs.push(vscode.commands.registerCommand('agent-chat.bugBot.toggle', async () => {
		const cfg = vscode.workspace.getConfiguration();
		const current = cfg.get<boolean>('agent-chat.bugBot.enabled', false);
		await cfg.update('agent-chat.bugBot.enabled', !current, vscode.ConfigurationTarget.Global);
		vscode.window.showInformationMessage(`Bug Bot ${!current ? 'enabled' : 'disabled'}.`);
	}));

	subs.push(vscode.commands.registerCommand('agent-chat.splitChanges', () => runSplitChanges()));

	subs.push(vscode.commands.registerCommand('agent-chat.addApiKey', async (preselected?: ProviderId) => {
		const provider = preselected ?? await pickProvider('Add or update API key for which provider?');
		if (!provider) {
			return;
		}
		const existing = await storage.get(provider);
		const value = await vscode.window.showInputBox({
			title: `${PROVIDER_LABELS[provider]} — API key`,
			placeHolder: PROVIDER_KEY_HINTS[provider],
			prompt: provider === 'ollama'
				? 'Base URL of the Ollama server (default: http://localhost:11434)'
				: 'Paste the API key (stored in OS keychain via VS Code SecretStorage)',
			password: provider !== 'ollama',
			value: existing,
			ignoreFocusOut: true,
		});
		if (value === undefined) {
			return;
		}
		if (value.trim() === '') {
			await storage.delete(provider);
			vscode.window.showInformationMessage(`${PROVIDER_LABELS[provider]} key removed.`);
			return;
		}
		await storage.set(provider, value.trim());
		vscode.window.showInformationMessage(`${PROVIDER_LABELS[provider]} key saved.`);
	}));

	subs.push(vscode.commands.registerCommand('agent-chat.removeApiKey', async () => {
		const configured = await storage.list();
		if (configured.length === 0) {
			vscode.window.showInformationMessage('No API keys are currently configured.');
			return;
		}
		const provider = await pickProvider('Remove which provider key?', configured);
		if (!provider) {
			return;
		}
		await storage.delete(provider);
		vscode.window.showInformationMessage(`${PROVIDER_LABELS[provider]} key removed.`);
	}));

	subs.push(vscode.commands.registerCommand('agent-chat.listApiKeys', async () => {
		const configured = await storage.list();
		if (configured.length === 0) {
			const choice = await vscode.window.showInformationMessage(
				'No API keys configured yet.',
				'Add Key...',
			);
			if (choice === 'Add Key...') {
				await vscode.commands.executeCommand('agent-chat.addApiKey');
			}
			return;
		}
		const message = configured.map(p => `• ${PROVIDER_LABELS[p]}`).join('\n');
		vscode.window.showInformationMessage(`Configured providers:\n${message}`, { modal: true });
	}));

	return vscode.Disposable.from(...subs);
}

async function pickProvider(placeHolder: string, allow?: readonly ProviderId[]): Promise<ProviderId | undefined> {
	const all: ProviderId[] = ['anthropic', 'openai', 'gemini', 'ollama', 'mistral', 'groq', 'deepseek', 'xai'];
	const list = allow ?? all;
	const items = list.map(p => ({ label: PROVIDER_LABELS[p], description: PROVIDER_KEY_HINTS[p], id: p }));
	const picked = await vscode.window.showQuickPick(items, { placeHolder, ignoreFocusOut: true });
	return picked?.id;
}

async function pickSession(store: AgentSessionsStore, placeHolder: string): Promise<IAgentSession | undefined> {
	const all = store.all();
	if (all.length === 0) {
		vscode.window.showInformationMessage('No agent sessions yet. Create one from the Agents view.');
		return undefined;
	}
	const items = all.map(s => ({ label: s.name, description: `${s.branch} · ${s.status}`, session: s }));
	const picked = await vscode.window.showQuickPick(items, { placeHolder, ignoreFocusOut: true });
	return picked?.session;
}

function slugify(input: string): string {
	return input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 40) || 'agent';
}

function shortToken(): string {
	return Math.random().toString(36).slice(2, 6);
}

async function runSplitChanges(): Promise<void> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		vscode.window.showWarningMessage('Open a folder before running split.');
		return;
	}
	const repoPath = folder.uri.fsPath;

	const changes = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: 'Inspecting working tree…' },
		() => collectChanges(repoPath),
	);
	if (changes.length === 0) {
		vscode.window.showInformationMessage('Working tree is clean — nothing to split.');
		return;
	}
	if (changes.length === 1) {
		vscode.window.showInformationMessage('Only one file changed — no need to split.');
		return;
	}

	const models = await vscode.lm.selectChatModels();
	if (models.length === 0) {
		vscode.window.showWarningMessage('No language model is configured. Add an API key first.');
		return;
	}
	const model = models[0];

	const source = new vscode.CancellationTokenSource();
	let groups: SuggestedGroup[] = [];
	try {
		groups = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: 'Asking the model to group changes…', cancellable: true },
			(_p, t) => {
				t.onCancellationRequested(() => source.cancel());
				return suggestGroups(changes, model, source.token);
			},
		);
	} finally {
		source.dispose();
	}

	if (groups.length === 0) {
		vscode.window.showWarningMessage('The model returned no usable groups. Aborting.');
		return;
	}

	const reviewed = await reviewGroups(groups);
	if (!reviewed) {
		return;
	}

	const baseBranch = await pickBaseBranch(repoPath);
	if (!baseBranch) {
		return;
	}

	const pushChoice = await vscode.window.showQuickPick(
		[
			{ label: 'No', detail: 'Create branches and commits locally only.', push: false, pr: false },
			{ label: 'Push only', detail: 'Push each branch to origin.', push: true, pr: false },
			{ label: 'Push and open PRs', detail: 'Push each branch and call `gh pr create`.', push: true, pr: true },
		],
		{ placeHolder: 'Push branches after committing?', ignoreFocusOut: true },
	);
	if (!pushChoice) {
		return;
	}

	const service = new SplitService();
	const outcomes = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: 'Splitting changes…' },
		() => service.execute(reviewed, { repoPath, baseBranch, push: pushChoice.push, createPullRequest: pushChoice.pr }),
	);

	const lines = outcomes.map(o => {
		if (o.error) {
			return `❌ ${o.branch}: ${o.error}`;
		}
		const parts = [`✅ ${o.branch}`];
		if (o.commit) {
			parts.push(`(${o.commit.slice(0, 7)})`);
		}
		if (o.pushed) {
			parts.push('pushed');
		}
		if (o.pullRequestUrl) {
			parts.push(o.pullRequestUrl);
		}
		return parts.join(' ');
	});
	const summary = lines.join('\n');
	const successCount = outcomes.filter(o => !o.error).length;
	const action = await vscode.window.showInformationMessage(
		`Split complete: ${successCount}/${outcomes.length} groups.`,
		{ modal: true, detail: summary },
		'Open Log',
	);
	if (action === 'Open Log') {
		await vscode.commands.executeCommand('workbench.action.output.toggleOutput');
	}
}

async function reviewGroups(groups: SuggestedGroup[]): Promise<SuggestedGroup[] | undefined> {
	const items = groups.map(g => ({
		label: g.title,
		description: g.suggestedBranch,
		detail: `${g.files.length} file(s) · ${g.description}`,
		picked: true,
		group: g,
	}));
	const picked = await vscode.window.showQuickPick(items, {
		title: `Review suggested groups (${groups.length})`,
		placeHolder: 'Toggle which groups to commit. Esc cancels.',
		canPickMany: true,
		ignoreFocusOut: true,
	});
	if (!picked || picked.length === 0) {
		return undefined;
	}
	return picked.map(p => p.group);
}

async function pickBaseBranch(repoPath: string): Promise<string | undefined> {
	const execAsync = promisify(exec);
	try {
		const { stdout } = await execAsync('git symbolic-ref refs/remotes/origin/HEAD --short', { cwd: repoPath });
		const defaultBranch = stdout.trim().replace(/^origin\//, '');
		const picked = await vscode.window.showInputBox({
			title: 'Base branch',
			value: defaultBranch,
			ignoreFocusOut: true,
			validateInput: v => /^[\w./\-_]+$/.test(v) ? null : 'Branch name contains invalid characters.',
		});
		return picked || undefined;
	} catch {
		return await vscode.window.showInputBox({
			title: 'Base branch',
			placeHolder: 'main',
			value: 'main',
			ignoreFocusOut: true,
		});
	}
}
