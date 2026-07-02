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
	SPEC_DRIVEN_CONFIG_SECTION,
	SPEC_DRIVEN_DIR_NAME,
	SPEC_DRIVEN_SUBDIR,
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

const RUNS_VERSION = 1;
const RUNS_INDEX_FILE = 'index.json';
const MAX_CONTEXT_FILE_SIZE_BYTES = 32 * 1024;
const MAX_CONTEXT_FILES = 10;

interface IRunsIndex {
	readonly version: number;
	readonly runs: ISpecRun[];
}

const SYSTEM_PROMPT_REQUIREMENTS = `Você é um analista de requisitos especializado em Spec Driven Development (SDD).
Gere um documento REQUIREMENTS.md completo com base na descrição do projeto e no contexto do workspace.
Escreva TODO o conteúdo em português do Brasil (pt-BR).

Use esta estrutura:
# Requisitos

## 1. Visão Geral

## 2. Objetivos

## 3. Não-Objetivos

## 4. Requisitos Funcionais
RF-001: <requisito> [Prioridade: MUST|SHOULD|COULD]
...

## 5. Requisitos Não-Funcionais
RNF-001 (Desempenho): ...
RNF-002 (Segurança): ...
RNF-003 (Disponibilidade): ...
RNF-004 (Manutenibilidade): ...
RNF-005 (Usabilidade): ...

## 6. Restrições e Premissas

Gere APENAS o conteúdo markdown. Sem preâmbulo nem explicações fora do documento.`;

const SYSTEM_PROMPT_STORIES = `Você é um especialista em práticas ágeis com foco em BDD e escrita de histórias de usuário.
Gere um documento USER_STORIES.md completo com base nos requisitos fornecidos.
Escreva TODO o conteúdo em português do Brasil (pt-BR).

Use esta estrutura:
# Histórias de Usuário

## Personas
Defina de 2 a 4 personas-chave relevantes para o sistema.

## Épicos e Histórias
Para cada épico, liste suas histórias:

### Épico E-001: <título>
#### HU-001: <título>
**Como** <persona>, **quero** <objetivo>, **para que** <benefício>.
**Prioridade:** MUST|SHOULD|COULD
**Story Points:** 1|2|3|5|8
**Critérios de Aceite:**
- Dado <pré-condição>, quando <ação>, então <resultado>.

Gere APENAS o conteúdo markdown. Sem preâmbulo nem explicações fora do documento.`;

const SYSTEM_PROMPT_ARCHITECTURE = `Você é um arquiteto de software especializado em design de sistemas escaláveis.
Gere um documento ARCHITECTURE.md completo com base nos requisitos e histórias de usuário fornecidos.
Escreva TODO o conteúdo em português do Brasil (pt-BR).

Use esta estrutura:
# Arquitetura

## Visão Geral do Sistema
Descrição de alto nível. Inclua um diagrama ASCII ou Mermaid.

## Componentes
Descreva cada componente, serviço ou módulo principal.

## Modelo de Dados
Entidades principais, seus atributos e relacionamentos.

## Stack Tecnológico
Tecnologias recomendadas com justificativas baseadas nos requisitos.

## Pontos de Integração
Sistemas externos, APIs, barramentos de eventos e padrões de comunicação.

## Registros de Decisão de Arquitetura (ADR)
### ADR-001: <decisão>
**Status:** Aceito
**Contexto:** ...
**Decisão:** ...
**Consequências:** ...

Gere APENAS o conteúdo markdown. Sem preâmbulo nem explicações fora do documento.`;

const SYSTEM_PROMPT_TASKS = `Você é um gerente de projetos especializado em planejamento ágil e breakdown de tarefas.
Gere um documento TASKS.md completo com base em todos os documentos de especificação fornecidos.
Escreva TODO o conteúdo em português do Brasil (pt-BR).

Use esta estrutura:
# Tarefas

## Marcos (Milestones)
| ID | Nome | Prazo | Descrição |
|----|------|-------|-----------|
| M1 | ... | Semana 2 | ... |

## Backlog de Tarefas
Para cada tarefa:
### T-001: <título>
**Marco:** M1
**Esforço:** P (<4h) | M (4–8h) | G (1–2d) | GG (>2d)
**Dependências:** T-XXX
**Descrição:** ...
**Concluído quando:** ...

## Plano de Sprints (Sugerido)
Agrupe as tarefas em sprints de 2 semanas.

## Definição de Pronto
- [ ] ...

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
		return URI.joinPath(root, SPEC_DRIVEN_DIR_NAME, SPEC_DRIVEN_SUBDIR);
	}

	private getWorkspaceRoot(): URI | undefined {
		const folders = this.workspaceContextService.getWorkspace().folders;
		return folders.length > 0 ? folders[0].uri : undefined;
	}

	async isSpecKitConfigured(): Promise<boolean> {
		const root = this.getWorkspaceRoot();
		if (!root) { return false; }
		const markers = [
			URI.joinPath(root, SPEC_KIT_MEMORY_DIR, SPEC_KIT_CONSTITUTION_FILE),
			URI.joinPath(root, SPEC_KIT_SPECIFY_DIR),
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

		const constitutionUri = URI.joinPath(root, SPEC_KIT_MEMORY_DIR, SPEC_KIT_CONSTITUTION_FILE);
		const templatesDir = URI.joinPath(root, SPEC_KIT_SPECIFY_DIR, SPEC_KIT_TEMPLATES_DIR);
		const specsDir = URI.joinPath(root, SPEC_KIT_SPECS_DIR);
		const exampleDir = URI.joinPath(specsDir, EXAMPLE_SPEC_SLUG);

		try {
			await this.ensureDirectory(URI.joinPath(root, SPEC_KIT_MEMORY_DIR));
			await this.ensureDirectory(templatesDir);
			await this.ensureDirectory(specsDir);
			await this.ensureDirectory(exampleDir);

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
			return { created: results.some(Boolean), constitutionUri };
		} catch (err) {
			const msg = String(err instanceof Error ? err.message : err);
			this.logService.error('[specDriven] scaffold error', err);
			this.notificationService.error(localize('specDriven.scaffoldFailed', "Falha ao configurar Spec Driven Development: {0}", msg));
			return { created: false };
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

			const modelId = await this.pickModel(config);
			if (!modelId) {
				throw new Error(localize('specDriven.noModel', "Nenhum modelo de IA está disponível. Configure um provedor de IA primeiro."));
			}

			const specsDir = this.getSpecsDirectory();
			if (!specsDir) { throw new Error('No workspace'); }
			const stamp = new Date(run.startedAt).toISOString().replace(/[:.]/g, '-').slice(0, 19);
			const runDir = URI.joinPath(specsDir, `${stamp}-${run.name}`);
			await this.ensureDirectory(specsDir);
			await this.ensureDirectory(runDir);
			this.updateRun(run.id, { artifacts: { dirUri: runDir.toString() }, modelId, phaseIndex: 1 });

			const baseContext = buildBaseContext(run.description, run.projectType, workspaceContext);

			// Accumulated doc content — only populated when a phase is actually run
			let requirements = '';
			let stories = '';
			let architecture = '';
			let completedCount = 1; // context already done

			// Phase 1: Requirements
			if (sel.includes('requirements')) {
				this.updateRun(run.id, { currentPhase: 'requirements', phaseIndex: completedCount });
				requirements = await this.generateDocument(SYSTEM_PROMPT_REQUIREMENTS, baseContext, modelId, token);
				if (token.isCancellationRequested) { this.finishRun(run.id, 'cancelled'); return; }
				const reqUri = URI.joinPath(runDir, 'REQUIREMENTS.md');
				await this.fileService.writeFile(reqUri, VSBuffer.fromString(requirements));
				completedCount++;
				this.updateRun(run.id, { artifacts: { ...this.getArtifacts(run.id), requirementsUri: reqUri.toString() }, phaseIndex: completedCount });
			}

			// Phase 2: User Stories
			if (sel.includes('stories')) {
				this.updateRun(run.id, { currentPhase: 'stories', phaseIndex: completedCount });
				const ctx = buildDocContext(baseContext, { requirements });
				stories = await this.generateDocument(SYSTEM_PROMPT_STORIES, ctx, modelId, token);
				if (token.isCancellationRequested) { this.finishRun(run.id, 'cancelled'); return; }
				const storiesUri = URI.joinPath(runDir, 'USER_STORIES.md');
				await this.fileService.writeFile(storiesUri, VSBuffer.fromString(stories));
				completedCount++;
				this.updateRun(run.id, { artifacts: { ...this.getArtifacts(run.id), storiesUri: storiesUri.toString() }, phaseIndex: completedCount });
			}

			// Phase 3: Architecture
			if (sel.includes('architecture')) {
				this.updateRun(run.id, { currentPhase: 'architecture', phaseIndex: completedCount });
				const ctx = buildDocContext(baseContext, { requirements, stories });
				architecture = await this.generateDocument(SYSTEM_PROMPT_ARCHITECTURE, ctx, modelId, token);
				if (token.isCancellationRequested) { this.finishRun(run.id, 'cancelled'); return; }
				const archUri = URI.joinPath(runDir, 'ARCHITECTURE.md');
				await this.fileService.writeFile(archUri, VSBuffer.fromString(architecture));
				completedCount++;
				this.updateRun(run.id, { artifacts: { ...this.getArtifacts(run.id), architectureUri: archUri.toString() }, phaseIndex: completedCount });
			}

			// Phase 4: Tasks
			if (sel.includes('tasks')) {
				this.updateRun(run.id, { currentPhase: 'tasks', phaseIndex: completedCount });
				const ctx = buildDocContext(baseContext, { requirements, stories, architecture });
				const tasks = await this.generateDocument(SYSTEM_PROMPT_TASKS, ctx, modelId, token);
				if (token.isCancellationRequested) { this.finishRun(run.id, 'cancelled'); return; }
				const tasksUri = URI.joinPath(runDir, 'TASKS.md');
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
		const filter: { vendor?: string; id?: string } = {};
		if (config.modelVendor) { filter.vendor = config.modelVendor; }
		if (config.modelId) { filter.id = config.modelId; }
		const models = await this.languageModelsService.selectLanguageModels(filter);
		if (models.length > 0) { return models[0]; }
		const fallback = await this.languageModelsService.selectLanguageModels({});
		return fallback[0];
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

	private getIndexUri(): URI | undefined {
		const dir = this.getSpecsDirectory();
		return dir ? URI.joinPath(dir, RUNS_INDEX_FILE) : undefined;
	}

	private async persistIndex(): Promise<void> {
		const config = this.getConfig();
		if (!config.persistRuns) { return; }
		const indexUri = this.getIndexUri();
		if (!indexUri) { return; }
		const runs = Array.from(this._runs.values())
			.filter(r => r.status !== 'running')
			.sort((a, b) => b.startedAt - a.startedAt)
			.slice(0, config.runRetention);
		const index: IRunsIndex = { version: RUNS_VERSION, runs };
		try {
			await this.ensureDirectory(this.getSpecsDirectory()!);
			await this.fileService.writeFile(indexUri, VSBuffer.fromString(JSON.stringify(index, null, 2)));
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

function buildBaseContext(description: string, projectType: SpecProjectType, workspaceContext: string): string {
	const typeLabel = projectType === 'new'
		? 'Novo projeto (greenfield — sem base de código existente)'
		: 'Projeto existente (brownfield — estender ou modificar base de código existente)';
	return `## Descrição do Projeto\n\n${description}\n\n## Tipo de Projeto\n\n${typeLabel}\n\n${workspaceContext}`;
}

interface IDocContext {
	requirements?: string;
	stories?: string;
	architecture?: string;
}

function buildDocContext(base: string, docs: IDocContext): string {
	const parts: string[] = [base];
	if (docs.requirements) { parts.push(`---\n\n## Requirements\n\n${docs.requirements}`); }
	if (docs.stories) { parts.push(`---\n\n## User Stories\n\n${docs.stories}`); }
	if (docs.architecture) { parts.push(`---\n\n## Architecture\n\n${docs.architecture}`); }
	return parts.join('\n\n');
}
