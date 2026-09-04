/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as path from 'node:path';
import { run } from '../esbuild-extension-common.mts';

const srcDir = path.join(import.meta.dirname, 'src');
const outDir = path.join(import.meta.dirname, 'dist');

run({
	platform: 'node',
	entryPoints: {
		'extension': path.join(srcDir, 'extension.ts'),
	},
	srcDir,
	outdir: outDir,
	additionalOptions: {
		// Resolved at runtime from the app's own `node_modules`, which the
		// extension host reaches by walking up from the extension folder. It
		// ships with the app rather than with this extension, so bundling it
		// here would duplicate the WASM runtime — and fail outright, since the
		// package is not a dependency of this extension.
		external: ['vscode', '@vscode/tree-sitter-wasm'],
	},
}, process.argv);
