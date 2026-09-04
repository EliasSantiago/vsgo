/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { registerIcon } from '../../../../../platform/theme/common/iconRegistry.js';
import { type AICustomizationPromptsStorage, BUILTIN_STORAGE } from '../../common/aiCustomizationWorkspaceService.js';
import { PromptsStorage } from '../../common/promptSyntax/service/promptsService.js';

/**
 * Icon for the AI Customization view container (sidebar).
 */
export const aiCustomizationViewIcon = registerIcon('ai-customization-view-icon', Codicon.sparkle, localize('aiCustomizationViewIcon', "Ícone da visão de Personalizações do Agente."));

/**
 * Icon for custom agents.
 */
export const agentIcon = registerIcon('ai-customization-agent', Codicon.agent, localize('aiCustomizationAgentIcon', "Ícone dos agentes personalizados."));

/**
 * Icon for skills.
 */
export const skillIcon = registerIcon('ai-customization-skill', Codicon.lightbulb, localize('aiCustomizationSkillIcon', "Ícone das skills."));

/**
 * Icon for instructions.
 */
export const instructionsIcon = registerIcon('ai-customization-instructions', Codicon.book, localize('aiCustomizationInstructionsIcon', "Ícone dos arquivos de instruções."));

/**
 * Icon for prompts.
 */
export const promptIcon = registerIcon('ai-customization-prompt', Codicon.bookmark, localize('aiCustomizationPromptIcon', "Ícone dos arquivos de prompt."));

/**
 * Icon for hooks.
 */
export const hookIcon = registerIcon('ai-customization-hook', Codicon.zap, localize('aiCustomizationHookIcon', "Ícone dos hooks."));

/**
 * Icon for adding a new item.
 */
export const addIcon = registerIcon('ai-customization-add', Codicon.add, localize('aiCustomizationAddIcon', "Ícone de adicionar novos itens."));

/**
 * Icon for the run action.
 */
export const runIcon = registerIcon('ai-customization-run', Codicon.play, localize('aiCustomizationRunIcon', "Ícone de executar um prompt ou agente."));

/**
 * Icon for workspace storage.
 */
export const workspaceIcon = registerIcon('ai-customization-workspace', Codicon.folder, localize('aiCustomizationWorkspaceIcon', "Ícone dos itens do workspace."));

/**
 * Icon for user storage.
 */
export const userIcon = registerIcon('ai-customization-user', Codicon.account, localize('aiCustomizationUserIcon', "Ícone dos itens do usuário."));

/**
 * Icon for extension storage.
 */
export const extensionIcon = registerIcon('ai-customization-extension', Codicon.extensions, localize('aiCustomizationExtensionIcon', "Ícone dos itens contribuídos por extensões."));

/**
 * Icon for plugin storage.
 */
export const pluginIcon = registerIcon('ai-customization-plugin', Codicon.plug, localize('aiCustomizationPluginIcon', "Ícone dos itens contribuídos por plugins."));

/**
 * Icon for built-in storage.
 */
export const builtinIcon = registerIcon('ai-customization-builtin', Codicon.starFull, localize('aiCustomizationBuiltinIcon', "Ícone dos itens nativos."));

/**
 * Icon for MCP servers.
 */
export const mcpServerIcon = registerIcon('ai-customization-mcp-server', Codicon.server, localize('aiCustomizationMcpServerIcon', "Ícone dos servidores MCP."));

/**
 * Returns the icon for a given storage type.
 */
export function storageToIcon(storage: AICustomizationPromptsStorage): ThemeIcon {
	switch (storage) {
		case PromptsStorage.local: return workspaceIcon;
		case PromptsStorage.user: return userIcon;
		case PromptsStorage.extension: return extensionIcon;
		case PromptsStorage.plugin: return pluginIcon;
		case BUILTIN_STORAGE: return builtinIcon;
		default: return instructionsIcon;
	}
}
