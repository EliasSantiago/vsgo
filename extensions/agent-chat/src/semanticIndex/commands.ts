/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { SemanticIndexService } from './semanticIndexService.js';

export function registerSemanticIndexCommands(index: SemanticIndexService): vscode.Disposable {
	return vscode.Disposable.from(
		vscode.commands.registerCommand('agent-chat.semanticIndex.rebuild', async () => {
			await vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: 'Reconstruindo o índice semântico',
				cancellable: true,
			}, async (_progress, token) => {
				await index.rebuild(token);
			});
			const stats = await index.stats();
			vscode.window.showInformationMessage(`Índice reconstruído: ${stats.chunks} trechos de ${stats.files} arquivos.`);
		}),
		vscode.commands.registerCommand('agent-chat.semanticIndex.status', async () => {
			const stats = await index.stats();
			if (!stats.enabled) {
				vscode.window.showInformationMessage('A busca semântica está desligada (`agent-chat.semanticIndex.enabled`).');
				return;
			}
			if (!stats.provisioned) {
				const setUp = 'Configurar';
				const choice = await vscode.window.showInformationMessage(
					`A busca semântica ainda não foi configurada: falta baixar o modelo ${stats.modelId}.`,
					setUp,
				);
				if (choice === setUp) {
					await index.promptForSetup();
				}
				return;
			}
			const megabytes = (stats.bytesOnDisk / 1048576).toFixed(1);
			const progress = stats.indexing ? ' Indexação ainda em andamento — a busca já funciona sobre o que foi indexado.' : '';
			vscode.window.showInformationMessage(
				`Índice semântico: ${stats.chunks} trechos de ${stats.files} arquivos, ${megabytes} MB em disco. Modelo ${stats.modelId} (${stats.dims ?? '?'} dimensões).${progress}`,
			);
		}),
	);
}
