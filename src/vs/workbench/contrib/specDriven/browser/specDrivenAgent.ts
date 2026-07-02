/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
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

| Arquivo | Conteúdo |
|---------|----------|
| \`REQUIREMENTS.md\` | Requisitos funcionais (FR-001…) e não-funcionais (NFR-001…), metas e restrições |
| \`USER_STORIES.md\` | Personas, épicos, histórias no formato BDD (Given/When/Then) |
| \`ARCHITECTURE.md\` | Componentes, fluxo de dados, stack tecnológico e ADRs |
| \`TASKS.md\` | Milestones, backlog de tarefas com esforço (S/M/L/XL) e sugestão de sprints |

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
| \`/completo\` | Gera todos os 4 documentos SDD |
| \`/requisitos\` | Gera apenas \`REQUIREMENTS.md\` |
| \`/historias\` | Gera apenas \`USER_STORIES.md\` |
| \`/arquitetura\` | Gera apenas \`ARCHITECTURE.md\` |
| \`/tarefas\` | Gera apenas \`TASKS.md\` |
| \`/ajuda\` | Exibe este guia |

> 💡 **Dica:** Se você já tem alguns documentos e quer apenas gerar as tarefas, use \`/tarefas\` com a descrição do projeto.`;

const PHASE_LABEL: Record<SpecPhase, string> = {
	context: 'Analisando contexto do workspace',
	requirements: 'Gerando REQUIREMENTS.md',
	stories: 'Gerando USER_STORIES.md',
	architecture: 'Gerando ARCHITECTURE.md',
	tasks: 'Gerando TASKS.md',
	done: 'Concluído',
};

const PHASE_EMOJI: Record<SpecPhase, string> = {
	context: '🔍',
	requirements: '📋',
	stories: '📖',
	architecture: '🏗️',
	tasks: '✅',
	done: '✅',
};

const PHASE_FILE: Partial<Record<SpecDocPhase, string>> = {
	requirements: 'REQUIREMENTS.md',
	stories: 'USER_STORIES.md',
	architecture: 'ARCHITECTURE.md',
	tasks: 'TASKS.md',
};

const PHASE_DESCRIPTION: Partial<Record<SpecDocPhase, string>> = {
	requirements: 'Requisitos funcionais (FR-001…) e não-funcionais (NFR-001…), metas e restrições',
	stories: 'Personas, épicos, histórias de usuário e critérios de aceite em BDD',
	architecture: 'Componentes, stack tecnológico, fluxo de dados e decisões de arquitetura (ADRs)',
	tasks: 'Milestones, backlog de tarefas com esforço estimado (S/M/L/XL) e sugestão de sprints',
};

// ─── Comando → fases ─────────────────────────────────────────────────────────

export function commandToPhases(command: string | undefined): readonly SpecDocPhase[] {
	switch (command) {
		case 'requisitos': return ['requirements'];
		case 'historias': return ['stories'];
		case 'arquitetura': return ['architecture'];
		case 'tarefas': return ['tasks'];
		default: return ALL_DOC_PHASES;
	}
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

		// Sem mensagem ou comando /ajuda → exibir guia
		if (cmd === 'ajuda' || (!request.message.trim() && !cmd)) {
			progress([{ kind: 'markdownContent', content: new MarkdownString(HELP_MARKDOWN) }]);
			return {};
		}

		return this.handleGenerate(request.message.trim(), cmd, progress, token);
	}

	async handleGenerate(
		description: string,
		command: string | undefined,
		progress: (parts: IChatProgress[]) => void,
		token: CancellationToken,
	): Promise<IChatAgentResult> {
		const selectedPhases = commandToPhases(command);
		const projectType = detectProjectType(description);
		const phaseFiles = selectedPhases.map(p => `\`${PHASE_FILE[p]}\``).join(', ');

		// Mensagem inicial
		const introMd = selectedPhases.length === ALL_DOC_PHASES.length
			? `🚀 **Iniciando geração SDD completa**\n\nDocumentos: ${phaseFiles}\n\n---\n`
			: `🚀 **Gerando ${phaseFiles}**\n\n---\n`;
		progress([{ kind: 'markdownContent', content: new MarkdownString(introMd) }]);
		progress([{ kind: 'progressMessage', content: new MarkdownString('Iniciando…'), shimmer: true }]);

		const runId = await this.specDrivenService.startRun(
			description || 'Projeto sem descrição',
			{ projectType, selectedPhases },
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

		const lines: string[] = [];
		lines.push(`\n## ✅ Especificações geradas com sucesso!`);
		if (elapsed !== undefined) {
			lines.push(`\n*Tempo total: ${elapsed}s*`);
		}
		lines.push(`\nOs documentos foram salvos em \`.vsgo/specs/\`:\n`);

		for (const phase of selectedPhases) {
			const file = PHASE_FILE[phase];
			const desc = PHASE_DESCRIPTION[phase];
			if (file && desc) {
				lines.push(`- **${file}** — ${desc}`);
			}
		}

		lines.push(`\n---`);
		lines.push(`\n### Próximos passos com SDD`);
		lines.push(`\n1. **Revise os requisitos** — ajuste prioridades (MUST/SHOULD/COULD) conforme o escopo do projeto`);
		lines.push(`2. **Refine as histórias** — compartilhe com o time no próximo refinamento de backlog`);
		lines.push(`3. **Valide a arquitetura** — discuta as decisões técnicas (ADRs) com os desenvolvedores`);
		lines.push(`4. **Importe as tarefas** — use o TASKS.md como base para seu planejamento de sprints`);
		lines.push(`\n> 💡 Você pode regenerar qualquer documento individualmente usando \`/requisitos\`, \`/historias\`, \`/arquitetura\` ou \`/tarefas\`.`);

		progress([{
			kind: 'markdownContent',
			content: new MarkdownString(lines.join('\n')),
		}]);

		// Adicionar referências de arquivo como pills clicáveis
		const artifacts: Array<[string | undefined, string]> = [
			[run.artifacts.requirementsUri, 'REQUIREMENTS.md'],
			[run.artifacts.storiesUri, 'USER_STORIES.md'],
			[run.artifacts.architectureUri, 'ARCHITECTURE.md'],
			[run.artifacts.tasksUri, 'TASKS.md'],
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
				title: 'Regenerar apenas TASKS.md',
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
