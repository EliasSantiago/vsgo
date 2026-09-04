/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { FindingSeverity } from './securityScan.js';

/**
 * Pattern-based checks that run before any model is asked anything.
 *
 * The scan used to be a single model call per file, which meant a weak or busy
 * model produced an empty report indistinguishable from a clean workspace.
 * These rules are the part of the answer that does not depend on a model: they
 * are deterministic, they run in milliseconds, and a finding here is a fact
 * about the text rather than an opinion about it.
 *
 * The bar for adding a rule is precision, not coverage. A rule that fires on
 * healthy code teaches people to ignore the panel, and an ignored panel finds
 * nothing at all. Anything needing real dataflow — is this variable actually
 * attacker-controlled — is left to the model review that runs after.
 */

/** Where in the codebase a file sits, which decides what is worth checking. */
export const enum SecurityLayer {
	/** Build files, CI, container and framework configuration. */
	Config = 'config',
	/** Anything that answers a request: API routes, controllers, handlers. */
	Routes = 'routes',
	/** Business logic, components, hooks, utilities. */
	Application = 'application',
	/** Queries, migrations, ORM models, storage access. */
	Data = 'data',
}

/** Order the scan walks the layers in, outermost attack surface first. */
export const SECURITY_LAYERS: readonly SecurityLayer[] = [
	SecurityLayer.Config,
	SecurityLayer.Routes,
	SecurityLayer.Application,
	SecurityLayer.Data,
];

export interface ISecurityRule {
	/** Stable identifier, reported with the finding so a rule can be argued with. */
	readonly id: string;
	readonly title: string;
	/** What the pattern means, why it is a risk, and what to do instead. */
	readonly description: string;
	readonly severity: FindingSeverity;
	readonly cwe: string;
	/**
	 * Matched against the whole file so a rule can span lines; the line number
	 * comes from the match offset. Must carry the `g` flag.
	 */
	readonly pattern: RegExp;
	/** File extensions the rule applies to. Empty means every scanned file. */
	readonly extensions?: readonly string[];
	/** Layers worth running this in. Empty means all of them. */
	readonly layers?: readonly SecurityLayer[];
	/**
	 * Drops the match when this matches the line it was found on. The usual job
	 * is excusing the safe idiom a pattern cannot tell apart from the unsafe one.
	 */
	readonly unless?: RegExp;
}

export interface IRuleMatch {
	readonly rule: ISecurityRule;
	/** 1-based. */
	readonly line: number;
	/** 1-based, into the line. */
	readonly column: number;
	readonly length: number;
}

/** Ends a string that came from somewhere the user controls. */
const REQUEST_SOURCE = String.raw`req\.(?:body|query|params|headers|cookies)|request\.(?:body|query|params)|ctx\.(?:query|params|request)|searchParams\.get|event\.(?:body|queryStringParameters)|\$_(?:GET|POST|REQUEST|COOKIE)`;

/** Names that mean a value is a credential rather than a label. */
const SECRET_NAME = String.raw`(?:api[_-]?key|secret|passwd|password|token|credential|private[_-]?key|access[_-]?key|auth)`;

export const SECURITY_RULES: readonly ISecurityRule[] = [
	// ── Secrets ──────────────────────────────────────────────────────────────
	{
		id: 'secret-private-key',
		title: 'Chave privada embutida no código',
		description: 'Um bloco PEM de chave privada está escrito no repositório. Quem tiver acesso ao histórico do git tem a chave, e revogá-la depois exige rotacionar tudo que ela assina. Mova a chave para um cofre de segredos ou para uma variável de ambiente lida em tempo de execução.',
		severity: 'error',
		cwe: 'CWE-798',
		pattern: /-----BEGIN\s+(?:RSA|DSA|EC|OPENSSH|PGP)?\s*PRIVATE KEY-----/g,
	},
	{
		id: 'secret-aws-access-key',
		title: 'Chave de acesso da AWS embutida no código',
		description: 'O identificador tem o formato de uma access key da AWS (AKIA/ASIA…). Chaves em código-fonte vazam por repositórios, builds e imagens de container. Use credenciais de ambiente, perfis de instância ou OIDC.',
		severity: 'error',
		cwe: 'CWE-798',
		pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
	},
	{
		id: 'secret-provider-token',
		title: 'Token de provedor exposto no código',
		description: 'A string tem o formato de uma credencial emitida por um provedor conhecido (OpenAI, Anthropic, GitHub, Stripe, Slack, Google, SendGrid, npm). Formatos assim são varridos automaticamente por bots em repositórios públicos, e o vazamento costuma virar cobrança ou acesso indevido em minutos. Revogue a credencial e leia-a de variável de ambiente. Se ela chega ao navegador, revogue de qualquer forma: tudo que o cliente recebe é público.',
		severity: 'error',
		cwe: 'CWE-798',
		// Matched by shape, not by the name of the variable holding it: a real key
		// assigned to `const k` is still a real key.
		pattern: /\bsk-proj-[A-Za-z0-9_-]{20,}|\bsk-ant-[A-Za-z0-9_-]{20,}|\bsk-[A-Za-z0-9]{32,}|\bgh[pousr]_[A-Za-z0-9]{36,}|\bgithub_pat_[A-Za-z0-9_]{50,}|\bxox[baprs]-[A-Za-z0-9-]{10,}|\b[sr]k_live_[A-Za-z0-9]{20,}|\bAIza[A-Za-z0-9_-]{30,}|\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}|\bnpm_[A-Za-z0-9]{36}\b/g,
	},
	{
		id: 'secret-assigned-literal',
		title: 'Credencial atribuída como texto literal',
		description: 'Uma variável com nome de credencial recebe um literal em vez de vir da configuração. Se for um segredo real, ele está versionado; se for um placeholder, ele ainda ensina o padrão errado. Leia de variável de ambiente ou de um cofre.',
		severity: 'warning',
		cwe: 'CWE-798',
		pattern: new RegExp(String.raw`\b\w*${SECRET_NAME}\w*\s*[:=]\s*['"\`][^'"\`\n]{8,}['"\`]`, 'gi'),
		// Reading from the environment, or an obvious placeholder, is the fix —
		// not the bug.
		unless: /process\.env|import\.meta\.env|os\.environ|getenv|System\.getenv|<[^>]+>|\bxxx+\b|your[_-]?|example|changeme|placeholder|\*{4,}/i,
	},
	{
		id: 'nextjs-public-secret',
		title: 'Segredo exposto ao navegador via NEXT_PUBLIC_',
		description: 'Toda variável NEXT_PUBLIC_ é embutida no bundle do cliente e fica legível para qualquer visitante. Esta tem nome de credencial. Se for mesmo um segredo, remova o prefixo e leia-a apenas no servidor.',
		severity: 'error',
		cwe: 'CWE-200',
		pattern: new RegExp(String.raw`NEXT_PUBLIC_\w*${SECRET_NAME}\w*`, 'gi'),
	},
	{
		id: 'secret-connection-string',
		title: 'String de conexão com senha embutida',
		description: 'A URL de conexão carrega usuário e senha em texto claro. Além de versionada, ela costuma acabar em logs e em mensagens de erro. Monte a URL a partir de variáveis de ambiente.',
		severity: 'error',
		cwe: 'CWE-798',
		pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s'"`:]+:[^\s'"`@]+@/gi,
		unless: /process\.env|import\.meta\.env|os\.environ|getenv|\$\{/,
	},

	// ── Injection ────────────────────────────────────────────────────────────
	{
		id: 'sql-string-concatenation',
		title: 'SQL montado por concatenação de texto',
		description: 'A consulta é montada juntando texto a valores em tempo de execução. Se algum desses valores vier da requisição, o atacante escreve SQL. Use consultas parametrizadas (placeholders) e passe os valores separadamente.',
		severity: 'error',
		cwe: 'CWE-89',
		// Verb plus its clause: `update` alone is an ordinary English word, and a
		// log line carrying `${name}` is not a query.
		pattern: /\b(?:SELECT\b[^;'"`\n]*\bFROM|INSERT\s+INTO|UPDATE\b[^;'"`\n]*\bSET|DELETE\s+FROM)\b[^;'"`\n]*(?:['"`]\s*\+|\+\s*['"`]|\$\{|%s|%\(|\bformat\s*\()/gi,
	},
	{
		id: 'sql-template-literal',
		title: 'SQL interpolado em template string',
		description: 'A consulta usa `${…}` para inserir valores direto no texto do SQL. Bibliotecas como pg, mysql2 e sqlite aceitam parâmetros posicionais — use-os. Marcadores de template seguros (`sql` do postgres.js, `Prisma.sql`) também resolvem.',
		severity: 'error',
		cwe: 'CWE-89',
		pattern: /\.(?:query|execute|raw|prepare|exec)\s*\(\s*`[^`]*\$\{/g,
		// A tagged template (sql`…`) escapes its interpolations by construction.
		unless: /\b(?:sql|Prisma\.sql|db\.sql)\s*`/,
	},
	{
		id: 'command-injection',
		title: 'Comando de shell montado com valor dinâmico',
		description: 'O comando é construído com interpolação ou concatenação e entregue a um shell, que interpreta `;`, `|` e `$()`. Prefira a forma que recebe o programa e os argumentos como lista (execFile, spawn sem shell) em vez de exec.',
		severity: 'error',
		cwe: 'CWE-78',
		pattern: /\b(?:exec|execSync|spawnSync|system|popen|shell_exec|passthru)\s*\(\s*(?:[`'"][^`'"]*(?:\$\{|"\s*\+|'\s*\+)|[^)]*\+)/g,
	},
	{
		id: 'child-process-shell-true',
		title: 'Processo filho iniciado com shell: true',
		description: 'Com `shell: true` os argumentos passam por um shell, o que reintroduz injeção mesmo quando eles vêm como lista. Remova a opção e chame o executável diretamente.',
		severity: 'warning',
		cwe: 'CWE-78',
		pattern: /shell\s*:\s*true/g,
		extensions: ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'],
	},
	{
		id: 'eval-dynamic-code',
		title: 'Execução dinâmica de código',
		description: 'eval e seus equivalentes executam texto como programa. Se o texto tocar em algo vindo de fora, é execução remota de código; mesmo quando não toca, impede análise estática e otimização. Quase sempre há uma estrutura de dados que resolve o mesmo problema.',
		severity: 'error',
		cwe: 'CWE-95',
		pattern: /\beval\s*\(|\bnew\s+Function\s*\(|\bset(?:Timeout|Interval)\s*\(\s*['"`]/g,
		unless: /\/\/|\*|eval\s*:/,
	},

	// ── XSS e renderização ───────────────────────────────────────────────────
	{
		id: 'xss-dangerously-set-inner-html',
		title: 'HTML injetado sem sanitização (dangerouslySetInnerHTML)',
		description: 'O React escapa tudo por padrão, e esta chamada desliga essa proteção. Se o HTML tiver qualquer parte vinda do usuário ou do banco, é XSS. Sanitize com DOMPurify antes, ou renderize como texto.',
		severity: 'error',
		cwe: 'CWE-79',
		pattern: /dangerouslySetInnerHTML/g,
		unless: /DOMPurify|sanitiz/i,
	},
	{
		id: 'xss-inner-html-assignment',
		title: 'Atribuição direta a innerHTML',
		description: 'Escrever em innerHTML faz o navegador interpretar o texto como marcação, incluindo `<script>` e manipuladores inline. Use textContent quando for texto, ou sanitize a marcação.',
		severity: 'warning',
		cwe: 'CWE-79',
		pattern: /\.(?:innerHTML|outerHTML)\s*=(?!=)/g,
		unless: /=\s*['"`]\s*['"`]\s*;?\s*$|DOMPurify|sanitiz/i,
	},
	{
		id: 'xss-document-write',
		title: 'document.write com conteúdo dinâmico',
		description: 'document.write injeta marcação no documento durante o parse e não escapa nada. Construa os nós com a API do DOM.',
		severity: 'warning',
		cwe: 'CWE-79',
		pattern: /document\.write(?:ln)?\s*\(\s*(?!['"`][^'"`]*['"`]\s*\))/g,
	},
	{
		id: 'xss-vue-v-html',
		title: 'v-html renderizando conteúdo sem sanitização',
		description: 'v-html insere HTML bruto no template. Vale a mesma regra do innerHTML: sanitize antes, ou use interpolação normal.',
		severity: 'warning',
		cwe: 'CWE-79',
		pattern: /v-html\s*=/g,
		extensions: ['vue', 'html'],
		unless: /DOMPurify|sanitiz/i,
	},

	// ── Transporte e criptografia ────────────────────────────────────────────
	{
		id: 'tls-verification-disabled',
		title: 'Verificação de certificado TLS desligada',
		description: 'Sem validar o certificado, a conexão continua criptografada mas deixa de provar com quem é — qualquer intermediário consegue se passar pelo servidor. Se o problema for um certificado interno, adicione a CA ao repositório de confiança em vez de desligar a checagem.',
		severity: 'error',
		cwe: 'CWE-295',
		pattern: /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*[=:]\s*['"]?0|verify\s*=\s*False|InsecureSkipVerify\s*:\s*true|curl_setopt\s*\([^)]*CURLOPT_SSL_VERIFYPEER\s*,\s*(?:false|0)/gi,
	},
	{
		id: 'weak-hash',
		title: 'Hash criptográfico obsoleto',
		description: 'MD5 e SHA-1 têm colisões práticas e não servem para assinatura, integridade ou senha. Use SHA-256 para integridade; para senha, um algoritmo com custo ajustável como bcrypt, scrypt ou Argon2.',
		severity: 'warning',
		cwe: 'CWE-327',
		pattern: /\b(?:createHash|Digest|hashlib\.|MessageDigest\.getInstance)\s*\(?\s*['"]?(?:md5|sha1|sha-1)['"]?/gi,
	},
	{
		id: 'weak-cipher-api',
		title: 'API de cifra depreciada (createCipher)',
		description: 'createCipher deriva a chave de uma senha com MD5 e sem IV aleatório, o que faz textos iguais cifrarem igual. Use createCipheriv com uma chave de verdade e um IV aleatório por mensagem.',
		severity: 'error',
		cwe: 'CWE-327',
		pattern: /\bcreate(?:Cipher|Decipher)\s*\(/g,
		unless: /createCipheriv|createDecipheriv/,
	},
	{
		id: 'insecure-randomness',
		title: 'Valor de segurança gerado com aleatoriedade fraca',
		description: 'Math.random não é criptográfico: a sequência é previsível a partir de algumas saídas. Para token, senha, id de sessão ou nonce, use crypto.randomUUID ou crypto.getRandomValues.',
		severity: 'warning',
		cwe: 'CWE-338',
		pattern: new RegExp(String.raw`(?:${SECRET_NAME}|nonce|salt|session|otp|uuid)\w*\s*[:=][^;\n]*Math\.random\s*\(`, 'gi'),
	},

	// ── Sessão, cookies e CORS ───────────────────────────────────────────────
	{
		id: 'cookie-not-httponly',
		title: 'Cookie legível por JavaScript',
		description: 'Com httpOnly desligado, qualquer XSS na página consegue ler o cookie — inclusive o de sessão. Deixe httpOnly ligado em tudo que o navegador não precisa ler.',
		severity: 'warning',
		cwe: 'CWE-1004',
		pattern: /httpOnly\s*:\s*false/gi,
	},
	{
		id: 'cookie-not-secure',
		title: 'Cookie enviado fora de HTTPS',
		description: 'Sem a flag secure o cookie viaja também em conexões http, onde é lido por qualquer intermediário da rede. Ligue secure em produção.',
		severity: 'warning',
		cwe: 'CWE-614',
		pattern: /secure\s*:\s*false/gi,
		layers: [SecurityLayer.Routes, SecurityLayer.Config, SecurityLayer.Application],
	},
	{
		id: 'cors-wildcard-origin',
		title: 'CORS liberado para qualquer origem',
		description: 'Responder Access-Control-Allow-Origin com `*` permite que qualquer site chame esta API pelo navegador. Em endpoint autenticado isso é grave; liste as origens que você realmente atende.',
		severity: 'warning',
		cwe: 'CWE-942',
		pattern: /['"]Access-Control-Allow-Origin['"]\s*[,:]\s*['"]\*['"]|origin\s*:\s*['"]\*['"]/g,
	},

	// ── Arquivos e desserialização ───────────────────────────────────────────
	{
		id: 'path-traversal-request-input',
		title: 'Caminho de arquivo montado com dado da requisição',
		description: 'Um valor da requisição entra na construção do caminho. Com `../` o atacante sai do diretório pretendido e lê o que quiser. Resolva o caminho e confirme que ele continua dentro da pasta permitida antes de abrir.',
		severity: 'error',
		cwe: 'CWE-22',
		pattern: new RegExp(String.raw`(?:readFile|readFileSync|createReadStream|createWriteStream|sendFile|unlink|writeFile|writeFileSync|open_?file)\s*\([^)\n]*(?:${REQUEST_SOURCE})`, 'g'),
	},
	{
		id: 'unsafe-deserialization',
		title: 'Desserialização de dados não confiáveis',
		description: 'Estes formatos reconstroem objetos arbitrários e, em várias linguagens, executam código durante a leitura. Use um formato de dados puro (JSON) ou a variante segura do carregador (yaml.safe_load).',
		severity: 'error',
		cwe: 'CWE-502',
		pattern: /\bpickle\.loads?\s*\(|\byaml\.load\s*\((?![^)]*Safe)|\bunserialize\s*\(|readObject\s*\(/g,
	},

	// ── Autorização ──────────────────────────────────────────────────────────
	{
		id: 'auth-check-disabled',
		title: 'Verificação de autenticação desativada no código',
		description: 'Uma checagem de autenticação ou autorização está desligada por constante. Isso costuma ser resquício de depuração, e resquício de depuração chega em produção. Remova, ou proteja com uma flag que não tenha como ficar ligada fora do ambiente local.',
		severity: 'error',
		cwe: 'CWE-306',
		pattern: /(?:skip|disable|bypass|no)[_-]?(?:auth|authentication|authorization|permission|acl)\w*\s*[:=]\s*(?:true|1|['"]true['"])/gi,
	},
];

/**
 * Signals that a file has security-relevant surface at all.
 *
 * The expensive review has a budget, and spending it uniformly across a
 * codebase spends most of it on files that cannot hold a vulnerability: type
 * declarations, barrel re-exports, constant tables, presentational components.
 * Static analysers solve this the same way — a cheap textual pre-filter decides
 * what the expensive pass even looks at.
 *
 * Each entry is a family of signals rather than a rule: none of them is a
 * finding, all of them mean "there is something here worth reading".
 */
const INTEREST_SIGNALS: readonly { readonly weight: number; readonly pattern: RegExp }[] = [
	// Input that an attacker can reach.
	{ weight: 3, pattern: /\breq\.|\brequest\.|searchParams|useSearchParams|formData|params\s*[.:})\]]|process\.argv|getServerSideProps|\$_(?:GET|POST)/ },
	// Anything that leaves the process carrying data.
	{ weight: 3, pattern: /\bfetch\s*\(|axios|https?\.request|\bcurl\b|XMLHttpRequest|WebSocket/ },
	// Sinks where a mistake becomes an exploit.
	{ weight: 4, pattern: /\.query\s*\(|\.execute\s*\(|\bexec\s*\(|spawn\s*\(|innerHTML|dangerouslySetInnerHTML|\beval\s*\(|readFile|writeFile|createWriteStream/ },
	// Identity and access decisions.
	{ weight: 4, pattern: /\bauth|session|\bjwt\b|\btoken\b|permission|\brole\b|isAdmin|currentUser|getUser|signIn|logout|middleware/i },
	// Anything holding or protecting a secret.
	{ weight: 3, pattern: /process\.env|import\.meta\.env|crypto|cipher|\bhash\b|bcrypt|argon2|\bsalt\b|\bsecret\b|api[_-]?key/i },
	// Persistence, where authorization is usually enforced or forgotten.
	{ weight: 3, pattern: /prisma|mongoose|sequelize|knex|typeorm|supabase|\bdb\.|\bsql\b|createClient/i },
	// Serialization and file handling.
	{ weight: 2, pattern: /JSON\.parse|yaml|pickle|unserialize|multer|formidable|upload/i },
	// Server-side entry points in the frameworks this catalogue targets.
	{ weight: 2, pattern: /['"]use server['"]|export\s+async\s+function\s+(?:GET|POST|PUT|PATCH|DELETE)|app\.(?:get|post|put|delete)\s*\(|router\.(?:get|post|put|delete)\s*\(/ },
];

/** Weight added for the layer a file sits in, before its own signals count. */
const LAYER_PRIORITY: Record<SecurityLayer, number> = {
	[SecurityLayer.Routes]: 6,
	[SecurityLayer.Data]: 4,
	[SecurityLayer.Config]: 3,
	[SecurityLayer.Application]: 0,
};

/**
 * How much a file is worth spending a model review on. Zero means the file has
 * no security surface the review could find anything in.
 *
 * The score is used two ways: to drop the floor entirely, and to order what
 * remains, so a budget that runs out runs out on the least interesting files
 * rather than on whatever the file walker happened to reach last.
 */
export function reviewPriority(content: string, path: string, layer: SecurityLayer): number {
	// A declaration file states types and executes nothing, so there is no code
	// path in it for the review to follow.
	if (/\.d\.ts$/i.test(path)) {
		return 0;
	}
	let score = 0;
	for (const signal of INTEREST_SIGNALS) {
		if (signal.pattern.test(content)) {
			score += signal.weight;
		}
	}
	// A file with no signal at all stays at zero even when it sits on a route:
	// the layer says where it lives, the signals say whether anything happens.
	return score === 0 ? 0 : score + LAYER_PRIORITY[layer];
}

/**
 * Rough risk of a file from its path alone.
 *
 * Used to order a layer before anything is read, so that when the review budget
 * runs out it runs out on the least interesting files. Free to compute, which
 * is the point: the content-based score can only rank files already opened.
 */
export function pathPriority(path: string): number {
	const lower = path.toLowerCase();
	let score = 0;
	if (/auth|login|signin|signup|session|password|oauth|saml|sso|token/.test(lower)) { score += 5; }
	if (/admin|internal|superuser|billing|payment|checkout|invoice|payout/.test(lower)) { score += 4; }
	if (/upload|download|file|import|export|webhook|callback/.test(lower)) { score += 3; }
	if (/user|account|profile|member|tenant|org/.test(lower)) { score += 2; }
	if (/\bapi\b|route|handler|controller|endpoint|server|action/.test(lower)) { score += 2; }
	// Fixtures and tests describe attacks more often than they contain them.
	if (/\.(?:test|spec)\.|__tests__|__mocks__|\/fixtures?\/|\/examples?\//.test(lower)) { score -= 6; }
	if (/\.d\.ts$|\.stories\.|\.min\.js$|generated|\.gen\./.test(lower)) { score -= 8; }
	return score;
}

/**
 * Version of the review inputs, mixed into the cache key.
 *
 * Bumped when the rules, the prompt or the pre-filter change in a way that
 * would make a previous answer wrong to reuse.
 */
export const SECURITY_ANALYSIS_VERSION = 2;

/** Extension of `path`, lowercased and without the dot. */
export function extensionOf(path: string): string {
	const dot = path.lastIndexOf('.');
	const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	return dot > slash ? path.slice(dot + 1).toLowerCase() : '';
}

/**
 * Which layer a file belongs to, from its path.
 *
 * Path first, because frameworks encode the answer there — `app/api/**` is a
 * route whatever its contents look like — and because it stays cheap enough to
 * classify a whole workspace before reading a single file.
 */
export function classifyLayer(path: string): SecurityLayer {
	const lower = path.toLowerCase();

	if (/(?:^|\/)(?:next\.config|vite\.config|webpack\.config|nuxt\.config|svelte\.config|tailwind\.config|dockerfile|docker-compose|\.github\/workflows\/|serverless|vercel\.json|middleware)\b/.test(lower)
		|| /\.(?:ya?ml|toml|ini|conf)$/.test(lower)) {
		return SecurityLayer.Config;
	}
	if (/(?:^|\/)(?:app|src\/app)\/api\//.test(lower)
		|| /(?:^|\/)pages\/api\//.test(lower)
		|| /(?:^|\/)(?:routes?|controllers?|handlers?|endpoints?|resolvers?)\//.test(lower)
		|| /\b(?:route|controller|handler|endpoint|resolver|middleware)\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rb|php|java|cs)$/.test(lower)
		|| /(?:^|\/)(?:server|api)\.(?:ts|js|mjs|py|go)$/.test(lower)) {
		return SecurityLayer.Routes;
	}
	if (/(?:^|\/)(?:db|database|models?|repositor(?:y|ies)|entities|schemas?|migrations?|prisma|dao|storage|queries)\//.test(lower)
		|| /\.(?:sql|prisma)$/.test(lower)
		|| /\b(?:model|repository|schema|migration|query|dao)\.(?:ts|js|py|go|rb|php|java|cs)$/.test(lower)) {
		return SecurityLayer.Data;
	}
	return SecurityLayer.Application;
}

/** Human-readable name of a layer, for progress and reports. */
export function layerLabel(layer: SecurityLayer): string {
	switch (layer) {
		case SecurityLayer.Config: return 'Configuração e segredos';
		case SecurityLayer.Routes: return 'Rotas e endpoints';
		case SecurityLayer.Data: return 'Camada de dados';
		default: return 'Camada de aplicação';
	}
}

/**
 * Runs every applicable rule over one file.
 *
 * Matching is done against the whole text rather than line by line so a rule
 * can span lines; the offset is turned back into a line and column at the end.
 */
export function runSecurityRules(content: string, path: string, layer: SecurityLayer): IRuleMatch[] {
	const extension = extensionOf(path);
	const lineStarts = computeLineStarts(content);
	const matches: IRuleMatch[] = [];

	for (const rule of SECURITY_RULES) {
		if (rule.extensions && rule.extensions.length > 0 && !rule.extensions.includes(extension)) {
			continue;
		}
		if (rule.layers && rule.layers.length > 0 && !rule.layers.includes(layer)) {
			continue;
		}
		// Fresh each run: a global regex carries lastIndex between calls, and a
		// shared one would start the next file mid-way through it.
		const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
		let match: RegExpExecArray | null;
		while ((match = pattern.exec(content)) !== null) {
			// A zero-length match never advances lastIndex on its own.
			if (match[0].length === 0) {
				pattern.lastIndex++;
				continue;
			}
			const line = lineOf(lineStarts, match.index);
			if (rule.unless && rule.unless.test(lineText(content, lineStarts, line))) {
				continue;
			}
			matches.push({
				rule,
				line: line + 1,
				column: match.index - lineStarts[line] + 1,
				length: match[0].length,
			});
			if (matchesPerFile(matches, rule) >= MAX_MATCHES_PER_RULE) {
				break;
			}
		}
	}
	return matches;
}

/**
 * Cap per rule in a single file. A file that trips the same pattern fifty times
 * has one problem, not fifty, and a panel of identical rows buries everything
 * else in the scan.
 */
const MAX_MATCHES_PER_RULE = 10;

function matchesPerFile(matches: readonly IRuleMatch[], rule: ISecurityRule): number {
	let count = 0;
	for (const match of matches) {
		if (match.rule === rule) {
			count++;
		}
	}
	return count;
}

/** Offset where each line begins, for turning a match index into a position. */
function computeLineStarts(content: string): number[] {
	const starts = [0];
	for (let i = 0; i < content.length; i++) {
		if (content.charCodeAt(i) === 10 /* \n */) {
			starts.push(i + 1);
		}
	}
	return starts;
}

/** Index into `lineStarts` of the line containing `offset`, by binary search. */
function lineOf(lineStarts: readonly number[], offset: number): number {
	let low = 0;
	let high = lineStarts.length - 1;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (lineStarts[mid] <= offset) {
			low = mid;
		} else {
			high = mid - 1;
		}
	}
	return low;
}

function lineText(content: string, lineStarts: readonly number[], line: number): string {
	const start = lineStarts[line];
	const end = line + 1 < lineStarts.length ? lineStarts[line + 1] - 1 : content.length;
	return content.slice(start, end);
}
