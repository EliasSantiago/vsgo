/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IHardwareProfile, memoryBudgetMB } from './hardware.js';

export interface ICatalogModel {
	/** Stable identifier, also used as the on-disk folder name. */
	readonly id: string;
	readonly name: string;
	readonly description: string;
	/** Hugging Face repository, e.g. `Qwen/Qwen2.5-Coder-7B-Instruct-GGUF`. */
	readonly repo: string;
	/**
	 * Case-insensitive fragment that selects the quantized file inside the repo.
	 * Resolved to a real filename at download time so the catalog does not rot
	 * when upstream renames its assets.
	 */
	readonly quant: string;
	/** Approximate download size, refined once the real file is resolved. */
	readonly sizeMB: number;
	readonly params: string;
	readonly layers: number;
	/** Context window we actually launch with, not the architectural maximum. */
	readonly contextLength: number;
	/** Rough KV-cache cost per 1024 tokens of context, in MB. */
	readonly kvMBPer1kCtx: number;
	readonly supportsTools: boolean;
	/** Set when the model needs a llama.cpp build that mainline does not provide. */
	readonly requiresPatchedRuntime?: boolean;
	/**
	 * What the weights are for. Only `chat` models are offered in the model
	 * picker; `embedding` ones exist solely to feed the semantic index.
	 */
	readonly kind?: 'chat' | 'embedding';
	/** Embedding models only: dimensionality of the vectors produced. */
	readonly dims?: number;
	/**
	 * Embedding models only. E5 and Nomic weights are trained with asymmetric
	 * prefixes and lose a lot of accuracy without them, so each entry carries
	 * the exact strings its family expects.
	 */
	readonly queryPrefix?: string;
	readonly documentPrefix?: string;
	/**
	 * Embedding models only. How llama.cpp turns per-token states into one
	 * vector: BERT-family encoders average them, while an embedder built on a
	 * causal LM carries the meaning in its final position.
	 */
	readonly pooling?: 'mean' | 'last';
	/**
	 * Embedding models only. True when the weights are a causal LM rather than
	 * an encoder, which means every sequence in a batch needs its own slice of
	 * KV cache instead of sharing one context.
	 */
	readonly causal?: boolean;
}

/**
 * Curated defaults. Users can add their own entries through the
 * `agent-chat.localModels.extraModels` setting.
 */
export const MODEL_CATALOG: readonly ICatalogModel[] = [
	{
		id: 'qwen2.5-coder-1.5b',
		name: 'Qwen2.5 Coder 1.5B',
		description: 'O menor modelo de código utilizável. Roda em quase qualquer notebook, mesmo só com CPU.',
		repo: 'Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF',
		quant: 'q4_k_m',
		sizeMB: 1065,
		params: '1.5B',
		layers: 28,
		contextLength: 16384,
		kvMBPer1kCtx: 28,
		supportsTools: true,
	},
	{
		id: 'qwen2.5-coder-3b',
		name: 'Qwen2.5 Coder 3B',
		description: 'Bom equilíbrio para máquinas sem GPU dedicada.',
		repo: 'bartowski/Qwen2.5-Coder-3B-Instruct-GGUF',
		quant: 'Q4_K_M',
		sizeMB: 1845,
		params: '3B',
		layers: 36,
		contextLength: 16384,
		kvMBPer1kCtx: 42,
		supportsTools: true,
	},
	{
		id: 'qwen2.5-coder-7b',
		name: 'Qwen2.5 Coder 7B',
		description: 'Padrão recomendado. Chamada de ferramentas confiável para fluxos de agente.',
		repo: 'Qwen/Qwen2.5-Coder-7B-Instruct-GGUF',
		quant: 'q4_k_m',
		sizeMB: 4465,
		params: '7B',
		layers: 28,
		contextLength: 32768,
		kvMBPer1kCtx: 57,
		supportsTools: true,
	},
	{
		id: 'qwen2.5-coder-14b',
		name: 'Qwen2.5 Coder 14B',
		description: 'Bem melhor em edições de vários passos. Pede 12 GB de VRAM.',
		repo: 'Qwen/Qwen2.5-Coder-14B-Instruct-GGUF',
		quant: 'q4_k_m',
		sizeMB: 8570,
		params: '14B',
		layers: 48,
		contextLength: 32768,
		kvMBPer1kCtx: 96,
		supportsTools: true,
	},
	{
		id: 'qwen2.5-coder-32b',
		name: 'Qwen2.5 Coder 32B',
		description: 'O mais próximo de um modelo hospedado. Precisa de uma GPU de 24 GB ou de um Mac com bastante memória unificada.',
		repo: 'Qwen/Qwen2.5-Coder-32B-Instruct-GGUF',
		quant: 'q4_k_m',
		sizeMB: 18935,
		params: '32B',
		layers: 64,
		contextLength: 32768,
		kvMBPer1kCtx: 128,
		supportsTools: true,
	},
	{
		id: 'qwen3-4b',
		name: 'Qwen3 4B',
		description: 'Geração mais nova da Qwen. Melhor raciocínio que o Coder 3B, ao custo de um cache de contexto maior.',
		repo: 'Qwen/Qwen3-4B-GGUF',
		quant: 'Q4_K_M',
		sizeMB: 2382,
		params: '4B',
		layers: 36,
		contextLength: 32768,
		kvMBPer1kCtx: 144,
		supportsTools: true,
	},
	{
		id: 'qwen3-8b',
		name: 'Qwen3 8B',
		description: 'Modelo de uso geral forte em chamada de ferramentas. Boa alternativa ao Coder 7B fora de tarefas de código.',
		repo: 'Qwen/Qwen3-8B-GGUF',
		quant: 'Q4_K_M',
		sizeMB: 4795,
		params: '8B',
		layers: 36,
		contextLength: 32768,
		kvMBPer1kCtx: 144,
		supportsTools: true,
	},
	{
		id: 'qwen3-coder-30b-a3b',
		name: 'Qwen3 Coder 30B A3B',
		description: 'Mistura de especialistas: ocupa memória de 30B mas só ativa 3B por token, então é rápido mesmo na CPU.',
		repo: 'unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF',
		quant: 'Q4_K_M',
		sizeMB: 17697,
		params: '30B (3B ativos)',
		layers: 48,
		contextLength: 32768,
		kvMBPer1kCtx: 96,
		supportsTools: true,
	},
	{
		id: 'gemma-3-1b',
		name: 'Gemma 3 1B',
		description: 'O menor Gemma do Google, quantizado com QAT. Serve para respostas curtas; pequeno demais para fluxos de agente.',
		repo: 'lmstudio-community/gemma-3-1B-it-qat-GGUF',
		quant: 'q4_0',
		sizeMB: 687,
		params: '1B',
		layers: 26,
		contextLength: 32768,
		kvMBPer1kCtx: 10,
		supportsTools: false,
	},
	{
		id: 'gemma-3-4b',
		name: 'Gemma 3 4B',
		description: 'Gemma de uso geral com QAT — a qualidade fica perto da versão sem quantizar. Atenção deslizante mantém o cache de contexto barato.',
		repo: 'unsloth/gemma-3-4b-it-qat-GGUF',
		quant: 'qat-Q4_0',
		sizeMB: 2260,
		params: '4B',
		layers: 34,
		contextLength: 32768,
		kvMBPer1kCtx: 26,
		supportsTools: true,
	},
	{
		id: 'gemma-3-12b',
		name: 'Gemma 3 12B',
		description: 'Bom equilíbrio da linha Gemma para escrita e explicação de código. Pede uma GPU de 12 GB para rodar inteiro.',
		repo: 'unsloth/gemma-3-12b-it-qat-GGUF',
		quant: 'qat-Q4_0',
		sizeMB: 6589,
		params: '12B',
		layers: 48,
		contextLength: 32768,
		kvMBPer1kCtx: 68,
		supportsTools: true,
	},
	{
		id: 'gemma-3-27b',
		name: 'Gemma 3 27B',
		description: 'O maior Gemma aberto. Compete com modelos hospedados em texto, mas precisa de 24 GB de VRAM ou de um Mac com bastante memória unificada.',
		repo: 'unsloth/gemma-3-27b-it-qat-GGUF',
		quant: 'qat-Q4_0',
		sizeMB: 14894,
		params: '27B',
		layers: 62,
		contextLength: 32768,
		kvMBPer1kCtx: 88,
		supportsTools: true,
	},
	{
		id: 'gemma-4-e4b',
		name: 'Gemma 4 E4B',
		description: 'Geração mais nova do Gemma, na variante de 4B efetivos. Poucas cabeças de atenção deixam o cache de contexto muito barato.',
		repo: 'google/gemma-4-E4B-it-qat-q4_0-gguf',
		quant: 'q4_0',
		sizeMB: 4916,
		params: '4B efetivos',
		layers: 42,
		contextLength: 32768,
		kvMBPer1kCtx: 16,
		supportsTools: true,
	},
	{
		id: 'gemma-4-12b',
		name: 'Gemma 4 12B',
		description: 'Gemma 4 completo. Só 8 das 48 camadas usam atenção global, então o contexto pesa pouco — o gargalo são os pesos.',
		repo: 'google/gemma-4-12B-it-qat-q4_0-gguf',
		quant: 'q4_0',
		sizeMB: 6653,
		params: '12B',
		layers: 48,
		contextLength: 32768,
		kvMBPer1kCtx: 75,
		supportsTools: true,
	},
	{
		id: 'llama-3.1-8b',
		name: 'Llama 3.1 8B',
		description: 'Padrão da Meta, o mais previsível a seguir instruções longas. Não é especializado em código.',
		repo: 'bartowski/Meta-Llama-3.1-8B-Instruct-GGUF',
		quant: 'Q4_K_M',
		sizeMB: 4693,
		params: '8B',
		layers: 32,
		contextLength: 32768,
		kvMBPer1kCtx: 128,
		supportsTools: true,
	},
	{
		id: 'phi-4-14b',
		name: 'Phi-4 14B',
		description: 'Modelo da Microsoft afiado em raciocínio e matemática. A janela de contexto é de apenas 16k.',
		repo: 'bartowski/phi-4-GGUF',
		quant: 'Q4_K_M',
		sizeMB: 8634,
		params: '14B',
		layers: 40,
		contextLength: 16384,
		kvMBPer1kCtx: 200,
		supportsTools: true,
	},
	{
		id: 'bonsai-8b',
		name: 'Bonsai 8B (1-bit)',
		description: '8B treinado nativamente em 1 bit — cabe em ~1,1 GB. Exige uma build do llama.cpp com kernels Q1_0.',
		repo: 'prism-ml/Bonsai-8B-gguf',
		quant: 'Q1_0',
		sizeMB: 1110,
		params: '8B',
		layers: 36,
		contextLength: 16384,
		kvMBPer1kCtx: 60,
		supportsTools: true,
		requiresPatchedRuntime: true,
	},
	// Embedding models. These never answer a prompt — they turn code chunks and
	// queries into vectors for the semantic index, and are hidden from the model
	// picker. They are small enough to run on CPU alongside a chat model.
	{
		id: 'qwen3-embedding-0.6b',
		name: 'Qwen3 Embedding 0.6B (embeddings)',
		description: 'Padrão do índice semântico. Multilíngue de verdade: entende comentários e documentação em português. Bem mais pesado que os alternativos.',
		repo: 'Qwen/Qwen3-Embedding-0.6B-GGUF',
		quant: 'Q8_0',
		sizeMB: 610,
		params: '0.6B',
		layers: 28,
		contextLength: 512,
		kvMBPer1kCtx: 28,
		supportsTools: false,
		kind: 'embedding',
		dims: 1024,
		// The task line is part of what the model was tuned on; dropping it costs
		// real accuracy. Documents are embedded bare.
		queryPrefix: 'Instruct: Given a question about a codebase, retrieve the code or documentation that answers it\nQuery: ',
		documentPrefix: '',
		pooling: 'last',
		causal: true,
	},
	{
		id: 'nomic-embed-text-v1.5',
		name: 'Nomic Embed Text v1.5 (embeddings)',
		description: 'Leve e rápido, o melhor custo-benefício em código. Treinado em inglês: perde conteúdo escrito em português.',
		repo: 'nomic-ai/nomic-embed-text-v1.5-GGUF',
		quant: 'q8_0',
		sizeMB: 139,
		params: '137M',
		layers: 12,
		contextLength: 2048,
		kvMBPer1kCtx: 8,
		supportsTools: false,
		kind: 'embedding',
		dims: 768,
		queryPrefix: 'search_query: ',
		documentPrefix: 'search_document: ',
	},
	{
		id: 'bge-small-en-v1.5',
		name: 'BGE Small EN v1.5 (embeddings)',
		description: 'O menor e mais rápido, com um terço do tamanho. Recupera um pouco pior que o Nomic.',
		repo: 'CompendiumLabs/bge-small-en-v1.5-gguf',
		quant: 'q8_0',
		sizeMB: 35,
		params: '33M',
		layers: 12,
		contextLength: 512,
		kvMBPer1kCtx: 4,
		supportsTools: false,
		kind: 'embedding',
		dims: 384,
		queryPrefix: 'Represent this sentence for searching relevant passages: ',
		documentPrefix: '',
	},
];

/** True when the entry produces vectors rather than chat completions. */
export function isEmbeddingModel(model: Pick<ICatalogModel, 'kind'>): boolean {
	return model.kind === 'embedding';
}

export type FitLevel = 'ideal' | 'ok' | 'tight' | 'unsupported';

export interface IModelFit {
	readonly level: FitLevel;
	readonly reason: string;
	/** Estimated peak memory for weights plus KV cache plus runtime overhead. */
	readonly requiredMB: number;
	/** Value to pass to llama-server's `-ngl`. */
	readonly gpuLayers: number;
}

/** Fixed slack for the runtime's own allocations (compute buffers, graph, ...). */
const RUNTIME_OVERHEAD_MB = 400;

/**
 * Decides whether `model` is a sensible choice on `profile`, and how many
 * layers to offload to the GPU.
 */
export function evaluateFit(model: ICatalogModel, profile: IHardwareProfile): IModelFit {
	const kvMB = Math.round(model.kvMBPer1kCtx * (model.contextLength / 1024));
	const requiredMB = model.sizeMB + kvMB + RUNTIME_OVERHEAD_MB;
	const { budgetMB, onGpu } = memoryBudgetMB(profile);
	const ramBudgetMB = Math.floor(profile.totalRamMB * 0.7);

	if (onGpu && requiredMB <= budgetMB) {
		return {
			level: 'ideal',
			reason: `Cabe inteiro na ${profile.unifiedMemory ? 'memória unificada' : 'VRAM'} (~${gb(requiredMB)} de ${gb(budgetMB)}).`,
			requiredMB,
			gpuLayers: 99,
		};
	}

	if (requiredMB > ramBudgetMB) {
		return {
			level: 'unsupported',
			reason: `Precisa de ~${gb(requiredMB)}, mas só ~${gb(ramBudgetMB)} da RAM do sistema é utilizável.`,
			requiredMB,
			gpuLayers: 0,
		};
	}

	// Fits in RAM. Offload whatever share of the layers the GPU can hold.
	const gpuLayers = onGpu ? partialOffloadLayers(model, budgetMB, kvMB) : 0;
	const headroom = requiredMB / ramBudgetMB;

	if (gpuLayers > 0) {
		return {
			level: 'ok',
			reason: `Repasse parcial para a GPU (~${gpuLayers} de ${model.layers} camadas), o resto na CPU.`,
			requiredMB,
			gpuLayers,
		};
	}
	if (headroom > 0.85) {
		return {
			level: 'tight',
			reason: `Roda na CPU, mas usa ~${gb(requiredMB)} de ~${gb(ramBudgetMB)} — espere swap e resposta lenta.`,
			requiredMB,
			gpuLayers: 0,
		};
	}
	// The machine is big enough; what is running on it right now may not leave
	// room. llama.cpp maps the weights rather than reading them, so a model that
	// overruns free memory is not refused — its pages are simply evicted again
	// and again, and every token re-reads them from disk.
	if (requiredMB > profile.availableRamMB * 0.9) {
		return {
			level: 'tight',
			reason: `Precisa de ~${gb(requiredMB)} e só ~${gb(profile.availableRamMB)} estão livres agora. Feche alguns aplicativos, ou espere swap e resposta lenta.`,
			requiredMB,
			gpuLayers: 0,
		};
	}
	return {
		level: 'ok',
		reason: `Roda na CPU (~${gb(requiredMB)}). A velocidade depende do número de núcleos.`,
		requiredMB,
		gpuLayers: 0,
	};
}

function partialOffloadLayers(model: ICatalogModel, budgetMB: number, kvMB: number): number {
	const usable = budgetMB - kvMB - RUNTIME_OVERHEAD_MB;
	if (usable <= 0) {
		return 0;
	}
	const perLayerMB = model.sizeMB / model.layers;
	return Math.max(0, Math.min(model.layers, Math.floor(usable / perLayerMB)));
}

function gb(mb: number): string {
	return `${(mb / 1024).toFixed(1)} GB`;
}

/** Sort order for the picker: best fit first, then the most capable model that still fits. */
export function compareByFit(a: IModelFit, b: IModelFit, aSize: number, bSize: number): number {
	const rank: Record<FitLevel, number> = { ideal: 0, ok: 1, tight: 2, unsupported: 3 };
	if (rank[a.level] !== rank[b.level]) {
		return rank[a.level] - rank[b.level];
	}
	return bSize - aSize;
}

/** Catalog plus any user-declared entries from settings. */
export function resolveCatalog(): readonly ICatalogModel[] {
	const extra = vscode.workspace
		.getConfiguration('agent-chat')
		.get<ICatalogModel[]>('localModels.extraModels', []);
	if (!Array.isArray(extra) || extra.length === 0) {
		return MODEL_CATALOG;
	}
	const valid = extra.filter(m => m && typeof m.id === 'string' && typeof m.repo === 'string' && typeof m.quant === 'string');
	const byId = new Map<string, ICatalogModel>();
	for (const model of [...MODEL_CATALOG, ...valid]) {
		byId.set(model.id, withDefaults(model));
	}
	return [...byId.values()];
}

function withDefaults(model: ICatalogModel): ICatalogModel {
	return {
		...model,
		name: model.name ?? model.id,
		description: model.description ?? '',
		params: model.params ?? '?',
		layers: model.layers ?? 32,
		contextLength: model.contextLength ?? 16384,
		kvMBPer1kCtx: model.kvMBPer1kCtx ?? 60,
		sizeMB: model.sizeMB ?? 4000,
		supportsTools: model.supportsTools ?? true,
	};
}
