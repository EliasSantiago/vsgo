/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../../base/browser/dom.js';
import { ActionViewItem } from '../../../../../../base/browser/ui/actionbar/actionViewItems.js';
import { IAction } from '../../../../../../base/common/actions.js';
import { autorun, IObservable } from '../../../../../../base/common/observable.js';
import { localize } from '../../../../../../nls.js';
import { ChatPermissionLevel, isAutoApproveLevel } from '../../../common/constants.js';

export interface IAutoModeDelegate {
	readonly currentPermissionLevel: IObservable<ChatPermissionLevel>;
	readonly toggle: () => void;
}

/**
 * Pill button that toggles between "Interativo" (Default) and "Automático" (AutoApprove).
 * Clicking the button invokes the parent action's run(), which calls delegate.toggle().
 */
export class AutoModeToggleActionItem extends ActionViewItem {

	private _iconEl: HTMLElement | undefined;
	private _labelEl: HTMLElement | undefined;

	constructor(
		context: unknown,
		action: IAction,
		private readonly delegate: IAutoModeDelegate,
	) {
		super(context, action, { icon: false, label: false });
	}

	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('chat-auto-mode-toggle-container');

		// this.label is the <a class="action-label"> anchor created by ActionViewItem.
		// Appending into it keeps the icon on the left, before the text, with correct layout.
		const anchor = this.label!;
		anchor.classList.add('chat-auto-mode-toggle');

		this._iconEl = dom.append(anchor, dom.$('span.codicon'));
		this._labelEl = dom.append(anchor, dom.$('span.chat-auto-mode-label'));

		this._register(autorun(reader => {
			const level = this.delegate.currentPermissionLevel.read(reader);
			this._refresh(level);
		}));
	}

	private _refresh(level: ChatPermissionLevel): void {
		if (!this._iconEl || !this._labelEl || !this.label) { return; }
		const isAuto = isAutoApproveLevel(level);
		this.label.classList.toggle('is-auto', isAuto);
		this._iconEl.className = `codicon ${isAuto ? 'codicon-zap' : 'codicon-shield'}`;
		this._labelEl.textContent = isAuto
			? localize('chat.autoMode', 'Automático')
			: localize('chat.interactiveMode', 'Interativo');
		this.label.title = isAuto
			? localize('chat.autoModeTooltip', 'Modo Automático — o agente executa ações sem pedir confirmação. Clique para alternar.')
			: localize('chat.interactiveModeTooltip', 'Modo Interativo — o agente pede confirmação antes de executar ações. Clique para alternar.');
	}
}
