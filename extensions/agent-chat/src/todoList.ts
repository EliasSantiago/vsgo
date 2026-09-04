/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export const TODO_TOOL_NAME = 'agent_todo_write';

export type TodoStatus = 'pending' | 'in_progress' | 'done';

export interface TodoItem {
	readonly content: string;
	readonly status: TodoStatus;
}

export interface TodoInput {
	readonly todos: readonly TodoItem[];
}

/**
 * Lets the model keep a checklist for the task it was given.
 *
 * Defined inline rather than registered because the list belongs to one
 * request: it is state the agent loop owns, and a globally registered tool
 * would have to keep it somewhere that outlives the conversation it describes.
 *
 * The point is not the display. A model working through a long task drifts —
 * it finishes step two and answers as though the task were done — and the
 * strongest correction available is having the remaining steps restated in the
 * context on every turn. Writing the list back as the tool result is what does
 * that; the panel the user sees is a side effect.
 */
export const TODO_TOOL: vscode.LanguageModelChatTool = {
	name: TODO_TOOL_NAME,
	description:
		'Keep a checklist for a task that takes several steps. Call it once at the start with the whole plan, '
		+ 'then again after each step with that step marked done and the next one in_progress. '
		+ 'Send the COMPLETE list every time — it replaces the previous one. '
		+ 'Exactly one item should be in_progress at a time. '
		+ 'Skip it for anything you can finish in one or two tool calls; it is overhead there. '
		+ 'The result is the current list, so use it to remind yourself what is still open before deciding what to do next.',
	inputSchema: {
		type: 'object',
		required: ['todos'],
		properties: {
			todos: {
				type: 'array',
				minItems: 1,
				maxItems: 20,
				description: 'The complete checklist, in the order the steps should happen.',
				items: {
					type: 'object',
					required: ['content', 'status'],
					properties: {
						content: {
							type: 'string',
							description: 'The step, as an imperative phrase ("Ler app.routes.ts").',
							minLength: 3,
						},
						status: {
							type: 'string',
							enum: ['pending', 'in_progress', 'done'],
							description: 'Where the step stands.',
						},
					},
				},
			},
		},
	},
};

const STATUS_MARK: Record<TodoStatus, string> = {
	pending: '[ ]',
	in_progress: '[~]',
	done: '[x]',
};

/**
 * Normalises whatever the model sent into a list worth storing, or explains
 * why it was rejected. Small models routinely send a bare string or drop the
 * status, and a silent repair would teach them the wrong shape.
 */
export function parseTodos(input: unknown): { todos?: TodoItem[]; error?: string } {
	const raw = (input as TodoInput | undefined)?.todos;
	if (!Array.isArray(raw) || raw.length === 0) {
		return { error: 'O campo `todos` precisa ser uma lista não vazia de {content, status}.' };
	}
	const todos: TodoItem[] = [];
	for (const item of raw) {
		const content = typeof item?.content === 'string' ? item.content.trim() : '';
		if (!content) {
			return { error: 'Cada item precisa de um `content` em texto descrevendo o passo.' };
		}
		const status = item?.status;
		if (status !== 'pending' && status !== 'in_progress' && status !== 'done') {
			return { error: `Status inválido em "${content}". Use "pending", "in_progress" ou "done".` };
		}
		todos.push({ content, status });
	}
	return { todos };
}

/** The list as the model reads it back, which is what keeps it on task. */
export function renderTodosForModel(todos: readonly TodoItem[]): string {
	const open = todos.filter(t => t.status !== 'done').length;
	const lines = todos.map(t => `${STATUS_MARK[t.status]} ${t.content}`);
	const tail = open === 0
		? 'Todos os passos estão concluídos. Dê a resposta final ao usuário.'
		: `${open} passo(s) em aberto. Siga para o próximo sem perguntar nada ao usuário.`;
	return `${lines.join('\n')}\n\n${tail}`;
}

/** The same list for the user, as a checklist in the chat. */
export function renderTodosForUser(todos: readonly TodoItem[]): string {
	const lines = todos.map(t => {
		const label = t.status === 'done' ? `~~${t.content}~~` : t.content;
		return `- ${t.status === 'done' ? '✓' : t.status === 'in_progress' ? '▸' : '○'} ${label}`;
	});
	return `\n\n${lines.join('\n')}\n\n`;
}
