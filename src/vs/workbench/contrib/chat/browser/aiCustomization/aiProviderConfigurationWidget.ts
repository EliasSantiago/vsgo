/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/aiCustomizationManagement.css';
import * as DOM from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { InputBox, MessageType } from '../../../../../base/browser/ui/inputbox/inputBox.js';
import { SelectBox } from '../../../../../base/browser/ui/selectBox/selectBox.js';
import { Checkbox } from '../../../../../base/browser/ui/toggle/toggle.js';
import { IStringDictionary } from '../../../../../base/common/collections.js';
import { IJSONSchema } from '../../../../../base/common/jsonSchema.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { defaultButtonStyles, defaultCheckboxStyles, defaultInputBoxStyles, defaultSelectBoxStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { ILanguageModelProviderDescriptor, ILanguageModelsService } from '../../common/languageModels.js';
import { ILanguageModelsConfigurationService } from '../../common/languageModelsConfiguration.js';

const $ = DOM.$;

/** One field of the form: how to read its value back and whether it is valid. */
interface IField {
	readonly property: string;
	/** The value to store, or `undefined` to leave the property out. */
	read(): unknown;
	/** An error message when the current value cannot be saved. */
	validate(): string | undefined;
	focus(): void;
}

/**
 * Form for creating or editing one configuration of a language model provider,
 * shown as a page inside the AI Providers section.
 *
 * The fields come from the provider's configuration schema: text and number
 * inputs, secrets masked, enums as a dropdown, booleans and enum lists as
 * checkboxes. Properties of any other shape cannot be edited here, so after
 * saving, the configuration file opens on the group for them, as the
 * quick-input flow does.
 */
export class AIProviderConfigurationWidget extends Disposable {

	readonly element: HTMLElement;

	private readonly formDisposables = this._register(new DisposableStore());
	private fields: IField[] = [];
	private nameField: IField | undefined;

	constructor(
		@ILanguageModelsService private readonly languageModelsService: ILanguageModelsService,
		@ILanguageModelsConfigurationService private readonly languageModelsConfigurationService: ILanguageModelsConfigurationService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super();
		this.element = $('.ai-provider-config');
	}

	/**
	 * Renders the form for `vendor`, filled with the group named `groupName`
	 * when editing one. `done` runs once the user saves or cancels.
	 */
	async show(vendor: ILanguageModelProviderDescriptor, groupName: string | undefined, done: () => void): Promise<void> {
		this.formDisposables.clear();
		this.fields = [];
		DOM.clearNode(this.element);

		// The descriptor's type is derived from the extension point schema; the
		// configuration it carries is a JSON schema like any other.
		const schema = vendor.configuration as IJSONSchema | undefined;
		const existing = groupName !== undefined
			? await this.languageModelsService.getLanguageModelsProviderGroupConfiguration(vendor.vendor, groupName)
			: undefined;

		const header = DOM.append(this.element, $('.ai-provider-config-header'));
		DOM.append(header, $('h2.ai-provider-config-title')).textContent = groupName !== undefined
			? localize('editProviderConfig', "Editar {0}", groupName)
			: localize('newProviderConfig', "Configurar {0}", vendor.displayName);
		DOM.append(header, $('p.ai-provider-config-description')).textContent = localize('providerConfigDescription', "As chaves de API ficam no armazenamento seguro do sistema, nunca no arquivo de configuração.");

		const form = DOM.append(this.element, $('.ai-provider-config-form'));

		this.nameField = this.createTextField(form, {
			property: 'name',
			label: localize('configName', "Nome"),
			description: localize('configNameDescription', "Identifica esta configuração quando o provedor tem mais de uma."),
			required: true,
			value: groupName ?? this.suggestName(vendor),
		});

		const unsupported: string[] = [];
		for (const [property, propertySchema] of Object.entries(schema?.properties ?? {})) {
			const field = this.createField(form, property, propertySchema, !!schema?.required?.includes(property), existing?.[property]);
			if (field) {
				this.fields.push(field);
			} else {
				unsupported.push(propertySchema.title ?? property);
			}
		}
		if (unsupported.length > 0 || schema?.additionalProperties) {
			DOM.append(form, $('p.ai-provider-config-note')).textContent = localize('advancedConfigNote', "Outras opções deste provedor são editadas no arquivo de configuração, que abre depois de salvar.");
		}

		const actions = DOM.append(this.element, $('.ai-provider-config-actions'));
		const save = this.formDisposables.add(new Button(actions, { ...defaultButtonStyles }));
		save.label = localize('saveProviderConfig', "Salvar");
		const cancel = this.formDisposables.add(new Button(actions, { ...defaultButtonStyles, secondary: true }));
		cancel.label = localize('cancelProviderConfig', "Cancelar");

		this.formDisposables.add(cancel.onDidClick(done));
		this.formDisposables.add(save.onDidClick(async () => {
			if (!this.validate()) {
				return;
			}
			const name = this.nameField!.read() as string;
			const configuration: IStringDictionary<unknown> = {};
			for (const field of this.fields) {
				const value = field.read();
				if (value !== undefined) {
					configuration[field.property] = value;
				}
			}
			save.enabled = false;
			try {
				const saved = await this.languageModelsService.saveLanguageModelsProviderGroup(vendor.vendor, name, schema ? configuration : undefined, groupName);
				done();
				if (unsupported.length > 0 || schema?.additionalProperties) {
					await this.languageModelsConfigurationService.configureLanguageModels({ group: saved });
				}
			} catch (error) {
				save.enabled = true;
				this.notificationService.error(error instanceof Error ? error.message : String(error));
			}
		}));

		this.nameField.focus();
	}

	/** First field in the form that reports a problem gets the focus; true when none does. */
	private validate(): boolean {
		let valid = true;
		for (const field of [this.nameField!, ...this.fields]) {
			if (field.validate() !== undefined && valid) {
				field.focus();
				valid = false;
			}
		}
		return valid;
	}

	/** The vendor's name, numbered past the configurations it already has. */
	private suggestName(vendor: ILanguageModelProviderDescriptor): string {
		const taken = new Set(this.languageModelsConfigurationService.getLanguageModelsProviderGroups()
			.filter(g => g.vendor === vendor.vendor)
			.map(g => g.name));
		let name = vendor.displayName;
		for (let count = 2; taken.has(name); count++) {
			name = `${vendor.displayName} ${count}`;
		}
		return name;
	}

	private createField(parent: HTMLElement, property: string, schema: IJSONSchema, required: boolean, value: unknown): IField | undefined {
		const label = schema.title ?? property;
		const description = schema.description ?? '';
		if (schema.type === 'boolean') {
			return this.createBooleanField(parent, property, label, description, value ?? schema.default);
		}
		if (schema.type === 'string' && Array.isArray(schema.enum)) {
			return this.createEnumField(parent, property, label, description, schema, value ?? schema.default);
		}
		if (schema.type === 'string' || schema.type === 'number' || schema.type === 'integer') {
			return this.createTextField(parent, {
				property,
				label,
				description,
				required,
				secret: !!schema.secret,
				numeric: schema.type !== 'string',
				value: value ?? schema.default,
			});
		}
		if (schema.type === 'array' && schema.items && !Array.isArray(schema.items) && Array.isArray(schema.items.enum)) {
			return this.createEnumListField(parent, property, label, description, schema.items.enum.map(String), value);
		}
		return undefined;
	}

	/** A row of the form: label and help text above the control. */
	private createRow(parent: HTMLElement, label: string, description: string, required = false): HTMLElement {
		const row = DOM.append(parent, $('.ai-provider-config-field'));
		const labelEl = DOM.append(row, $('.ai-provider-config-label'));
		labelEl.textContent = label;
		if (required) {
			DOM.append(labelEl, $('span.ai-provider-config-required')).textContent = ' *';
		}
		if (description) {
			DOM.append(row, $('.ai-provider-config-help')).textContent = description;
		}
		return DOM.append(row, $('.ai-provider-config-control'));
	}

	private createTextField(parent: HTMLElement, options: { property: string; label: string; description: string; required: boolean; secret?: boolean; numeric?: boolean; value: unknown }): IField {
		const control = this.createRow(parent, options.label, options.description, options.required);
		const check = (value: string): string | undefined => {
			if (!value.trim()) {
				return options.required ? localize('fieldRequired', "Preencha este campo.") : undefined;
			}
			if (options.numeric && isNaN(Number(value))) {
				return localize('fieldNumber', "Informe um número.");
			}
			return undefined;
		};
		const input = this.formDisposables.add(new InputBox(control, this.contextViewService, {
			type: options.secret ? 'password' : 'text',
			ariaLabel: options.label,
			inputBoxStyles: defaultInputBoxStyles,
			validationOptions: {
				validation: value => {
					const content = check(value);
					return content ? { content, type: MessageType.ERROR } : null;
				},
			},
		}));
		input.value = options.value === undefined || options.value === null ? '' : String(options.value);
		return {
			property: options.property,
			read: () => {
				const value = input.value.trim();
				if (!value) {
					return undefined;
				}
				return options.numeric ? Number(value) : value;
			},
			validate: () => {
				input.validate();
				return check(input.value);
			},
			focus: () => input.focus(),
		};
	}

	private createBooleanField(parent: HTMLElement, property: string, label: string, description: string, value: unknown): IField {
		const control = this.createRow(parent, label, description);
		const checkbox = this.formDisposables.add(new Checkbox(label, value === true, defaultCheckboxStyles));
		control.appendChild(checkbox.domNode);
		return {
			property,
			read: () => checkbox.checked,
			validate: () => undefined,
			focus: () => checkbox.focus(),
		};
	}

	private createEnumField(parent: HTMLElement, property: string, label: string, description: string, schema: IJSONSchema, value: unknown): IField {
		const control = this.createRow(parent, label, description);
		const values = schema.enum!.map(String);
		const selectBox = this.formDisposables.add(new SelectBox(
			values.map((v, i) => ({ text: v, description: schema.enumDescriptions?.[i] })),
			Math.max(0, values.indexOf(String(value))),
			this.contextViewService,
			defaultSelectBoxStyles,
			{ ariaLabel: label },
		));
		let selected = Math.max(0, values.indexOf(String(value)));
		this.formDisposables.add(selectBox.onDidSelect(e => selected = e.index));
		selectBox.render(control);
		return {
			property,
			read: () => values[selected],
			validate: () => undefined,
			focus: () => selectBox.focus(),
		};
	}

	private createEnumListField(parent: HTMLElement, property: string, label: string, description: string, items: readonly string[], value: unknown): IField {
		const control = this.createRow(parent, label, description);
		const current = new Set(Array.isArray(value) ? value.map(String) : []);
		const boxes = items.map(item => {
			const option = DOM.append(control, $('.ai-provider-config-option'));
			const checkbox = this.formDisposables.add(new Checkbox(item, current.has(item), defaultCheckboxStyles));
			option.appendChild(checkbox.domNode);
			DOM.append(option, $('span')).textContent = item;
			return { item, checkbox };
		});
		return {
			property,
			read: () => {
				const picked = boxes.filter(b => b.checkbox.checked).map(b => b.item);
				return picked.length > 0 ? picked : undefined;
			},
			validate: () => undefined,
			focus: () => boxes[0]?.checkbox.focus(),
		};
	}
}
