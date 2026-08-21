#!/usr/bin/env bash
# COMANDO ÚNICO de release do vsgo: sobe a versão, gera os instaladores desta
# máquina e deixa a pasta pronta para subir no servidor de download.
#
# Saída: dist/<versao>/ com os artefatos + SHA256SUMS.txt, manifest.json,
#        index.html e COMO-INSTALAR.md.
#
# Cada instalador precisa ser compilado NO SEU PRÓPRIO sistema operacional: os
# módulos nativos (terminal, log, storage, file watcher) não cruzam de um SO
# para outro. Por isso, o caminho normal para gerar Windows + macOS + Linux de
# uma vez é o GitHub Actions:
#
#   bash scripts/release.sh --tag        # sobe a versão, cria a tag e dispara o CI
#
# Uso local (só o SO desta máquina):
#   bash scripts/release.sh                    # sobe patch, build de produção
#   bash scripts/release.sh --no-bump          # sem mexer na versão
#   bash scripts/release.sh --fast             # build não minificado (teste)
#   bash scripts/release.sh linux              # força um alvo específico
#   bash scripts/release.sh --base-url https://downloads.exemplo.com/vsgo
#   bash scripts/release.sh --out /caminho/da/pasta
#
# Flags:
#   --tag       cria e envia a tag v<versao>, disparando o workflow de release
#   --no-bump   não incrementa a versão do package.json
#   --fast      build não minificado (mais rápido, para testar o empacotamento)
#   --base-url  prefixo das URLs no manifest.json e no index.html

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPTS="$REPO_ROOT/scripts"

[[ -f /etc/ssl/certs/ca-certificates.crt ]] && export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt

# Alvo padrão: o SO desta máquina.
case "$(uname -s)" in
	Linux) HOST_TARGET="linux" ;;
	Darwin) HOST_TARGET="mac" ;;
	MINGW*|MSYS*|CYGWIN*) HOST_TARGET="win" ;;
	*) HOST_TARGET="" ;;
esac

TARGET="$HOST_TARGET"
BUMP=1
BUILD_ARG="--min"
BASE_URL=""
OUT_DIR=""
DO_TAG=0
while [[ $# -gt 0 ]]; do
	case "$1" in
		linux|win|mac) TARGET="$1" ;;
		--tag) DO_TAG=1 ;;
		--no-bump) BUMP=0 ;;
		--fast) BUILD_ARG="" ;;
		--min) BUILD_ARG="--min" ;;
		--base-url) shift; BASE_URL="$1" ;;
		--out) shift; OUT_DIR="$1" ;;
		*) echo "Argumento desconhecido: $1"; exit 1 ;;
	esac
	shift
done

cd "$REPO_ROOT"

# ─── Bump de versão ───────────────────────────────────────────────────────────
# Subir o patch é o que faz o dpkg/apt e o instalador do Windows reconhecerem o
# pacote novo como ATUALIZAÇÃO do que já está instalado.
if [[ "$BUMP" -eq 1 ]]; then
	echo "==> Incrementando versão (patch)..."
	npm version patch --no-git-tag-version >/dev/null
fi
VERSION="$(node -p "require('./package.json').version")"
[[ -n "$OUT_DIR" ]] || OUT_DIR="$REPO_ROOT/dist/$VERSION"

echo "==> vsgo release — versão $VERSION"
echo ""

# ─── Modo CI: dispara o workflow que builda os três sistemas ──────────────────
if [[ "$DO_TAG" -eq 1 ]]; then
	if git rev-parse "v$VERSION" >/dev/null 2>&1; then
		echo "ERRO: a tag v$VERSION já existe. Suba a versão ou apague a tag antiga."
		exit 1
	fi

	# A tag aponta para um commit, não para o que está no disco: fora do
	# package.json/package-lock.json (que o bump acabou de mexer), a árvore
	# precisa estar limpa.
	DIRTY="$(git status --porcelain -- . ':(exclude)package.json' ':(exclude)package-lock.json')"
	if [[ -n "$DIRTY" ]]; then
		echo "ERRO: há mudanças não commitadas:"
		echo "$DIRTY"
		echo ""
		echo "Commite ou descarte antes de criar a tag."
		exit 1
	fi

	if [[ -n "$(git status --porcelain -- package.json package-lock.json)" ]]; then
		echo "==> Commitando o bump de versão..."
		git add package.json package-lock.json
		git commit -m "Release $VERSION" >/dev/null
	fi

	echo "==> Criando e enviando a tag v$VERSION..."
	git tag -a "v$VERSION" -m "vsgo $VERSION"
	git push origin HEAD
	git push origin "v$VERSION"
	echo ""
	echo "✅ Tag enviada. O workflow de release começou a rodar."
	echo "   Acompanhe em: https://github.com/EliasSantiago/vsgo/actions"
	echo ""
	echo "   Ao terminar, os instaladores de Windows, macOS e Linux ficam"
	echo "   anexados à release v$VERSION e também como artifact do workflow."
	exit 0
fi

# ─── Build local ──────────────────────────────────────────────────────────────
if [[ -z "$TARGET" ]]; then
	echo "ERRO: não sei buildar para este sistema ($(uname -s))."
	echo "Use 'bash scripts/release.sh --tag' para gerar tudo pelo GitHub Actions."
	exit 1
fi

if [[ "$TARGET" != "$HOST_TARGET" ]]; then
	echo "AVISO: alvo '$TARGET' diferente do SO desta máquina ('$HOST_TARGET')."
	echo "       O pacote sai com módulos nativos do SO errado. Use --tag."
	echo ""
fi

mkdir -p "$OUT_DIR"

case "$TARGET" in
	linux)
		echo "==> Build Linux (.deb + .tar.gz)..."
		bash "$SCRIPTS/build-linux.sh" $BUILD_ARG --out "$OUT_DIR"
		;;
	win)
		echo "==> Build Windows (instalador .exe)..."
		bash "$SCRIPTS/build-win.sh" $BUILD_ARG --out "$OUT_DIR"
		;;
	mac)
		echo "==> Build macOS (.dmg + .zip)..."
		bash "$SCRIPTS/build-mac.sh" $BUILD_ARG --out "$OUT_DIR"
		;;
esac
echo ""

# ─── Manifesto, checksums e página de download ────────────────────────────────
MANIFEST_ARGS=("$OUT_DIR")
[[ -n "$BASE_URL" ]] && MANIFEST_ARGS+=(--base-url "$BASE_URL")
bash "$SCRIPTS/make-manifest.sh" "${MANIFEST_ARGS[@]}"
echo ""

echo "✅ Release $VERSION concluído para: $TARGET"
echo ""
echo "   Este build cobre só o SO desta máquina. Para gerar Windows + macOS +"
echo "   Linux de uma vez, com os módulos nativos corretos de cada um:"
echo "     bash scripts/release.sh --no-bump --tag"
