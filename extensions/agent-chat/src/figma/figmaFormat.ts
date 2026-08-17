/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IFigmaNode, IFigmaPaint, IFigmaTypeStyle } from './figmaApi.js';

/**
 * Converte a árvore de nós da Figma num esboço de texto.
 *
 * O JSON cru de um arquivo da Figma chega a dezenas de megabytes: um único frame
 * traz matrizes de transformação, efeitos, restrições, ids de estilo e propriedades
 * de exportação em cada nó. Entregar isso a um modelo não é caro, é inviável —
 * estoura a janela de contexto antes da primeira frase.
 *
 * O que sobra aqui é o que se usa para escrever a interface de novo: hierarquia,
 * nome, tipo, geometria, preenchimento, borda, raio, auto-layout e tipografia.
 * O resto é descartado sem cerimônia. Preferimos uma linha densa por nó a JSON
 * indentado porque cada chave repetida custaria tokens em todos os nós.
 */

/** Acima disto o esboço deixa de caber e de ser lido; o corte é anunciado. */
const DEFAULT_MAX_NODES = 300;

export interface IOutlineOptions {
	readonly maxNodes?: number;
	/** Profundidade máxima a percorrer. Indefinido = sem limite próprio. */
	readonly maxDepth?: number;
}

export function outlineNode(root: IFigmaNode, options: IOutlineOptions = {}): string {
	const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
	const lines: string[] = [];
	let emitted = 0;
	let skipped = 0;

	const walk = (node: IFigmaNode, depth: number): void => {
		// Nó invisível não vira pixel na tela, e portanto não vira código. Levá-lo
		// junto só induz o modelo a implementar o que ninguém vê.
		if (node.visible === false) {
			return;
		}
		if (emitted >= maxNodes) {
			skipped++;
			return;
		}
		lines.push('  '.repeat(depth) + describeNode(node));
		emitted++;
		if (options.maxDepth !== undefined && depth >= options.maxDepth) {
			const hidden = countVisible(node.children);
			if (hidden > 0) {
				lines.push('  '.repeat(depth + 1) + `… ${hidden} filho(s) além da profundidade pedida`);
			}
			return;
		}
		for (const child of node.children ?? []) {
			walk(child, depth + 1);
		}
	};

	walk(root, 0);

	if (skipped > 0) {
		lines.push('');
		lines.push(`… ${skipped} nó(s) omitido(s): o limite de ${maxNodes} foi atingido. Peça um nó específico (passe a URL dele, ou o nodeId) para ver essa parte em detalhe.`);
	}
	return lines.join('\n');
}

function countVisible(children: readonly IFigmaNode[] | undefined): number {
	return (children ?? []).filter(c => c.visible !== false).length;
}

/** Uma linha por nó: identidade, caixa e só os estilos que foram de fato definidos. */
function describeNode(node: IFigmaNode): string {
	const parts: string[] = [`${node.type} "${node.name}"`];

	const box = node.absoluteBoundingBox;
	if (box) {
		parts.push(`${round(box.width)}×${round(box.height)}`);
	}

	if (node.layoutMode && node.layoutMode !== 'NONE') {
		const layout: string[] = [node.layoutMode === 'HORIZONTAL' ? 'row' : 'column'];
		if (node.itemSpacing) {
			layout.push(`gap ${round(node.itemSpacing)}`);
		}
		const padding = describePadding(node);
		if (padding) {
			layout.push(`padding ${padding}`);
		}
		if (node.primaryAxisAlignItems) {
			layout.push(`main ${node.primaryAxisAlignItems.toLowerCase()}`);
		}
		if (node.counterAxisAlignItems) {
			layout.push(`cross ${node.counterAxisAlignItems.toLowerCase()}`);
		}
		parts.push(`[${layout.join(' ')}]`);
	}

	const fill = describePaints(node.fills);
	if (fill) {
		parts.push(`fill ${fill}`);
	}
	const stroke = describePaints(node.strokes);
	if (stroke) {
		parts.push(`stroke ${stroke}${node.strokeWeight ? ` ${round(node.strokeWeight)}px` : ''}`);
	}

	const radius = describeRadius(node);
	if (radius) {
		parts.push(`radius ${radius}`);
	}
	if (node.opacity !== undefined && node.opacity < 1) {
		parts.push(`opacity ${node.opacity.toFixed(2)}`);
	}

	const type = describeTypography(node.style);
	if (type) {
		parts.push(type);
	}
	if (node.characters) {
		parts.push(`text ${JSON.stringify(clip(node.characters, 120))}`);
	}
	if (node.componentId) {
		parts.push('instance');
	}

	// O id vai por último e sempre: é por ele que o próximo pedido busca este nó.
	parts.push(`#${node.id}`);
	return parts.join('  ');
}

function describePadding(node: IFigmaNode): string | undefined {
	const top = node.paddingTop ?? 0;
	const right = node.paddingRight ?? 0;
	const bottom = node.paddingBottom ?? 0;
	const left = node.paddingLeft ?? 0;
	if (!top && !right && !bottom && !left) {
		return undefined;
	}
	if (top === right && right === bottom && bottom === left) {
		return `${round(top)}`;
	}
	if (top === bottom && left === right) {
		return `${round(top)}/${round(left)}`;
	}
	return `${round(top)}/${round(right)}/${round(bottom)}/${round(left)}`;
}

function describeRadius(node: IFigmaNode): string | undefined {
	if (node.rectangleCornerRadii && node.rectangleCornerRadii.some(r => r > 0)) {
		const [tl, tr, br, bl] = node.rectangleCornerRadii;
		return tl === tr && tr === br && br === bl ? `${round(tl)}` : `${round(tl)}/${round(tr)}/${round(br)}/${round(bl)}`;
	}
	return node.cornerRadius ? `${round(node.cornerRadius)}` : undefined;
}

function describePaints(paints: readonly IFigmaPaint[] | undefined): string | undefined {
	const visible = (paints ?? []).filter(p => p.visible !== false);
	if (visible.length === 0) {
		return undefined;
	}
	const described = visible.map(paint => {
		if (paint.type === 'SOLID' && paint.color) {
			return toHex(paint.color, paint.opacity);
		}
		// Gradientes e imagens não viram uma cor; o tipo já diz ao modelo que ali
		// não cabe um `background-color` simples.
		return paint.type.toLowerCase().replace(/_/g, '-');
	});
	return described.slice(0, 3).join('+');
}

function describeTypography(style: IFigmaTypeStyle | undefined): string | undefined {
	if (!style || (!style.fontFamily && !style.fontSize)) {
		return undefined;
	}
	const parts: string[] = [];
	if (style.fontFamily) {
		parts.push(style.fontFamily);
	}
	if (style.fontSize) {
		parts.push(style.lineHeightPx ? `${round(style.fontSize)}/${round(style.lineHeightPx)}` : `${round(style.fontSize)}`);
	}
	if (style.fontWeight) {
		parts.push(`w${style.fontWeight}`);
	}
	if (style.letterSpacing) {
		parts.push(`ls ${style.letterSpacing.toFixed(2)}`);
	}
	if (style.textAlignHorizontal && style.textAlignHorizontal !== 'LEFT') {
		parts.push(style.textAlignHorizontal.toLowerCase());
	}
	return parts.join(' ');
}

/**
 * Cor da Figma (canais 0–1) para hexadecimal.
 *
 * O alfa combina o do canal com o da camada de pintura, que são coisas
 * separadas no modelo da Figma e a mesma coisa no CSS. Só aparece quando não é
 * opaco, para a maioria dos casos render `#RRGGBB` puro.
 */
function toHex(color: { r: number; g: number; b: number; a?: number }, paintOpacity?: number): string {
	const channel = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');
	const rgb = `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`.toUpperCase();
	const alpha = (color.a ?? 1) * (paintOpacity ?? 1);
	return alpha >= 0.999 ? rgb : `${rgb}${channel(alpha)}`.toUpperCase();
}

function round(value: number): number {
	return Math.round(value * 100) / 100;
}

function clip(text: string, max: number): string {
	const collapsed = text.replace(/\s+/g, ' ').trim();
	return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max)}…`;
}
