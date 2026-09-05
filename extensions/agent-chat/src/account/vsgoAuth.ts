/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { createHash, randomBytes } from 'crypto';
import { hostname } from 'os';
import { log } from '../logger.js';

/** Id do provedor de autenticação, também o `vendor` do provedor de modelos. */
export const VSGO_AUTH_ID = 'vsgo';
const VSGO_AUTH_LABEL = 'Conta vsgo';

/** Onde a sessão fica: uma chave só, no cofre do sistema. */
const SECRET_KEY = 'agent-chat.vsgo.session';

const DEFAULT_BASE_URL = 'https://vsgo.orkestrai.com.br';

/** Quanto tempo o editor espera a autorização acontecer no navegador. */
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

/** Endereço da aplicação web, comum à autenticação e ao gateway. */
export function vsgoBaseUrl(): string {
	const configured = vscode.workspace
		.getConfiguration('agentChat.vsgo')
		.get<string>('baseUrl');
	return (configured || DEFAULT_BASE_URL).replace(/\/$/, '');
}

/** O que a troca do código devolve, e o que guardamos da conta. */
interface IGrantResponse {
	api_key: string;
	key_id: string;
	account: { id: string; email: string | null; name: string | null };
	plan: { id: string; name: string; requests_per_minute: number; monthly_token_limit: number | null };
}

interface IStoredSession {
	readonly id: string;
	readonly accessToken: string;
	readonly keyId: string;
	readonly account: IGrantResponse['account'];
	readonly plan: IGrantResponse['plan'];
}

/**
 * A conta vsgo dentro do editor.
 *
 * O editor nunca vê a senha de ninguém: ele abre o navegador na tela de
 * autorização, quem decide é a sessão já autenticada no site, e o que volta
 * pelo `vsgo://` é um código de uso único. A chave da conta só aparece na
 * troca seguinte, que sai daqui direto para `/v1/editor/token` — por isso o
 * PKCE: o verificador nunca sai desta máquina, e um código interceptado no
 * caminho de volta não vale nada sem ele.
 *
 * Implementa `AuthenticationProvider` para herdar o que o VS Code já sabe
 * fazer com contas: o menu de Contas na barra lateral, o "sair" de lá, e o
 * consentimento por extensão. Sem isso, cada tela precisaria da própria UI.
 */
export class VsgoAuthProvider implements vscode.AuthenticationProvider, vscode.Disposable {

	private readonly _onDidChangeSessions = new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
	readonly onDidChangeSessions = this._onDidChangeSessions.event;

	/** Autorizações em voo, por `state`: o handler de URI resolve a promessa. */
	private readonly pending = new Map<string, (result: { code: string } | Error) => void>();

	private cached: IStoredSession | undefined;

	/*
	 * Próxima autorização começa pela tela de CADASTRO.
	 *
	 * `vscode.authentication.getSession` não leva opções nossas até o provedor,
	 * e é por ele que o sign-in precisa passar (é ali que moram o consentimento
	 * por extensão e a conta no menu lateral). Então o comando de criar conta
	 * levanta esta bandeirinha antes de chamar, e o `createSession` a consome —
	 * o que muda é um parâmetro na URL que o navegador abre.
	 */
	private startAtSignUp = false;

	constructor(private readonly secrets: vscode.SecretStorage) { }

	/** Chamado pelo comando "Criar conta" antes de pedir a sessão. */
	signUpNext(): void {
		this.startAtSignUp = true;
	}

	/**
	 * Recebe o `vsgo://vscode.agent-chat/auth-callback?code=…&state=…` que a
	 * página de autorização devolve.
	 *
	 * O `state` é conferido antes de qualquer outra coisa: sem ele, qualquer
	 * página capaz de abrir um `vsgo://` poderia empurrar um código de outra
	 * conta para dentro de uma janela que só estava esperando.
	 */
	handleUri(uri: vscode.Uri): void {
		const query = new URLSearchParams(uri.query);
		const state = query.get('state') ?? '';
		const resolve = this.pending.get(state);
		if (!resolve) {
			log('[vsgo] callback de autorização sem pedido correspondente; ignorado');
			return;
		}
		this.pending.delete(state);
		const code = query.get('code');
		resolve(code ? { code } : new Error('A autorização voltou sem código.'));
	}

	async getSessions(_scopes?: readonly string[]): Promise<vscode.AuthenticationSession[]> {
		const session = await this.read();
		return session ? [toAuthSession(session)] : [];
	}

	async createSession(_scopes: readonly string[]): Promise<vscode.AuthenticationSession> {
		const verifier = randomBytes(32).toString('base64url');
		const challenge = createHash('sha256').update(verifier).digest('base64url');
		const state = randomBytes(16).toString('base64url');

		// `asExternalUri` é o que faz isto funcionar em janela remota ou em
		// túnel: ali o `vsgo://` local não chegaria de volta sozinho.
		const callback = await vscode.env.asExternalUri(
			vscode.Uri.parse(`${vscode.env.uriScheme}://vscode.agent-chat/auth-callback`),
		);

		const authorizeUrl = new URL('/conectar', vsgoBaseUrl());
		authorizeUrl.searchParams.set('challenge', challenge);
		authorizeUrl.searchParams.set('state', state);
		authorizeUrl.searchParams.set('device', deviceName());
		authorizeUrl.searchParams.set('redirect', callback.toString(true));

		// Sem sessão no site, o `novo=1` faz a página de autorização mandar
		// para o cadastro em vez do login. Com sessão, não muda nada: quem já
		// está dentro vê a tela de autorização direto.
		const signUp = this.startAtSignUp;
		this.startAtSignUp = false;
		if (signUp) {
			authorizeUrl.searchParams.set('novo', '1');
		}

		const grant = await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: signUp
					? 'Criando sua conta vsgo pelo navegador…'
					: 'Conectando à sua conta vsgo pelo navegador…',
				cancellable: true,
			},
			async (_progress, token) => {
				const code = this.waitForCode(state, token);
				await vscode.env.openExternal(vscode.Uri.parse(authorizeUrl.toString()));
				return this.exchange(await code, verifier);
			},
		);

		const session: IStoredSession = {
			id: grant.key_id,
			accessToken: grant.api_key,
			keyId: grant.key_id,
			account: grant.account,
			plan: grant.plan,
		};
		await this.write(session);

		const authSession = toAuthSession(session);
		this._onDidChangeSessions.fire({ added: [authSession], removed: [], changed: [] });
		log(`[vsgo] conta conectada: ${session.account.email ?? session.account.id} (plano ${session.plan.name})`);
		return authSession;
	}

	/**
	 * Sair aqui revoga a chave no servidor, não só apaga o cofre local.
	 *
	 * Uma credencial que continua válida numa máquina de que a pessoa acabou de
	 * sair é exatamente o que o botão promete ter encerrado. A revogação é o
	 * melhor esforço: sem rede, o cofre local ainda é limpo, e a chave pode ser
	 * desconectada depois pelo painel.
	 */
	async removeSession(sessionId: string): Promise<void> {
		const session = await this.read();
		if (!session || session.id !== sessionId) {
			return;
		}
		try {
			const res = await fetch(`${vsgoBaseUrl()}/v1/editor/revoke`, {
				method: 'POST',
				headers: { 'Authorization': `Bearer ${session.accessToken}` },
			});
			if (!res.ok) {
				log(`[vsgo] revogação respondeu ${res.status}`);
			}
		} catch (err) {
			log('[vsgo] revogação falhou:', err instanceof Error ? err.message : String(err));
		}
		await this.clear();
		this._onDidChangeSessions.fire({ added: [], removed: [toAuthSession(session)], changed: [] });
	}

	/** A sessão guardada, sem passar pelo consentimento por extensão. */
	async currentSession(): Promise<IStoredSession | undefined> {
		return this.read();
	}

	/**
	 * A conta como ela está AGORA no servidor, e não como estava na conexão.
	 *
	 * Nome, e-mail e plano são gravados no cofre no momento em que a instalação
	 * foi conectada, e ficam ali parados: quem trocou de plano no site continua
	 * vendo "Free" na tela de configurações do editor até desconectar e
	 * conectar de novo — justamente na tela que existe para responder "o que
	 * esta conta me dá".
	 *
	 * `/v1/me` responde com o estado atual. Sem rede, ou com o servidor fora,
	 * devolve o que está guardado: uma tela com o plano de ontem é melhor do
	 * que uma tela vazia. Chave recusada é outra história — aí a sessão local
	 * não vale mais nada e é descartada, como no resto do provedor.
	 */
	async accountInfo(): Promise<{ name?: string; email?: string; plan?: string } | undefined> {
		const session = await this.read();
		if (!session) {
			return undefined;
		}

		const guardado = {
			name: session.account.name ?? undefined,
			email: session.account.email ?? undefined,
			plan: session.plan.name,
		};

		try {
			const res = await fetch(`${vsgoBaseUrl()}/v1/me`, {
				headers: { 'Authorization': `Bearer ${session.accessToken}` },
			});
			if (res.status === 401 || res.status === 403) {
				await this.invalidate();
				return undefined;
			}
			if (!res.ok) {
				return guardado;
			}
			const atual = await res.json() as {
				email?: string | null;
				name?: string | null;
				plan?: { id: string; name: string; requests_per_minute: number; monthly_token_limit: number | null };
			};
			if (!atual.plan) {
				return guardado;
			}

			// O cofre acompanha: a próxima leitura já sai certa mesmo offline.
			await this.write({
				...session,
				account: {
					...session.account,
					email: atual.email ?? session.account.email,
					name: atual.name ?? session.account.name,
				},
				plan: {
					id: atual.plan.id,
					name: atual.plan.name,
					requests_per_minute: atual.plan.requests_per_minute,
					monthly_token_limit: atual.plan.monthly_token_limit,
				},
			});

			return {
				name: atual.name ?? guardado.name,
				email: atual.email ?? guardado.email,
				plan: atual.plan.name,
			};
		} catch (err) {
			log('[vsgo] /v1/me indisponível; usando a conta guardada:', err instanceof Error ? err.message : String(err));
			return guardado;
		}
	}

	/**
	 * Descarta a sessão local porque o servidor recusou a chave.
	 *
	 * Uma chave revogada no painel ou uma conta suspensa deixam o editor com um
	 * segredo que não abre mais nada; mantê-lo só faria a lista de modelos ficar
	 * vazia sem explicar por quê.
	 */
	async invalidate(): Promise<void> {
		const session = await this.read();
		if (!session) {
			return;
		}
		await this.clear();
		this._onDidChangeSessions.fire({ added: [], removed: [toAuthSession(session)], changed: [] });
	}

	dispose(): void {
		this._onDidChangeSessions.dispose();
		for (const [, resolve] of this.pending) {
			resolve(new Error('A janela foi fechada durante a conexão.'));
		}
		this.pending.clear();
	}

	private waitForCode(state: string, token: vscode.CancellationToken): Promise<string> {
		return new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(state);
				reject(new Error('Tempo esgotado esperando a autorização no navegador.'));
			}, SIGN_IN_TIMEOUT_MS);

			const cancelled = token.onCancellationRequested(() => {
				clearTimeout(timer);
				this.pending.delete(state);
				reject(new vscode.CancellationError());
			});

			this.pending.set(state, result => {
				clearTimeout(timer);
				cancelled.dispose();
				if (result instanceof Error) {
					reject(result);
				} else {
					resolve(result.code);
				}
			});
		});
	}

	private async exchange(code: string, verifier: string): Promise<IGrantResponse> {
		const res = await fetch(`${vsgoBaseUrl()}/v1/editor/token`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ code, verifier }),
		});
		if (!res.ok) {
			const detail = await res.text();
			log(`[vsgo] /v1/editor/token respondeu ${res.status}: ${detail.slice(0, 300)}`);
			throw new Error(
				res.status === 400 || res.status === 401
					? 'A autorização expirou ou já foi usada. Tente conectar de novo.'
					: 'Não foi possível falar com o vsgo agora. Tente de novo em instantes.',
			);
		}
		return await res.json() as IGrantResponse;
	}

	private async read(): Promise<IStoredSession | undefined> {
		if (this.cached) {
			return this.cached;
		}
		const raw = await this.secrets.get(SECRET_KEY);
		if (!raw) {
			return undefined;
		}
		try {
			this.cached = JSON.parse(raw) as IStoredSession;
			return this.cached;
		} catch {
			// Cofre com conteúdo de outra versão: melhor pedir para entrar de novo
			// do que carregar um objeto pela metade por toda a sessão.
			await this.secrets.delete(SECRET_KEY);
			return undefined;
		}
	}

	private async write(session: IStoredSession): Promise<void> {
		this.cached = session;
		await this.secrets.store(SECRET_KEY, JSON.stringify(session));
	}

	private async clear(): Promise<void> {
		this.cached = undefined;
		await this.secrets.delete(SECRET_KEY);
	}
}

function toAuthSession(session: IStoredSession): vscode.AuthenticationSession {
	return {
		id: session.id,
		accessToken: session.accessToken,
		account: {
			id: session.account.id,
			label: session.account.email ?? session.account.name ?? 'Conta vsgo',
		},
		// A conta é uma só e dá acesso ao que o plano libera; não há escopo a
		// negociar, e inventar um faria o VS Code pedir consentimentos separados
		// para a mesma coisa.
		scopes: [],
	};
}

/** Como esta instalação vai aparecer na lista de chaves da conta. */
function deviceName(): string {
	const host = hostname().split('.')[0]?.slice(0, 32);
	return host ? `vsgo em ${host}` : 'vsgo';
}

/** Registra o provedor de contas e o handler do `vsgo://` de retorno. */
export function registerVsgoAuth(secrets: vscode.SecretStorage): { provider: VsgoAuthProvider; disposable: vscode.Disposable } {
	const provider = new VsgoAuthProvider(secrets);
	const subs: vscode.Disposable[] = [
		provider,
		vscode.authentication.registerAuthenticationProvider(VSGO_AUTH_ID, VSGO_AUTH_LABEL, provider, {
			supportsMultipleAccounts: false,
		}),
		vscode.window.registerUriHandler({ handleUri: uri => provider.handleUri(uri) }),
	];
	return { provider, disposable: vscode.Disposable.from(...subs) };
}
