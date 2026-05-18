/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ByokStorage } from './byokStorage.js';
import { registerAllProviders } from './providers/index.js';
import { registerCommands } from './commands.js';
import { registerTools } from './tools.js';
import { createChatHandler } from './chatHandler.js';
import { RulesLoader } from './rules/rulesLoader.js';
import { MemoryService } from './memory/memoryService.js';
import { MemoryTreeProvider } from './memory/memoryView.js';
import { AgentSessionsStore } from './agentsWindow/agentSessionsStore.js';
import { AgentSessionsService } from './agentsWindow/agentSessionsService.js';
import { AgentSessionsTreeProvider } from './agentsWindow/agentSessionsView.js';
import { WorktreeService } from './agentsWindow/worktreeService.js';
import { BugBotProvider } from './bugBot/bugBotProvider.js';
import { BugBotService } from './bugBot/bugBotService.js';
import { initLogger, log } from './logger.js';

const PARTICIPANT_ID = 'vscode.agent-chat.default';

export function activate(context: vscode.ExtensionContext): void {
	const channel = initLogger();
	context.subscriptions.push(channel);
	log('activate: starting');

	const storage = new ByokStorage(context.secrets);
	const rulesLoader = new RulesLoader();
	const memoryService = new MemoryService();
	const memoryTree = new MemoryTreeProvider(memoryService);

	const worktreeService = new WorktreeService();
	const agentSessionsStore = new AgentSessionsStore(context.globalState);
	const agentSessionsService = new AgentSessionsService(agentSessionsStore, worktreeService);
	const agentSessionsTree = new AgentSessionsTreeProvider(agentSessionsStore);

	const bugBotProvider = new BugBotProvider();
	const bugBotService = new BugBotService(bugBotProvider);

	const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, createChatHandler(rulesLoader, memoryService));
	participant.iconPath = new vscode.ThemeIcon('sparkle');

	const memoryView = vscode.window.createTreeView('agentChatMemory', { treeDataProvider: memoryTree, showCollapseAll: false });
	const agentsView = vscode.window.createTreeView('agentChatSessions', { treeDataProvider: agentSessionsTree, showCollapseAll: false });

	const diffRefreshTimer = setInterval(async () => {
		for (const session of agentSessionsStore.all()) {
			try {
				await agentSessionsService.refreshDiff(session.id);
			} catch {
				// best-effort
			}
		}
	}, 15000);

	context.subscriptions.push(
		participant,
		rulesLoader,
		memoryService,
		memoryTree,
		memoryView,
		agentSessionsStore,
		agentSessionsTree,
		agentsView,
		bugBotProvider,
		bugBotService,
		{ dispose: () => clearInterval(diffRefreshTimer) },
		registerAllProviders(storage),
		registerCommands(storage, rulesLoader, memoryService, agentSessionsStore, agentSessionsService, bugBotProvider),
		registerTools(),
	);
	log('activate: registered participant, providers, commands, tools, rules, memory, agents, bugBot');
}

export function deactivate(): void { }
