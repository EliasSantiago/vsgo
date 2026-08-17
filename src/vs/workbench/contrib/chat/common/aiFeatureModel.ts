/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService, IQuickPickItem, QuickPickInput } from '../../../../platform/quickinput/common/quickInput.js';
import { ILanguageModelChatMetadata, ILanguageModelsService } from './languageModels.js';

/**
 * Model selection for the features that prompt a model of their own — Security
 * Scan, Spec Driven, QA — none of which go through the chat, and none of which
 * follow the model picked there.
 *
 * Each keeps its choice in its own configuration section, as a `modelVendor`
 * plus `modelId` pair. This module is the single place that reads that pair,
 * turns it into a model to call, and lets the user change it. Before it existed
 * the same resolution sat copied in all three services, and an empty setting
 * silently meant "whichever provider happened to register first" — which is how
 * a scan ends up running on a model nobody chose.
 */

/** A feature that runs its own prompts and remembers its own model choice. */
export interface IAiFeature {
	/** Configuration section holding this feature's `modelVendor` and `modelId`. */
	readonly configSection: string;
	/** The feature's name, shown as the picker's title. */
	readonly title: string;
}

/** What the settings say, before it is matched against what is installed. */
export interface IAiFeatureModelChoice {
	/** Empty means any vendor. */
	readonly vendor: string;
	/** Empty means "the first available", which is what makes a choice implicit. */
	readonly id: string;
}

/** Outcome of matching a choice against the models actually available. */
export interface IResolvedAiFeatureModel {
	/** Identifier to hand to {@link ILanguageModelsService.sendChatRequest}. */
	readonly identifier: string;
	/**
	 * True when a model was named in the settings but could not be found, and
	 * this is a substitute. Worth reporting: the feature is about to answer with
	 * a model the user did not ask for.
	 */
	readonly isSubstitute: boolean;
}

export function readAiFeatureModelChoice(configurationService: IConfigurationService, feature: IAiFeature): IAiFeatureModelChoice {
	const vendor = configurationService.getValue<string>(`${feature.configSection}.modelVendor`);
	const id = configurationService.getValue<string>(`${feature.configSection}.modelId`);
	return {
		vendor: typeof vendor === 'string' ? vendor : '',
		id: typeof id === 'string' ? id : '',
	};
}

/**
 * Model the feature should call right now.
 *
 * Resolving is asynchronous because it makes every provider produce its list:
 * a model the user chose weeks ago only exists again once its vendor has been
 * asked. Undefined means there is no model at all to run on.
 */
export async function resolveAiFeatureModel(
	languageModelsService: ILanguageModelsService,
	choice: IAiFeatureModelChoice,
): Promise<IResolvedAiFeatureModel | undefined> {
	const filter: { vendor?: string; id?: string } = {};
	if (choice.vendor) { filter.vendor = choice.vendor; }
	if (choice.id) { filter.id = choice.id; }

	if (filter.vendor || filter.id) {
		const matching = await languageModelsService.selectLanguageModels(filter);
		if (matching.length > 0) {
			return { identifier: matching[0], isSubstitute: false };
		}
	}

	// Either nothing was chosen, or what was chosen is gone — the provider was
	// signed out of, the local model was deleted. Running on something beats
	// failing, as long as the caller is told it happened.
	const available = await languageModelsService.selectLanguageModels({});
	if (available.length === 0) {
		return undefined;
	}
	return { identifier: available[0], isSubstitute: !!(filter.vendor || filter.id) };
}

/**
 * Name of the model the feature will use, for a label.
 *
 * Reads only the models already resolved, so it stays synchronous and cheap
 * enough to call on every configuration change. A choice whose model is not in
 * that cache is shown by its configured id rather than guessed at: it is either
 * still resolving or no longer installed, and both are worth seeing.
 */
export function describeAiFeatureModel(
	languageModelsService: ILanguageModelsService,
	configurationService: IConfigurationService,
	feature: IAiFeature,
): string {
	const choice = readAiFeatureModelChoice(configurationService, feature);
	const known = resolvedMetadata(languageModelsService);

	if (choice.id) {
		const match = known.find(model => model.id === choice.id && (!choice.vendor || model.vendor === choice.vendor));
		return match ? match.name : choice.id;
	}
	if (choice.vendor) {
		const match = known.find(model => model.vendor === choice.vendor);
		return match ? match.name : choice.vendor;
	}
	const first = known[0];
	return first
		? localize('aiFeatureModel.automaticWith', "Automático ({0})", first.name)
		: localize('aiFeatureModel.noneAvailable', "Nenhum modelo");
}

/**
 * Asks which model the feature should use and stores the answer.
 *
 * Written to user settings rather than kept in memory: these runs are long and
 * occasional, and having to re-pick a model on every window is worse than the
 * setting being one more thing in the file.
 */
export async function selectAiFeatureModel(accessor: ServicesAccessor, feature: IAiFeature): Promise<void> {
	const languageModelsService = accessor.get(ILanguageModelsService);
	const quickInputService = accessor.get(IQuickInputService);
	const configurationService = accessor.get(IConfigurationService);

	const identifiers = await languageModelsService.selectLanguageModels({});
	const models: ILanguageModelChatMetadata[] = [];
	for (const identifier of identifiers) {
		const metadata = languageModelsService.lookupLanguageModel(identifier);
		if (metadata) {
			models.push(metadata);
		}
	}

	const choice = readAiFeatureModelChoice(configurationService, feature);
	const automatic: IModelPick = {
		label: localize('aiFeatureModel.automatic', "Automático"),
		description: models.length > 0
			? localize('aiFeatureModel.automaticDescription', "Usa o primeiro modelo disponível ({0})", models[0].name)
			: localize('aiFeatureModel.automaticEmpty', "Usa o primeiro modelo disponível"),
	};

	const items: QuickPickInput<IModelPick>[] = [automatic];
	if (models.length > 0) {
		items.push({ type: 'separator', label: localize('aiFeatureModel.installed', "Modelos disponíveis") });
	}
	let active: IModelPick = automatic;
	for (const model of models) {
		const item: IModelPick = {
			label: model.name,
			description: model.vendor,
			detail: localize('aiFeatureModel.window', "Janela de {0}k tokens", Math.max(1, Math.round(model.maxInputTokens / 1024))),
			model,
		};
		if (choice.id === model.id && (!choice.vendor || choice.vendor === model.vendor)) {
			active = item;
		}
		items.push(item);
	}

	const picked = await quickInputService.pick(items, {
		title: localize('aiFeatureModel.title', "Modelo para {0}", feature.title),
		placeHolder: models.length > 0
			? localize('aiFeatureModel.placeholder', "Escolha o modelo que este recurso vai usar")
			: localize('aiFeatureModel.placeholderEmpty', "Nenhum provedor de IA configurado ainda"),
		activeItem: active,
	});
	if (!picked) {
		return;
	}

	// Both keys are written together: a vendor left behind from an earlier pick
	// would filter out the model just chosen.
	await configurationService.updateValue(`${feature.configSection}.modelId`, picked.model?.id ?? '', ConfigurationTarget.USER);
	await configurationService.updateValue(`${feature.configSection}.modelVendor`, picked.model?.vendor ?? '', ConfigurationTarget.USER);
}

interface IModelPick extends IQuickPickItem {
	/** Absent on the "automatic" entry, which clears the choice. */
	readonly model?: ILanguageModelChatMetadata;
}

/**
 * Reports the model a feature will use, and keeps reporting it as the choice or
 * the installed models change. Calls `onLabel` once before returning, so a view
 * can wire this up and have its label filled in.
 */
export function trackAiFeatureModel(
	languageModelsService: ILanguageModelsService,
	configurationService: IConfigurationService,
	feature: IAiFeature,
	onLabel: (label: string) => void,
): IDisposable {
	const store = new DisposableStore();
	const update = () => onLabel(describeAiFeatureModel(languageModelsService, configurationService, feature));
	store.add(configurationService.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration(`${feature.configSection}.modelId`) || e.affectsConfiguration(`${feature.configSection}.modelVendor`)) {
			update();
		}
	}));
	store.add(languageModelsService.onDidChangeLanguageModels(() => update()));
	update();
	return store;
}

/** Metadata for every model resolved so far, in the order the service holds them. */
function resolvedMetadata(languageModelsService: ILanguageModelsService): ILanguageModelChatMetadata[] {
	const models: ILanguageModelChatMetadata[] = [];
	for (const identifier of languageModelsService.getLanguageModelIds()) {
		const metadata = languageModelsService.lookupLanguageModel(identifier);
		if (metadata) {
			models.push(metadata);
		}
	}
	return models;
}
