/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/aiCustomizationManagement.css';
import * as DOM from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { AIUsageGranularity, IAIUsageFilter, IAIUsageService, IAIUsageTotals } from '../../common/aiUsageService.js';

const $ = DOM.$;

/**
 * Section widget for the AI Customization Management Editor that visualizes
 * language model token usage: at-a-glance totals (today / month / year / all
 * time) and a breakdown grouped by day, month or year, with vendor and model
 * filters. Backed entirely by {@link IAIUsageService}.
 */
export class AIUsageWidget extends Disposable {

	readonly element: HTMLElement;

	private readonly renderDisposables = this._register(new DisposableStore());

	private granularity: AIUsageGranularity = 'day';
	private vendorFilter: string | undefined;
	private modelFilter: string | undefined;

	private summaryContainer!: HTMLElement;
	private controlsContainer!: HTMLElement;
	private tableContainer!: HTMLElement;

	constructor(
		@IAIUsageService private readonly aiUsageService: IAIUsageService,
		@IDialogService private readonly dialogService: IDialogService,
	) {
		super();
		this.element = $('.ai-usage-widget');
		this.create();
		this._register(this.aiUsageService.onDidChangeUsage(() => this.refresh()));
	}

	private create(): void {
		const header = DOM.append(this.element, $('.ai-usage-header'));
		const description = DOM.append(header, $('p.ai-usage-description'));
		description.textContent = localize('aiUsageInfo', "Track language model token consumption across all providers. Totals are estimates based on each provider's token counter.");

		this.summaryContainer = DOM.append(this.element, $('.ai-usage-summary'));
		this.controlsContainer = DOM.append(this.element, $('.ai-usage-controls'));
		this.tableContainer = DOM.append(this.element, $('.ai-usage-table'));

		this.refresh();
	}

	render(): void {
		this.refresh();
	}

	private refresh(): void {
		this.renderDisposables.clear();
		this.renderSummary();
		this.renderControls();
		this.renderTable();
	}

	private currentFilter(): IAIUsageFilter {
		return {
			vendors: this.vendorFilter ? [this.vendorFilter] : undefined,
			modelIds: this.modelFilter ? [this.modelFilter] : undefined,
		};
	}

	private renderSummary(): void {
		DOM.clearNode(this.summaryContainer);
		const filter = this.currentFilter();
		const now = new Date();
		const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
		const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
		const startOfYear = new Date(now.getFullYear(), 0, 1).getTime();

		const cards: { label: string; totals: IAIUsageTotals }[] = [
			{ label: localize('usageToday', "Today"), totals: this.aiUsageService.getTotals({ ...filter, from: startOfDay }) },
			{ label: localize('usageMonth', "This Month"), totals: this.aiUsageService.getTotals({ ...filter, from: startOfMonth }) },
			{ label: localize('usageYear', "This Year"), totals: this.aiUsageService.getTotals({ ...filter, from: startOfYear }) },
			{ label: localize('usageAll', "All Time"), totals: this.aiUsageService.getTotals(filter) },
		];

		for (const card of cards) {
			const cardEl = DOM.append(this.summaryContainer, $('.ai-usage-card'));
			DOM.append(cardEl, $('.ai-usage-card-label')).textContent = card.label;
			DOM.append(cardEl, $('.ai-usage-card-value')).textContent = formatTokens(card.totals.inputTokens + card.totals.outputTokens);
			DOM.append(cardEl, $('.ai-usage-card-sub')).textContent = localize('usageCardSub', "{0} requests · {1} in · {2} out", card.totals.requests, formatTokens(card.totals.inputTokens), formatTokens(card.totals.outputTokens));
		}
	}

	private renderControls(): void {
		DOM.clearNode(this.controlsContainer);

		// Granularity segmented buttons.
		const granularityGroup = DOM.append(this.controlsContainer, $('.ai-usage-granularity'));
		const options: { id: AIUsageGranularity; label: string }[] = [
			{ id: 'day', label: localize('granularityDay', "Day") },
			{ id: 'month', label: localize('granularityMonth', "Month") },
			{ id: 'year', label: localize('granularityYear', "Year") },
		];
		for (const option of options) {
			const button = DOM.append(granularityGroup, $('button.ai-usage-granularity-button')) as HTMLButtonElement;
			button.textContent = option.label;
			button.classList.toggle('active', this.granularity === option.id);
			this.renderDisposables.add(DOM.addDisposableListener(button, 'click', () => {
				this.granularity = option.id;
				this.refresh();
			}));
		}

		// Vendor and model filters.
		this.renderFilterSelect(
			localize('filterVendor', "Provider"),
			[{ value: '', label: localize('allVendors', "All providers") }, ...this.aiUsageService.getVendors().map(v => ({ value: v, label: v }))],
			this.vendorFilter ?? '',
			value => { this.vendorFilter = value || undefined; this.refresh(); },
		);
		this.renderFilterSelect(
			localize('filterModel', "Model"),
			[{ value: '', label: localize('allModels', "All models") }, ...this.aiUsageService.getModelIds().map(m => ({ value: m, label: m }))],
			this.modelFilter ?? '',
			value => { this.modelFilter = value || undefined; this.refresh(); },
		);

		// Clear button.
		const clearButton = this.renderDisposables.add(new Button(this.controlsContainer, { ...defaultButtonStyles, secondary: true }));
		clearButton.label = localize('clearUsage', "Clear History");
		clearButton.element.classList.add('ai-usage-clear');
		this.renderDisposables.add(clearButton.onDidClick(async () => {
			const confirmed = await this.dialogService.confirm({
				message: localize('clearUsageConfirm', "Clear all recorded token usage?"),
				detail: localize('clearUsageDetail', "This permanently removes the usage history. This cannot be undone."),
				primaryButton: localize('clearUsageYes', "Clear"),
			});
			if (confirmed.confirmed) {
				this.aiUsageService.clear();
			}
		}));
	}

	private renderFilterSelect(label: string, options: { value: string; label: string }[], selected: string, onChange: (value: string) => void): void {
		const wrapper = DOM.append(this.controlsContainer, $('.ai-usage-filter'));
		DOM.append(wrapper, $('span.ai-usage-filter-label')).textContent = label;
		const select = DOM.append(wrapper, $('select.ai-usage-filter-select')) as HTMLSelectElement;
		for (const option of options) {
			const optionEl = DOM.append(select, $('option')) as HTMLOptionElement;
			optionEl.value = option.value;
			optionEl.textContent = option.label;
			optionEl.selected = option.value === selected;
		}
		this.renderDisposables.add(DOM.addDisposableListener(select, 'change', () => onChange(select.value)));
	}

	private renderTable(): void {
		DOM.clearNode(this.tableContainer);
		const rows = this.aiUsageService.getTotalsByPeriod(this.granularity, this.currentFilter());

		if (rows.length === 0) {
			DOM.append(this.tableContainer, $('.ai-usage-empty')).textContent = localize('noUsage', "No usage recorded yet for the selected filters.");
			return;
		}

		const table = DOM.append(this.tableContainer, $('table.ai-usage-grid'));
		const headerRow = DOM.append(DOM.append(table, $('thead')), $('tr'));
		for (const heading of [
			localize('colPeriod', "Period"),
			localize('colRequests', "Requests"),
			localize('colInput', "Input"),
			localize('colOutput', "Output"),
			localize('colTotal', "Total"),
		]) {
			DOM.append(headerRow, $('th')).textContent = heading;
		}

		const body = DOM.append(table, $('tbody'));
		for (const row of rows) {
			const tr = DOM.append(body, $('tr'));
			DOM.append(tr, $('td.ai-usage-cell-period')).textContent = row.period;
			DOM.append(tr, $('td')).textContent = String(row.requests);
			DOM.append(tr, $('td')).textContent = formatTokens(row.inputTokens);
			DOM.append(tr, $('td')).textContent = formatTokens(row.outputTokens);
			DOM.append(tr, $('td.ai-usage-cell-total')).textContent = formatTokens(row.inputTokens + row.outputTokens);
		}
	}
}

/** Formats a token count with locale grouping (e.g. `12,345`). */
function formatTokens(value: number): string {
	return value.toLocaleString();
}
