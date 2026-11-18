/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/** An image a tool returned, already encoded for the wire. */
export interface IToolResultImage {
	readonly mimeType: string;
	readonly base64: string;
}

/** What a tool result carries, split by how providers have to send it. */
export interface IToolResultContent {
	readonly text: string;
	readonly images: readonly IToolResultImage[];
}

/**
 * Image formats every vision API we talk to accepts. Anthropic is the strictest
 * and takes exactly these four; anything else is better described than sent.
 */
const WIRE_IMAGE_TYPES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/**
 * Splits the content of a tool result into its text and its images.
 *
 * Providers used to keep only the text, so a screenshot a tool produced never
 * reached the model. The images now come back separately, because each API
 * takes them in a different place: inside the tool result (Anthropic), or in a
 * user message right after it (the OpenAI chat format, whose tool messages are
 * text only).
 *
 * Text-typed data parts are decoded rather than dropped: some MCP servers send
 * their JSON that way.
 */
export function splitToolResult(content: readonly unknown[]): IToolResultContent {
	const text: string[] = [];
	const images: IToolResultImage[] = [];
	for (const part of content) {
		if (part instanceof vscode.LanguageModelTextPart) {
			text.push(part.value);
		} else if (typeof part === 'string') {
			text.push(part);
		} else if (part instanceof vscode.LanguageModelDataPart) {
			if (WIRE_IMAGE_TYPES.has(part.mimeType)) {
				images.push({ mimeType: part.mimeType, base64: Buffer.from(part.data).toString('base64') });
			} else if (part.mimeType.startsWith('text/') || part.mimeType === 'application/json') {
				text.push(new TextDecoder().decode(part.data));
			}
		}
	}
	return { text: text.join('\n'), images };
}

/** Text that stands in front of a tool's images when they travel in a separate user message. */
export function toolImagesCaption(count: number): string {
	return count === 1
		? 'Image returned by the tool call above:'
		: `${count} images returned by the tool calls above:`;
}

/**
 * Whether a model behind an OpenAI-compatible endpoint can read images, judged
 * by its id. Those endpoints publish no capability flags, and sending an image
 * to a text-only model makes the whole request fail, so an unknown id is
 * treated as text-only.
 */
export function looksVisionCapable(modelId: string): boolean {
	return /claude|gpt-4o|gpt-4\.1|gpt-5|gemini|grok-4|vision|pixtral|mistral-(medium|small)-(2|latest)|llama-4|qwen[\w.-]*vl|llava/i.test(modelId);
}
