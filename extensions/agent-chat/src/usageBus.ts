/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Token counts for a single model call, real or estimated. */
export interface IReportedUsage {
	readonly inputTokens: number;
	readonly outputTokens: number;
	/** `true` when the numbers came from a character count instead of the provider. */
	readonly estimated: boolean;
}

/**
 * Carries the token counts a provider read off its streaming API back to the
 * chat handler, which is the only place allowed to report them to the chat view.
 *
 * The two halves never meet on their own: the provider implements
 * `LanguageModelChatProvider` and the handler is a chat participant, and a
 * request travels between them through the main thread, which only forwards what
 * the response stream models — and it does not model usage. Both halves are this
 * same extension, so the numbers take this shortcut instead.
 *
 * Correlation is explicit because the handler is not the only caller:
 * sub-agents, BugBot and the PR splitter send their own requests, and their
 * tokens must not land on the bar that describes the user's conversation. Only a
 * request that carries a token gets published, so everything else is ignored for
 * free.
 */
class UsageBus {

	/** Dropped after this long, in case a request dies before anyone collects it. */
	private static readonly ENTRY_TTL_MS = 5 * 60 * 1000;

	private static readonly MODEL_OPTION_KEY = 'vsgoUsageToken';

	private readonly pending = new Map<string, { readonly usage: IReportedUsage; readonly at: number }>();
	private counter = 0;

	/** Mints a token for one upcoming `sendRequest`. */
	newToken(): string {
		return `usage-${++this.counter}-${Date.now()}`;
	}

	/** Model options that tag a request so its usage comes back tagged too. */
	modelOptions(token: string): { readonly [name: string]: unknown } {
		return { [UsageBus.MODEL_OPTION_KEY]: token };
	}

	/** Reads back the token a request was tagged with, if it was tagged at all. */
	tokenFrom(modelOptions: { readonly [name: string]: unknown } | undefined): string | undefined {
		const value = modelOptions?.[UsageBus.MODEL_OPTION_KEY];
		return typeof value === 'string' && value.length > 0 ? value : undefined;
	}

	publish(token: string | undefined, usage: IReportedUsage): void {
		if (!token) {
			return;
		}
		this.evictStale();
		this.pending.set(token, { usage, at: Date.now() });
	}

	/** Takes the usage for one request. A second call for the same token returns nothing. */
	take(token: string): IReportedUsage | undefined {
		const entry = this.pending.get(token);
		this.pending.delete(token);
		return entry?.usage;
	}

	private evictStale(): void {
		const cutoff = Date.now() - UsageBus.ENTRY_TTL_MS;
		for (const [key, entry] of this.pending) {
			if (entry.at < cutoff) {
				this.pending.delete(key);
			}
		}
	}
}

export const usageBus = new UsageBus();
