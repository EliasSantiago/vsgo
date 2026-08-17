/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/**
 * Acesso de leitura à API REST da Figma.
 *
 * Existe porque o servidor MCP remoto da Figma não é uma opção aqui: ele só
 * aceita clientes de uma allowlist ("Only clients listed in the Figma MCP
 * Catalog can connect"), o registro dinâmico responde 403 para qualquer outro, e
 * o escopo `mcp:connect` não é concedido a apps OAuth comuns. A API REST não tem
 * nada disso — um token pessoal basta, e ela entrega a mesma coisa que interessa
 * ao agente: a estrutura, a geometria e os estilos do que foi desenhado.
 */

const API_BASE = 'https://api.figma.com/v1';
const SECRET_KEY = 'agent-chat.figma.token';

/** Token pessoal da Figma, guardado no cofre do VS Code e nunca em settings. */
export class FigmaToken {
	constructor(private readonly _secrets: vscode.SecretStorage) { }

	get(): Thenable<string | undefined> {
		return this._secrets.get(SECRET_KEY);
	}

	store(token: string): Thenable<void> {
		return this._secrets.store(SECRET_KEY, token.trim());
	}

	delete(): Thenable<void> {
		return this._secrets.delete(SECRET_KEY);
	}
}

export class FigmaAuthError extends Error { }

/** O que se consegue extrair de uma URL da Figma colada pelo usuário. */
export interface IFigmaTarget {
	readonly fileKey: string;
	/** Presente quando a URL apontava para um nó selecionado. Formato da API (`1:234`). */
	readonly nodeId?: string;
}

/**
 * Lê uma URL da Figma, ou aceita uma chave de arquivo crua.
 *
 * As URLs vêm em duas formas — `/design/<key>/…` nas atuais e `/file/<key>/…`
 * nas antigas — e o `node-id` na barra de endereço usa hífen (`1-234`) enquanto
 * a API quer dois-pontos (`1:234`). Traduzir isso aqui é o que permite ao usuário
 * simplesmente colar o link que ele já tem aberto no navegador, que é a única
 * forma que alguém realmente usa.
 */
export function parseFigmaTarget(input: string): IFigmaTarget | undefined {
	const trimmed = input.trim();
	if (!trimmed) {
		return undefined;
	}

	if (!/^https?:\/\//i.test(trimmed)) {
		// Chave crua. As chaves da Figma são alfanuméricas; recusar o resto evita
		// tratar uma frase solta como se fosse um identificador.
		return /^[A-Za-z0-9]{10,}$/.test(trimmed) ? { fileKey: trimmed } : undefined;
	}

	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return undefined;
	}
	if (!/(^|\.)figma\.com$/i.test(url.hostname)) {
		return undefined;
	}

	const segments = url.pathname.split('/').filter(Boolean);
	const kindAt = segments.findIndex(s => s === 'design' || s === 'file' || s === 'proto' || s === 'board' || s === 'slides');
	const fileKey = kindAt >= 0 ? segments[kindAt + 1] : undefined;
	if (!fileKey) {
		return undefined;
	}

	const rawNodeId = url.searchParams.get('node-id') ?? undefined;
	return { fileKey, nodeId: rawNodeId ? normalizeNodeId(rawNodeId) : undefined };
}

/** `1-234` (barra de endereço) e `1:234` (API) são o mesmo nó. */
export function normalizeNodeId(id: string): string {
	return id.trim().replace(/-/g, ':');
}

export interface IFigmaFileSummary {
	readonly name: string;
	readonly lastModified: string;
	readonly editorType?: string;
	readonly document: IFigmaNode;
}

/** Só o que o formatador usa. O JSON real da Figma tem muito mais. */
export interface IFigmaNode {
	readonly id: string;
	readonly name: string;
	readonly type: string;
	readonly children?: IFigmaNode[];
	readonly absoluteBoundingBox?: { x: number; y: number; width: number; height: number };
	readonly fills?: IFigmaPaint[];
	readonly strokes?: IFigmaPaint[];
	readonly strokeWeight?: number;
	readonly cornerRadius?: number;
	readonly rectangleCornerRadii?: number[];
	readonly opacity?: number;
	readonly visible?: boolean;
	readonly characters?: string;
	readonly style?: IFigmaTypeStyle;
	readonly layoutMode?: 'NONE' | 'HORIZONTAL' | 'VERTICAL';
	readonly itemSpacing?: number;
	readonly paddingLeft?: number;
	readonly paddingRight?: number;
	readonly paddingTop?: number;
	readonly paddingBottom?: number;
	readonly primaryAxisAlignItems?: string;
	readonly counterAxisAlignItems?: string;
	readonly componentId?: string;
}

export interface IFigmaPaint {
	readonly type: string;
	readonly visible?: boolean;
	readonly opacity?: number;
	readonly color?: { r: number; g: number; b: number; a?: number };
}

export interface IFigmaTypeStyle {
	readonly fontFamily?: string;
	readonly fontWeight?: number;
	readonly fontSize?: number;
	readonly lineHeightPx?: number;
	readonly letterSpacing?: number;
	readonly textAlignHorizontal?: string;
}

export class FigmaApi {

	constructor(private readonly _token: FigmaToken) { }

	private async _fetch<T>(path: string, token: vscode.CancellationToken): Promise<T> {
		const personalToken = await this._token.get();
		if (!personalToken) {
			throw new FigmaAuthError('Nenhum token da Figma configurado. Peça ao usuário para rodar **Agent Chat: Conectar à Figma** na Paleta de Comandos (o token sai de Settings → Security → Personal access tokens, com o escopo file_content:read).');
		}

		const controller = new AbortController();
		const cancel = token.onCancellationRequested(() => controller.abort());
		let response: Response;
		try {
			response = await fetch(`${API_BASE}${path}`, {
				headers: { 'X-Figma-Token': personalToken },
				signal: controller.signal,
			});
		} finally {
			cancel.dispose();
		}

		if (response.status === 403 || response.status === 401) {
			// A Figma responde 403 tanto para token inválido quanto para arquivo fora
			// do alcance da conta. Dizer as duas hipóteses evita mandar alguém
			// recriar um token que estava certo.
			throw new FigmaAuthError('A Figma recusou a requisição (403). Três causas possíveis: o token está inválido ou expirado; falta o escopo file_content:read nele; ou o arquivo não pertence a uma conta/organização que esse token alcança.');
		}
		if (!response.ok) {
			throw new Error(`API da Figma respondeu ${response.status}: ${(await response.text()).slice(0, 300)}`);
		}
		return await response.json() as T;
	}

	/** Estrutura do arquivo, cortada na profundidade pedida para não vir inteira. */
	async file(fileKey: string, depth: number, token: vscode.CancellationToken): Promise<IFigmaFileSummary> {
		return this._fetch<IFigmaFileSummary>(`/files/${encodeURIComponent(fileKey)}?depth=${depth}`, token);
	}

	/** Sub-árvores específicas. É o caminho barato quando já se sabe o nó. */
	async nodes(fileKey: string, ids: string[], depth: number, token: vscode.CancellationToken): Promise<{ name: string; nodes: Record<string, { document: IFigmaNode } | null> }> {
		const query = `ids=${encodeURIComponent(ids.join(','))}&depth=${depth}`;
		return this._fetch(`/files/${encodeURIComponent(fileKey)}/nodes?${query}`, token);
	}

	/**
	 * URLs de imagem renderizada para os nós.
	 *
	 * São links temporários servidos pela Figma; não há download aqui de
	 * propósito. Os provedores descartam partes binárias no resultado de uma
	 * ferramenta, então uma imagem embutida nunca chegaria ao modelo — a URL, como
	 * texto, chega, e o modelo pode repassá-la ao usuário em markdown.
	 */
	async images(fileKey: string, ids: string[], scale: number, format: string, token: vscode.CancellationToken): Promise<{ images: Record<string, string | null>; err?: string }> {
		const query = `ids=${encodeURIComponent(ids.join(','))}&scale=${scale}&format=${encodeURIComponent(format)}`;
		return this._fetch(`/images/${encodeURIComponent(fileKey)}?${query}`, token);
	}

	/** Confere o token e devolve o nome da conta, para o comando de conexão. */
	async me(token: vscode.CancellationToken): Promise<{ email?: string; handle?: string }> {
		return this._fetch('/me', token);
	}
}
