/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Hygiene works by creating cascading subsets of all our files and
 * passing them through a sequence of checks. Here are the current subsets,
 * named according to the checks performed on them. Each subset contains
 * the following one, as described in mathematical notation:
 *
 * all ⊃ eol ⊇ indentation ⊃ copyright ⊃ typescript
 */

export const all = Object.freeze<string[]>([
	'*',
	'build/**/*',
	'extensions/**/*',
	'scripts/**/*',
	'src/**/*',
	'test/**/*',
	'!cli/**/*',
	'!out*/**',
	'!extensions/**/out*/**',
	'!extensions/**/*-out/**',
	'!test/**/out/**',
	'!**/node_modules/**',
	'!**/*.js.map',
	'!**/*.tsbuildinfo',
]);

export const unicodeFilter = Object.freeze<string[]>([
	'**',

	'!**/ThirdPartyNotices.txt',
	'!**/ThirdPartyNotices.cli.txt',
	'!**/LICENSE.{txt,rtf}',
	'!LICENSES.chromium.html',
	'!**/LICENSE',

	'!**/*.{dll,exe,png,bmp,jpg,gif,scpt,cur,ttf,woff,eot,template,ico,icns,opus,wasm}',
	'!**/test/**',
	'!**/*.test.ts',
	'!**/*.{d.ts,json,md}',
	'!**/*.mp3',
	'!**/*.tiff',
	'!**/*.provisionprofile',

	'!build/win32/**',
	'!extensions/markdown-language-features/notebook-out/*.js',
	'!extensions/markdown-language-features/markdown-editor-out/*.js',
	'!extensions/markdown-math/notebook-out/**',
	'!extensions/mermaid-markdown-features/chat-webview-out/**',
	'!extensions/ipynb/notebook-out/**',
	'!extensions/notebook-renderers/renderer-out/**',
	'!extensions/php-language-features/src/features/phpGlobalFunctions.ts',
	'!extensions/terminal-suggest/src/completions/upstream/**',
	'!extensions/typescript-language-features/test-workspace/**',
	'!extensions/vscode-api-tests/testWorkspace/**',
	'!extensions/vscode-api-tests/testWorkspace2/**',
	'!extensions/**/dist/**',
	'!extensions/**/out/**',
	'!extensions/**/snippets/**',
	'!extensions/**/colorize-fixtures/**',
	'!extensions/terminal-suggest/src/shell/fishBuiltinsCache.ts',


	'!src/vs/base/browser/dompurify/**',
	'!src/vs/workbench/services/keybinding/browser/keyboardLayouts/**',
	'!src/vs/workbench/contrib/terminal/common/scripts/psreadline/**',

	// vsgo: features authored with intentional pt-BR content (localized strings,
	// LLM prompt/markdown templates, build scripts) where non-ASCII is expected.
	'!src/main.ts',
	'!src/vs/base/common/product.ts',
	'!src/vs/workbench/api/common/extHostChatAgents2.ts',
	'!src/vs/workbench/contrib/chat/common/chatModes.ts',
	'!src/vs/workbench/contrib/chat/browser/chatEditing/chatEditingEditorActions.ts',
	'!src/vs/workbench/contrib/chat/browser/actions/chatExecuteActions.ts',
	'!src/vs/workbench/contrib/chat/browser/chatSetup/chatSetupContributions.ts',
	'!src/vs/workbench/contrib/chat/browser/widget/chatContentParts/toolInvocationParts/chatTerminalToolConfirmationSubPart.ts',
	'!src/vs/workbench/contrib/chat/browser/widget/chatContentParts/toolInvocationParts/chatToolConfirmationSubPart.ts',
	'!src/vs/workbench/contrib/chat/browser/widget/chatContentParts/toolInvocationParts/chatSandboxPrerequisiteConfirmationSubPart.ts',
	'!src/vs/workbench/contrib/chat/browser/widget/input/autoModeToggleActionItem.ts',
	'!src/vs/workbench/contrib/chat/browser/widget/input/modePickerActionItem.ts',
	'!src/vs/workbench/contrib/chat/browser/widget/input/chatInputPart.ts',
	'!src/vs/workbench/contrib/chat/browser/widgetHosts/viewPane/chatUpdateBanner.ts',
	'!src/vs/workbench/contrib/chat/browser/widgetHosts/viewPane/chatViewTitleControl.ts',
	'!src/vs/workbench/contrib/chat/browser/widget/input/modelPicker/modelPickerWidget.ts',
	'!src/vs/workbench/contrib/chat/common/aiCustomizationWorkspaceService.ts',
	'!src/vs/workbench/services/chat/common/chatEntitlementService.ts',
	'!src/vs/workbench/contrib/chat/browser/chatSetup/chatSetupProviders.ts',
	'!src/vs/workbench/contrib/chat/browser/aiCustomization/**',
	'!src/vs/workbench/contrib/chat/common/aiFeatureModel.ts',
	'!src/vs/workbench/api/browser/mainThreadChatAgents2.ts',
	'!src/vs/workbench/contrib/specDriven/**',
	'!src/vs/workbench/contrib/welcomeOnboarding/**',
	'!src/vs/workbench/contrib/securityScan/**',
	'!extensions/agent-chat/**',
	'!scripts/build-linux.sh',
	'!scripts/dev.sh',
	'!scripts/watch-dev.sh',
	'!scripts/build-win.sh',
	'!scripts/build-mac.sh',
	'!scripts/make-manifest.sh',
	'!scripts/release.sh',

	// Files with licences
	'!src/vs/platform/endpoint/common/licenseAgreement.ts',
]);

export const indentationFilter = Object.freeze<string[]>([
	'**',

	// except specific files
	'!**/ThirdPartyNotices.txt',
	'!**/ThirdPartyNotices.cli.txt',
	'!**/LICENSE.{txt,rtf}',
	'!LICENSES.chromium.html',
	'!**/LICENSE',
	'!**/*.mp3',
	'!src/vs/base/browser/dompurify/*',
	'!src/vs/base/common/lit-html/**',
	'!src/vs/base/common/signals-core/**',
	'!src/vs/base/common/marked/marked.js',
	'!src/vs/base/common/semver/semver.js',
	'!src/vs/base/node/terminateProcess.sh',
	'!src/vs/base/node/cpuUsage.sh',
	'!src/vs/editor/common/languages/highlights/*.scm',
	'!src/vs/editor/common/languages/injections/*.scm',
	'!test/unit/assert.js',
	'!resources/linux/snap/electron-launch',
	'!build/ext.js',
	'!build/darwin/patch-dmg.py',
	'!build/npm/gyp/patches/gyp_spectre_mitigation_support.patch',
	'!product.overrides.json',
	'!src/vs/platform/endpoint/common/licenseAgreement.ts',

	// except specific folders
	'!test/automation/out/**',
	'!test/monaco/out/**',
	'!test/smoke/out/**',
	'!extensions/terminal-suggest/src/shell/zshBuiltinsCache.ts',
	'!extensions/terminal-suggest/src/shell/fishBuiltinsCache.ts',
	'!extensions/terminal-suggest/src/completions/upstream/**',
	'!extensions/typescript-language-features/test-workspace/**',
	'!extensions/typescript-language-features/resources/walkthroughs/**',
	'!extensions/typescript-language-features/package-manager/node-maintainer/**',
	'!extensions/markdown-math/notebook-out/**',
	'!extensions/ipynb/notebook-out/**',
	'!extensions/vscode-api-tests/testWorkspace/**',
	'!extensions/vscode-api-tests/testWorkspace2/**',
	'!build/monaco/**',
	'!build/win32/**',
	'!build/checker/**',
	'!src/vs/workbench/contrib/terminal/common/scripts/psreadline/**',

	// except multiple specific files
	'!**/package.json',
	'!**/package-lock.json',

	// except multiple specific folders
	'!**/codicon/**',
	'!**/fixtures/**',
	'!**/lib/**',
	'!extensions/**/dist/**',
	'!extensions/**/out/**',
	'!extensions/**/snippets/**',
	'!extensions/**/syntaxes/**',
	'!extensions/**/themes/**',
	'!extensions/**/colorize-fixtures/**',


	// vsgo: template literals embedding JS/JSON/markdown, whose content is
	// intentionally space-indented and must not be reflowed to tabs.
	'!src/vs/workbench/contrib/securityScan/browser/securityScanService.ts',
	'!src/vs/workbench/contrib/securityScan/browser/securityScanActions.ts',
	'!src/vs/workbench/contrib/specDriven/browser/specKitTemplates.ts',
	'!src/vs/workbench/contrib/specDriven/browser/specDrivenService.ts',
	'!extensions/agent-chat/src/agentProfile.ts',

	// except specific file types
	'!src/vs/*/**/*.d.ts',
	'!src/typings/**/*.d.ts',
	'!extensions/**/*.d.ts',
	'!**/*.{svg,exe,png,bmp,jpg,gif,scpt,bat,cmd,cur,ttf,woff,eot,md,ps1,psm1,template,yaml,yml,d.ts.recipe,ico,icns,plist,opus,admx,adml,wasm}',
	'!build/{lib,download,linux,darwin}/**/*.js',
	'!build/**/*.sh',
	'!build/azure-pipelines/**/*.js',
	'!build/azure-pipelines/**/*.config',
	'!build/npm/gyp/custom-headers/**',
	'!**/Dockerfile',
	'!**/Dockerfile.*',
	'!**/*.Dockerfile',
	'!**/*.dockerfile',
	'!**/*.tiff',

	// except for built files
	'!extensions/mermaid-markdown-features/chat-webview-out/*.js',
	'!extensions/mermaid-markdown-features/markdown-preview-out/*.js',
	'!extensions/mermaid-markdown-features/notebook-out/*.js',
	'!extensions/markdown-language-features/media/*.js',
	'!extensions/markdown-language-features/markdown-editor-out/*.js',
	'!extensions/markdown-language-features/notebook-out/*.js',
	'!extensions/markdown-math/notebook-out/*.js',
	'!extensions/ipynb/notebook-out/**',
	'!extensions/notebook-renderers/renderer-out/*.js',
	'!extensions/simple-browser/media/*.js',
]);

export const copyrightFilter = Object.freeze<string[]>([
	'**',
	'!**/*.desktop',
	'!**/*.json',
	'!**/*.jsonc',
	'!**/*.jsonl',
	'!**/*.html',
	'!**/*.template',
	'!**/*.md',
	'!**/*.bat',
	'!**/*.cmd',
	'!**/*.ico',
	'!**/*.gif',
	'!**/*.opus',
	'!**/*.mp3',
	'!**/*.icns',
	'!**/*.xml',
	'!**/*.sh',
	'!**/*.zsh',
	'!**/*.fish',
	'!**/*.txt',
	'!**/*.xpm',
	'!**/*.opts',
	'!**/*.disabled',
	'!**/*.code-workspace',
	'!**/*.js.map',
	'!**/*.wasm',
	'!**/*.tiff',
	'!**/*.provisionprofile',
	'!build/**/*.init',
	'!build/darwin/patch-dmg.py',
	'!build/linux/libcxx-fetcher.*',
	'!build/npm/gyp/custom-headers/**',
	'!resources/linux/snap/snapcraft.yaml',
	'!resources/win32/bin/code.js',
	'!resources/completions/**',
	'!extensions/configuration-editing/build/inline-allOf.ts',
	'!extensions/markdown-language-features/media/highlight.css',
	'!extensions/markdown-math/notebook-out/**',
	'!extensions/ipynb/notebook-out/**',
	'!extensions/simple-browser/media/codicon.css',
	'!extensions/terminal-suggest/src/completions/upstream/**',
	'!extensions/typescript-language-features/node-maintainer/**',
	'!extensions/html-language-features/server/src/modes/typescript/*',
	'!extensions/*/server/bin/*',
	'!src/vs/platform/agentHost/node/codex/protocol/generated/**',
	'!src/vs/workbench/contrib/terminal/common/scripts/psreadline/**',
	'!extensions/mermaid-markdown-features/chat-webview-out/**',
	'!extensions/mermaid-markdown-features/markdown-preview-out/**',
	'!extensions/mermaid-markdown-features/notebook-out/**',

	// vendored third-party libraries
	'!src/vs/base/common/lit-html/**',
	'!src/vs/base/common/signals-core/**',

]);

export const tsFormattingFilter = Object.freeze<string[]>([
	'src/**/*.ts',
	'test/**/*.ts',
	'extensions/**/*.ts',
	'!src/vs/*/**/*.d.ts',
	'!src/typings/**/*.d.ts',
	'!extensions/**/*.d.ts',
	'!**/fixtures/**',
	'!**/typings/**',
	'!**/node_modules/**',
	'!extensions/**/colorize-fixtures/**',
	'!extensions/vscode-api-tests/testWorkspace/**',
	'!extensions/vscode-api-tests/testWorkspace2/**',
	'!extensions/**/*.test.ts',
	'!extensions/html-language-features/server/lib/jquery.d.ts',
	'!extensions/terminal-suggest/src/shell/zshBuiltinsCache.ts',
	'!extensions/terminal-suggest/src/shell/fishBuiltinsCache.ts',
	'!src/vs/platform/agentHost/node/codex/protocol/generated/**',

]);

export const eslintFilter = Object.freeze<string[]>([
	'**/*.{js,cjs,mjs}',
	'**/*.{ts,tsx,mts,cts}',
	'.eslint-plugin-local/**/*.ts',
	'!src/vs/platform/agentHost/node/codex/protocol/generated/**',
	...readFileSync(join(import.meta.dirname, '..', '.eslint-ignore'))
		.toString()
		.split(/\r\n|\n/)
		.filter(line => line && !line.startsWith('#'))
		.map(line => line.startsWith('!') ? line.slice(1) : `!${line}`)
]);

export const stylelintFilter = Object.freeze<string[]>([
	'src/**/*.css',
	'extensions/**/*.css',
	'!extensions/**/node_modules/**',
	'!extensions/**/test/**',
	'!extensions/**/test-data/**',
	'!extensions/**/testData/**',
]);
