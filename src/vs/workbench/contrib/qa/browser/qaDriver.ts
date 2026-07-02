/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ICaptureResult } from '../common/qa.js';

export const IQaDriver = createDecorator<IQaDriver>('qaDriver');

export interface IQaDriver {
	readonly _serviceBrand: undefined;
	launch(opts: { headless: boolean }): Promise<void>;
	navigate(url: string): Promise<void>;
	click(targetId: number): Promise<void>;
	type(targetId: number, text: string): Promise<void>;
	pressKey(key: string): Promise<void>;
	scroll(direction: 'up' | 'down', amount: number): Promise<void>;
	waitFor(condition: 'idle' | 'load' | { text: string } | { selector: string }, timeoutMs: number): Promise<void>;
	getVisibleText(): Promise<string>;
	captureState(): Promise<ICaptureResult>;
	close(): Promise<void>;
}

/**
 * Renderer-side proxy for the QA driver. The real Playwright code lives in the
 * built-in `qa-driver` extension (extensions/qa-driver) and runs in the
 * extension host, where Node modules can be required directly. We round-trip
 * via `ICommandService.executeCommand`, which transparently forwards calls to
 * commands registered with `vscode.commands.registerCommand` in the extension.
 */
export class PlaywrightQaDriver extends Disposable implements IQaDriver {
	declare readonly _serviceBrand: undefined;

	constructor(
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();
	}

	private exec<T>(command: string, ...args: unknown[]): Promise<T> {
		return this.commandService.executeCommand<T>(command, ...args) as Promise<T>;
	}

	async launch(opts: { headless: boolean }): Promise<void> {
		await this.exec<void>('vsgo.qaDriver.launch', opts);
	}

	async navigate(url: string): Promise<void> {
		await this.exec<void>('vsgo.qaDriver.navigate', url);
	}

	async click(targetId: number): Promise<void> {
		await this.exec<void>('vsgo.qaDriver.click', targetId);
	}

	async type(targetId: number, text: string): Promise<void> {
		await this.exec<void>('vsgo.qaDriver.type', targetId, text);
	}

	async pressKey(key: string): Promise<void> {
		await this.exec<void>('vsgo.qaDriver.pressKey', key);
	}

	async scroll(direction: 'up' | 'down', amount: number): Promise<void> {
		await this.exec<void>('vsgo.qaDriver.scroll', direction, amount);
	}

	async waitFor(condition: 'idle' | 'load' | { text: string } | { selector: string }, timeoutMs: number): Promise<void> {
		await this.exec<void>('vsgo.qaDriver.waitFor', condition, timeoutMs);
	}

	async getVisibleText(): Promise<string> {
		return await this.exec<string>('vsgo.qaDriver.getVisibleText');
	}

	async captureState(): Promise<ICaptureResult> {
		return await this.exec<ICaptureResult>('vsgo.qaDriver.captureState');
	}

	async close(): Promise<void> {
		try { await this.exec<void>('vsgo.qaDriver.close'); } catch { /* worker may already be gone */ }
	}
}
