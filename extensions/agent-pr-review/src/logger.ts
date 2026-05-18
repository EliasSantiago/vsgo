/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

export function initLogger(): vscode.OutputChannel {
	channel = vscode.window.createOutputChannel('Agent PR Review');
	return channel;
}

export function log(message: string, ...rest: unknown[]): void {
	if (!channel) {
		return;
	}
	const prefix = `[${new Date().toISOString()}] `;
	const extras = rest.map(r => (typeof r === 'string' ? r : JSON.stringify(r))).join(' ');
	channel.appendLine(prefix + message + (extras ? ' ' + extras : ''));
}
