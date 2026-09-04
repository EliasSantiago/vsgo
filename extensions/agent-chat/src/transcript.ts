/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/**
 * Key under which the working transcript is stashed in `ChatResult.metadata`.
 * VS Code hands that metadata back on the next request through
 * `ChatResponseTurn.result`, which is the only supported way to carry tool
 * calls and tool results across requests — `ChatResponseTurn.response` exposes
 * rendered content only.
 */
export const TRANSCRIPT_METADATA_KEY = 'agentChatTranscript';

const TRANSCRIPT_VERSION = 1;

/**
 * Budget for one serialized transcript. Metadata is persisted with the chat
 * session, so this trades how far back a continuation can see against how much
 * is written to disk per response.
 */
const MAX_TRANSCRIPT_CHARS = 150_000;

/** Per tool result cap, so a single large read cannot consume the whole budget. */
const MAX_RESULT_CHARS = 24_000;

const TRUNCATION_MARKER = '\n…[truncado no histórico]';

type SerializedPart =
	| { readonly kind: 'text'; readonly value: string }
	| { readonly kind: 'toolCall'; readonly callId: string; readonly name: string; readonly input: unknown }
	| { readonly kind: 'toolResult'; readonly callId: string; readonly value: string };

interface ISerializedMessage {
	readonly role: 'user' | 'assistant';
	readonly parts: readonly SerializedPart[];
}

interface ISerializedTranscript {
	readonly version: number;
	readonly messages: readonly ISerializedMessage[];
}

/**
 * Turns the working messages of a request into JSON that survives the round trip
 * through `ChatResult.metadata`.
 *
 * Image and other binary parts are dropped: providers already discard them in
 * tool results, and they would blow the size budget.
 *
 * @param messages Working messages WITHOUT the leading system prompt, which is
 * rebuilt from current rules and memories on every request.
 */
export function serializeTranscript(messages: readonly vscode.LanguageModelChatMessage[]): ISerializedTranscript {
	const serialized: ISerializedMessage[] = [];
	for (const message of messages) {
		const parts = serializeParts(message.content);
		if (parts.length > 0) {
			serialized.push({
				role: message.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user',
				parts,
			});
		}
	}
	return { version: TRANSCRIPT_VERSION, messages: fitToBudget(dropOrphans(serialized)) };
}

/**
 * Rebuilds the messages stashed by a previous request, or `undefined` when the
 * turn carries no usable snapshot.
 */
export function restoreTranscript(result: vscode.ChatResult | undefined): vscode.LanguageModelChatMessage[] | undefined {
	const raw = result?.metadata?.[TRANSCRIPT_METADATA_KEY] as ISerializedTranscript | undefined;
	if (!raw || raw.version !== TRANSCRIPT_VERSION || !Array.isArray(raw.messages) || raw.messages.length === 0) {
		return undefined;
	}

	const messages: vscode.LanguageModelChatMessage[] = [];
	for (const message of raw.messages) {
		if (!Array.isArray(message?.parts)) {
			continue;
		}
		if (message.role === 'assistant') {
			const parts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart> = [];
			for (const part of message.parts) {
				if (part.kind === 'text') {
					parts.push(new vscode.LanguageModelTextPart(part.value));
				} else if (part.kind === 'toolCall') {
					parts.push(new vscode.LanguageModelToolCallPart(part.callId, part.name, part.input as object));
				}
			}
			if (parts.length > 0) {
				messages.push(vscode.LanguageModelChatMessage.Assistant(parts));
			}
		} else {
			const parts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolResultPart> = [];
			for (const part of message.parts) {
				if (part.kind === 'text') {
					parts.push(new vscode.LanguageModelTextPart(part.value));
				} else if (part.kind === 'toolResult') {
					parts.push(new vscode.LanguageModelToolResultPart(part.callId, [new vscode.LanguageModelTextPart(part.value)]));
				}
			}
			if (parts.length > 0) {
				messages.push(vscode.LanguageModelChatMessage.User(parts));
			}
		}
	}
	return messages.length > 0 ? messages : undefined;
}

function serializeParts(content: readonly unknown[]): SerializedPart[] {
	const parts: SerializedPart[] = [];
	for (const part of content) {
		if (part instanceof vscode.LanguageModelTextPart) {
			if (part.value) {
				parts.push({ kind: 'text', value: part.value });
			}
		} else if (part instanceof vscode.LanguageModelToolCallPart) {
			parts.push({ kind: 'toolCall', callId: part.callId, name: part.name, input: part.input });
		} else if (part instanceof vscode.LanguageModelToolResultPart) {
			parts.push({ kind: 'toolResult', callId: part.callId, value: truncate(flattenResult(part.content), MAX_RESULT_CHARS) });
		}
	}
	return parts;
}

function flattenResult(content: readonly unknown[]): string {
	let text = '';
	for (const part of content) {
		if (part instanceof vscode.LanguageModelTextPart) {
			text += part.value;
		}
	}
	return text;
}

/**
 * Removes tool calls whose result never came back and results whose call is
 * gone. Providers reject a request where the two do not pair up, which is
 * exactly the shape a cancelled or errored turn leaves behind.
 */
function dropOrphans(messages: readonly ISerializedMessage[]): ISerializedMessage[] {
	const calledIds = new Set<string>();
	const answeredIds = new Set<string>();
	for (const message of messages) {
		for (const part of message.parts) {
			if (part.kind === 'toolCall') {
				calledIds.add(part.callId);
			} else if (part.kind === 'toolResult') {
				answeredIds.add(part.callId);
			}
		}
	}

	const kept: ISerializedMessage[] = [];
	for (const message of messages) {
		const parts = message.parts.filter(part => {
			if (part.kind === 'toolCall') {
				return answeredIds.has(part.callId);
			}
			if (part.kind === 'toolResult') {
				return calledIds.has(part.callId);
			}
			return true;
		});
		if (parts.length > 0) {
			kept.push({ role: message.role, parts });
		}
	}
	return kept;
}

/**
 * Drops the oldest messages until the snapshot fits the budget, then keeps
 * dropping while the transcript would start on tool results — their calls would
 * already be gone.
 */
function fitToBudget(messages: readonly ISerializedMessage[]): ISerializedMessage[] {
	let start = 0;
	while (start < messages.length && JSON.stringify(messages.slice(start)).length > MAX_TRANSCRIPT_CHARS) {
		start++;
	}
	while (start < messages.length && messages[start].parts.some(part => part.kind === 'toolResult')) {
		start++;
	}
	return messages.slice(start);
}

function truncate(text: string, max: number): string {
	return text.length > max ? text.slice(0, max) + TRUNCATION_MARKER : text;
}
