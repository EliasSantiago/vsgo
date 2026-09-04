#!/usr/bin/env bash
# Gera os artefatos de distribuição do vsgo para Linux x64:
#   - vsgo_<versao>-<rev>_amd64.deb    → Ubuntu/Debian ("apt install ./arquivo.deb")
#   - vsgo-<versao>-linux-x64.tar.gz   → portátil, roda em qualquer distro sem instalar
#
# Uso:
#   bash scripts/build-linux.sh                 # .deb + .tar.gz (build rápido)
#   bash scripts/build-linux.sh --min           # build de produção (minificado)
#   bash scripts/build-linux.sh --skip-build    # reaproveita o build anterior
#   bash scripts/build-linux.sh --no-deb        # só o .tar.gz
#   bash scripts/build-linux.sh --no-tar        # só o .deb
#   bash scripts/build-linux.sh --out DIR       # destino dos arquivos (padrão: ./dist)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_ROOT="$(dirname "$REPO_ROOT")"         # pasta pai (onde o gulp escreve vsgo-linux-x64)
ARCH="x64"
DEB_ARCH="amd64"
APP_DIR="$BUILD_ROOT/vsgo-linux-$ARCH"       # saída da task de empacotamento
VSCODE_LINK="$BUILD_ROOT/VSCode-linux-$ARCH" # nome que o gulpfile de deb espera (hardcoded)
DEB_OUT_DIR="$REPO_ROOT/.build/linux/deb/$DEB_ARCH/deb"

[[ -f /etc/ssl/certs/ca-certificates.crt ]] && export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
# Usa a lista de dependências de referência (curada) em vez do cálculo via
# sysroot/dpkg-shlibdeps, que exige a toolchain de CI da Microsoft.
export VSCODE_USE_REFERENCE_DEPS=1

# Escolhe a task base: não minificada (padrão, mais rápida) ou minificada (produção).
BUILD_TASK="vscode-linux-$ARCH"
SKIP_BUILD=0
WANT_DEB=1
WANT_TAR=1
OUT_DIR="$REPO_ROOT/dist"
while [[ $# -gt 0 ]]; do
	case "$1" in
		--min) BUILD_TASK="vscode-linux-$ARCH-min" ;;
		--skip-build|--skip-package) SKIP_BUILD=1 ;;
		--no-deb) WANT_DEB=0 ;;
		--no-tar) WANT_TAR=0 ;;
		--out) shift; OUT_DIR="$1" ;;
		*) echo "Argumento desconhecido: $1"; exit 1 ;;
	esac
	shift
done

if [[ "$(uname -s)" != "Linux" ]]; then
	echo "ERRO: este script precisa rodar no Linux (SO atual: $(uname -s))."
	exit 1
fi

if [[ "$WANT_DEB" -eq 1 ]]; then
	for tool in dpkg-deb fakeroot; do
		command -v "$tool" >/dev/null 2>&1 || {
			echo "ERRO: '$tool' não encontrado. Instale com:"
			echo "  sudo apt update && sudo apt install -y dpkg-dev fakeroot"
			exit 1
		}
	done
fi

cd "$REPO_ROOT"
VERSION="$(node -p "require('./package.json').version")"
TAR_FILE="$OUT_DIR/vsgo-${VERSION}-linux-${ARCH}.tar.gz"

echo "==> vsgo — build Linux x64"
echo "    Repo    : $REPO_ROOT"
echo "    Versão  : $VERSION"
echo "    Task    : $BUILD_TASK"
echo "    Destino : $OUT_DIR"
echo ""

mkdir -p "$OUT_DIR"

# ─── Build da aplicação ───────────────────────────────────────────────────────
if [[ "$SKIP_BUILD" -eq 0 ]]; then
	echo "==> [1/4] Gerando aplicação Linux ($BUILD_TASK)..."
	npm run gulp "$BUILD_TASK"
	echo ""
else
	echo "==> [1/4] Build ignorado (--skip-build); reaproveitando $APP_DIR"
	if [[ ! -d "$APP_DIR" ]]; then
		echo "ERRO: build anterior não encontrado em $APP_DIR"
		exit 1
	fi
fi

# ─── Empacotamento .deb ───────────────────────────────────────────────────────
# O gulpfile de deb lê de "../VSCode-linux-x64" (nome fixo), mas a app é gerada
# em "vsgo-linux-x64". Criamos um symlink para compatibilizar.
if [[ "$WANT_DEB" -eq 1 ]]; then
	echo "==> [2/4] Empacotando .deb..."
	rm -f "$VSCODE_LINK"
	ln -s "$APP_DIR" "$VSCODE_LINK"

	# Rodados em invocações separadas: o gulp executa tarefas passadas juntas em
	# PARALELO, e o build-deb depende do diretório criado pelo prepare-deb.
	npm run gulp "vscode-linux-$ARCH-prepare-deb"
	npm run gulp "vscode-linux-$ARCH-build-deb"

	rm -f "$VSCODE_LINK"

	DEB_FILE="$(ls -t "$DEB_OUT_DIR"/*.deb 2>/dev/null | head -1 || true)"
	if [[ -z "$DEB_FILE" ]]; then
		echo "ERRO: nenhum .deb encontrado em $DEB_OUT_DIR"
		exit 1
	fi
	cp -f "$DEB_FILE" "$OUT_DIR/"
	DEB_FINAL="$OUT_DIR/$(basename "$DEB_FILE")"
	echo ""
else
	echo "==> [2/4] .deb ignorado (--no-deb)"
	DEB_FINAL=""
fi

# ─── Arquivo portátil .tar.gz ─────────────────────────────────────────────────
if [[ "$WANT_TAR" -eq 1 ]]; then
	echo "==> [3/4] Empacotando .tar.gz portátil..."
	rm -f "$TAR_FILE"
	# --owner/--group zerados: o pacote não deve carregar o usuário de quem buildou.
	tar --owner=0 --group=0 -czf "$TAR_FILE" -C "$BUILD_ROOT" "vsgo-linux-$ARCH"
	echo ""
else
	echo "==> [3/4] .tar.gz ignorado (--no-tar)"
	TAR_FILE=""
fi

# ─── Resumo ───────────────────────────────────────────────────────────────────
echo "==> [4/4] Artefatos gerados:"
echo ""
echo "✅ Concluído!"
if [[ -n "$DEB_FINAL" ]]; then
	echo "   $(basename "$DEB_FINAL")  ($(du -sh "$DEB_FINAL" | cut -f1))"
	echo "     instalar: sudo apt install \"$DEB_FINAL\""
fi
if [[ -n "$TAR_FILE" ]]; then
	echo "   $(basename "$TAR_FILE")  ($(du -sh "$TAR_FILE" | cut -f1))"
	echo "     usar: tar -xzf arquivo.tar.gz && ./vsgo-linux-x64/vsgo"
fi
