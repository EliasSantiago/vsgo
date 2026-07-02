#!/usr/bin/env bash
# Gera o pacote .deb do vsgo para Ubuntu/Debian x64.
# Resultado: ~/vsgo_<versao>_amd64.deb  (instalável com "apt install ./arquivo.deb")
#
# Uso:
#   bash scripts/build-linux.sh                # build padrão (não minificado)
#   bash scripts/build-linux.sh --min          # build de produção (minificado, mais lento/pesado)
#   bash scripts/build-linux.sh --skip-package # só empacota, reaproveita o build anterior

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_ROOT="$(dirname "$REPO_ROOT")"        # pasta pai (onde o gulp escreve vsgo-linux-x64)
ARCH="x64"
DEB_ARCH="amd64"
APP_DIR="$BUILD_ROOT/vsgo-linux-$ARCH"       # saída da task de empacotamento
VSCODE_LINK="$BUILD_ROOT/VSCode-linux-$ARCH" # nome que o gulpfile de deb espera (hardcoded)
DEB_OUT_DIR="$REPO_ROOT/.build/linux/deb/$DEB_ARCH/deb"

export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
# Usa a lista de dependências de referência (curada) em vez do cálculo via
# sysroot/dpkg-shlibdeps, que exige a toolchain de CI da Microsoft.
export VSCODE_USE_REFERENCE_DEPS=1

# Escolhe a task base: não minificada (padrão, mais rápida) ou minificada (produção).
BUILD_TASK="vscode-linux-$ARCH"
SKIP_PACKAGE=0
for arg in "$@"; do
	case "$arg" in
		--min) BUILD_TASK="vscode-linux-$ARCH-min" ;;
		--skip-package) SKIP_PACKAGE=1 ;;
		*) echo "Argumento desconhecido: $arg"; exit 1 ;;
	esac
done

VERSION="$(node -p "require('$REPO_ROOT/package.json').version")"

echo "==> vsgo — build Linux (.deb) x64"
echo "    Repo   : $REPO_ROOT"
echo "    Versão : $VERSION"
echo "    Task   : $BUILD_TASK"
echo "    Saída  : ~/vsgo_${VERSION}-*_amd64.deb"
echo ""

cd "$REPO_ROOT"

# ─── Build da aplicação ───────────────────────────────────────────────────────
if [[ "$SKIP_PACKAGE" -eq 0 ]]; then
	echo "==> [1/3] Gerando aplicação Linux ($BUILD_TASK)..."
	npm run gulp "$BUILD_TASK"
	echo ""
else
	echo "==> [1/3] Build ignorado (--skip-package); reaproveitando $APP_DIR"
	if [[ ! -d "$APP_DIR" ]]; then
		echo "ERRO: build anterior não encontrado em $APP_DIR"
		exit 1
	fi
fi

# ─── Empacotamento .deb ───────────────────────────────────────────────────────
# O gulpfile de deb lê de "../VSCode-linux-x64" (nome fixo), mas a app é gerada
# em "vsgo-linux-x64". Criamos um symlink para compatibilizar.
echo "==> [2/3] Empacotando .deb..."
rm -f "$VSCODE_LINK"
ln -s "$APP_DIR" "$VSCODE_LINK"

# Rodados em invocações separadas: o gulp executa tarefas passadas juntas em
# PARALELO, e o build-deb depende do diretório criado pelo prepare-deb.
npm run gulp "vscode-linux-$ARCH-prepare-deb"
npm run gulp "vscode-linux-$ARCH-build-deb"

rm -f "$VSCODE_LINK"
echo ""

# ─── Cópia do artefato ────────────────────────────────────────────────────────
echo "==> [3/3] Coletando artefato..."
DEB_FILE="$(ls -t "$DEB_OUT_DIR"/*.deb 2>/dev/null | head -1 || true)"
if [[ -z "$DEB_FILE" ]]; then
	echo "ERRO: nenhum .deb encontrado em $DEB_OUT_DIR"
	exit 1
fi
cp -f "$DEB_FILE" "$HOME/"
FINAL="$HOME/$(basename "$DEB_FILE")"
echo ""

echo "✅ Concluído!"
echo "   Arquivo: $FINAL"
echo "   Tamanho: $(du -sh "$FINAL" | cut -f1)"
echo ""
echo "   Instalar/atualizar no Ubuntu:"
echo "     sudo apt install \"$FINAL\""
echo "   (ou: sudo dpkg -i \"$FINAL\")"
