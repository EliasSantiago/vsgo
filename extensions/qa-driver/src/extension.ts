/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ICaptureResult, QaDriver } from './qaDriver.js';

export function activate(context: vscode.ExtensionContext): void {
	const driver = new QaDriver();

	context.subscriptions.push(
		vscode.commands.registerCommand('vsgo.qaDriver.launch', (opts: { headless: boolean }) =>
			driver.launch(opts)),
		vscode.commands.registerCommand('vsgo.qaDriver.navigate', (url: string) =>
			driver.navigate(url)),
		vscode.commands.registerCommand('vsgo.qaDriver.click', (targetId: number) =>
			driver.click(targetId)),
		vscode.commands.registerCommand('vsgo.qaDriver.type', (targetId: number, text: string) =>
			driver.type(targetId, text)),
		vscode.commands.registerCommand('vsgo.qaDriver.pressKey', (key: string) =>
			driver.pressKey(key)),
		vscode.commands.registerCommand('vsgo.qaDriver.scroll', (direction: 'up' | 'down', amount: number) =>
			driver.scroll(direction, amount)),
		vscode.commands.registerCommand('vsgo.qaDriver.waitFor', (condition: 'idle' | 'load' | { text: string } | { selector: string }, timeoutMs: number) =>
			driver.waitFor(condition, timeoutMs)),
		vscode.commands.registerCommand('vsgo.qaDriver.getVisibleText', (): Promise<string> =>
			driver.getVisibleText()),
		vscode.commands.registerCommand('vsgo.qaDriver.captureState', (): Promise<ICaptureResult> =>
			driver.captureState()),
		vscode.commands.registerCommand('vsgo.qaDriver.close', () =>
			driver.close()),
		{ dispose: () => { void driver.close(); } },
	);
}

export function deactivate(): void {
	// driver disposed via subscriptions
}
