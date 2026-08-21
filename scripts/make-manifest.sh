#!/usr/bin/env bash
# Prepara uma pasta de artefatos para publicação em um servidor de download.
#
# Varre a pasta, identifica cada arquivo (SO, arquitetura, tipo) e gera:
#   - SHA256SUMS.txt   → conferência de integridade ("sha256sum -c SHA256SUMS.txt")
#   - manifest.json    → índice legível por máquina (para site, updater, automação)
#   - index.html       → página de download pronta para subir junto
#   - COMO-INSTALAR.md → instruções por sistema operacional
#
# Uso:
#   bash scripts/make-manifest.sh                          # usa ./dist
#   bash scripts/make-manifest.sh caminho/da/pasta
#   bash scripts/make-manifest.sh --base-url https://downloads.exemplo.com/vsgo
#   bash scripts/make-manifest.sh --no-page                # não gera o index.html

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$REPO_ROOT/dist"
BASE_URL=""
WANT_PAGE=1
while [[ $# -gt 0 ]]; do
	case "$1" in
		--base-url) shift; BASE_URL="${1%/}" ;;
		--no-page) WANT_PAGE=0 ;;
		-*) echo "Argumento desconhecido: $1"; exit 1 ;;
		*) DIST_DIR="$1" ;;
	esac
	shift
done

[[ -d "$DIST_DIR" ]] || { echo "ERRO: pasta não encontrada: $DIST_DIR"; exit 1; }
DIST_DIR="$(cd "$DIST_DIR" && pwd)"

VERSION="$(cd "$REPO_ROOT" && node -p "require('./package.json').version")"
COMMIT="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# sha256sum/stat mudam de nome e de flags entre Linux e macOS.
if command -v sha256sum >/dev/null 2>&1; then
	sha256_of() { sha256sum "$1" | cut -d' ' -f1; }
else
	sha256_of() { shasum -a 256 "$1" | cut -d' ' -f1; }
fi
if stat -c %s "$0" >/dev/null 2>&1; then
	size_of() { stat -c %s "$1"; }
else
	size_of() { stat -f %z "$1"; }
fi

# Traduz o nome do arquivo em (plataforma, arquitetura, tipo, rótulo).
classify() {
	local name="$1"
	case "$name" in
		*.deb)                    echo "linux|x64|package|Pacote Debian/Ubuntu (.deb)" ;;
		*linux-x64.tar.gz)        echo "linux|x64|archive|Arquivo portátil (.tar.gz)" ;;
		vsgoUserSetup-x64-*.exe)  echo "windows|x64|installer|Instalador (recomendado)" ;;
		vsgoSystemSetup-x64-*.exe) echo "windows|x64|installer-system|Instalador para todos os usuários" ;;
		*darwin-arm64.dmg)        echo "macos|arm64|installer|Instalador Apple Silicon (.dmg)" ;;
		*darwin-x64.dmg)          echo "macos|x64|installer|Instalador Intel (.dmg)" ;;
		*darwin-arm64.zip)        echo "macos|arm64|archive|App compactado Apple Silicon (.zip)" ;;
		*darwin-x64.zip)          echo "macos|x64|archive|App compactado Intel (.zip)" ;;
		*)                        echo "" ;;
	esac
}

cd "$DIST_DIR"

echo "==> vsgo — preparando pasta de download"
echo "    Pasta   : $DIST_DIR"
echo "    Versão  : $VERSION"
[[ -n "$BASE_URL" ]] && echo "    Base URL: $BASE_URL"
echo ""

FILES=()
while IFS= read -r f; do
	FILES+=("$f")
done < <(ls -1 2>/dev/null | grep -E '\.(deb|exe|dmg|zip|tar\.gz)$' | sort)

if [[ "${#FILES[@]}" -eq 0 ]]; then
	echo "ERRO: nenhum artefato (.deb/.exe/.dmg/.zip/.tar.gz) encontrado em $DIST_DIR"
	exit 1
fi

# ─── SHA256SUMS.txt ───────────────────────────────────────────────────────────
: > SHA256SUMS.txt
for f in "${FILES[@]}"; do
	printf '%s  %s\n' "$(sha256_of "$f")" "$f" >> SHA256SUMS.txt
done
echo "    SHA256SUMS.txt  (${#FILES[@]} arquivos)"

# ─── manifest.json ────────────────────────────────────────────────────────────
{
	printf '{\n'
	printf '\t"product": "vsgo",\n'
	printf '\t"version": "%s",\n' "$VERSION"
	printf '\t"commit": "%s",\n' "$COMMIT"
	printf '\t"releasedAt": "%s",\n' "$NOW"
	printf '\t"baseUrl": "%s",\n' "$BASE_URL"
	printf '\t"files": [\n'
	first=1
	for f in "${FILES[@]}"; do
		info="$(classify "$f")"
		[[ -z "$info" ]] && continue
		IFS='|' read -r platform arch kind label <<< "$info"
		[[ "$first" -eq 1 ]] || printf ',\n'
		first=0
		printf '\t\t{\n'
		printf '\t\t\t"name": "%s",\n' "$f"
		printf '\t\t\t"platform": "%s",\n' "$platform"
		printf '\t\t\t"arch": "%s",\n' "$arch"
		printf '\t\t\t"kind": "%s",\n' "$kind"
		printf '\t\t\t"label": "%s",\n' "$label"
		printf '\t\t\t"size": %s,\n' "$(size_of "$f")"
		printf '\t\t\t"sha256": "%s",\n' "$(sha256_of "$f")"
		printf '\t\t\t"url": "%s"\n' "${BASE_URL:+$BASE_URL/}$f"
		printf '\t\t}'
	done
	printf '\n\t]\n'
	printf '}\n'
} > manifest.json
echo "    manifest.json"

# Falha cedo se o JSON saiu malformado — é ele que o site/updater vai consumir.
node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8'))"

# ─── COMO-INSTALAR.md ─────────────────────────────────────────────────────────
cp "$REPO_ROOT/scripts/dist-templates/COMO-INSTALAR.md" COMO-INSTALAR.md
echo "    COMO-INSTALAR.md"

# ─── index.html ───────────────────────────────────────────────────────────────
if [[ "$WANT_PAGE" -eq 1 ]]; then
	{
		cat <<'PAGE_HEAD'
<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Baixar o vsgo</title>
<style>
	:root { color-scheme: light dark; --bg: #ffffff; --fg: #1b1b1f; --muted: #5c5c66; --line: #e2e2e8; --card: #f7f7f9; --accent: #2f5bd7; }
	@media (prefers-color-scheme: dark) {
		:root { --bg: #17171a; --fg: #ececf1; --muted: #a0a0ad; --line: #2e2e35; --card: #1f1f24; --accent: #7ba0ff; }
	}
	* { box-sizing: border-box; }
	body { margin: 0; padding: 3rem 1.25rem 5rem; background: var(--bg); color: var(--fg);
		font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Ubuntu, sans-serif; }
	main { max-width: 46rem; margin: 0 auto; }
	h1 { font-size: 2rem; margin: 0 0 .25rem; letter-spacing: -.02em; }
	.version { color: var(--muted); margin: 0 0 2.5rem; font-variant-numeric: tabular-nums; }
	h2 { font-size: 1.05rem; margin: 2rem 0 .75rem; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
	ul { list-style: none; margin: 0; padding: 0; display: grid; gap: .5rem; }
	li { border: 1px solid var(--line); border-radius: 10px; background: var(--card); }
	a.dl { display: flex; flex-wrap: wrap; align-items: baseline; gap: .5rem .75rem;
		padding: .85rem 1rem; text-decoration: none; color: inherit; }
	a.dl:hover { border-radius: 10px; outline: 2px solid var(--accent); outline-offset: -1px; }
	.label { font-weight: 600; }
	.meta { color: var(--muted); font-size: .85rem; font-variant-numeric: tabular-nums; margin-left: auto; }
	.sha { display: block; padding: 0 1rem .8rem; color: var(--muted);
		font: .72rem/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
	footer { margin-top: 3rem; padding-top: 1.5rem; border-top: 1px solid var(--line); color: var(--muted); font-size: .9rem; }
	footer a { color: var(--accent); }
</style>
</head>
<body>
<main>
PAGE_HEAD
		printf '<h1>Baixar o vsgo</h1>\n'
		printf '<p class="version">Versão %s · %s</p>\n' "$VERSION" "${NOW%T*}"

		for group in windows macos linux; do
			case "$group" in
				windows) title="Windows" ;;
				macos) title="macOS" ;;
				linux) title="Linux" ;;
			esac
			rows=""
			for f in "${FILES[@]}"; do
				info="$(classify "$f")"
				[[ -z "$info" ]] && continue
				IFS='|' read -r platform arch kind label <<< "$info"
				[[ "$platform" == "$group" ]] || continue
				bytes="$(size_of "$f")"
				mb="$(LC_ALL=C awk -v b="$bytes" 'BEGIN { printf "%.1f", b / 1048576 }')"
				rows+="$(printf '<li><a class="dl" href="%s"><span class="label">%s</span><span class="meta">%s MB</span></a><span class="sha">%s</span></li>\n' \
					"${BASE_URL:+$BASE_URL/}$f" "$label" "$mb" "$(sha256_of "$f")")"
			done
			[[ -z "$rows" ]] && continue
			printf '<h2>%s</h2>\n<ul>\n%s</ul>\n' "$title" "$rows"
		done

		cat <<'PAGE_FOOT'
<footer>
<p>Instruções detalhadas em <a href="COMO-INSTALAR.md">COMO-INSTALAR.md</a>.
Confira a integridade dos arquivos com <a href="SHA256SUMS.txt">SHA256SUMS.txt</a>.</p>
<p>No Windows, o SmartScreen pode avisar que o app não é reconhecido: clique em
"Mais informações" e depois em "Executar assim mesmo". No macOS, abra o app pela
primeira vez com o botão direito → "Abrir".</p>
</footer>
</main>
</body>
</html>
PAGE_FOOT
	} > index.html
	echo "    index.html"
fi

echo ""
echo "✅ Pasta pronta para subir ao servidor:"
echo "   $DIST_DIR"
ls -1sh "$DIST_DIR" | tail -n +2 | sed 's/^/     /'
