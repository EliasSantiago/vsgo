/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { log } from '../logger.js';
import { IAgentSession, newSessionId } from './agentSession.js';
import { AgentSessionsStore } from './agentSessionsStore.js';
import { WorktreeService } from './worktreeService.js';

export interface CreateSessionInput {
	readonly name: string;
	readonly branch: string;
	readonly prompt: string;
	readonly baseBranch?: string;
}

export class AgentSessionsService {

	constructor(
		private readonly store: AgentSessionsStore,
		private readonly worktrees: WorktreeService,
	) { }

	async create(input: CreateSessionInput): Promise<IAgentSession> {
		const baseFolder = vscode.workspace.workspaceFolders?.[0];
		if (!baseFolder) {
			throw new Error('Open a folder before creating an agent session.');
		}
		const baseRepoPath = await this.worktrees.resolveRepoRoot(baseFolder.uri.fsPath);
		const id = newSessionId();
		const worktreePath = await this.worktrees.create({
			sessionId: id,
			branch: input.branch,
			baseRepoPath,
			baseBranch: input.baseBranch,
		});
		const now = Date.now();
		const session: IAgentSession = {
			id,
			name: input.name,
			branch: input.branch,
			worktreePath,
			baseRepoPath,
			prompt: input.prompt,
			status: 'idle',
			createdAt: now,
			updatedAt: now,
		};
		await this.store.add(session);
		log(`agents: created session ${id} (${input.branch}) at ${worktreePath}`);
		return session;
	}

	async refreshDiff(id: string): Promise<void> {
		const session = this.store.get(id);
		if (!session) {
			return;
		}
		const summary = await this.worktrees.diffSummary(session.worktreePath);
		await this.store.update(id, { diffSummary: summary });
	}

	async delete(id: string): Promise<void> {
		const session = this.store.get(id);
		if (!session) {
			return;
		}
		await this.worktrees.remove(session.worktreePath, session.baseRepoPath);
		await this.store.remove(id);
		log(`agents: deleted session ${id}`);
	}
}
