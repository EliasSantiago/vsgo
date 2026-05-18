/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IAgentSession } from './agentSession.js';

const STORAGE_KEY = 'agent-chat.sessions';

export class AgentSessionsStore implements vscode.Disposable {

	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChange = this._onDidChange.event;

	private sessions: IAgentSession[] = [];

	constructor(private readonly memento: vscode.Memento) {
		this.sessions = this.memento.get<IAgentSession[]>(STORAGE_KEY, []);
	}

	dispose(): void {
		this._onDidChange.dispose();
	}

	all(): readonly IAgentSession[] {
		return [...this.sessions].sort((a, b) => b.createdAt - a.createdAt);
	}

	get(id: string): IAgentSession | undefined {
		return this.sessions.find(s => s.id === id);
	}

	async add(session: IAgentSession): Promise<void> {
		this.sessions = [...this.sessions.filter(s => s.id !== session.id), session];
		await this.persist();
	}

	async update(id: string, patch: Partial<IAgentSession>): Promise<IAgentSession | undefined> {
		const idx = this.sessions.findIndex(s => s.id === id);
		if (idx === -1) {
			return undefined;
		}
		const updated: IAgentSession = { ...this.sessions[idx], ...patch, updatedAt: Date.now() };
		this.sessions[idx] = updated;
		await this.persist();
		return updated;
	}

	async remove(id: string): Promise<void> {
		const next = this.sessions.filter(s => s.id !== id);
		if (next.length === this.sessions.length) {
			return;
		}
		this.sessions = next;
		await this.persist();
	}

	private async persist(): Promise<void> {
		await this.memento.update(STORAGE_KEY, this.sessions);
		this._onDidChange.fire();
	}
}
