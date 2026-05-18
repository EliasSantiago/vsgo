/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

export function initLogger(): vscode.OutputChannel {
	channel = vscode.window.createOutputChannel('Agent Chat');
	return channel;
}

export function log(...parts: unknown[]): void {
	if (!channel) {
		return;
	}
	const ts = new Date().toISOString().slice(11, 23);
	const line = parts.map(p => typeof p === 'string' ? p : JSON.stringify(p)).join(' ');
	channel.appendLine(`[${ts}] ${line}`);
}
