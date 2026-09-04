/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// eslint-disable-next-line local/code-import-patterns
import type { Page } from 'playwright-core';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IPlaywrightService } from '../../../../platform/browserView/common/playwrightService.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { hasKey } from '../../../../base/common/types.js';
import { ICaptureResult, IInteractiveElement } from '../common/qa.js';

export const IQaDriver = createDecorator<IQaDriver>('qaDriver');

export interface IQaDriver {
	readonly _serviceBrand: undefined;
	launch(): Promise<void>;
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
 * Session under which QA pages are tracked. `IPlaywrightService` keys its browser instances by an
 * opaque string — the chat tools pass the chat session — so QA gets one of its own, keeping its
 * pages apart from anything the chat agent is driving.
 */
const QA_SESSION_ID = 'vsgo-qa';

/** Where a run starts, before the agent navigates anywhere. */
const BLANK_PAGE = 'about:blank';

/**
 * Tags every visible interactive element with `data-vsgo-qa-id` and returns the index the model
 * clicks against. Runs as a string inside the page, so it cannot reference anything out here.
 */
const INDEX_SCRIPT = `(() => {
	const selectors = 'a, button, input, textarea, select, [role="button"], [role="link"], [role="checkbox"], [role="textbox"], [contenteditable="true"]';
	const all = Array.from(document.querySelectorAll(selectors));
	const visible = all.filter(el => {
		const r = el.getBoundingClientRect();
		if (r.width < 2 || r.height < 2) return false;
		const style = getComputedStyle(el);
		if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false;
		return r.top < innerHeight && r.bottom > 0 && r.left < innerWidth && r.right > 0;
	});
	const out = [];
	visible.forEach((el, i) => {
		const id = i + 1;
		el.setAttribute('data-vsgo-qa-id', String(id));
		const r = el.getBoundingClientRect();
		const label = (el.getAttribute('aria-label')
			|| el.getAttribute('placeholder')
			|| el.textContent
			|| el.getAttribute('value')
			|| el.getAttribute('name')
			|| el.getAttribute('title')
			|| '').trim().slice(0, 80);
		out.push({ id, role: el.getAttribute('role') || el.tagName.toLowerCase(), label, bbox: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] });
	});
	return out;
})()`;

/**
 * Drives QA runs through the integrated browser — the same Electron `WebContentsView` the chat
 * agent uses, reached over CDP by `IPlaywrightService`.
 *
 * The alternative, launching Chromium through `playwright.chromium.launch()`, needs a browser
 * binary that arrives only with Playwright's dev dependencies: it is absent from a packaged build,
 * and from platforms Playwright publishes no download for. Attaching to the browser Electron
 * already is removes that dependency, and the tester watches the run inside the editor.
 *
 * The trade-off is that there is no headless mode — a `WebContentsView` is a real view — and that
 * pages share the Electron session, so the tester's cookies are visible to the run.
 */
export class BrowserViewQaDriver extends Disposable implements IQaDriver {
	declare readonly _serviceBrand: undefined;

	private pageId: string | undefined;

	constructor(
		@IPlaywrightService private readonly playwrightService: IPlaywrightService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async launch(): Promise<void> {
		await this.close();
		const { pageId } = await this.playwrightService.openPage(QA_SESSION_ID, BLANK_PAGE);
		this.pageId = pageId;
	}

	async navigate(url: string): Promise<void> {
		await this.invoke(
			(page, target) => page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 }),
			url,
		);
	}

	async click(targetId: number): Promise<void> {
		await this.invoke((page, selector) => page.locator(selector).click(), targetSelector(targetId));
	}

	async type(targetId: number, text: string): Promise<void> {
		await this.invoke(async (page, selector, value) => {
			const locator = page.locator(selector);
			await locator.click();
			await locator.fill(value);
		}, targetSelector(targetId), text);
	}

	async pressKey(key: string): Promise<void> {
		await this.invoke((page, value) => page.keyboard.press(value), key);
	}

	async scroll(direction: 'up' | 'down', amount: number): Promise<void> {
		const delta = (direction === 'down' ? 1 : -1) * amount;
		await this.invoke((page, value) => page.mouse.wheel(0, value), delta);
	}

	async waitFor(condition: 'idle' | 'load' | { text: string } | { selector: string }, timeoutMs: number): Promise<void> {
		if (condition === 'idle' || condition === 'load') {
			const state: 'networkidle' | 'load' = condition === 'idle' ? 'networkidle' : 'load';
			await this.invoke(
				(page, value, timeout) => page.waitForLoadState(value, { timeout }),
				state,
				timeoutMs,
			);
			return;
		}
		const selector = hasKey(condition, { selector: true }) ? condition.selector : `text=${condition.text}`;
		await this.invoke(
			(page, value, timeout) => page.waitForSelector(value, { timeout }),
			selector,
			timeoutMs,
		);
	}

	async getVisibleText(): Promise<string> {
		// The callback runs inside the page under test, not in a workbench window, so its `document` is the remote one.
		// eslint-disable-next-line no-restricted-syntax
		return this.invoke(page => page.evaluate(() => (document.body?.innerText ?? '').slice(0, 8000)));
	}

	async captureState(): Promise<ICaptureResult> {
		return this.invoke(async (page, script) => {
			const elements = await page.evaluate<IInteractiveElement[]>(script);
			const screenshot = await page.screenshot({ type: 'png', fullPage: false });
			return {
				url: page.url(),
				title: await page.title(),
				screenshotDataBase64: screenshot.toString('base64'),
				elements,
			};
		}, INDEX_SCRIPT);
	}

	/**
	 * Releases the page. The view is left open on purpose: after a failed run, the final state of
	 * the page is the most useful thing on screen.
	 */
	async close(): Promise<void> {
		const pageId = this.pageId;
		this.pageId = undefined;
		if (!pageId) {
			return;
		}
		try {
			await this.playwrightService.stopTrackingPage(pageId);
		} catch (err) {
			this.logService.warn('[qa] could not stop tracking page', err);
		}
	}

	/**
	 * `fn` is shipped to the shared process as source text, so it must not close over anything out
	 * here — everything it needs arrives through `args`.
	 */
	private invoke<TArgs extends unknown[], TReturn>(
		fn: (page: Page, ...args: TArgs) => Promise<TReturn>,
		...args: TArgs
	): Promise<TReturn> {
		if (!this.pageId) {
			throw new Error('Browser not launched. Call "launch" first.');
		}
		return this.playwrightService.invokeFunctionRaw<TReturn>(QA_SESSION_ID, this.pageId, fn.toString(), ...args);
	}
}

function targetSelector(targetId: number): string {
	return `[data-vsgo-qa-id="${targetId}"]`;
}
