/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { log } from './logger.js';

/**
 * Servidores MCP para o agente deste chat.
 *
 * O núcleo descobre e registra os servidores do `mcp.json` sozinho, mas quem os
 * *inicia* é o chat embutido: `mcpService.autostart()` tem um único chamador em
 * todo o workbench, no fluxo de request do `chatServiceImpl`. Este chat não passa
 * por ali, então sem este módulo um servidor configurado fica em "Stopped" para
 * sempre — visível na lista, sem nunca entregar uma ferramenta.
 *
 * A partida vai pelo comando `workbench.mcp.startServer`, que já aceita `'*'`
 * para "todos" e sabe esperar as ferramentas ficarem vivas. É API de comando, e
 * não de serviço, porque uma extensão não alcança o `IMcpService`.
 */

/** Comando do núcleo que sobe servidores MCP. Aceita um id ou `'*'` para todos. */
const START_SERVER_COMMAND = 'workbench.mcp.startServer';
/** Comando do núcleo que abre o `mcp.json` do perfil do usuário. */
export const OPEN_USER_CONFIG_COMMAND = 'workbench.mcp.openUserMcpJson';
/** Fluxo guiado do núcleo para acrescentar um servidor. */
export const ADD_SERVER_COMMAND = 'workbench.mcp.addConfiguration';
/** Lista de servidores do núcleo, com estado e ações por servidor. */
export const LIST_SERVERS_COMMAND = 'workbench.mcp.listServer';

/** Tag que o núcleo põe em toda ferramenta vinda de um servidor MCP. */
const MCP_TOOL_TAG = 'mcp';

export function isMcpToolInfo(info: vscode.LanguageModelToolInformation): boolean {
	return info.tags.includes(MCP_TOOL_TAG);
}

/** Ferramentas MCP visíveis agora, já registradas pelo núcleo. */
export function mcpTools(): readonly vscode.LanguageModelToolInformation[] {
	return vscode.lm.tools.filter(isMcpToolInfo);
}

export class McpServers implements vscode.Disposable {

	private readonly _store: vscode.Disposable[] = [];
	/** Uma partida por vez; as chamadas concorrentes esperam a mesma promessa. */
	private _starting: Promise<void> | undefined;
	/**
	 * Se a tentativa automática desta janela já aconteceu — dê certo ou não.
	 *
	 * É uma só, de propósito. Antes disto a condição era "tentar até haver
	 * ferramentas", e um servidor que exige login nunca tem ferramentas: cada
	 * turno do chat repetia a partida, e cada partida abria de novo o diálogo de
	 * autenticação, no meio da conversa. Uma tentativa por janela não tem como
	 * insistir. Reconfigurar ou pedir a partida pelo painel zera isto.
	 */
	private _autoStartAttempted = false;

	constructor() {
		// Reconfigurar servidores é o momento em que se quer vê-los de pé — é logo
		// depois de salvar o mcp.json que a pessoa volta ao chat para testar.
		this._store.push(vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('agent-chat.mcp.enabled') && this._enabled()) {
				this._autoStartAttempted = false;
				void this.start({ reason: 'configuração alterada' });
			}
		}));
	}

	dispose(): void {
		this._store.forEach(d => d.dispose());
		this._store.length = 0;
	}

	private _enabled(): boolean {
		return vscode.workspace.getConfiguration('agent-chat').get<boolean>('mcp.enabled', true);
	}

	/**
	 * Sobe os servidores já na abertura da janela, se pedido. Desligado por
	 * padrão: um servidor `stdio` é um processo novo, e subir todos junto com a
	 * janela é o tipo de custo que uma máquina sem RAM sobrando não tem como
	 * pagar. Por padrão eles sobem no primeiro turno do chat, que é quando fazem
	 * falta de verdade.
	 */
	startOnStartupIfConfigured(): void {
		const onStartup = vscode.workspace.getConfiguration('agent-chat').get<boolean>('mcp.startOnStartup', false);
		if (onStartup && this._enabled()) {
			// Consome a tentativa automática da janela: subir aqui e de novo no
			// primeiro turno seria a mesma insistência, só espalhada.
			this._autoStartAttempted = true;
			void this.start({ reason: 'abertura da janela' });
		}
	}

	/**
	 * Sobe todos os servidores configurados. Idempotente e barata depois da
	 * primeira vez: o comando do núcleo ignora quem já está rodando.
	 *
	 * Não propaga erro. Um servidor MCP fora do ar não pode impedir uma conversa
	 * — o agente segue com as ferramentas próprias, e o motivo fica no log.
	 */
	async start(opts?: { reason?: string; force?: boolean; interactive?: boolean }): Promise<void> {
		if (!this._enabled() && !opts?.force) {
			return;
		}
		if (this._starting) {
			return this._starting;
		}
		this._starting = this._start(opts?.reason, opts?.interactive === true).finally(() => {
			this._starting = undefined;
		});
		return this._starting;
	}

	private async _start(reason: string | undefined, interactive: boolean): Promise<void> {
		const before = mcpTools().length;
		// `waitForLiveTools` faz o comando só voltar quando as ferramentas foram
		// listadas. Sem isso a primeira mensagem sairia antes de elas existirem e o
		// modelo não as veria — exatamente o problema que este módulo existe para
		// resolver.
		//
		// Mas a espera precisa de prazo nosso. Do lado do núcleo ela termina em
		// erro, parada ou ferramentas vivas; um servidor preso em "Starting" —
		// aguardando um OAuth no navegador, ou uma conexão que não responde — não
		// é nenhum dos três, e o `startServer` não passa token de cancelamento
		// para lá. Como isto é aguardado no começo de cada turno, sem prazo um
		// servidor pendurado penduraria a conversa junto.
		const budgetMs = Math.max(0, vscode.workspace.getConfiguration('agent-chat').get<number>('mcp.startTimeout', 15) * 1000);
		let timer: ReturnType<typeof setTimeout> | undefined;
		// A diferença que separa uma partida automática de uma pedida: trabalho de
		// fundo não interrompe ninguém. Com `errorOnUserInteraction` o núcleo lança
		// erro em vez de abrir prompt — de confiança, de variável ou de autenticação
		// —, então um servidor que exige login simplesmente não sobe, e o motivo vai
		// para o log. O diálogo de OAuth só aparece quando foi você que pediu a
		// partida, que é o único momento em que ele faz sentido.
		const startOpts = interactive
			? { waitForLiveTools: true }
			: { waitForLiveTools: true, promptType: 'never', errorOnUserInteraction: true };
		const started = vscode.commands.executeCommand(START_SERVER_COMMAND, '*', startOpts);
		const deadline = new Promise<'timeout'>(resolve => {
			timer = setTimeout(() => resolve('timeout'), budgetMs);
		});
		try {
			const outcome = await Promise.race([started.then(() => 'done' as const), deadline]);
			if (outcome === 'timeout') {
				// Não é falha: os servidores seguem subindo por conta do núcleo, e as
				// ferramentas deles entram no turno seguinte. Só não seguramos este.
				log(`[mcp] servidores ainda subindo depois de ${budgetMs}ms${reason ? ` (${reason})` : ''}; seguindo com ${mcpTools().length} ferramentas`);
				return;
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			log(`[mcp] falha ao iniciar servidores${reason ? ` (${reason})` : ''}: ${message}`);
			return;
		} finally {
			clearTimeout(timer);
			// Uma rejeição que chegue depois da corrida não pode virar unhandled
			// rejection e derrubar o log do extension host com ruído.
			void started.then(undefined, () => undefined);
		}
		const after = mcpTools().length;
		log(`[mcp] servidores iniciados${reason ? ` (${reason})` : ''}: ${after} ferramentas disponíveis${after !== before ? ` (antes: ${before})` : ''}`);
	}

	/**
	 * Garante os servidores de pé antes de um turno do agente.
	 *
	 * Uma tentativa por janela, e só. A conversa é do usuário, não um gancho para
	 * o chat ficar reencostando em serviço externo: se a tentativa não trouxe
	 * ferramenta nenhuma, o turno seguinte segue direto, sem esperar e sem tentar
	 * de novo. Quem quiser insistir usa o painel — e é lá que os diálogos de
	 * autenticação podem aparecer.
	 */
	async ensureStartedForRequest(): Promise<void> {
		if (!this._enabled() || this._autoStartAttempted) {
			return;
		}
		this._autoStartAttempted = true;
		await this.start({ reason: 'início de turno' });
	}
}

/**
 * Agrupa as ferramentas MCP vivas pelo servidor que as trouxe.
 *
 * O núcleo nomeia cada ferramenta como `mcp_<prefixo do servidor>_<nome>`, então
 * o prefixo é o que se tem para agrupar por servidor sem alcançar o `IMcpService`.
 * É aproximação assumida: um nome fora desse formato cai em "outros" em vez de
 * inventar um servidor que talvez não exista.
 */
function groupToolsByServer(tools: readonly vscode.LanguageModelToolInformation[]): Map<string, vscode.LanguageModelToolInformation[]> {
	const groups = new Map<string, vscode.LanguageModelToolInformation[]>();
	for (const tool of tools) {
		const match = /^mcp_([^_]+)_/.exec(tool.name);
		const key = match ? match[1] : 'outros';
		const list = groups.get(key);
		if (list) {
			list.push(tool);
		} else {
			groups.set(key, [tool]);
		}
	}
	return groups;
}

interface McpMenuItem extends vscode.QuickPickItem {
	readonly action?: 'start' | 'add' | 'openConfig' | 'manage' | 'toggle';
}

/**
 * Painel único de MCP para quem usa este chat.
 *
 * Ele responde a pergunta que nenhuma tela existente respondia — *o agente está
 * enxergando as minhas ferramentas MCP agora?* — e a partir dela leva às telas do
 * núcleo que já fazem o resto. Nada aqui reimplementa o gerenciador de servidores
 * do workbench de propósito: duplicá-lo daria duas verdades sobre o mesmo estado.
 */
export function registerMcpCommands(servers: McpServers): vscode.Disposable {
	return vscode.commands.registerCommand('agent-chat.mcp.manage', async () => {
		const config = vscode.workspace.getConfiguration('agent-chat');
		const enabled = config.get<boolean>('mcp.enabled', true);
		const live = mcpTools();
		const groups = groupToolsByServer(live);

		// Separadores são itens comuns com `kind`, e por isso cabem no mesmo array.
		const items: McpMenuItem[] = [];

		items.push({ label: 'Estado', kind: vscode.QuickPickItemKind.Separator });
		if (!enabled) {
			items.push({
				label: '$(circle-slash) Ferramentas MCP desligadas',
				detail: 'O agente ignora todo servidor MCP enquanto agent-chat.mcp.enabled estiver desligado.',
			});
		} else if (groups.size === 0) {
			items.push({
				label: '$(debug-disconnect) Nenhum servidor MCP em execução',
				// Servidor no ar sem entregar ferramenta quase sempre é login pendente:
				// os servidores http (Figma, GitHub e afins) respondem 401 até o OAuth
				// ser concluído, e o erro só aparece na saída do servidor. Dizer isso
				// aqui poupa a caçada — o estado sozinho não explica nada.
				detail: 'Sobem no primeiro turno do chat, ou agora em "Iniciar servidores". Se já tentou e nada apareceu, veja "Gerenciar servidores": servidores que exigem login ficam em erro 401 até a autenticação ser concluída.',
			});
		} else {
			for (const [server, tools] of groups) {
				items.push({
					label: `$(check) ${server}`,
					description: tools.length === 1 ? '1 ferramenta' : `${tools.length} ferramentas`,
					detail: tools.map(t => t.name).join(', '),
				});
			}
		}

		items.push({ label: 'Ações', kind: vscode.QuickPickItemKind.Separator });
		items.push({
			label: '$(play) Iniciar servidores agora',
			detail: 'Sobe todo servidor configurado e espera as ferramentas ficarem disponíveis.',
			action: 'start',
		});
		items.push({
			label: '$(add) Adicionar servidor...',
			detail: 'Fluxo guiado do VS Code: escolha o tipo, informe o comando ou a URL.',
			action: 'add',
		});
		items.push({
			label: '$(json) Abrir a configuração (mcp.json)',
			detail: 'Edite à mão. O arquivo tem autocompletar de schema e um botão de iniciar por servidor.',
			action: 'openConfig',
		});
		items.push({
			label: '$(server) Gerenciar servidores...',
			detail: 'Lista do VS Code com estado, saída e ações de cada servidor.',
			action: 'manage',
		});
		items.push({
			label: enabled ? '$(circle-slash) Desligar ferramentas MCP' : '$(check) Ligar ferramentas MCP',
			detail: enabled
				? 'O agente deixa de receber ferramentas MCP.'
				: 'O agente volta a receber as ferramentas dos servidores configurados.',
			action: 'toggle',
		});

		const picked = await vscode.window.showQuickPick(items, {
			title: 'Servidores MCP',
			placeHolder: enabled && groups.size > 0
				? `O agente está enxergando ${live.length === 1 ? '1 ferramenta MCP' : `${live.length} ferramentas MCP`}`
				: 'Nenhuma ferramenta MCP disponível para o agente',
		});

		switch (picked?.action) {
			case 'start': {
				await vscode.window.withProgress(
					{ location: vscode.ProgressLocation.Notification, title: 'Iniciando servidores MCP...' },
					// Interativa: aqui os diálogos de confiança e de login são bem-vindos,
					// porque foi um pedido explícito e a pessoa está olhando para a tela.
					() => servers.start({ reason: 'pedido do usuário', force: true, interactive: true }),
				);
				// Partida que não rende ferramenta nenhuma precisa dizer o que houve.
				// Calar aqui devolve a pessoa ao ponto de partida sem pista alguma —
				// que é a experiência que este painel existe para acabar.
				if (mcpTools().length === 0) {
					const seeServers = 'Ver servidores';
					const answer = await vscode.window.showWarningMessage(
						'Nenhum servidor MCP entregou ferramentas. Servidores que exigem login costumam ficar em erro 401 até a autenticação ser concluída.',
						seeServers,
					);
					if (answer === seeServers) {
						await vscode.commands.executeCommand(LIST_SERVERS_COMMAND);
					}
					break;
				}
				// Reabrir mostra o resultado: sem isto a pessoa fica sem saber se
				// deu certo, que é exatamente a queixa que este painel resolve.
				await vscode.commands.executeCommand('agent-chat.mcp.manage');
				break;
			}
			case 'add':
				await vscode.commands.executeCommand(ADD_SERVER_COMMAND);
				break;
			case 'openConfig':
				await vscode.commands.executeCommand(OPEN_USER_CONFIG_COMMAND);
				break;
			case 'manage':
				await vscode.commands.executeCommand(LIST_SERVERS_COMMAND);
				break;
			case 'toggle':
				await config.update('mcp.enabled', !enabled, vscode.ConfigurationTarget.Global);
				break;
		}
	});
}
