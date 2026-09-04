/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/chatSessionTabs.css';
import { $, addDisposableListener, append, clearNode, EventType } from '../../../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../../../base/browser/keyboardEvent.js';
import { DomScrollableElement } from '../../../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { KeyCode } from '../../../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { isEqual } from '../../../../../../base/common/resources.js';
import { ScrollbarVisibility } from '../../../../../../base/common/scrollable.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { URI } from '../../../../../../base/common/uri.js';
import { localize } from '../../../../../../nls.js';
import { IHoverService } from '../../../../../../platform/hover/browser/hover.js';
import { IAgentSession, isLocalAgentSessionItem } from '../../agentSessions/agentSessionsModel.js';
import { IAgentSessionsService } from '../../agentSessions/agentSessionsService.js';

/**
 * Delegate that connects the chat session tab strip to the hosting chat view.
 */
export interface IChatSessionTabsDelegate {

	/**
	 * Opens the chat session identified by `resource` in the chat view.
	 */
	openSession(resource: URI): void;

	/**
	 * Starts a new chat session.
	 */
	createNewChat(): void;

	/**
	 * Opens the full agent sessions history (sidebar).
	 */
	showHistory(): void;
}

/**
 * A horizontal, scrollable strip of tabs - one per local chat session - rendered
 * at the top of the chat view. The tabs are shown to the left of a trailing
 * "New Chat" (+) button. When the tabs overflow the available width a horizontal
 * scrollbar is shown.
 */
export class ChatSessionTabsControl extends Disposable {

	private static readonly HEIGHT = 35;

	private readonly container: HTMLElement;
	private readonly tabsList: HTMLElement;
	private readonly scrollable: DomScrollableElement;

	private readonly tabsDisposables = this._register(new DisposableStore());

	private activeResource: URI | undefined;
	private hasTabs = false;

	private readonly _onDidChangeHeight = this._register(new Emitter<void>());
	readonly onDidChangeHeight: Event<void> = this._onDidChangeHeight.event;

	constructor(
		parent: HTMLElement,
		private readonly delegate: IChatSessionTabsDelegate,
		@IAgentSessionsService private readonly agentSessionsService: IAgentSessionsService,
		@IHoverService private readonly hoverService: IHoverService,
	) {
		super();

		this.container = append(parent, $('.chat-session-tabs'));

		// Leading "Show Agent Sessions Sidebar" (history) button, before the session list
		const historyButton = append(this.container, $('.chat-session-tabs-history-button'));
		historyButton.tabIndex = 0;
		historyButton.setAttribute('role', 'button');
		append(historyButton, $(ThemeIcon.asCSSSelector(Codicon.history)));
		this._register(this.hoverService.setupDelayedHover(historyButton, { content: localize("showSessionHistory", "Show Chat History") }));
		this._register(addDisposableListener(historyButton, EventType.CLICK, () => this.delegate.showHistory()));
		this._register(addDisposableListener(historyButton, EventType.KEY_DOWN, e => {
			const event = new StandardKeyboardEvent(e);
			if (event.equals(KeyCode.Enter) || event.equals(KeyCode.Space)) {
				event.preventDefault();
				this.delegate.showHistory();
			}
		}));

		// Scrollable list of session tabs
		this.tabsList = $('.chat-session-tabs-list');
		this.scrollable = this._register(new DomScrollableElement(this.tabsList, {
			vertical: ScrollbarVisibility.Hidden,
			horizontal: ScrollbarVisibility.Visible,
			horizontalScrollbarSize: 3,
			useShadows: false,
			scrollYToX: true
		}));
		append(this.container, this.scrollable.getDomNode());

		// Trailing "New Chat" button
		const newButton = append(this.container, $('.chat-session-tabs-new-button'));
		newButton.tabIndex = 0;
		newButton.setAttribute('role', 'button');
		append(newButton, $(ThemeIcon.asCSSSelector(Codicon.plus)));
		this._register(this.hoverService.setupDelayedHover(newButton, { content: localize("newChat", "New Chat") }));
		this._register(addDisposableListener(newButton, EventType.CLICK, () => this.delegate.createNewChat()));
		this._register(addDisposableListener(newButton, EventType.KEY_DOWN, e => {
			const event = new StandardKeyboardEvent(e);
			if (event.equals(KeyCode.Enter) || event.equals(KeyCode.Space)) {
				event.preventDefault();
				this.delegate.createNewChat();
			}
		}));

		this._register(this.agentSessionsService.model.onDidChangeSessions(() => this.render()));
		this._register(this.agentSessionsService.model.onDidChangeSessionArchivedState(() => this.render()));

		this.render();
	}

	/**
	 * The height the control occupies. It collapses to `0` when there are no
	 * sessions to show so the chat widget can use the full height.
	 */
	get height(): number {
		return this.hasTabs ? ChatSessionTabsControl.HEIGHT : 0;
	}

	/**
	 * Marks the tab for `resource` as the active one.
	 */
	setActiveSession(resource: URI | undefined): void {
		if (isEqual(this.activeResource, resource)) {
			return;
		}

		this.activeResource = resource;
		this.render();
	}

	private render(): void {
		this.tabsDisposables.clear();
		clearNode(this.tabsList);

		const sessions = this.agentSessionsService.model.sessions
			.filter(session => isLocalAgentSessionItem(session) && !session.isArchived())
			.sort((a, b) => (b.timing.lastRequestStarted ?? b.timing.created) - (a.timing.lastRequestStarted ?? a.timing.created));

		const hadTabs = this.hasTabs;
		this.hasTabs = sessions.length > 0;
		this.container.classList.toggle('empty', !this.hasTabs);

		let activeTab: HTMLElement | undefined;
		for (const session of sessions) {
			const tab = this.renderTab(session);
			if (isEqual(this.activeResource, session.resource)) {
				activeTab = tab;
			}
		}

		this.scrollable.scanDomNode();
		activeTab?.scrollIntoView({ block: 'nearest', inline: 'nearest' });

		if (hadTabs !== this.hasTabs) {
			this._onDidChangeHeight.fire();
		}
	}

	private renderTab(session: IAgentSession): HTMLElement {
		const isActive = isEqual(this.activeResource, session.resource);

		const tab = append(this.tabsList, $('.chat-session-tab'));
		tab.classList.toggle('active', isActive);
		tab.tabIndex = 0;
		tab.setAttribute('role', 'tab');
		tab.setAttribute('aria-selected', String(isActive));

		const label = append(tab, $('span.chat-session-tab-label'));
		label.textContent = session.label || localize("untitledChat", "New Chat");

		this.tabsDisposables.add(this.hoverService.setupDelayedHover(tab, { content: session.label || localize("untitledChat", "New Chat") }));

		const open = () => this.delegate.openSession(session.resource);
		this.tabsDisposables.add(addDisposableListener(tab, EventType.CLICK, () => open()));
		this.tabsDisposables.add(addDisposableListener(tab, EventType.KEY_DOWN, e => {
			const event = new StandardKeyboardEvent(e);
			if (event.equals(KeyCode.Enter) || event.equals(KeyCode.Space)) {
				event.preventDefault();
				open();
			}
		}));

		// Close (archive) button
		const close = append(tab, $('.chat-session-tab-close' + ThemeIcon.asCSSSelector(Codicon.close)));
		close.setAttribute('role', 'button');
		this.tabsDisposables.add(this.hoverService.setupDelayedHover(close, { content: localize("closeChat", "Close") }));
		this.tabsDisposables.add(addDisposableListener(close, EventType.CLICK, e => {
			e.preventDefault();
			e.stopPropagation();
			session.setArchived(true);
		}));

		return tab;
	}

	layout(): void {
		this.scrollable.scanDomNode();
	}
}
