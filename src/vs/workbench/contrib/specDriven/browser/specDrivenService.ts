/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { FileOperationResult, IFileService, toFileOperationResult } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { resolveAiFeatureModel } from '../../chat/common/aiFeatureModel.js';
import { ChatMessageRole, getTextResponseFromStream, IChatMessage, ILanguageModelsService } from '../../chat/common/languageModels.js';
import {
	ALL_DOC_PHASES,
	ISpecArtifacts,
	ISpecDrivenConfiguration,
	ISpecDrivenService,
	ISpecKitScaffoldResult,
	ISpecRun,
	ISpecRunOpts,
	SpecDocPhase,
	SpecProjectType,
	ISpecFolderInfo,
	SPEC_DRIVEN_CONFIG_SECTION,
	SPEC_DRIVEN_STATE_SUBDIR,
	SPEC_KIT_CONSTITUTION_FILE,
	SPEC_KIT_MEMORY_DIR,
	SPEC_KIT_SPECIFY_DIR,
	SPEC_KIT_SPECS_DIR,
	SPEC_KIT_TEMPLATES_DIR,
} from '../common/spec.js';
import {
	CONSTITUTION_CONTENT,
	EXAMPLE_SPEC_SLUG,
	PLAN_TEMPLATE_CONTENT,
	SPECS_README_CONTENT,
	SPEC_TEMPLATE_CONTENT,
	TASKS_TEMPLATE_CONTENT,
} from './specKitTemplates.js';
import { IVsgoWorkspaceService } from '../../vsgo/common/vsgoWorkspace.js';

// 2: runs produce spec-kit documents (spec/plan/tasks) instead of the old four-document set,
// so indexes written by earlier versions are dropped rather than migrated — the documents they
// point at stay on disk.
const RUNS_VERSION = 2;
const RUNS_INDEX_FILE = 'index.json';
const MAX_CONTEXT_FILE_SIZE_BYTES = 32 * 1024;
const MAX_CONTEXT_FILES = 10;

interface IRunsIndex {
	readonly version: number;
	readonly runs: ISpecRun[];
}

const SYSTEM_PROMPT_MATCH = `Você classifica pedidos de especificação em um projeto que usa spec-kit.
Recebe a lista de specs existentes e um novo pedido do usuário.

Responda APENAS com o identificador da pasta (ex.: \`002-autenticacao\`) da spec que o pedido
claramente CONTINUA, DETALHA ou ATUALIZA.

Responda exatamente \`NENHUMA\` quando o pedido tratar de uma funcionalidade nova, quando apenas
tangenciar uma spec existente, ou quando houver qualquer dúvida. Na dúvida, prefira \`NENHUMA\` —
criar uma spec a mais é barato, sobrescrever a spec errada não é.

Sem explicação, sem pontuação, apenas o identificador ou \`NENHUMA\`.`;

const SYSTEM_PROMPT_SPEC = `Você é um analista de requisitos especializado em Spec Driven Development.
Gere o conteúdo de \`spec.md\` no formato do spec-kit, com base na descrição e no contexto do workspace.
Escreva TODO o conteúdo em português do Brasil (pt-BR).

REGRA CENTRAL: a spec descreve **o quê** e **o porquê**, nunca o **como**. É proibido citar
linguagens, frameworks, bibliotecas, bancos de dados, endpoints, esquemas ou nomes de arquivo —
tudo isso pertence ao \`plan.md\`. Informação que faltar vira \`[NEEDS CLARIFICATION: pergunta]\`,
nunca uma invenção plausível.

Use exatamente esta estrutura, mantendo os prefixos de numeração:
# Spec: <identificador> — <título>

**Status:** Rascunho
**Depende de:** <identificadores de outras specs, ou "nenhuma">

## Resumo
_(Uma a três frases descrevendo o domínio.)_

## Problema e objetivo

## Papéis

## Histórias de usuário
- Como <papel>, quero <ação>, para que <benefício>.

## Requisitos funcionais (RF)
- **RF-001:** <comportamento observável>

## Requisitos não-funcionais (RNF)
- **RNF-001:** <desempenho, segurança, privacidade, disponibilidade, usabilidade...>

## Regras de negócio (RN)
- **RN-001:** <invariante ou política do domínio>

## Critérios de aceitação (Given/When/Then)
- **CA-001** (cobre RF-001):
  - **Dado** <pré-condição>
  - **Quando** <ação>
  - **Então** <resultado esperado>

## Fora de escopo

## Dependências

## Questões em aberto

Todo RF precisa de ao menos um CA que o cubra, e cada CA declara qual RF cobre.
Gere APENAS o conteúdo markdown. Sem preâmbulo nem explicações fora do documento.`;

const SYSTEM_PROMPT_PLAN = `Você é um arquiteto de software especializado em Spec Driven Development.
Gere o conteúdo de \`plan.md\` no formato do spec-kit, a partir da spec fornecida.
Escreva TODO o conteúdo em português do Brasil (pt-BR).

REGRA CENTRAL: o plano é o **como**. Toda escolha técnica — linguagem, framework, banco,
contratos, topologia — vive aqui e em nenhum outro documento. Cada decisão relevante registra as
alternativas consideradas e o motivo da escolha. Não reescreva requisitos: referencie-os por RF/RNF.

Use exatamente esta estrutura:
# Plan: <identificador> — <título>

**Status:** Rascunho
**Spec:** ./spec.md

## Checklist de conformidade com a constituição
- [ ] Spec correspondente está Aprovada e livre de implementação
- [ ] Critérios de aceitação mapeados para testes
- [ ] Tipagem estrita
- [ ] Domínio isolado de frameworks/infra
- [ ] Simplicidade / YAGNI respeitados
- [ ] Privacidade por padrão considerada

## Abordagem / arquitetura
_(Visão geral da solução. Diagrama ASCII ou Mermaid se ajudar.)_

## Modelo de dados

## Contratos / API

## Componentes de frontend
_(Se não se aplicar, escreva "Não se aplica".)_

## Decisões e alternativas
- **Decisão:** <escolha> — **Alternativas consideradas:** <...> — **Motivo:** <...>

## Riscos e mitigações
- **Risco:** <...> — **Mitigação:** <...>

## Estratégia de testes
_(Unidade, integração, e2e; quais critérios de aceitação cada nível cobre.)_

Marque \`[x]\` na checklist apenas o que o plano realmente garante; deixe \`[ ]\` no que ficou pendente.
Gere APENAS o conteúdo markdown. Sem preâmbulo nem explicações fora do documento.`;

const SYSTEM_PROMPT_TASKS = `Você é um tech lead especializado em Spec Driven Development.
Gere o conteúdo de \`tasks.md\` no formato do spec-kit, a partir da spec e do plano fornecidos.
Escreva TODO o conteúdo em português do Brasil (pt-BR).

REGRA CENTRAL: cada tarefa é executável e rastreável. Numere como \`Tnnn\`, marque \`[P]\` nas que
podem rodar em paralelo e referencie o RF ou CA que a tarefa cobre. Todo CA da spec precisa de ao
menos uma tarefa de teste que o cubra.

Use exatamente esta estrutura:
# Tasks: <identificador> — <título>

**Status:** Rascunho
**Spec:** ./spec.md · **Plan:** ./plan.md

## Fase 1 — Preparação
- [ ] **T001** <descrição> — _(ref: —)_

## Fase 2 — Domínio / dados
- [ ] **T010** <descrição> — _(ref: RF-001)_

## Fase 3 — Backend / API
- [ ] **T020** <descrição> — _(ref: RF-001)_

## Fase 4 — Frontend
- [ ] **T030 [P]** <descrição> — _(ref: RF-001)_

## Fase 5 — Testes
- [ ] **T040** <teste que cobre CA-001> — _(ref: CA-001)_

## Fase 6 — Finalização
- [ ] **T050** <documentação, revisão, release> — _(ref: —)_

Fases sem tarefa aplicável podem ser omitidas.
Gere APENAS o conteúdo markdown. Sem preâmbulo nem explicações fora do documento.`;

export class SpecDrivenService extends Disposable implements ISpecDrivenService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeRuns = this._register(new Emitter<void>());
	readonly onDidChangeRuns = this._onDidChangeRuns.event;

	private readonly _onDidChangeRun = this._register(new Emitter<string>());
	readonly onDidChangeRun = this._onDidChangeRun.event;

	private readonly _runs = new Map<string, ISpecRun>();
	private readonly _activeCts = new Map<string, CancellationTokenSource>();

	constructor(
		@ILanguageModelsService private readonly languageModelsService: ILanguageModelsService,
		@IFileService private readonly fileService: IFileService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@INotificationService private readonly notificationService: INotificationService,
		@ILogService private readonly logService: ILogService,
		@IVsgoWorkspaceService private readonly vsgoWorkspaceService: IVsgoWorkspaceService,
	) {
		super();
		this.rehydrate().catch(err => this.logService.warn('[specDriven] rehydrate failed', err));
	}

	getRuns(): readonly ISpecRun[] {
		return Array.from(this._runs.values()).sort((a, b) => b.startedAt - a.startedAt);
	}

	getRun(id: string): ISpecRun | undefined {
		return this._runs.get(id);
	}

	getSpecsDirectory(): URI | undefined {
		const root = this.getWorkspaceRoot();
		if (!root) { return undefined; }
		return URI.joinPath(root, SPEC_KIT_SPECS_DIR);
	}

	private getWorkspaceRoot(): URI | undefined {
		const folders = this.workspaceContextService.getWorkspace().folders;
		return folders.length > 0 ? folders[0].uri : undefined;
	}

	async isSpecKitConfigured(): Promise<boolean> {
		const root = this.getWorkspaceRoot();
		if (!root) { return false; }
		const markers = [
			URI.joinPath(root, SPEC_KIT_SPECIFY_DIR),
			this.legacyConstitutionUri(root),
		];
		for (const marker of markers) {
			if (await this.fileService.exists(marker)) { return true; }
		}
		return false;
	}

	async scaffoldSpecKit(): Promise<ISpecKitScaffoldResult> {
		const root = this.getWorkspaceRoot();
		if (!root) {
			this.notificationService.info(localize('specDriven.noWorkspaceScaffold', "Spec Driven: abra uma pasta primeiro."));
			return { created: false };
		}

		const specifyDir = URI.joinPath(root, SPEC_KIT_SPECIFY_DIR);
		const memoryDir = URI.joinPath(specifyDir, SPEC_KIT_MEMORY_DIR);
		const constitutionUri = this.constitutionUri(root);
		const templatesDir = URI.joinPath(specifyDir, SPEC_KIT_TEMPLATES_DIR);
		const specsDir = URI.joinPath(root, SPEC_KIT_SPECS_DIR);
		const exampleDir = URI.joinPath(specsDir, EXAMPLE_SPEC_SLUG);

		try {
			await this.ensureDirectory(memoryDir);
			await this.ensureDirectory(templatesDir);
			await this.ensureDirectory(specsDir);
			await this.ensureDirectory(exampleDir);

			const migrated = await this.migrateLegacyConstitution(root, constitutionUri);

			const writes: Array<Promise<boolean>> = [
				this.writeFileIfAbsent(constitutionUri, CONSTITUTION_CONTENT),
				this.writeFileIfAbsent(URI.joinPath(templatesDir, 'spec-template.md'), SPEC_TEMPLATE_CONTENT),
				this.writeFileIfAbsent(URI.joinPath(templatesDir, 'plan-template.md'), PLAN_TEMPLATE_CONTENT),
				this.writeFileIfAbsent(URI.joinPath(templatesDir, 'tasks-template.md'), TASKS_TEMPLATE_CONTENT),
				this.writeFileIfAbsent(URI.joinPath(specsDir, 'README.md'), SPECS_README_CONTENT),
				this.writeFileIfAbsent(URI.joinPath(exampleDir, 'spec.md'), SPEC_TEMPLATE_CONTENT),
				this.writeFileIfAbsent(URI.joinPath(exampleDir, 'plan.md'), PLAN_TEMPLATE_CONTENT),
				this.writeFileIfAbsent(URI.joinPath(exampleDir, 'tasks.md'), TASKS_TEMPLATE_CONTENT),
			];
			const results = await Promise.all(writes);
			return { created: results.some(Boolean) || migrated, constitutionUri, migrated };
		} catch (err) {
			const msg = String(err instanceof Error ? err.message : err);
			this.logService.error('[specDriven] scaffold error', err);
			this.notificationService.error(localize('specDriven.scaffoldFailed', "Falha ao configurar Spec Driven Development: {0}", msg));
			return { created: false };
		}
	}

	async listSpecFolders(): Promise<readonly ISpecFolderInfo[]> {
		const specsDir = this.getSpecsDirectory();
		if (!specsDir) { return []; }
		const folders: ISpecFolderInfo[] = [];
		try {
			const stat = await this.fileService.resolve(specsDir);
			for (const child of stat.children ?? []) {
				if (!child.isDirectory || !/^\d{3,}-/.test(child.name)) { continue; }
				const spec = await this.readDocIfPresent(child.resource, 'spec.md');
				if (!spec) { continue; }
				folders.push({ folder: child.name, ...describeSpec(spec) });
			}
		} catch (err) {
			this.logService.warn('[specDriven] could not list spec folders', err);
		}
		return folders.sort((a, b) => b.folder.localeCompare(a.folder));
	}

	async matchSpecFolder(description: string, token?: CancellationToken): Promise<string | undefined> {
		const folders = await this.listSpecFolders();
		if (folders.length === 0 || !description.trim()) { return undefined; }

		const modelId = await this.pickModel(this.getConfig());
		if (!modelId) { return undefined; }

		const catalog = folders
			.map(f => `- ${f.folder} — ${f.title}${f.summary ? `: ${f.summary}` : ''}`)
			.join('\n');
		const userContent = `## Specs existentes\n\n${catalog}\n\n## Novo pedido\n\n${description}`;

		try {
			const answer = await this.generateDocument(
				SYSTEM_PROMPT_MATCH,
				userContent,
				modelId,
				token ?? CancellationToken.None,
			);
			const candidate = answer.trim().split(/\s|`/).find(Boolean) ?? '';
			return folders.some(f => f.folder === candidate) ? candidate : undefined;
		} catch (err) {
			// Matching is an optimisation: a failure must not block the generation itself.
			this.logService.warn('[specDriven] spec matching failed', err);
			return undefined;
		}
	}

	private async readDocIfPresent(dir: URI, name: string): Promise<string> {
		try {
			const buf = await this.fileService.readFile(URI.joinPath(dir, name));
			return buf.value.toString().slice(0, MAX_CONTEXT_FILE_SIZE_BYTES);
		} catch {
			return '';
		}
	}

	/**
	 * Next `NNN-slug` folder name, continuing spec-kit's numbering. The existing folders are
	 * scanned so a new feature never collides with the seed `001-exemplo` or with a spec someone
	 * created by hand.
	 */
	private async nextSpecFolderName(specsDir: URI, slug: string): Promise<string> {
		let highest = 0;
		try {
			const stat = await this.fileService.resolve(specsDir);
			for (const child of stat.children ?? []) {
				const match = /^(\d{3,})-/.exec(child.name);
				if (child.isDirectory && match) {
					highest = Math.max(highest, parseInt(match[1], 10));
				}
			}
		} catch {
			// specs/ does not exist yet — start the sequence at 001
		}

		// Two runs started close together would otherwise pick the same number and overwrite each
		// other, so keep going until the folder is actually free.
		let next = highest + 1;
		while (await this.fileService.exists(URI.joinPath(specsDir, `${String(next).padStart(3, '0')}-${slug}`))) {
			next++;
		}
		return `${String(next).padStart(3, '0')}-${slug}`;
	}

	private constitutionUri(root: URI): URI {
		return URI.joinPath(root, SPEC_KIT_SPECIFY_DIR, SPEC_KIT_MEMORY_DIR, SPEC_KIT_CONSTITUTION_FILE);
	}

	/** Where earlier versions of vsgo put the constitution, before the `.specify` layout. */
	private legacyConstitutionUri(root: URI): URI {
		return URI.joinPath(root, SPEC_KIT_MEMORY_DIR, SPEC_KIT_CONSTITUTION_FILE);
	}

	/**
	 * Reads the project constitution, the principles every generated document has to respect.
	 * Falls back to the pre-`.specify` location so projects that never re-ran the setup still
	 * get their principles honoured. Returns an empty string when there is none.
	 */
	private async readConstitution(): Promise<string> {
		const root = this.getWorkspaceRoot();
		if (!root) { return ''; }
		for (const uri of [this.constitutionUri(root), this.legacyConstitutionUri(root)]) {
			try {
				const buf = await this.fileService.readFile(uri);
				const text = buf.value.toString().trim();
				if (text) {
					return text.slice(0, MAX_CONTEXT_FILE_SIZE_BYTES);
				}
			} catch {
				// not found at this location — try the next one
			}
		}
		return '';
	}

	/**
	 * Moves a constitution left at the project root by an earlier version into `.specify/memory`,
	 * so a project never ends up with two of them. The file is moved rather than recreated —
	 * it is a document the team edits, and the default content would overwrite their principles.
	 * Returns true when a move happened.
	 */
	private async migrateLegacyConstitution(root: URI, constitutionUri: URI): Promise<boolean> {
		const legacyUri = this.legacyConstitutionUri(root);
		try {
			if (!await this.fileService.exists(legacyUri) || await this.fileService.exists(constitutionUri)) {
				return false;
			}
			await this.fileService.move(legacyUri, constitutionUri);
			await this.deleteIfEmpty(URI.joinPath(root, SPEC_KIT_MEMORY_DIR));
			this.logService.info('[specDriven] migrated constitution to .specify/memory');
			return true;
		} catch (err) {
			this.logService.warn('[specDriven] could not migrate legacy constitution', err);
			return false;
		}
	}

	private async deleteIfEmpty(uri: URI): Promise<void> {
		try {
			const stat = await this.fileService.resolve(uri);
			if (stat.isDirectory && (stat.children ?? []).length === 0) {
				await this.fileService.del(uri, { useTrash: false });
			}
		} catch {
			// ignore — the folder may already be gone
		}
	}

	/** Writes `content` only when the file does not yet exist. Returns true when written. */
	private async writeFileIfAbsent(uri: URI, content: string): Promise<boolean> {
		if (await this.fileService.exists(uri)) { return false; }
		await this.fileService.writeFile(uri, VSBuffer.fromString(content));
		return true;
	}

	async startRun(description: string, opts?: ISpecRunOpts): Promise<string> {
		const folders = this.workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) {
			this.notificationService.info(localize('specDriven.noWorkspace', "Spec Driven: open a folder first."));
			return '';
		}
		const id = generateUuid();
		const selectedPhases: readonly SpecDocPhase[] = opts?.selectedPhases ?? ALL_DOC_PHASES;
		const run: ISpecRun = {
			id,
			name: slugify(description) || id.slice(0, 8),
			description,
			projectType: opts?.projectType ?? 'existing',
			selectedPhases,
			targetFolder: opts?.targetFolder,
			requestedModelId: opts?.modelId,
			startedAt: Date.now(),
			status: 'running',
			currentPhase: 'context',
			phaseIndex: 0,
			artifacts: {},
		};
		this._runs.set(id, run);
		this._onDidChangeRuns.fire();
		this._onDidChangeRun.fire(id);

		const cts = new CancellationTokenSource();
		this._activeCts.set(id, cts);
		this.executeRun(run, cts.token).catch(err => this.logService.error('[specDriven] run unhandled error', err));
		return id;
	}

	cancelRun(runId: string): void {
		this._activeCts.get(runId)?.cancel();
	}

	private async executeRun(run: ISpecRun, token: CancellationToken): Promise<void> {
		const config = this.getConfig();
		const sel = run.selectedPhases;
		// phaseIndex counts completed phases (context = 1 when done, then +1 per selected doc done)
		const totalPhases = sel.length + 1;

		try {
			// Phase 0: gather workspace context (always runs)
			this.updateRun(run.id, { currentPhase: 'context', phaseIndex: 0 });
			const workspaceContext = await this.gatherWorkspaceContext(token);
			if (token.isCancellationRequested) { this.finishRun(run.id, 'cancelled'); return; }

			// What the chat had selected wins over the feature's setting; the
			// setting is what the view's own button runs on.
			const modelId = run.requestedModelId ?? await this.pickModel(config);
			if (!modelId) {
				throw new Error(localize('specDriven.noModel', "Nenhum modelo de IA está disponível. Configure um provedor de IA primeiro."));
			}

			// One `NNN-slug` folder per run, in the project tree next to the rest of the spec-kit
			// structure, so the team reviews and commits it like any other source file.
			const specsDir = this.getSpecsDirectory();
			if (!specsDir) { throw new Error('No workspace'); }
			await this.ensureDirectory(specsDir);
			const folderName = run.targetFolder ?? await this.nextSpecFolderName(specsDir, run.name);
			const runDir = URI.joinPath(specsDir, folderName);
			await this.ensureDirectory(runDir);
			this.updateRun(run.id, { artifacts: { dirUri: runDir.toString() }, modelId, phaseIndex: 1 });

			// Read per run rather than once per session: the team edits the constitution, and the
			// next run should honour the edit without a reload.
			const constitution = await this.readConstitution();
			const baseContext = buildBaseContext(run.description, run.projectType, workspaceContext, constitution, folderName);

			// Documents already in the folder: they seed the context so a partial run can reference
			// them, and a regenerated document revises them instead of replacing them blindly.
			let spec = run.targetFolder ? await this.readDocIfPresent(runDir, 'spec.md') : '';
			let plan = run.targetFolder ? await this.readDocIfPresent(runDir, 'plan.md') : '';
			let completedCount = 1; // context already done

			// Phase 1: spec.md — what and why
			if (sel.includes('spec')) {
				this.updateRun(run.id, { currentPhase: 'spec', phaseIndex: completedCount });
				const ctx = spec ? buildRevisionContext(baseContext, 'spec.md', spec) : baseContext;
				spec = await this.generateDocument(SYSTEM_PROMPT_SPEC, ctx, modelId, token);
				if (token.isCancellationRequested) { this.finishRun(run.id, 'cancelled'); return; }
				const specUri = URI.joinPath(runDir, 'spec.md');
				await this.fileService.writeFile(specUri, VSBuffer.fromString(spec));
				completedCount++;
				this.updateRun(run.id, { artifacts: { ...this.getArtifacts(run.id), specUri: specUri.toString() }, phaseIndex: completedCount });
			}

			// Phase 2: plan.md — how
			if (sel.includes('plan')) {
				this.updateRun(run.id, { currentPhase: 'plan', phaseIndex: completedCount });
				const withSpec = buildDocContext(baseContext, { spec });
				const ctx = plan ? buildRevisionContext(withSpec, 'plan.md', plan) : withSpec;
				plan = await this.generateDocument(SYSTEM_PROMPT_PLAN, ctx, modelId, token);
				if (token.isCancellationRequested) { this.finishRun(run.id, 'cancelled'); return; }
				const planUri = URI.joinPath(runDir, 'plan.md');
				await this.fileService.writeFile(planUri, VSBuffer.fromString(plan));
				completedCount++;
				this.updateRun(run.id, { artifacts: { ...this.getArtifacts(run.id), planUri: planUri.toString() }, phaseIndex: completedCount });
			}

			// Phase 3: tasks.md — the work
			if (sel.includes('tasks')) {
				this.updateRun(run.id, { currentPhase: 'tasks', phaseIndex: completedCount });
				const withDocs = buildDocContext(baseContext, { spec, plan });
				const existingTasks = run.targetFolder ? await this.readDocIfPresent(runDir, 'tasks.md') : '';
				const ctx = existingTasks ? buildRevisionContext(withDocs, 'tasks.md', existingTasks) : withDocs;
				const tasks = await this.generateDocument(SYSTEM_PROMPT_TASKS, ctx, modelId, token);
				if (token.isCancellationRequested) { this.finishRun(run.id, 'cancelled'); return; }
				const tasksUri = URI.joinPath(runDir, 'tasks.md');
				await this.fileService.writeFile(tasksUri, VSBuffer.fromString(tasks));
				completedCount++;
				this.updateRun(run.id, { artifacts: { ...this.getArtifacts(run.id), tasksUri: tasksUri.toString() }, phaseIndex: completedCount });
			}

			this.updateRun(run.id, {
				status: 'done',
				endedAt: Date.now(),
				currentPhase: 'done',
				phaseIndex: totalPhases,
			});
			this._onDidChangeRuns.fire();
			await this.persistIndex();
		} catch (err) {
			if (!token.isCancellationRequested) {
				const msg = String(err instanceof Error ? err.message : err);
				this.logService.error('[specDriven] run error', err);
				this.notificationService.error(localize('specDriven.runFailed', "Spec generation failed: {0}", msg));
				this.updateRun(run.id, { status: 'error', endedAt: Date.now(), currentPhase: 'done', error: msg });
				this._onDidChangeRuns.fire();
				await this.persistIndex();
			}
		} finally {
			this._activeCts.delete(run.id);
		}
	}

	private finishRun(id: string, status: 'cancelled' | 'error'): void {
		this.updateRun(id, { status, endedAt: Date.now(), currentPhase: 'done' });
		this._onDidChangeRuns.fire();
		this.persistIndex().catch(err => this.logService.warn('[specDriven] persistIndex failed', err));
	}

	private getArtifacts(id: string): ISpecArtifacts {
		return this._runs.get(id)?.artifacts ?? {};
	}

	private async generateDocument(
		systemPrompt: string,
		userContent: string,
		modelId: string,
		token: CancellationToken,
	): Promise<string> {
		const messages: IChatMessage[] = [
			{ role: ChatMessageRole.System, content: [{ type: 'text', value: systemPrompt }] },
			{ role: ChatMessageRole.User, content: [{ type: 'text', value: userContent }] },
		];
		const response = await this.languageModelsService.sendChatRequest(modelId, undefined, messages, {}, token);
		return getTextResponseFromStream(response);
	}

	private async gatherWorkspaceContext(token: CancellationToken): Promise<string> {
		const folders = this.workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) { return ''; }
		const root = folders[0].uri;
		const parts: string[] = ['## Workspace Context'];

		// Top-level directory tree
		try {
			const stat = await this.fileService.resolve(root);
			const visible = (stat.children ?? []).filter(c => !c.name.startsWith('.'));
			parts.push('\n### Directory Structure (top-level)');
			for (const c of visible.slice(0, 40)) {
				parts.push(`- ${c.isDirectory ? '[dir]' : '[file]'} ${c.name}`);
			}
		} catch {
			// ignore if workspace root is unreadable
		}

		if (token.isCancellationRequested) { return parts.join('\n'); }

		// Key manifest / documentation files
		const keyFiles = [
			'README.md', 'README.txt', 'README.rst',
			'package.json', 'package-lock.json',
			'pyproject.toml', 'setup.py', 'requirements.txt',
			'Cargo.toml', 'go.mod', 'pom.xml',
			'build.gradle', 'composer.json', 'Gemfile',
			'CLAUDE.md', 'CONTRIBUTING.md',
		];
		let filesRead = 0;
		for (const name of keyFiles) {
			if (filesRead >= MAX_CONTEXT_FILES || token.isCancellationRequested) { break; }
			try {
				const uri = URI.joinPath(root, name);
				const stat = await this.fileService.stat(uri);
				if (stat.size && stat.size > MAX_CONTEXT_FILE_SIZE_BYTES) { continue; }
				const buf = await this.fileService.readFile(uri);
				parts.push(`\n### ${name}\n\`\`\`\n${buf.value.toString().slice(0, MAX_CONTEXT_FILE_SIZE_BYTES)}\n\`\`\``);
				filesRead++;
			} catch {
				// file not found — expected for most entries
			}
		}
		return parts.join('\n');
	}

	private updateRun(id: string, patch: Partial<ISpecRun>): void {
		const run = this._runs.get(id);
		if (!run) { return; }
		Object.assign(run, patch);
		this._onDidChangeRun.fire(id);
	}

	private async pickModel(config: ISpecDrivenConfiguration): Promise<string | undefined> {
		const resolved = await resolveAiFeatureModel(this.languageModelsService, { vendor: config.modelVendor, id: config.modelId });
		if (!resolved) {
			return undefined;
		}
		if (resolved.isSubstitute) {
			const name = this.languageModelsService.lookupLanguageModel(resolved.identifier)?.name ?? resolved.identifier;
			this.notificationService.warn(localize('specDriven.modelSubstituted', "O modelo configurado para o Spec Driven não está disponível. Usando {0}.", name));
		}
		return resolved.identifier;
	}

	private getConfig(): ISpecDrivenConfiguration {
		const c = this.configurationService.getValue<Partial<ISpecDrivenConfiguration>>(SPEC_DRIVEN_CONFIG_SECTION) || {};
		return {
			modelVendor: typeof c.modelVendor === 'string' ? c.modelVendor : '',
			modelId: typeof c.modelId === 'string' ? c.modelId : '',
			persistRuns: c.persistRuns !== false,
			runRetention: typeof c.runRetention === 'number' ? Math.max(1, c.runRetention) : 20,
		};
	}

	private async ensureDirectory(uri: URI): Promise<void> {
		try {
			await this.fileService.createFolder(uri);
		} catch {
			// ignore — folder may already exist
		}
	}

	/** Where the run index lives — machine state, not a document, so it stays under `.vsgo`. */
	private getIndexUri(): URI | undefined {
		const dir = this.vsgoWorkspaceService.getArtifactsRoot(SPEC_DRIVEN_STATE_SUBDIR);
		return dir ? URI.joinPath(dir, RUNS_INDEX_FILE) : undefined;
	}

	private async persistIndex(): Promise<void> {
		const config = this.getConfig();
		if (!config.persistRuns) { return; }
		const runs = Array.from(this._runs.values())
			.filter(r => r.status !== 'running')
			.sort((a, b) => b.startedAt - a.startedAt)
			.slice(0, config.runRetention);
		const index: IRunsIndex = { version: RUNS_VERSION, runs };
		try {
			const dir = await this.vsgoWorkspaceService.ensureArtifactsRoot(SPEC_DRIVEN_STATE_SUBDIR);
			if (!dir) { return; }
			await this.fileService.writeFile(URI.joinPath(dir, RUNS_INDEX_FILE), VSBuffer.fromString(JSON.stringify(index, null, 2)));
		} catch (err) {
			this.logService.warn('[specDriven] persistIndex failed', err);
		}
	}

	private async rehydrate(): Promise<void> {
		const config = this.getConfig();
		if (!config.persistRuns) { return; }
		const indexUri = this.getIndexUri();
		if (!indexUri) { return; }
		let content: string;
		try {
			const buf = await this.fileService.readFile(indexUri);
			content = buf.value.toString();
		} catch (err) {
			if (toFileOperationResult(err) !== FileOperationResult.FILE_NOT_FOUND) {
				this.logService.warn('[specDriven] could not read index', err);
			}
			return;
		}
		try {
			const index = JSON.parse(content) as IRunsIndex;
			if (!index || index.version !== RUNS_VERSION || !Array.isArray(index.runs)) { return; }
			for (const r of index.runs) {
				this._runs.set(r.id, { ...r });
			}
			this._onDidChangeRuns.fire();
		} catch (err) {
			this.logService.warn('[specDriven] index corrupt', err);
		}
	}
}

function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, '')
		.trim()
		.replace(/\s+/g, '-')
		.slice(0, 40);
}

function buildBaseContext(description: string, projectType: SpecProjectType, workspaceContext: string, constitution: string, specId: string): string {
	const typeLabel = projectType === 'new'
		? 'Novo projeto (greenfield — sem base de código existente)'
		: 'Projeto existente (brownfield — estender ou modificar base de código existente)';
	const parts: string[] = [];
	// The constitution comes first and states its own authority: it is the project's law, and
	// the model has to be told that it outranks the request when the two disagree.
	if (constitution) {
		parts.push(
			'## Constituição do Projeto\n\n' +
			'Princípios não-negociáveis deste projeto. Todo documento gerado DEVE respeitá-los.\n' +
			'Se a descrição do projeto conflitar com a constituição, a constituição prevalece —\n' +
			'registre o conflito no documento em vez de violá-la.\n\n' +
			constitution
		);
	}
	parts.push(`## Identificador desta Spec\n\n\`${specId}\` — use este identificador no título dos documentos.`);
	parts.push(`## Descrição do Projeto\n\n${description}`);
	parts.push(`## Tipo de Projeto\n\n${typeLabel}`);
	parts.push(workspaceContext);
	return parts.join('\n\n');
}

interface IDocContext {
	spec?: string;
	plan?: string;
}

function buildDocContext(base: string, docs: IDocContext): string {
	const parts: string[] = [base];
	if (docs.spec) { parts.push(`---\n\n## spec.md\n\n${docs.spec}`); }
	if (docs.plan) { parts.push(`---\n\n## plan.md\n\n${docs.plan}`); }
	return parts.join('\n\n');
}

/**
 * Context for regenerating a document that already exists. Without this the model rewrites from
 * scratch and silently drops decisions the team had already made, along with the RF/CA numbering
 * that the other documents reference.
 */
function buildRevisionContext(base: string, file: string, existing: string): string {
	return `${base}\n\n---\n\n## Versão atual de ${file}\n\n` +
		`Revise o documento abaixo incorporando o pedido acima. Preserve as decisões que continuam\n` +
		`válidas e a numeração existente (RF, RNF, RN, CA, T) — outros documentos referenciam esses\n` +
		`identificadores. Não recomece do zero.\n\n${existing}`;
}

/** Pulls a title and a one-line summary out of a `spec.md`, for matching against a new request. */
function describeSpec(content: string): { title: string; summary: string } {
	const lines = content.split(/\r?\n/);
	let title = '';
	for (const line of lines) {
		const match = /^#\s+(.*)$/.exec(line.trim());
		if (match) {
			title = match[1].replace(/^Spec:\s*/i, '').trim();
			break;
		}
	}
	let summary = '';
	const summaryIndex = lines.findIndex(line => /^##\s+Resumo\s*$/i.test(line.trim()));
	if (summaryIndex >= 0) {
		for (const line of lines.slice(summaryIndex + 1)) {
			const text = line.trim();
			if (text.startsWith('#')) { break; }
			// Skip the template's own placeholder, which says nothing about the feature.
			if (text && !text.startsWith('_(')) {
				summary = text;
				break;
			}
		}
	}
	return { title: title || '(sem título)', summary: summary.slice(0, 200) };
}
