/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ByokStorage } from './byokStorage.js';
import { registerAllProviders } from './providers/index.js';
import { registerCommands } from './commands.js';
import { registerTools } from './tools.js';
import { SemanticIndexService } from './semanticIndex/semanticIndexService.js';
import { registerSemanticIndexCommands } from './semanticIndex/commands.js';
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
import { LocalProvider } from './providers/local.js';
import { detectHardware } from './localModels/hardware.js';
import { LocalModelsController, registerLocalModelsCommands } from './localModels/localModelsController.js';
import { ModelStore } from './localModels/modelStore.js';
import { ServerManager } from './localModels/serverManager.js';
import { McpServers, registerMcpCommands } from './mcp.js';
import { registerFigma } from './figma/figmaTool.js';
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

	const modelStore = new ModelStore(context.globalStorageUri);
	const serverManager = new ServerManager(context.globalStorageUri, modelStore, context.globalState);
	const localProvider = new LocalProvider('local', storage, modelStore, serverManager);
	// Backs the Local Models panel in the AI Customizations editor: the panel
	// lives in the workbench and reaches the catalog, the downloads and the
	// runtime only through the commands registered here.
	const localModelsController = new LocalModelsController(modelStore, serverManager);
	// A newly downloaded model changes what the local provider can offer in the
	// picker. It does not touch a running server, which serves only the weights
	// it was launched with; deleting the model being served is the one case that
	// has to stop it, and the controller does that at the point of deletion.
	const modelStoreListener = modelStore.onDidChange(() => localProvider.refresh());

	// Semantic index over the workspace. Scoped to `storageUri` so each workspace
	// keeps its own vectors, and inert until the embedding model is installed.
	const semanticIndex = new SemanticIndexService(context.storageUri, context.globalState, modelStore, serverManager);

	const mcpServers = new McpServers();

	const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, createChatHandler(rulesLoader, memoryService, mcpServers));
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
		modelStore,
		modelStoreListener,
		serverManager,
		localProvider,
		localModelsController,
		mcpServers,
		{ dispose: () => clearInterval(diffRefreshTimer) },
		registerLocalModelsCommands(localModelsController),
		registerMcpCommands(mcpServers),
		registerAllProviders(storage, localProvider),
		registerCommands(storage, rulesLoader, memoryService, agentSessionsStore, agentSessionsService, bugBotProvider, serverManager),
		semanticIndex,
		registerTools(semanticIndex),
		registerSemanticIndexCommands(semanticIndex),
		registerFigma(context.secrets),
	);
	// Nothing resolves a credential-less vendor on startup, so ask for the first
	// resolution ourselves. The signal travels the same ordered channel as the
	// registration above, so it cannot overtake it.
	localProvider.refresh();
	const warmUp = new vscode.CancellationTokenSource();
	context.subscriptions.push(warmUp);
	void preloadLastUsedModel(serverManager, warmUp.token);
	// Indexing runs unattended once provisioned; the first run has to ask,
	// because it downloads a model.
	const indexWarmUp = new vscode.CancellationTokenSource();
	context.subscriptions.push(indexWarmUp);
	void semanticIndex.ensureReady(indexWarmUp.token).then(ready => {
		if (!ready) {
			void semanticIndex.promptForSetup();
		}
	});
	mcpServers.startOnStartupIfConfigured();
	log('activate: registered participant, providers, commands, tools, rules, memory, agents, bugBot, localModels, mcp');
}

/**
 * Brings the last local model the user chatted with into memory while they are
 * still finding their way around the window, so the first message does not pay
 * for the weights.
 *
 * Off unless `agent-chat.localModels.preload` is turned on. Loading gigabytes of
 * weights seconds after the window appears is what a machine with little free
 * RAM can least afford, and the kernel answers by killing whatever is largest —
 * often taking the window, and the shell that launched it, with it. Left to the
 * user, the server comes up when they ask for it: the play button in the Local
 * Models panel, or the first message sent to a local model.
 *
 * Deliberately does nothing for someone who has never used a local model: the
 * cost is gigabytes of reads and a resident process, and there is no way to
 * guess which of the installed models they meant. It also stands down when the
 * machine is short on memory, where loading early would only push the desktop
 * into swap sooner.
 */
async function preloadLastUsedModel(server: ServerManager, token: vscode.CancellationToken): Promise<void> {
	if (!vscode.workspace.getConfiguration('agent-chat').get<boolean>('localModels.preload', false)) {
		log('[localModels] preload disabled; the server starts on demand');
		return;
	}
	const pinned = vscode.workspace.getConfiguration('agent-chat').get<string>('localModels.preloadModel', '').trim();
	const model = pinned ? await server.installedModel(pinned) : await server.lastUsedModel();
	if (!model) {
		log(pinned
			? `[localModels] no preload: "${pinned}" is not installed`
			: '[localModels] no preload: no local model used yet, and more than one is installed');
		return;
	}
	if (token.isCancellationRequested) {
		return;
	}
	const { availableRamMB } = await detectHardware();
	const neededMB = Math.round(model.sizeBytes / (1024 * 1024)) + PRELOAD_HEADROOM_MB;
	if (neededMB > availableRamMB) {
		log(`[localModels] skipping preload of ${model.name}: needs ~${neededMB} MB, ~${availableRamMB} MB free`);
		return;
	}
	// After the window has settled. Startup is already competing for disk, and
	// the weights are a multi-gigabyte read that would slow everything visible.
	await new Promise<void>(resolve => setTimeout(resolve, PRELOAD_DELAY_MS));
	if (token.isCancellationRequested) {
		return;
	}
	log(`[localModels] preloading ${model.name}`);
	await server.preload(model, token);
}

/** Room left for the KV cache and the runtime on top of the weights themselves. */
const PRELOAD_HEADROOM_MB = 1500;

/** How long after activation the weights start loading. */
const PRELOAD_DELAY_MS = 5000;

export function deactivate(): void { }
