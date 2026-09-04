/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/** Whether the text being embedded is a search query or an indexed passage. */
export type EmbeddingRole = 'query' | 'document';

/** Where the vectors come from. */
export type EmbeddingProviderKind = 'local' | 'api';

export interface IEmbeddingProviderStatus {
	/** True when {@link IEmbeddingProvider.embed} can be expected to work. */
	readonly ready: boolean;
	/** Human-readable name of what is producing the vectors. */
	readonly label: string;
	/** What is missing, when `ready` is false. */
	readonly problem?: string;
}

/**
 * Turns text into vectors.
 *
 * The rest of the index — chunking, storage, search, the tool — is written
 * against this and nothing else, so swapping where the vectors come from costs
 * one implementation rather than a rewrite.
 */
export interface IEmbeddingProvider {

	readonly kind: EmbeddingProviderKind;

	/**
	 * Identity of the vectors this provider produces, stored alongside the index.
	 *
	 * Two providers never share an index: the numbers mean different things even
	 * at equal width. When this changes the index is discarded and rebuilt.
	 */
	readonly indexKey: string;

	/** Vector width, or `undefined` when it cannot be determined yet. */
	dims(token: vscode.CancellationToken): Promise<number | undefined>;

	status(): Promise<IEmbeddingProviderStatus>;

	/**
	 * Embeds `texts`.
	 *
	 * Returns `undefined` when the provider is unusable as a whole — no
	 * credential, no runtime, cancelled. Individual `undefined` entries mark
	 * inputs that could not be embedded, which the caller drops rather than
	 * failing the whole file over.
	 */
	embed(texts: readonly string[], role: EmbeddingRole, token: vscode.CancellationToken): Promise<(Float32Array | undefined)[] | undefined>;

	/** Frees whatever the provider holds; it may be used again afterwards. */
	release(): void;

	dispose(): void;
}
