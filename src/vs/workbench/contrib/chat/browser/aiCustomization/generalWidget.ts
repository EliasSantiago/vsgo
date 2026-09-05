/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/aiCustomizationManagement.css';
import * as DOM from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { URI } from '../../../../../base/common/uri.js';
import { IPreferencesService } from '../../../../services/preferences/common/preferences.js';
import { IAuthenticationService } from '../../../../services/authentication/common/authentication.js';

const $ = DOM.$;

/**
 * O que a extensão da conta devolve sobre quem está conectado.
 *
 * Vem por comando, e não da `AuthenticationSession`, porque a sessão só carrega
 * `id` e `label` — e esta tela mostra nome E e-mail em linhas diferentes, como
 * o menu de conta de qualquer produto. Quem é dona do dado é a extensão.
 */
interface IAccountInfo {
	readonly name?: string;
	readonly email?: string;
	readonly plan?: string;
}

/**
 * A seção "Geral" da Personalização do Agente.
 *
 * É a primeira coisa que a tela abre, e a primeira coisa dela é a conta: sem
 * conta conectada, um convite para entrar ou criar; com conta, quem está
 * conectado e o botão de sair. Depois vêm os atalhos que a pessoa procura aqui
 * mesmo quando veio por outro motivo — configurações do editor, atalhos de
 * teclado, painel da conta no site.
 *
 * O formato é o de uma lista de linhas: rótulo e explicação à esquerda, o
 * controle à direita. É o mesmo desenho das outras seções desta tela, e o que
 * um usuário de editor moderno espera encontrar numa tela de configurações.
 */
export class GeneralWidget extends Disposable {

	readonly element: HTMLElement;

	private readonly renderDisposables = this._register(new DisposableStore());

	private accountContainer!: HTMLElement;

	constructor(
		@ICommandService private readonly commandService: ICommandService,
		@IProductService private readonly productService: IProductService,
		@IAuthenticationService private readonly authenticationService: IAuthenticationService,
		@IPreferencesService private readonly preferencesService: IPreferencesService,
		@IOpenerService private readonly openerService: IOpenerService,
	) {
		super();
		this.element = $('.general-widget');
		this.create();

		/*
		 * A conta muda por fora desta tela — pelo menu de Contas, pelo comando
		 * "Sair", por uma chave revogada no painel. Redesenhar no evento é o
		 * que evita a tela dizer "Entrar" para quem acabou de entrar.
		 */
		const providerId = this.productService.defaultChatAgent?.provider.default.id;
		if (providerId) {
			this._register(this.authenticationService.onDidChangeSessions(e => {
				if (e.providerId === providerId) {
					void this.renderAccount();
				}
			}));
			this._register(this.authenticationService.onDidRegisterAuthenticationProvider(e => {
				if (e.id === providerId) {
					void this.renderAccount();
				}
			}));
		}
	}

	private create(): void {
		const header = DOM.append(this.element, $('.general-header'));
		DOM.append(header, $('h2.general-title')).textContent = localize('generalTitle', "Geral");
		DOM.append(header, $('p.general-description')).textContent = localize('generalDesc', "A sua conta e os ajustes que valem para o editor inteiro.");

		this.accountContainer = this.createGroup();
		void this.renderAccount();

		this.renderPreferences();
	}

	/**
	 * Um grupo de ajustes: título opcional e, abaixo, o bloco onde as linhas
	 * entram. As linhas ficam juntas num bloco só, com divisória entre elas,
	 * em vez de um cartão solto para cada — é o que faz uma lista de ajustes
	 * ser lida como uma lista, e não como um mosaico.
	 */
	private createGroup(title?: string): HTMLElement {
		const group = DOM.append(this.element, $('.general-group'));
		if (title) {
			DOM.append(group, $('.general-group-title')).textContent = title;
		}
		return DOM.append(group, $('.general-rows'));
	}

	render(): void {
		void this.renderAccount();
	}

	/** Uma linha da lista: rótulo, explicação e o controle à direita. */
	private createRow(parent: HTMLElement, label: string, description: string): HTMLElement {
		const row = DOM.append(parent, $('.general-row'));
		const text = DOM.append(row, $('.general-row-text'));
		DOM.append(text, $('.general-row-label')).textContent = label;
		DOM.append(text, $('.general-row-description')).textContent = description;
		return DOM.append(row, $('.general-row-action'));
	}

	private button(parent: HTMLElement, label: string, run: () => void, secondary = false): void {
		const button = this.renderDisposables.add(new Button(parent, { ...defaultButtonStyles, secondary }));
		button.label = label;
		this.renderDisposables.add(button.onDidClick(run));
	}

	private async renderAccount(): Promise<void> {
		this.renderDisposables.clear();
		DOM.clearNode(this.accountContainer);

		const agent = this.productService.defaultChatAgent;
		const signIn = agent?.accountSignInCommand;
		const signUp = agent?.accountSignUpCommand;
		const signOut = agent?.accountSignOutCommand;

		// Produto sem conta própria (Code OSS puro): não há o que mostrar aqui.
		if (!signIn) {
			return;
		}

		const account = await this.readAccount();

		if (!account) {
			const action = this.createRow(
				this.accountContainer,
				localize('signInTitle', "Entrar"),
				localize('signInDesc', "Entre na sua conta para usar os modelos de IA sem administrar chave de provedor."),
			);
			if (signUp) {
				this.button(action, localize('signUpButton', "Criar conta"), () => {
					void this.commandService.executeCommand(signUp);
				}, true);
			}
			this.button(action, localize('signInButton', "Entrar"), () => {
				void this.commandService.executeCommand(signIn);
			});
			return;
		}

		/*
		 * Conectado, a linha vira a identidade: o nome em cima, o e-mail
		 * embaixo. Sem nome no cadastro, o e-mail sobe para o lugar dele — uma
		 * linha vazia diria menos do que repetir o endereço.
		 */
		const row = DOM.append(this.accountContainer, $('.general-row'));
		const text = DOM.append(row, $('.general-row-text'));
		DOM.append(text, $('.general-row-label')).textContent = account.name ?? account.email ?? localize('accountFallback', "Conta conectada");
		const detail = DOM.append(text, $('.general-row-description'));
		detail.textContent = account.name && account.email ? account.email : '';
		if (account.plan) {
			DOM.append(text, $('.general-row-badge')).textContent = localize('accountPlan', "Plano {0}", account.plan);
		}

		const action = DOM.append(row, $('.general-row-action'));
		if (signOut) {
			this.button(action, localize('signOutButton', "Sair"), () => {
				void this.commandService.executeCommand(signOut);
			}, true);
		}
	}

	/**
	 * Pergunta à extensão da conta quem está conectado.
	 *
	 * Falha em silêncio de propósito. O erro que se espera aqui é "comando não
	 * encontrado", de uma extensão que ainda não ativou, e o certo nesse
	 * instante é mostrar "Entrar" — não um aviso vermelho sobre algo que se
	 * resolve sozinho um segundo depois. Quando ela ativa, registra o provedor
	 * de autenticação, e o listener do construtor redesenha a seção.
	 */
	private async readAccount(): Promise<IAccountInfo | undefined> {
		const command = this.productService.defaultChatAgent?.accountInfoCommand;
		if (!command) {
			return undefined;
		}
		try {
			return await this.commandService.executeCommand<IAccountInfo | undefined>(command);
		} catch {
			return undefined;
		}
	}

	private renderPreferences(): void {
		const group = this.createGroup(localize('preferences', "Preferências"));

		const settings = this.createRow(
			group,
			localize('editorSettings', "Configurações do editor"),
			localize('editorSettingsDesc', "Fonte, formatação, minimapa e todo o resto."),
		);
		this.buttonPersistent(settings, localize('open', "Abrir"), () => {
			void this.preferencesService.openUserSettings();
		});

		const keybindings = this.createRow(
			group,
			localize('keyboardShortcuts', "Atalhos de teclado"),
			localize('keyboardShortcutsDesc', "Veja e mude os atalhos de todos os comandos."),
		);
		this.buttonPersistent(keybindings, localize('open', "Abrir"), () => {
			void this.preferencesService.openGlobalKeybindingSettings(false);
		});

		const dashboardUrl = this.productService.defaultChatAgent?.accountDashboardUrl;
		if (dashboardUrl) {
			const dashboard = this.createRow(
				group,
				localize('accountDashboard', "Painel da conta"),
				localize('accountDashboardDesc', "Consumo, plano e cobrança, no site."),
			);
			this.buttonPersistent(dashboard, localize('openExternal', "Abrir no navegador"), () => {
				void this.openerService.open(URI.parse(dashboardUrl));
			});
		}
	}

	/*
	 * Os botões das preferências vivem enquanto o widget viver: são desenhados
	 * uma vez só, e não a cada refresh da conta — que é quem limpa o
	 * `renderDisposables`.
	 */
	private buttonPersistent(parent: HTMLElement, label: string, run: () => void): void {
		const button = this._register(new Button(parent, { ...defaultButtonStyles, secondary: true }));
		button.label = label;
		this._register(button.onDidClick(run));
	}
}
