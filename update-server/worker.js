/**
 * Feed de atualização do vsgo — Cloudflare Worker.
 *
 * O vsgo pergunta de hora em hora:
 *   GET /api/update/{plataforma}/{quality}/{commit-instalado}
 *
 * E espera 204 (já está atualizado) ou um JSON com o build novo. Este Worker
 * responde lendo a release mais recente do GitHub na hora, então NÃO precisa
 * ser reimplantado a cada versão: publicou a release, o feed já aponta para ela.
 *
 * As respostas do GitHub ficam em cache por CACHE_TTL para não esbarrar no
 * limite de requisições da API.
 */

const REPO = 'EliasSantiago/vsgo';
const USER_AGENT = 'vsgo-update-feed';
const CACHE_TTL = 300; // segundos

/**
 * Nomes de plataforma que o cliente usa, e qual arquivo da release serve cada um.
 * Ver src/vs/platform/update/electron-main/updateService.*.ts.
 * Plataforma ausente aqui = nada a oferecer = 204.
 */
const ASSET_BY_PLATFORM = {
	'win32-x64-user': /^vsgoUserSetup-x64-.*\.exe$/,
	'win32-x64': /^vsgoSystemSetup-x64-.*\.exe$/,
	'darwin-arm64': /-darwin-arm64\.zip$/,
	'darwin': /-darwin-x64\.zip$/,
	'linux-x64': /-linux-x64\.tar\.gz$/,
};

function noContent() {
	return new Response(null, { status: 204 });
}

async function github(path) {
	const res = await fetch(`https://api.github.com${path}`, {
		headers: { 'user-agent': USER_AGENT, accept: 'application/vnd.github+json' },
		cf: { cacheTtl: CACHE_TTL, cacheEverything: true },
	});
	if (!res.ok) {
		throw new Error(`GitHub ${path} respondeu ${res.status}`);
	}
	return res.json();
}

/** Tags anotadas apontam para um objeto tag, que aponta para o commit. */
async function commitOfTag(tag) {
	const ref = await github(`/repos/${REPO}/git/ref/tags/${encodeURIComponent(tag)}`);
	if (ref.object.type !== 'tag') {
		return ref.object.sha;
	}
	const tagObject = await github(`/repos/${REPO}/git/tags/${ref.object.sha}`);
	return tagObject.object.sha;
}

export default {
	async fetch(request) {
		const { pathname } = new URL(request.url);
		const match = /^\/api\/update\/([^/]+)\/([^/]+)\/([^/]+)\/?$/.exec(pathname);
		if (!match) {
			return new Response('vsgo update feed\n', { status: 404 });
		}

		const [, platform, quality, installedCommit] = match;
		if (quality !== 'stable') {
			return noContent();
		}

		const pattern = ASSET_BY_PLATFORM[platform];
		if (!pattern) {
			return noContent();
		}

		let release;
		let latestCommit;
		try {
			release = await github(`/repos/${REPO}/releases/latest`);
			latestCommit = await commitOfTag(release.tag_name);
		} catch {
			// Se o GitHub falhar, dizer "está atualizado" é melhor do que devolver
			// erro: no macOS um erro no feed vira mensagem para o usuário.
			return noContent();
		}

		if (installedCommit === latestCommit) {
			return noContent();
		}

		const asset = release.assets.find(a => pattern.test(a.name));
		if (!asset) {
			return noContent();
		}

		const body = {
			version: latestCommit,
			productVersion: release.tag_name.replace(/^v/, ''),
			timestamp: Date.parse(release.published_at),
			url: asset.browser_download_url,
		};

		// O updater do Windows confere o sha256 quando ele vem — melhor omitir
		// do que mandar errado, senão a atualização falha na verificação.
		if (typeof asset.digest === 'string' && asset.digest.startsWith('sha256:')) {
			body.sha256hash = asset.digest.slice('sha256:'.length);
		}

		return Response.json(body, {
			headers: { 'cache-control': `public, max-age=${CACHE_TTL}` },
		});
	},
};
