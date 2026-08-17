/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { basename } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ILanguageModelsService } from '../../../contrib/chat/common/languageModels.js';
import { IChatFollowup, IChatProgress } from '../../../contrib/chat/common/chatService/chatService.js';
import { IChatAgentHistoryEntry, IChatAgentImplementation, IChatAgentRequest, IChatAgentResult } from '../../../contrib/chat/common/participants/chatAgents.js';
import { ALL_DOC_PHASES, ISpecDrivenService, ISpecRun, SpecDocPhase, SpecPhase } from '../common/spec.js';

export const SDD_AGENT_ID = 'sdd';

// ─── Textos em Português do Brasil ───────────────────────────────────────────

const HELP_MARKDOWN = `## Spec Driven Development (SDD)

Olá! Sou o agente **@sdd**, especialista em **Spec Driven Development** — uma metodologia que coloca a especificação no centro do processo de desenvolvimento.

Com o SDD, antes de escrever código, você documenta claramente **o quê**, **por quê** e **como** o sistema deve funcionar. Isso reduz retrabalho, alinha o time e acelera o planejamento.

---

### Para quem é este agente?

| Perfil | O que pode fazer |
|--------|-----------------|
| 🧑‍💼 **Analista de Requisitos** | Gerar requisitos estruturados, histórias com critérios de aceite e rastreabilidade |
| 📊 **Gerente de Projetos** | Obter milestones, breakdown de tarefas com estimativas e plano de sprints |
| 👨‍💻 **Desenvolvedor** | Consultar arquitetura, decisões técnicas (ADRs) e critérios de aceite das histórias |

---

### Documentos que posso gerar

Sigo o formato do **spec-kit**: cada geração cria uma pasta \`specs/NNN-slug/\` com os três documentos abaixo.

| Arquivo | Conteúdo |
|---------|----------|
| \`spec.md\` | **O quê e por quê**, sem tecnologia — requisitos (RF/RNF), regras de negócio (RN), histórias e critérios de aceitação (CA) |
| \`plan.md\` | **O como** — arquitetura, modelo de dados, contratos, decisões técnicas com alternativas e estratégia de testes |
| \`tasks.md\` | Tarefas \`Tnnn\` em seis fases, marcadas com \`[P]\` quando paralelizáveis e referenciando o RF/CA que cobrem |

> A separação é a regra central do SDD: tecnologia só aparece no \`plan.md\`. Se algo estiver indefinido na spec, eu marco \`[NEEDS CLARIFICATION: ...]\` em vez de inventar.

---

### Como usar

Descreva seu projeto ou funcionalidade em linguagem natural. Exemplos:

> *"Uma plataforma SaaS multi-tenant para gestão de onboarding de funcionários com controle de acesso por perfil."*

> *"Sistema de agendamento de consultas médicas com notificações por SMS e integração com prontuário eletrônico."*

> *"API REST para gerenciamento de estoque com relatórios em tempo real e integração com ERP legado."*

---

### Comandos disponíveis

| Comando | Descrição |
|---------|-----------|
| \`/completo\` | Gera \`spec.md\`, \`plan.md\` e \`tasks.md\` |
| \`/spec\` | Gera apenas \`spec.md\` |
| \`/plano\` | Gera apenas \`plan.md\` |
| \`/tarefas\` | Gera apenas \`tasks.md\` |
| \`/ajuda\` | Exibe este guia |

> 💡 **Dica:** o fluxo do SDD é sequencial — aprove a \`spec.md\` antes de escrever o \`plan.md\`, e o plano antes de executar as \`tasks.md\`.

---

### Continuidade

Antes de gerar, eu verifico se o seu pedido continua uma spec que já existe. Se continuar, eu pergunto se você quer **atualizar** aquela spec — revisando os documentos e preservando a numeração \`RF\`/\`CA\`/\`T\` que os outros arquivos referenciam — ou **criar uma nova**. Assim o projeto não acumula duas specs sobre o mesmo assunto.

Pedidos de \`/plano\` ou \`/tarefas\` que claramente pertencem a uma spec existente entram direto nela, sem perguntar.`;

const PHASE_LABEL: Record<SpecPhase, string> = {
	context: 'Analisando contexto do workspace',
	spec: 'Gerando spec.md',
	plan: 'Gerando plan.md',
	tasks: 'Gerando tasks.md',
	done: 'Concluído',
};

const PHASE_EMOJI: Record<SpecPhase, string> = {
	context: '🔍',
	spec: '📋',
	plan: '🏗️',
	tasks: '✅',
	done: '✅',
};

const PHASE_FILE: Record<SpecDocPhase, string> = {
	spec: 'spec.md',
	plan: 'plan.md',
	tasks: 'tasks.md',
};

const PHASE_DESCRIPTION: Record<SpecDocPhase, string> = {
	spec: 'O quê e por quê — RF, RNF, regras de negócio, histórias e critérios de aceitação',
	plan: 'O como — arquitetura, modelo de dados, contratos, decisões técnicas e estratégia de testes',
	tasks: 'Tarefas Tnnn em seis fases, com marcação de paralelismo e rastreio para RF/CA',
};

// ─── Comando → fases ─────────────────────────────────────────────────────────

export function commandToPhases(command: string | undefined): readonly SpecDocPhase[] {
	switch (command) {
		case 'spec': return ['spec'];
		case 'plano': return ['plan'];
		case 'tarefas': return ['tasks'];
		default: return ALL_DOC_PHASES;
	}
}

// ─── Confirmação "spec existente" ────────────────────────────────────────────

/** Payload carried by the confirmation, so the follow-up request resumes the original ask. */
interface ISpecChoice {
	readonly description: string;
	readonly command: string | undefined;
	readonly folder: string;
}

function readChoice(data: unknown[] | undefined): ISpecChoice | undefined {
	const first = data?.[0] as Partial<ISpecChoice> | undefined;
	if (!first || typeof first.description !== 'string' || typeof first.folder !== 'string') {
		return undefined;
	}
	return {
		description: first.description,
		command: typeof first.command === 'string' ? first.command : undefined,
		folder: first.folder,
	};
}

function detectProjectType(message: string): 'new' | 'existing' {
	const lower = message.toLowerCase();
	if (/novo projeto|do zero|greenfield|criar do zero|projeto novo|começar do zero/.test(lower)) {
		return 'new';
	}
	return 'existing';
}

// ─── Agente ──────────────────────────────────────────────────────────────────

export class SpecDrivenAgent extends Disposable implements IChatAgentImplementation {

	constructor(
		@ISpecDrivenService private readonly specDrivenService: ISpecDrivenService,
		@ILanguageModelsService private readonly languageModelsService: ILanguageModelsService,
	) {
		super();
	}

	async invoke(
		request: IChatAgentRequest,
		progress: (parts: IChatProgress[]) => void,
		_history: IChatAgentHistoryEntry[],
		token: CancellationToken,
	): Promise<IChatAgentResult> {
		const cmd = request.command?.toLowerCase();

		// Resposta a uma confirmação nossa: o pedido original volta em `data`, então a geração
		// retoma de onde parou sem perguntar de novo nem reclassificar.
		const accepted = readChoice(request.acceptedConfirmationData);
		if (accepted) {
			return this.runGeneration(accepted.description, accepted.command, accepted.folder, request.userSelectedModelId, progress, token);
		}
		const rejected = readChoice(request.rejectedConfirmationData);
		if (rejected) {
			return this.runGeneration(rejected.description, rejected.command, undefined, request.userSelectedModelId, progress, token);
		}

		// Sem mensagem ou comando /ajuda → exibir guia
		if (cmd === 'ajuda' || (!request.message.trim() && !cmd)) {
			progress([{ kind: 'markdownContent', content: new MarkdownString(HELP_MARKDOWN) }]);
			return {};
		}

		return this.handleGenerate(request.message.trim(), cmd, request.userSelectedModelId, progress, token);
	}

	/**
	 * Decides whether the request continues an existing feature before generating anything.
	 *
	 * A request that only asks for `plan.md` or `tasks.md` belongs to a spec that already exists,
	 * so a confident match is used directly. A request that would (re)write `spec.md` is a
	 * different matter: reusing the folder overwrites a document the team may have approved, so
	 * the user decides.
	 */
	async handleGenerate(
		description: string,
		command: string | undefined,
		/** Model selected in the chat, which wins over this feature's own setting. */
		modelId: string | undefined,
		progress: (parts: IChatProgress[]) => void,
		token: CancellationToken,
	): Promise<IChatAgentResult> {
		const selectedPhases = commandToPhases(command);
		const match = await this.specDrivenService.matchSpecFolder(description, token);
		if (token.isCancellationRequested) { return {}; }

		if (match && selectedPhases.includes('spec')) {
			const choice: ISpecChoice = { description, command, folder: match };
			progress([{
				kind: 'confirmation',
				title: `Spec existente: ${match}`,
				message: new MarkdownString(
					`Este pedido parece continuar a spec \`${match}\`.\n\n` +
					`Posso **atualizar** os documentos dela — preservando as decisões e a numeração que ainda valem — ` +
					`ou **criar uma spec nova** em uma pasta separada.`
				),
				data: choice,
				buttons: [`Atualizar ${match}`, 'Criar spec nova'],
			}]);
			return {};
		}

		return this.runGeneration(description, command, match, modelId, progress, token);
	}

	private async runGeneration(
		description: string,
		command: string | undefined,
		targetFolder: string | undefined,
		modelId: string | undefined,
		progress: (parts: IChatProgress[]) => void,
		token: CancellationToken,
	): Promise<IChatAgentResult> {
		const selectedPhases = commandToPhases(command);
		const projectType = detectProjectType(description);
		const phaseFiles = selectedPhases.map(p => `\`${PHASE_FILE[p]}\``).join(', ');

		if (targetFolder) {
			progress([{
				kind: 'markdownContent',
				content: new MarkdownString(`📎 Continuando a spec \`${targetFolder}\`.\n`),
			}]);
		} else if (!selectedPhases.includes('spec') && (await this.specDrivenService.listSpecFolders()).length > 0) {
			// A plan or task list without a spec to hang off is almost always a mis-targeted
			// request, so say plainly that a new folder is being created.
			progress([{
				kind: 'markdownContent',
				content: new MarkdownString(
					`ℹ️ Não identifiquei a qual spec existente este pedido pertence, então vou criar uma pasta nova. ` +
					`Se era para continuar outra, cancele e mencione o nome dela (ex.: \`002-autenticacao\`).\n`
				),
			}]);
		}

		// Mensagem inicial
		const introMd = selectedPhases.length === ALL_DOC_PHASES.length
			? `🚀 **Iniciando geração SDD completa**\n\nDocumentos: ${phaseFiles}\n\n---\n`
			: `🚀 **Gerando ${phaseFiles}**\n\n---\n`;
		const modelLabel = modelId
			? this.languageModelsService.lookupLanguageModel(modelId)?.name ?? modelId
			: localize('specDriven.configuredModel', "o modelo configurado em Spec Driven");
		progress([{ kind: 'markdownContent', content: new MarkdownString(`${introMd}\n_Gerando com **${modelLabel}**._\n`) }]);
		progress([{ kind: 'progressMessage', content: new MarkdownString('Iniciando…'), shimmer: true }]);

		const runId = await this.specDrivenService.startRun(
			description || 'Projeto sem descrição',
			{ projectType, selectedPhases, targetFolder, modelId },
		);

		if (!runId) {
			progress([{
				kind: 'markdownContent',
				content: new MarkdownString('❌ **Erro:** Nenhum workspace aberto. Abra uma pasta antes de gerar especificações.'),
			}]);
			return { errorDetails: { message: 'Nenhum workspace aberto.' } };
		}

		const run = await this.waitForCompletion(runId, progress, token);
		if (!run) { return {}; }

		if (run.status === 'cancelled') {
			progress([{ kind: 'markdownContent', content: new MarkdownString('\n⛔ Geração cancelada pelo usuário.') }]);
			return {};
		}

		if (run.status === 'error') {
			progress([{
				kind: 'markdownContent',
				content: new MarkdownString(`\n❌ **Erro na geração:** ${run.error ?? 'Erro desconhecido.'}`)
			}]);
			return { errorDetails: { message: run.error ?? 'Erro desconhecido.' } };
		}

		this.emitCompletionMessage(run, selectedPhases, progress);
		return {};
	}

	private waitForCompletion(
		runId: string,
		progress: (parts: IChatProgress[]) => void,
		token: CancellationToken,
	): Promise<ISpecRun | undefined> {
		return new Promise<ISpecRun | undefined>(resolve => {
			let lastPhase: SpecPhase | undefined;

			const sub = this.specDrivenService.onDidChangeRun(changedId => {
				if (changedId !== runId) { return; }
				const run = this.specDrivenService.getRun(runId);
				if (!run) { sub.dispose(); resolve(undefined); return; }

				if (run.currentPhase !== lastPhase && run.currentPhase !== 'done') {
					lastPhase = run.currentPhase;
					progress([{
						kind: 'progressMessage',
						content: new MarkdownString(`${PHASE_EMOJI[run.currentPhase]} ${PHASE_LABEL[run.currentPhase]}…`),
						shimmer: true,
					}]);
				}

				if (run.status !== 'running') {
					sub.dispose();
					resolve(run);
				}
			});

			const cancelSub = token.onCancellationRequested(() => {
				cancelSub.dispose();
				sub.dispose();
				this.specDrivenService.cancelRun(runId);
				resolve(this.specDrivenService.getRun(runId));
			});
		});
	}

	private emitCompletionMessage(
		run: ISpecRun,
		selectedPhases: readonly SpecDocPhase[],
		progress: (parts: IChatProgress[]) => void,
	): void {
		const elapsed = run.endedAt && run.startedAt
			? Math.round((run.endedAt - run.startedAt) / 1000)
			: undefined;

		const folder = run.artifacts.dirUri ? basename(URI.parse(run.artifacts.dirUri)) : undefined;

		const lines: string[] = [];
		lines.push(`\n## ✅ Especificações geradas com sucesso!`);
		if (elapsed !== undefined) {
			lines.push(`\n*Tempo total: ${elapsed}s*`);
		}
		lines.push(folder
			? `\nOs documentos foram salvos em \`specs/${folder}/\`:\n`
			: `\nOs documentos foram salvos em \`specs/\`:\n`);

		for (const phase of selectedPhases) {
			lines.push(`- **${PHASE_FILE[phase]}** — ${PHASE_DESCRIPTION[phase]}`);
		}

		lines.push(`\n---`);
		lines.push(`\n### Próximos passos com SDD`);
		lines.push(`\n1. **Revise a \`spec.md\`** — resolva todo \`[NEEDS CLARIFICATION]\` e mude o Status para Aprovada`);
		lines.push(`2. **Valide o \`plan.md\`** — confira a checklist de conformidade com a constituição e as alternativas descartadas`);
		lines.push(`3. **Execute as \`tasks.md\`** — só depois da spec e do plano aprovados, conforme a constituição`);
		lines.push(`\n> 💡 Você pode regenerar qualquer documento individualmente usando \`/spec\`, \`/plano\` ou \`/tarefas\`.`);

		progress([{
			kind: 'markdownContent',
			content: new MarkdownString(lines.join('\n')),
		}]);

		// Adicionar referências de arquivo como pills clicáveis
		const artifacts: Array<[string | undefined, string]> = [
			[run.artifacts.specUri, 'spec.md'],
			[run.artifacts.planUri, 'plan.md'],
			[run.artifacts.tasksUri, 'tasks.md'],
		];
		for (const [uri] of artifacts) {
			if (uri) {
				progress([{ kind: 'reference', reference: URI.parse(uri) }]);
			}
		}
	}

	async provideFollowups(
		request: IChatAgentRequest,
		_result: IChatAgentResult,
		_history: IChatAgentHistoryEntry[],
		_token: CancellationToken,
	): Promise<IChatFollowup[]> {
		const originalMessage = request.message.trim();
		return [
			{
				kind: 'reply',
				agentId: SDD_AGENT_ID,
				message: originalMessage,
				subCommand: 'tarefas',
				title: 'Regenerar apenas tasks.md',
				tooltip: 'Gera novamente apenas o breakdown de tarefas para este projeto',
			},
			{
				kind: 'reply',
				agentId: SDD_AGENT_ID,
				message: '',
				subCommand: 'ajuda',
				title: 'Ver guia SDD',
				tooltip: 'Exibe o guia completo do Spec Driven Development',
			},
		];
	}
}
