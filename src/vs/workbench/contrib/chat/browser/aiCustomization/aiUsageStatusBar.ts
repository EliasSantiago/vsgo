/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { Disposable, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, ShowTooltipCommand, StatusbarAlignment } from '../../../../services/statusbar/browser/statusbar.js';
import { IAIUsageService, IAIUsageTotals } from '../../common/aiUsageService.js';

/**
 * Shows a status bar indicator with the token count of the most recent language
 * model request, plus a tooltip breaking down today's / this session's / all-time
 * consumption. Backed by {@link IAIUsageService}.
 */
export class AIUsageStatusBarContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.aiUsageStatusBar';

	private readonly entry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());

	constructor(
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@IAIUsageService private readonly aiUsageService: IAIUsageService,
	) {
		super();
		this.entry.value = this.statusbarService.addEntry(this.buildEntry(), AIUsageStatusBarContribution.ID, StatusbarAlignment.RIGHT, 100);
		this._register(this.aiUsageService.onDidChangeUsage(() => this.entry.value?.update(this.buildEntry())));
	}

	private buildEntry(): IStatusbarEntry {
		const entries = this.aiUsageService.entries;
		const last = entries.length > 0 ? entries[entries.length - 1] : undefined;
		const lastTokens = last ? last.inputTokens + last.outputTokens : 0;
		const text = `$(graph) ${formatCompact(lastTokens)}`;

		return {
			name: localize('aiUsageStatus', "Uso de Tokens de IA"),
			text,
			ariaLabel: localize('aiUsageStatusAria', "A última requisição usou {0} tokens", lastTokens),
			tooltip: this.buildTooltip(),
			command: ShowTooltipCommand,
		};
	}

	private buildTooltip(): MarkdownString {
		const now = new Date();
		const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
		const today = this.aiUsageService.getTotals({ from: startOfDay });
		const all = this.aiUsageService.getTotals();

		const md = new MarkdownString('', { supportThemeIcons: true });
		md.appendMarkdown(`**${localize('aiUsageTooltipTitle', "Uso de Tokens de IA")}**\n\n`);
		md.appendMarkdown(`${line(localize('aiUsageTooltipToday', "Hoje"), today)}\n\n`);
		md.appendMarkdown(`${line(localize('aiUsageTooltipAll', "Desde o início"), all)}\n\n`);
		md.appendMarkdown(localize('aiUsageTooltipHint', "Abra _Uso de IA_ no editor de Personalizações do Agente para ver o detalhamento completo."));
		return md;
	}
}

function line(label: string, totals: IAIUsageTotals): string {
	return localize(
		'aiUsageTooltipLine',
		"{0}: {1} tokens ({2} entrada / {3} saída) · {4} requisições",
		label,
		(totals.inputTokens + totals.outputTokens).toLocaleString(),
		totals.inputTokens.toLocaleString(),
		totals.outputTokens.toLocaleString(),
		totals.requests,
	);
}

/** Compact number formatting for the tight status bar (e.g. `12.3k`). */
function formatCompact(value: number): string {
	if (value < 1000) {
		return String(value);
	}
	if (value < 1_000_000) {
		return `${(value / 1000).toFixed(1)}k`;
	}
	return `${(value / 1_000_000).toFixed(1)}M`;
}
