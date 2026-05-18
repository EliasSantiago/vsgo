/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../../base/common/buffer.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { CHAT_CATEGORY } from './chatActions.js';

type SkillScope = 'workspace' | 'user';

interface ISkillScopePick extends IQuickPickItem {
	scope: SkillScope;
}

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

class CreateSkillAction extends Action2 {
	static readonly ID = 'workbench.action.chat.createSkill';

	constructor() {
		super({
			id: CreateSkillAction.ID,
			title: localize2('createSkill', 'Create Skill...'),
			category: CHAT_CATEGORY,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const fileService = accessor.get(IFileService);
		const editorService = accessor.get(IEditorService);
		const workspaceContextService = accessor.get(IWorkspaceContextService);
		const pathService = accessor.get(IPathService);
		const notificationService = accessor.get(INotificationService);

		const folders = workspaceContextService.getWorkspace().folders;
		const hasWorkspace = folders.length > 0;

		const scopeItems: ISkillScopePick[] = [];
		if (hasWorkspace) {
			scopeItems.push({
				label: localize('skillScope.workspace.label', 'Workspace'),
				description: localize('skillScope.workspace.desc', "Saved in '.agents/skills' of the current workspace"),
				scope: 'workspace',
			});
		}
		scopeItems.push({
			label: localize('skillScope.user.label', 'User'),
			description: localize('skillScope.user.desc', "Saved in '~/.agents/skills' (available in every workspace)"),
			scope: 'user',
		});

		const scopePick = await quickInputService.pick(scopeItems, {
			placeHolder: localize('skillScope.placeholder', 'Where should this skill live?'),
		});
		if (!scopePick) {
			return;
		}

		const skillName = await this.promptForName(quickInputService, fileService, scopePick.scope, folders[0]?.uri, pathService);
		if (!skillName) {
			return;
		}

		const description = await this.promptForDescription(quickInputService);
		if (description === undefined) {
			return;
		}

		let skillsRoot: URI;
		if (scopePick.scope === 'workspace') {
			skillsRoot = joinPath(folders[0].uri, '.agents', 'skills');
		} else {
			const userHome = await pathService.userHome();
			skillsRoot = joinPath(userHome, '.agents', 'skills');
		}

		const skillDir = joinPath(skillsRoot, skillName);
		const skillFile = joinPath(skillDir, 'SKILL.md');

		try {
			await fileService.createFolder(skillDir);
			await fileService.writeFile(skillFile, VSBuffer.fromString(buildSkillTemplate(skillName, description)));
			await editorService.openEditor({ resource: skillFile, options: { pinned: true } });
		} catch (error) {
			notificationService.notify({
				severity: Severity.Error,
				message: localize('createSkill.error', "Failed to create skill: {0}", String(error)),
			});
		}
	}

	private async promptForName(
		quickInputService: IQuickInputService,
		fileService: IFileService,
		scope: SkillScope,
		workspaceRoot: URI | undefined,
		pathService: IPathService,
	): Promise<string | undefined> {
		const store = new DisposableStore();
		try {
			const inputBox = store.add(quickInputService.createInputBox());
			inputBox.title = localize('skillName.title', 'Create Skill');
			inputBox.placeholder = localize('skillName.placeholder', 'e.g. pre-commit-review');
			inputBox.prompt = localize('skillName.prompt', "Skill name (lowercase, dashes only)");
			inputBox.ignoreFocusOut = true;

			const validate = async (value: string): Promise<string | undefined> => {
				const trimmed = value.trim();
				if (!trimmed) {
					return localize('skillName.empty', 'Name is required');
				}
				if (!SKILL_NAME_PATTERN.test(trimmed)) {
					return localize('skillName.invalid', "Use lowercase letters, numbers and dashes only");
				}
				const root = scope === 'workspace' && workspaceRoot
					? joinPath(workspaceRoot, '.agents', 'skills')
					: joinPath(await pathService.userHome(), '.agents', 'skills');
				const target = joinPath(root, trimmed);
				if (await fileService.exists(target)) {
					return localize('skillName.exists', "A skill named '{0}' already exists at this location", trimmed);
				}
				return undefined;
			};

			store.add(inputBox.onDidChangeValue(async value => {
				inputBox.validationMessage = await validate(value);
			}));

			inputBox.show();

			return await new Promise<string | undefined>(resolve => {
				store.add(inputBox.onDidAccept(async () => {
					const value = inputBox.value.trim();
					const error = await validate(value);
					if (error) {
						inputBox.validationMessage = error;
						return;
					}
					resolve(value);
					inputBox.hide();
				}));
				store.add(inputBox.onDidHide(() => resolve(undefined)));
			});
		} finally {
			store.dispose();
		}
	}

	private async promptForDescription(quickInputService: IQuickInputService): Promise<string | undefined> {
		const store = new DisposableStore();
		try {
			const inputBox = store.add(quickInputService.createInputBox());
			inputBox.title = localize('skillDescription.title', 'Create Skill');
			inputBox.placeholder = localize('skillDescription.placeholder', 'What does this skill do?');
			inputBox.prompt = localize('skillDescription.prompt', 'Description (optional, helps the assistant decide when to invoke it)');
			inputBox.ignoreFocusOut = true;
			inputBox.show();

			return await new Promise<string | undefined>(resolve => {
				store.add(inputBox.onDidAccept(() => {
					resolve(inputBox.value.trim());
					inputBox.hide();
				}));
				store.add(inputBox.onDidHide(() => resolve(undefined)));
			});
		} finally {
			store.dispose();
		}
	}
}

function buildSkillTemplate(name: string, description: string): string {
	const desc = description.replace(/'/g, "''");
	return `---
name: ${name}
description: '${desc}'
---

# ${name}

Describe the workflow this skill packages. Keep it focused and actionable.

## When to use

- Trigger 1
- Trigger 2

## Steps

1. First step
2. Second step
3. Third step
`;
}

export function registerChatSkillActions() {
	registerAction2(CreateSkillAction);
}

export const CREATE_SKILL_ACTION_ID = CreateSkillAction.ID;
