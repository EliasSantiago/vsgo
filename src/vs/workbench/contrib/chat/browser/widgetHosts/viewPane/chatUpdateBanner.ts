/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/chatUpdateBanner.css';
import { $, append, clearNode } from '../../../../../../base/browser/dom.js';
import { Button } from '../../../../../../base/browser/ui/button/button.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { localize } from '../../../../../../nls.js';
import { IHoverService } from '../../../../../../platform/hover/browser/hover.js';
import { IProductService } from '../../../../../../platform/product/common/productService.js';
import { defaultButtonStyles } from '../../../../../../platform/theme/browser/defaultStyles.js';
import { IUpdateService, State as UpdateState, StateType } from '../../../../../../platform/update/common/update.js';

/**
 * What the banner shows for the current update state: the message, and the
 * action offered to the user (absent while something is in progress).
 */
interface IBannerContent {
	readonly message: string;
	readonly action?: { readonly label: string; readonly run: () => void };
	readonly busy?: boolean;
}

/**
 * A slim strip at the top of the chat view announcing that a new version of the
 * product is available, with the button that carries the update forward.
 *
 * It sits next to the conversation on purpose: the chat is where people spend
 * their time, and the global activity badge goes unnoticed.
 */
export class ChatUpdateBanner extends Disposable {

	private static readonly HEIGHT = 40;

	private readonly container: HTMLElement;
	private readonly contentDisposables = this._register(new DisposableStore());

	private readonly _onDidChangeHeight = this._register(new Emitter<void>());
	readonly onDidChangeHeight: Event<void> = this._onDidChangeHeight.event;

	private visible = false;

	/** The state the user dismissed, so the same announcement does not come back. */
	private dismissedState: StateType | undefined;

	constructor(
		parent: HTMLElement,
		@IUpdateService private readonly updateService: IUpdateService,
		@IProductService private readonly productService: IProductService,
		@IHoverService private readonly hoverService: IHoverService,
	) {
		super();

		this.container = append(parent, $('.chat-update-banner.empty'));

		this._register(this.updateService.onStateChange(state => this.render(state)));
		this.render(this.updateService.state);
	}

	/**
	 * The height the banner occupies. It collapses to `0` when there is no
	 * update to announce, so the chat widget gets the full height.
	 */
	get height(): number {
		return this.visible ? ChatUpdateBanner.HEIGHT : 0;
	}

	private render(state: UpdateState): void {
		this.contentDisposables.clear();
		clearNode(this.container);

		// A new state is a new announcement, so an earlier dismissal no longer applies.
		if (this.dismissedState !== undefined && this.dismissedState !== state.type) {
			this.dismissedState = undefined;
		}

		const content = this.dismissedState === state.type ? undefined : this.getContent(state);
		const wasVisible = this.visible;
		this.visible = !!content;
		this.container.classList.toggle('empty', !this.visible);

		if (content) {
			this.renderContent(content, state.type);
		}

		if (wasVisible !== this.visible) {
			this._onDidChangeHeight.fire();
		}
	}

	private getContent(state: UpdateState): IBannerContent | undefined {
		const name = this.productService.nameShort;

		switch (state.type) {
			case StateType.AvailableForDownload:
				return {
					message: localize('chatUpdateBanner.available', "Uma nova versão do {0} está disponível.", name),
					action: {
						label: localize('chatUpdateBanner.download', "Baixar"),
						run: () => this.updateService.downloadUpdate(true)
					}
				};

			case StateType.Downloading:
				return { message: localize('chatUpdateBanner.downloading', "Baixando a atualização..."), busy: true };

			case StateType.Downloaded:
				return {
					message: localize('chatUpdateBanner.downloaded', "A atualização do {0} foi baixada.", name),
					action: {
						label: localize('chatUpdateBanner.install', "Instalar"),
						run: () => this.updateService.applyUpdate()
					}
				};

			case StateType.Updating:
				return { message: localize('chatUpdateBanner.updating', "Instalando a atualização..."), busy: true };

			case StateType.Ready: {
				const version = state.update.productVersion;
				return {
					message: version
						? localize('chatUpdateBanner.readyVersion', "{0} {1} pronto para instalar.", name, version)
						: localize('chatUpdateBanner.ready', "Atualização do {0} pronta para instalar.", name),
					action: {
						label: localize('chatUpdateBanner.restart', "Reiniciar agora"),
						run: () => this.updateService.quitAndInstall()
					}
				};
			}

			default:
				return undefined; // nothing worth interrupting the user for
		}
	}

	private renderContent(content: IBannerContent, stateType: StateType): void {
		const icon = content.busy ? Codicon.sync : Codicon.cloudDownload;
		const iconElement = append(this.container, $(ThemeIcon.asCSSSelector(icon)));
		iconElement.classList.add('chat-update-banner-icon');
		iconElement.classList.toggle('spinning', !!content.busy);

		const message = append(this.container, $('.chat-update-banner-message'));
		message.textContent = content.message;
		this.contentDisposables.add(this.hoverService.setupDelayedHover(message, () => ({ content: content.message })));

		if (content.action) {
			const button = this.contentDisposables.add(new Button(this.container, { ...defaultButtonStyles, title: content.action.label }));
			button.label = content.action.label;
			button.element.classList.add('chat-update-banner-action');
			this.contentDisposables.add(button.onDidClick(() => content.action!.run()));
		}

		const dismissLabel = localize('chatUpdateBanner.dismiss', "Dispensar");
		const dismiss = append(this.container, $(`.chat-update-banner-dismiss${ThemeIcon.asCSSSelector(Codicon.close)}`));
		dismiss.tabIndex = 0;
		dismiss.setAttribute('role', 'button');
		dismiss.setAttribute('aria-label', dismissLabel);
		this.contentDisposables.add(this.hoverService.setupDelayedHover(dismiss, () => ({ content: dismissLabel })));
		this.contentDisposables.add(this.registerDismiss(dismiss, stateType));
	}

	private registerDismiss(element: HTMLElement, stateType: StateType): DisposableStore {
		const store = new DisposableStore();
		const dismiss = () => {
			this.dismissedState = stateType;
			this.render(this.updateService.state);
		};

		store.add(Event.fromDOMEventEmitter(element, 'click')(dismiss));
		store.add(Event.fromDOMEventEmitter<KeyboardEvent>(element, 'keydown')(e => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				dismiss();
			}
		}));

		return store;
	}
}
