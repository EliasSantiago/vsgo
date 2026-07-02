#!/usr/bin/env bash
# Gera uma nova versão (atualização) do vsgo para Ubuntu (.deb) e/ou Windows (.zip).
#
# Ao subir a versão (patch), o dpkg/apt passa a reconhecer o novo .deb como uma
# ATUALIZAÇÃO do que já está instalado. É por isso que este é o script de update.
#
# Uso:
#   bash scripts/release.sh                 # sobe patch e gera Linux + Windows
#   bash scripts/release.sh linux           # só Linux (.deb)
#   bash scripts/release.sh win             # só Windows (.zip)
#   bash scripts/release.sh all --no-bump   # gera ambos SEM mudar a versão
#   bash scripts/release.sh linux --min     # build de produção minificado
#
# Flags:
#   --no-bump   não incrementa a versão do package.json
#   --min       repassa --min aos builds (produção minificada, mais lento/pesado)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPTS="$REPO_ROOT/scripts"
DIST_DIR="$REPO_ROOT/dist"

export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt

TARGET="all"
BUMP=1
BUILD_ARG=""
for arg in "$@"; do
	case "$arg" in
		linux|win|all) TARGET="$arg" ;;
		--no-bump) BUMP=0 ;;
		--min) BUILD_ARG="--min" ;;
		*) echo "Argumento desconhecido: $arg"; exit 1 ;;
	esac
done

cd "$REPO_ROOT"

# ─── Bump de versão ───────────────────────────────────────────────────────────
if [[ "$BUMP" -eq 1 ]]; then
	echo "==> Incrementando versão (patch)..."
	# npm version altera package.json sem criar git tag/commit (--no-git-tag-version).
	npm version patch --no-git-tag-version >/dev/null
fi
VERSION="$(node -p "require('$REPO_ROOT/package.json').version")"
echo "==> vsgo release — versão $VERSION (alvo: $TARGET)"
echo ""

mkdir -p "$DIST_DIR"

# ─── Builds ───────────────────────────────────────────────────────────────────
if [[ "$TARGET" == "linux" || "$TARGET" == "all" ]]; then
	echo "==> Build Linux (.deb)..."
	bash "$SCRIPTS/build-linux.sh" $BUILD_ARG
	cp -f "$HOME"/vsgo_"${VERSION}"-*_amd64.deb "$DIST_DIR/" 2>/dev/null || true
	echo ""
fi

if [[ "$TARGET" == "win" || "$TARGET" == "all" ]]; then
	echo "==> Build Windows (instalador .exe)..."
	bash "$SCRIPTS/build-win.sh" $BUILD_ARG
	cp -f "$HOME/vsgoSetup-x64-${VERSION}.exe" "$DIST_DIR/" 2>/dev/null || true
	echo ""
fi

echo "✅ Release $VERSION concluído!"
echo "   Artefatos em: $DIST_DIR"
ls -lh "$DIST_DIR" | tail -n +2 | awk '{print "     " $9 "  (" $5 ")"}'
