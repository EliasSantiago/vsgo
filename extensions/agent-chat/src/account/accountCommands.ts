/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { VSGO_AUTH_ID, VsgoAuthProvider, vsgoBaseUrl } from './vsgoAuth.js';
import { VsgoProvider } from '../providers/vsgo.js';
import { log } from '../logger.js';

/**
 * Comandos da conta vsgo.
 *
 * `signIn` passa por `vscode.authentication` em vez de chamar o provedor
 * direto: é ali que mora o consentimento por extensão e a conta que aparece no
 * menu lateral, e ignorá-lo deixaria a sessão invisível para o resto do editor.
 */
export function registerAccountCommands(
	auth: VsgoAuthProvider,
	provider: VsgoProvider,
): vscode.Disposable {
	const subs: vscode.Disposable[] = [];

	subs.push(vscode.commands.registerCommand('agent-chat.vsgo.signIn', () => signIn(provider)));

	subs.push(vscode.commands.registerCommand('agent-chat.vsgo.signOut', async () => {
		const session = await auth.currentSession();
		if (!session) {
			vscode.window.showInformationMessage('Nenhuma conta vsgo conectada nesta instalação.');
			return;
		}
		const confirm = await vscode.window.showWarningMessage(
			`Sair da conta ${session.account.email ?? session.account.id}?`,
			{ modal: true, detail: 'A credencial desta instalação é revogada. Você pode conectar de novo quando quiser.' },
			'Sair',
		);
		if (confirm !== 'Sair') {
			return;
		}
		await auth.removeSession(session.id);
		provider.refresh();
		vscode.window.showInformationMessage('Conta vsgo desconectada desta instalação.');
	}));

	subs.push(vscode.commands.registerCommand('agent-chat.vsgo.openDashboard', () =>
		vscode.env.openExternal(vscode.Uri.parse(`${vsgoBaseUrl()}/dashboard`))));

	// Também o `managementCommand` do vendor: o que a engrenagem do seletor de
	// modelos abre quando a conta vsgo está na lista.
	subs.push(vscode.commands.registerCommand('agent-chat.vsgo.manageAccount', () => manage(auth, provider)));

	return vscode.Disposable.from(...subs);
}

async function signIn(provider: VsgoProvider): Promise<void> {
	try {
		const session = await vscode.authentication.getSession(VSGO_AUTH_ID, [], { createIfNone: true });
		provider.refresh();
		vscode.window.showInformationMessage(`Conta vsgo conectada: ${session.account.label}.`);
	} catch (err) {
		if (err instanceof vscode.CancellationError) {
			return;
		}
		const message = err instanceof Error ? err.message : String(err);
		log('[vsgo] falha ao conectar a conta:', message);
		vscode.window.showErrorMessage(`Não foi possível conectar a conta vsgo. ${message}`);
	}
}

/**
 * O que a pessoa pode fazer com a conta, no estado em que ela está.
 *
 * Conectada, o plano aparece no topo — é a resposta para "por que este modelo
 * não está na lista?", que sem isto vira uma ida ao site para descobrir.
 */
async function manage(auth: VsgoAuthProvider, provider: VsgoProvider): Promise<void> {
	const session = await auth.currentSession();

	if (!session) {
		const choice = await vscode.window.showQuickPick(
			[
				{ label: '$(sign-in) Entrar na conta vsgo', detail: 'Abre o navegador para autorizar esta instalação', id: 'in' },
				{ label: '$(link-external) Ver planos e preços', detail: `${vsgoBaseUrl()}/precos`, id: 'plans' },
			],
			{ title: 'Conta vsgo', placeHolder: 'Nenhuma conta conectada nesta instalação' },
		);
		if (choice?.id === 'in') {
			await signIn(provider);
		} else if (choice?.id === 'plans') {
			await vscode.env.openExternal(vscode.Uri.parse(`${vsgoBaseUrl()}/precos`));
		}
		return;
	}

	const choice = await vscode.window.showQuickPick(
		[
			{ label: '$(refresh) Atualizar a lista de modelos', detail: 'Depois de trocar de plano, por exemplo', id: 'refresh' },
			{ label: '$(dashboard) Abrir o painel', detail: `${vsgoBaseUrl()}/dashboard`, id: 'dash' },
			{ label: '$(sign-out) Sair desta conta', detail: 'Revoga a credencial desta instalação', id: 'out' },
		],
		{
			title: `Conta vsgo · plano ${session.plan.name}`,
			placeHolder: session.account.email ?? session.account.id,
		},
	);

	switch (choice?.id) {
		case 'refresh':
			provider.refresh();
			vscode.window.showInformationMessage('Lista de modelos da conta vsgo atualizada.');
			break;
		case 'dash':
			await vscode.env.openExternal(vscode.Uri.parse(`${vsgoBaseUrl()}/dashboard`));
			break;
		case 'out':
			await vscode.commands.executeCommand('agent-chat.vsgo.signOut');
			break;
	}
}
