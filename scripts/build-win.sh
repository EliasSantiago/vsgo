#!/usr/bin/env bash
# Gera o INSTALADOR único (.exe) do vsgo para Windows x64, via Inno Setup + Wine.
# Resultado: ~/vsgoSetup-x64-<versao>.exe  (instalador de arquivo único)
#
# Requer: wine instalado (ISCC.exe do Inno Setup é executado através dele).
#
# Uso:
#   bash scripts/build-win.sh                # instalador "user" (padrão, sem admin)
#   bash scripts/build-win.sh --system       # instalador "system" (exige admin no Windows)
#   bash scripts/build-win.sh --min          # build de produção minificado
#   bash scripts/build-win.sh --skip-build   # só empacota o instalador, reaproveita o build

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_ROOT="$(dirname "$REPO_ROOT")"
ARCH="x64"
OUT_DIR="$BUILD_ROOT/vsgo-win32-$ARCH"        # saída da task de empacotamento

export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
export WINEDEBUG="${WINEDEBUG:--all}"

BUILD_TASK="vscode-win32-$ARCH"
TARGET="user"
SKIP_BUILD=0
for arg in "$@"; do
	case "$arg" in
		--min) BUILD_TASK="vscode-win32-$ARCH-min" ;;
		--system) TARGET="system" ;;
		--user) TARGET="user" ;;
		--skip-build) SKIP_BUILD=1 ;;
		*) echo "Argumento desconhecido: $arg"; exit 1 ;;
	esac
done

if ! command -v wine >/dev/null 2>&1; then
	echo "ERRO: 'wine' não encontrado. Instale com:"
	echo "  sudo apt update && sudo apt install -y wine"
	echo "(o instalador do Inno Setup só é gerado através do wine)"
	exit 1
fi

VERSION="$(node -p "require('$REPO_ROOT/package.json').version")"
SETUP_DIR="$REPO_ROOT/.build/win32-$ARCH/${TARGET}-setup"
FINAL="$HOME/vsgoSetup-${ARCH}-${VERSION}.exe"

echo "==> vsgo — instalador Windows x64 (.exe) [$TARGET]"
echo "    Repo   : $REPO_ROOT"
echo "    Versão : $VERSION"
echo "    Wine   : $(wine --version 2>/dev/null || echo '?')"
echo "    Saída  : $FINAL"
echo ""

cd "$REPO_ROOT"

# ─── Build da aplicação ───────────────────────────────────────────────────────
if [[ "$SKIP_BUILD" -eq 0 ]]; then
	echo "==> [1/3] Gerando pacote Windows x64 ($BUILD_TASK)..."
	# O passo final (…-ci) pode falhar por falta de wine em alguma ferramenta;
	# ignoramos desde que a pasta de saída tenha sido gerada.
	npm run gulp "$BUILD_TASK" || {
		if [[ ! -d "$OUT_DIR" ]]; then
			echo "ERRO: diretório de saída não encontrado: $OUT_DIR"
			exit 1
		fi
		echo "    (aviso: passo ci falhou — pacote base gerado, seguindo)"
	}
	echo ""
else
	echo "==> [1/3] Build ignorado (--skip-build); reaproveitando $OUT_DIR"
	[[ -d "$OUT_DIR" ]] || { echo "ERRO: build anterior não encontrado em $OUT_DIR"; exit 1; }
fi

# ─── inno_updater (necessário para o instalador) ──────────────────────────────
echo "==> [2/3] Preparando inno_updater e ícone..."
npm run gulp "vscode-win32-$ARCH-inno-updater"
echo ""

# ─── Instalador Inno Setup (via wine) ─────────────────────────────────────────
echo "==> [3/3] Gerando instalador Inno Setup ($TARGET)..."
npm run gulp "vscode-win32-$ARCH-${TARGET}-setup"

SETUP_EXE="$(ls -t "$SETUP_DIR"/*.exe 2>/dev/null | head -1 || true)"
if [[ -z "$SETUP_EXE" ]]; then
	echo "ERRO: instalador não encontrado em $SETUP_DIR"
	exit 1
fi
cp -f "$SETUP_EXE" "$FINAL"
echo ""

echo "✅ Concluído!"
echo "   Instalador: $FINAL"
echo "   Tamanho   : $(du -sh "$FINAL" | cut -f1)"
echo ""
echo "   Distribua o .exe. No Windows, o usuário dá duplo-clique para instalar/atualizar."
