/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { IProductOnboardingTheme } from '../../../../base/common/product.js';

/**
 * Step identifiers for the onboarding walkthrough.
 */
export const enum OnboardingStepId {
	SignIn = 'onboarding.signIn',
	Personalize = 'onboarding.personalize',
	AiPreference = 'onboarding.aiPreference',
	AgentSessions = 'onboarding.agentSessions',
}

/**
 * Returns a localized title for each step.
 */
export function getOnboardingStepTitle(stepId: OnboardingStepId): string {
	switch (stepId) {
		case OnboardingStepId.SignIn:
			return localize('onboarding.step.signIn', "Entrar");
		case OnboardingStepId.Personalize:
			return localize('onboarding.step.personalize', "Deixe do Seu Jeito");
		case OnboardingStepId.AiPreference:
			return localize('onboarding.step.aiPreference', "Seu Estilo de IA");
		case OnboardingStepId.AgentSessions:
			return localize('onboarding.step.agentSessions', "Construa com Agentes de IA");
	}
}

/**
 * Returns a localized subtitle for each step.
 */
export function getOnboardingStepSubtitle(stepId: OnboardingStepId): string {
	switch (stepId) {
		case OnboardingStepId.SignIn:
			return localize('onboarding.step.signIn.subtitle', "Sincronize configurações, libere recursos de IA e conecte-se ao GitHub");
		case OnboardingStepId.Personalize:
			return localize('onboarding.step.personalize.subtitle', "Escolha seu tema e seu mapeamento de teclado");
		case OnboardingStepId.AiPreference:
			return localize('onboarding.step.aiPreference.subtitle', "Escolha quanta colaboração com a IA combina com o seu fluxo de trabalho");
		case OnboardingStepId.AgentSessions:
			return localize('onboarding.step.agentSessions.subtitle', "Abra o Chat quando quiser com {0}", isMacintosh ? '\u2318\u2303I' : 'Ctrl+Alt+I');
	}
}

/**
 * Ordered step IDs for the onboarding flow.
 */
export const ONBOARDING_STEPS: readonly OnboardingStepId[] = [
	OnboardingStepId.SignIn,
	OnboardingStepId.Personalize,
	OnboardingStepId.AgentSessions,
];

/**
 * Theme option for the onboarding personalization step.
 * Sourced from product.json via `onboardingThemes`.
 */
export type IOnboardingThemeOption = IProductOnboardingTheme;

/**
 * AI collaboration preference for the AI style step.
 */
export const enum AiCollaborationMode {
	CodeFirst = 'code-first',
	Balanced = 'balanced',
	AgentForward = 'agent-forward',
}

/**
 * AI collaboration preference option.
 */
export interface IAiPreferenceOption {
	readonly id: AiCollaborationMode;
	readonly label: string;
	readonly description: string;
	readonly icon: string;
}

/**
 * AI collaboration preference options shown in the AI style step.
 */
export const ONBOARDING_AI_PREFERENCE_OPTIONS: readonly IAiPreferenceOption[] = [
	{
		id: AiCollaborationMode.CodeFirst,
		label: localize('onboarding.aiPref.codeFirst', "Eu Escrevo o Código"),
		description: localize('onboarding.aiPref.codeFirst.desc', "A IA ajuda com sugestões e responde quando você pergunta. Você mantém o controle de cada edição."),
		icon: 'edit',
	},
	{
		id: AiCollaborationMode.Balanced,
		label: localize('onboarding.aiPref.balanced', "Lado a Lado"),
		description: localize('onboarding.aiPref.balanced.desc', "Sugestões em linha mais um painel de chat para uma colaboração mais profunda. Um equilíbrio entre escrever e delegar."),
		icon: 'layoutSidebarRight',
	},
	{
		id: AiCollaborationMode.AgentForward,
		label: localize('onboarding.aiPref.agentForward', "A IA Assume a Frente"),
		description: localize('onboarding.aiPref.agentForward.desc', "Deixe o agente conduzir — descreva o que você quer e revise o resultado. Ótimo para criar estruturas e explorar."),
		icon: 'copilot',
	},
];

/**
 * Storage key for persisting onboarding completion state.
 */
export const ONBOARDING_STORAGE_KEY = 'welcomeOnboarding.state';
