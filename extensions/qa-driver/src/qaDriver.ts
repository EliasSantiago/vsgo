/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

type Any = any;

export interface IInteractiveElement {
	readonly id: number;
	readonly role: string;
	readonly label: string;
	readonly bbox: [number, number, number, number];
}

export interface ICaptureResult {
	readonly url: string;
	readonly title: string;
	readonly screenshotDataBase64: string;
	readonly elements: readonly IInteractiveElement[];
}

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

function loadPlaywright(): Any {
	try {
		return require('playwright');
	} catch {
		return require('playwright-core');
	}
}

export class QaDriver {

	private browser: Any | undefined;
	private context: Any | undefined;
	private page: Any | undefined;

	private async ensurePage(): Promise<Any> {
		if (this.page) { return this.page; }
		throw new Error('Browser not launched. Call "launch" first.');
	}

	async launch(opts: { headless: boolean }): Promise<void> {
		if (this.browser) {
			try { await this.browser.close(); } catch { /* ignore */ }
		}
		const pw = loadPlaywright();
		this.browser = await pw.chromium.launch({ headless: opts.headless });
		this.context = await this.browser.newContext({ viewport: { width: 1280, height: 800 } });
		this.page = await this.context.newPage();
	}

	async navigate(url: string): Promise<void> {
		const page = await this.ensurePage();
		await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
	}

	private async getElementByVsgoId(targetId: number): Promise<Any> {
		const page = await this.ensurePage();
		const handle = await page.$(`[data-vsgo-qa-id="${targetId}"]`);
		if (!handle) {
			throw new Error(`No interactive element with id=${targetId}. Re-run captureState to refresh.`);
		}
		return handle;
	}

	async click(targetId: number): Promise<void> {
		const el = await this.getElementByVsgoId(targetId);
		await el.click();
	}

	async type(targetId: number, text: string): Promise<void> {
		const el = await this.getElementByVsgoId(targetId);
		await el.click();
		await el.fill(text);
	}

	async pressKey(key: string): Promise<void> {
		const page = await this.ensurePage();
		await page.keyboard.press(key);
	}

	async scroll(direction: 'up' | 'down', amount: number): Promise<void> {
		const page = await this.ensurePage();
		const delta = (direction === 'down' ? 1 : -1) * amount;
		await page.mouse.wheel(0, delta);
	}

	async waitFor(condition: 'idle' | 'load' | { text: string } | { selector: string }, timeoutMs: number): Promise<void> {
		const page = await this.ensurePage();
		if (condition === 'idle') {
			await page.waitForLoadState('networkidle', { timeout: timeoutMs });
		} else if (condition === 'load') {
			await page.waitForLoadState('load', { timeout: timeoutMs });
		} else if (condition && typeof condition === 'object') {
			const cond = condition as { text?: string; selector?: string };
			if (cond.text !== undefined) {
				await page.waitForSelector(`text=${cond.text}`, { timeout: timeoutMs });
			} else if (cond.selector !== undefined) {
				await page.waitForSelector(cond.selector, { timeout: timeoutMs });
			}
		}
	}

	async getVisibleText(): Promise<string> {
		const page = await this.ensurePage();
		return await page.evaluate(() => (document.body?.innerText ?? '').slice(0, 8000));
	}

	async captureState(): Promise<ICaptureResult> {
		const page = await this.ensurePage();
		const elements: IInteractiveElement[] = await page.evaluate(INDEX_SCRIPT);
		const buf = await page.screenshot({ type: 'png', fullPage: false });
		const title = await page.title();
		return {
			url: page.url(),
			title,
			screenshotDataBase64: buf.toString('base64'),
			elements,
		};
	}

	async close(): Promise<void> {
		try { await this.browser?.close(); } catch { /* ignore */ }
		this.browser = undefined;
		this.context = undefined;
		this.page = undefined;
	}
}
