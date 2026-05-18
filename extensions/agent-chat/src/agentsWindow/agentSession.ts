/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type AgentSessionStatus = 'idle' | 'running' | 'error' | 'done';

export interface IAgentSession {
	readonly id: string;
	readonly name: string;
	readonly branch: string;
	readonly worktreePath: string;
	readonly baseRepoPath: string;
	readonly prompt: string;
	readonly status: AgentSessionStatus;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly diffSummary?: { filesChanged: number; insertions: number; deletions: number };
	readonly lastError?: string;
}

export function newSessionId(): string {
	return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
