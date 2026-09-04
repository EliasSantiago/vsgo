/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Characters of unbroken repetition that count as a collapse. At the shortest
 * unit this is 400 copies of one character and at the longest a dozen copies of
 * a whole token, both far past anything a model emits on purpose — the longest
 * repeating run in ordinary output is a rule of dashes or a table separator,
 * which stops well inside a single line.
 */
const WINDOW = 400;

/**
 * Longest repeating unit recognised. `<unused49>` needs ten characters; the
 * ceiling is there so a model looping over a short phrase is still caught while
 * the scan stays proportional to the window.
 */
const MAX_UNIT = 32;

/**
 * Watches a model's output for the collapse described in
 * ggml-org/llama.cpp#26088, #26239 and #26471, where the runtime starts
 * emitting one token forever — `<unused49>` on Gemma 4, `<` on DeepSeek — and
 * keeps going until it hits the token ceiling. The slot stays poisoned
 * afterwards, so every later request on that process comes back as garbage too.
 *
 * Detection is by shape rather than by token: the upstream bug has surfaced
 * with a different filler on each model, and the one thing they share is that
 * the tail of the stream becomes perfectly periodic.
 */
export class DegenerateOutputGuard {

	private tail = '';
	private collapsed = false;

	/** Whether the stream has already been judged degenerate. */
	get tripped(): boolean {
		return this.collapsed;
	}

	/**
	 * Feeds the next chunk of generated text. Returns true once the stream has
	 * collapsed, and keeps returning true for every chunk after that.
	 */
	accept(text: string): boolean {
		if (this.collapsed) {
			return true;
		}
		this.tail = (this.tail + text).slice(-WINDOW);
		if (this.tail.length >= WINDOW && isPeriodic(this.tail)) {
			this.collapsed = true;
		}
		return this.collapsed;
	}
}

/**
 * Whether `text` is some unit of at most {@link MAX_UNIT} characters repeated
 * end to end. A string repeats with period `unit` exactly when shifting it by
 * that many characters leaves it unchanged.
 */
function isPeriodic(text: string): boolean {
	for (let unit = 1; unit <= MAX_UNIT; unit++) {
		if (text.slice(unit) === text.slice(0, text.length - unit)) {
			return true;
		}
	}
	return false;
}
