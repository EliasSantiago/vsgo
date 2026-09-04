/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { FigmaApi, FigmaAuthError, FigmaToken, IFigmaNode, normalizeNodeId, parseFigmaTarget } from './figmaApi.js';
import { outlineNode } from './figmaFormat.js';
import { log } from '../logger.js';

export const FIGMA_TOOL_NAME = 'agent_figma';

export interface IFigmaToolInput {
	/** URL da Figma colada pelo usuário, ou a chave do arquivo. */
	target: string;
	action?: 'outline' | 'inspect' | 'image';
	nodeId?: string;
	depth?: number;
}

/**
 * Profundidades separadas por ação, e não uma só configurável.
 *
 * `outline` quer a planta do arquivo — páginas e frames de topo — e descer
 * demais ali só produz ruído. `inspect` é o oposto: já se sabe qual nó interessa
 * e o que se quer é tudo dentro dele, porque é dali que sai o código.
 */
const OUTLINE_DEPTH = 2;
const INSPECT_DEPTH = 12;

export class FigmaTool implements vscode.LanguageModelTool<IFigmaToolInput> {

	constructor(private readonly _api: FigmaApi) { }

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IFigmaToolInput>, token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
		const text = await this._run(options.input, token);
		return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
	}

	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<IFigmaToolInput>): Promise<vscode.PreparedToolInvocation> {
		const action = options.input.action ?? 'outline';
		const label = action === 'image' ? 'Renderizando' : action === 'inspect' ? 'Inspecionando' : 'Lendo';
		return { invocationMessage: `${label} o design na Figma` };
	}

	private async _run(input: IFigmaToolInput, token: vscode.CancellationToken): Promise<string> {
		const target = parseFigmaTarget(input.target ?? '');
		if (!target) {
			return 'Não reconheci esse alvo. Passe a URL do arquivo ou do frame na Figma (por exemplo `https://www.figma.com/design/ABC123/Meu-App?node-id=1-234`) ou a chave do arquivo.';
		}
		// O nó pode vir do parâmetro ou da própria URL. O explícito ganha: se o
		// modelo pediu um nó, é esse que ele quer, mesmo que a URL cite outro.
		const nodeId = input.nodeId ? normalizeNodeId(input.nodeId) : target.nodeId;
		const action = input.action ?? (nodeId ? 'inspect' : 'outline');

		try {
			switch (action) {
				case 'image':
					return await this._image(target.fileKey, nodeId, token);
				case 'inspect':
					return await this._inspect(target.fileKey, nodeId, input.depth, token);
				default:
					return await this._outline(target.fileKey, nodeId, input.depth, token);
			}
		} catch (err) {
			if (err instanceof FigmaAuthError) {
				return err.message;
			}
			if (token.isCancellationRequested) {
				return 'Consulta à Figma cancelada.';
			}
			const message = err instanceof Error ? err.message : String(err);
			log(`[figma] ${action} falhou: ${message}`);
			return `A consulta à Figma falhou: ${message}`;
		}
	}

	private async _outline(fileKey: string, nodeId: string | undefined, depth: number | undefined, token: vscode.CancellationToken): Promise<string> {
		if (nodeId) {
			return this._inspect(fileKey, nodeId, depth ?? OUTLINE_DEPTH, token);
		}
		const file = await this._api.file(fileKey, depth ?? OUTLINE_DEPTH, token);
		const head = `Arquivo "${file.name}" (modificado em ${file.lastModified})`;
		const body = outlineNode(file.document, { maxDepth: depth ?? OUTLINE_DEPTH });
		return [
			head,
			body,
			'',
			'Cada linha termina com o id do nó. Para ver um frame por dentro — com geometria, cores, tipografia e auto-layout —, chame de novo com `action: "inspect"` e o `nodeId` dele.',
		].join('\n');
	}

	private async _inspect(fileKey: string, nodeId: string | undefined, depth: number | undefined, token: vscode.CancellationToken): Promise<string> {
		if (!nodeId) {
			return 'Para inspecionar preciso de um nó: passe uma URL que contenha `node-id`, ou informe `nodeId`. Sem isso, use `action: "outline"` para ver a estrutura do arquivo e escolher um.';
		}
		const response = await this._api.nodes(fileKey, [nodeId], depth ?? INSPECT_DEPTH, token);
		const entry = response.nodes[nodeId];
		if (!entry) {
			return `O nó ${nodeId} não existe nesse arquivo (ou não está ao alcance deste token). Rode \`action: "outline"\` para ver os nós disponíveis.`;
		}
		return [
			`Nó ${nodeId} do arquivo "${response.name}"`,
			outlineNode(entry.document),
			'',
			legendFor(entry.document),
		].join('\n');
	}

	private async _image(fileKey: string, nodeId: string | undefined, token: vscode.CancellationToken): Promise<string> {
		if (!nodeId) {
			return 'Para renderizar preciso de um nó: passe uma URL com `node-id` ou informe `nodeId`.';
		}
		const result = await this._api.images(fileKey, [nodeId], 2, 'png', token);
		if (result.err) {
			return `A Figma não conseguiu renderizar: ${result.err}`;
		}
		const url = result.images[nodeId];
		if (!url) {
			return `A Figma não devolveu imagem para o nó ${nodeId}.`;
		}
		// A URL vai como texto, e não a imagem: os provedores descartam partes
		// binárias no resultado de uma ferramenta, então um PNG embutido não
		// chegaria ao modelo. Como texto, ele pode repassar o link ao usuário.
		return [
			`PNG (2×) do nó ${nodeId}:`,
			url,
			'',
			'Link temporário servido pela Figma. Você não consegue ver esta imagem — mostre o link ao usuário em markdown se ele quiser conferir o visual; para escrever o código, use `action: "inspect"`, que traz medidas e cores em texto.',
		].join('\n');
	}
}

/**
 * Diz ao modelo como ler o esboço.
 *
 * Sem isto, `[row gap 8 padding 16/24]` é adivinhação, e um modelo que adivinha
 * escreve CSS errado com confiança. Só aparece quando há auto-layout ou texto no
 * que voltou — a legenda custa tokens e não se paga quando não há o que explicar.
 */
function legendFor(root: IFigmaNode): string {
	let hasLayout = false;
	let hasText = false;
	const visit = (node: IFigmaNode): void => {
		if (node.layoutMode && node.layoutMode !== 'NONE') {
			hasLayout = true;
		}
		if (node.characters) {
			hasText = true;
		}
		for (const child of node.children ?? []) {
			visit(child);
		}
	};
	visit(root);

	const lines = ['Como ler: `TIPO "nome"  largura×altura  …  #id`.'];
	if (hasLayout) {
		lines.push('`[row|column gap N padding T/R/B/L main … cross …]` é auto-layout da Figma, equivalente a flexbox: `row`=`flex-direction: row`, `gap`=`gap`, `main`/`cross` são `justify-content`/`align-items`.');
	}
	lines.push('`fill`/`stroke` trazem a cor em hexadecimal (com alfa quando não é opaco); `radius` é o raio das quinas, em ordem TL/TR/BR/BL quando são diferentes.');
	if (hasText) {
		lines.push('Em nós de texto, `Família 16/24 w600` é família, tamanho/entrelinha em px e peso.');
	}
	return lines.join('\n');
}

/**
 * Ferramenta e comandos da Figma, num pacote só.
 *
 * Fica fora do `registerTools()` porque este precisa do cofre de segredos, que
 * só existe no contexto da extensão — e forçar aquele registro a receber o
 * contexto inteiro por causa de uma ferramenta seria pior do que este par.
 */
export function registerFigma(secrets: vscode.SecretStorage): vscode.Disposable {
	const tokenStore = new FigmaToken(secrets);
	const api = new FigmaApi(tokenStore);
	return vscode.Disposable.from(
		vscode.lm.registerTool(FIGMA_TOOL_NAME, new FigmaTool(api)),
		registerFigmaCommands(tokenStore, api),
	);
}

/** Comandos de conexão. O token fica no cofre; nunca em settings nem no log. */
function registerFigmaCommands(tokenStore: FigmaToken, api: FigmaApi): vscode.Disposable {
	const subs: vscode.Disposable[] = [];

	subs.push(vscode.commands.registerCommand('agent-chat.figma.connect', async () => {
		const entered = await vscode.window.showInputBox({
			title: 'Conectar à Figma',
			prompt: 'Token pessoal da Figma. Gere em Settings → Security → Personal access tokens → Generate new token, marcando o escopo file_content:read ("Read the contents of files"). A Figma só mostra o token uma vez.',
			placeHolder: 'figd_...',
			password: true,
			ignoreFocusOut: true,
			validateInput: value => value.trim() ? undefined : 'O token é obrigatório',
		});
		if (!entered) {
			return;
		}
		await tokenStore.store(entered);

		// Confere na hora. Guardar um token errado em silêncio empurra a falha para
		// o meio de uma conversa, onde ela parece problema da ferramenta.
		const cts = new vscode.CancellationTokenSource();
		try {
			const me = await api.me(cts.token);
			const who = me.handle || me.email || 'conta desconhecida';
			vscode.window.showInformationMessage(`Figma conectada como ${who}.`);
		} catch (err) {
			await tokenStore.delete();
			const message = err instanceof Error ? err.message : String(err);
			vscode.window.showErrorMessage(`Token recusado pela Figma, nada foi guardado. ${message}`);
		} finally {
			cts.dispose();
		}
	}));

	subs.push(vscode.commands.registerCommand('agent-chat.figma.disconnect', async () => {
		await tokenStore.delete();
		vscode.window.showInformationMessage('Token da Figma removido.');
	}));

	return vscode.Disposable.from(...subs);
}
