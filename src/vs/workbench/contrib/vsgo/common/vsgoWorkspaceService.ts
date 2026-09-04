/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IVsgoWorkspaceService, VSGO_DIR_NAME, VSGO_GITIGNORE_CONTENT } from './vsgoWorkspace.js';

export class VsgoWorkspaceService extends Disposable implements IVsgoWorkspaceService {
	declare readonly _serviceBrand: undefined;

	/**
	 * Workspace folder hosting the artifacts. A multi-root workspace has no single obvious
	 * home, so an existing `.vsgo` wins over folder order — artifacts stay put when folders
	 * are reordered or a new one is added in front. Resolved lazily, then kept for the
	 * session so the choice cannot drift between two writes.
	 */
	private hostFolder: URI | undefined;
	private resolving: Promise<void> | undefined;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(() => {
			this.hostFolder = undefined;
			this.resolving = undefined;
			this.resolveHostFolder().catch(err => this.logService.warn('[vsgo] could not resolve artifacts folder', err));
		}));
		this.resolveHostFolder().catch(err => this.logService.warn('[vsgo] could not resolve artifacts folder', err));
	}

	getArtifactsRoot(subdir?: string): URI | undefined {
		const folder = this.hostFolder ?? this.firstFolder();
		if (!folder) {
			return undefined;
		}
		const root = URI.joinPath(folder, VSGO_DIR_NAME);
		return subdir ? URI.joinPath(root, subdir) : root;
	}

	async ensureArtifactsRoot(subdir?: string): Promise<URI | undefined> {
		await this.resolveHostFolder();
		const root = this.getArtifactsRoot();
		if (!root) {
			return undefined;
		}
		await this.createFolder(root);
		await this.ensureGitignore(root);
		if (!subdir) {
			return root;
		}
		const target = URI.joinPath(root, subdir);
		await this.createFolder(target);
		return target;
	}

	private firstFolder(): URI | undefined {
		const folders = this.workspaceContextService.getWorkspace().folders;
		return folders.length > 0 ? folders[0].uri : undefined;
	}

	private async resolveHostFolder(): Promise<void> {
		if (this.hostFolder) {
			return;
		}
		if (!this.resolving) {
			this.resolving = this.doResolveHostFolder();
		}
		await this.resolving;
	}

	private async doResolveHostFolder(): Promise<void> {
		const folders = this.workspaceContextService.getWorkspace().folders;
		for (const folder of folders) {
			if (await this.fileService.exists(URI.joinPath(folder.uri, VSGO_DIR_NAME))) {
				this.hostFolder = folder.uri;
				return;
			}
		}
		this.hostFolder = this.firstFolder();
	}

	private async createFolder(uri: URI): Promise<void> {
		try {
			await this.fileService.createFolder(uri);
		} catch {
			// ignore — the folder may already exist
		}
	}

	private async ensureGitignore(root: URI): Promise<void> {
		const gitignoreUri = URI.joinPath(root, '.gitignore');
		try {
			if (await this.fileService.exists(gitignoreUri)) {
				return;
			}
			await this.fileService.writeFile(gitignoreUri, VSBuffer.fromString(VSGO_GITIGNORE_CONTENT));
		} catch (err) {
			this.logService.warn('[vsgo] could not write .vsgo/.gitignore', err);
		}
	}
}
