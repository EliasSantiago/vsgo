/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { IProductService } from '../../../../platform/product/common/productService.js';

/**
 * Returns the short product brand name, suitable for short labels and status entries
 * (e.g. "Code", "VSCodium"). Falls back to "AI" if `nameShort` is not available.
 */
export function getAIBrandShort(productService: IProductService): string {
	return productService.nameShort || localize('aiBrandShortFallback', "AI");
}

/**
 * Returns the long product brand name, suitable for tooltips, dialogs, and welcome titles
 * (e.g. "Visual Studio Code"). Falls back to {@link getAIBrandShort} if `nameLong` is not available.
 */
export function getAIBrandLong(productService: IProductService): string {
	return productService.nameLong || getAIBrandShort(productService);
}
