#!/usr/bin/env bash
# Gera o INSTALADOR (.exe) do vsgo para Windows x64, via Inno Setup.
#
#   vsgoUserSetup-x64-<versao>.exe    → instalação por usuário, NÃO pede admin (padrão)
#   vsgoSystemSetup-x64-<versao>.exe  → instalação para todos os usuários, pede admin
#
# O usuário final baixa o .exe, dá duplo-clique e instala — igual ao VS Code.
#
# ATENÇÃO: rode este script NO WINDOWS (Git Bash) ou pelo GitHub Actions.
# Os módulos nativos (terminal, log, storage, file watcher) são compilados para o
# SO da máquina que builda; um pacote Windows gerado no Linux sai com binários
# ELF e esses recursos quebram. Ver .github/workflows/release.yml.
#
# Uso:
#   bash scripts/build-win.sh                 # instalador de usuário (padrão)
#   bash scripts/build-win.sh --system        # instalador de sistema (admin)
#   bash scripts/build-win.sh --all           # os dois instaladores
#   bash scripts/build-win.sh --min           # build de produção minificado
#   bash scripts/build-win.sh --skip-build    # só empacota, reaproveita o build
#   bash scripts/build-win.sh --out DIR       # destino dos arquivos (padrão: ./dist)
#   bash scripts/build-win.sh --force-cross   # permite cross-build no Linux (via wine)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_ROOT="$(dirname "$REPO_ROOT")"
ARCH="x64"
APP_DIR="$BUILD_ROOT/vsgo-win32-$ARCH"        # saída da task de empacotamento

[[ -f /etc/ssl/certs/ca-certificates.crt ]] && export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
export WINEDEBUG="${WINEDEBUG:--all}"

BUILD_TASK="vscode-win32-$ARCH"
TARGETS=("user")
SKIP_BUILD=0
FORCE_CROSS=0
OUT_DIR="$REPO_ROOT/dist"
while [[ $# -gt 0 ]]; do
	case "$1" in
		--min) BUILD_TASK="vscode-win32-$ARCH-min" ;;
		--system) TARGETS=("system") ;;
		--user) TARGETS=("user") ;;
		--all|--both) TARGETS=("user" "system") ;;
		--skip-build) SKIP_BUILD=1 ;;
		--force-cross) FORCE_CROSS=1 ;;
		--out) shift; OUT_DIR="$1" ;;
		*) echo "Argumento desconhecido: $1"; exit 1 ;;
	esac
	shift
done

# ─── Sanidade da plataforma ───────────────────────────────────────────────────
IS_WINDOWS=0
case "$(uname -s)" in
	MINGW*|MSYS*|CYGWIN*) IS_WINDOWS=1 ;;
esac

if [[ "$IS_WINDOWS" -eq 0 ]]; then
	echo "─────────────────────────────────────────────────────────────────────"
	echo "ATENÇÃO: você está gerando um pacote Windows fora do Windows."
	echo ""
	echo "Os módulos nativos (node-pty, spdlog, sqlite3, native-keymap,"
	echo "@parcel/watcher…) são compilados para o SO desta máquina. O instalador"
	echo "resultante leva binários Linux dentro e, no Windows, o terminal"
	echo "integrado, os logs, o storage e o file watcher NÃO funcionam."
	echo ""
	echo "Para gerar um instalador correto:"
	echo "  - rode este script no Windows (Git Bash), ou"
	echo "  - dispare o workflow: bash scripts/release.sh --tag"
	echo "─────────────────────────────────────────────────────────────────────"
	if [[ "$FORCE_CROSS" -eq 0 ]]; then
		echo "Abortado. Use --force-cross se quiser mesmo um build de teste."
		exit 1
	fi
	echo "Prosseguindo por causa de --force-cross (build de TESTE, não distribua)."
	echo ""

	if ! command -v wine >/dev/null 2>&1; then
		echo "ERRO: 'wine' não encontrado. Instale com:"
		echo "  sudo apt update && sudo apt install -y wine"
		echo "(fora do Windows, o Inno Setup só roda através do wine)"
		exit 1
	fi
fi

cd "$REPO_ROOT"
# Caminho relativo de propósito: no Git Bash do Windows o $REPO_ROOT sai no
# formato MSYS (/d/a/...), que o require() do Node não resolve.
VERSION="$(node -p "require('./package.json').version")"

echo "==> vsgo — instalador Windows $ARCH (.exe)"
echo "    Repo    : $REPO_ROOT"
echo "    Versão  : $VERSION"
echo "    Alvos   : ${TARGETS[*]}"
echo "    Destino : $OUT_DIR"
echo ""

mkdir -p "$OUT_DIR"

# ─── Build da aplicação ───────────────────────────────────────────────────────
if [[ "$SKIP_BUILD" -eq 0 ]]; then
	echo "==> [1/3] Gerando pacote Windows $ARCH ($BUILD_TASK)..."
	# O passo final (…-ci) pode falhar por falta de alguma ferramenta;
	# seguimos desde que a pasta de saída tenha sido gerada.
	npm run gulp "$BUILD_TASK" || {
		if [[ ! -d "$APP_DIR" ]]; then
			echo "ERRO: diretório de saída não encontrado: $APP_DIR"
			exit 1
		fi
		echo "    (aviso: passo ci falhou — pacote base gerado, seguindo)"
	}
	echo ""
else
	echo "==> [1/3] Build ignorado (--skip-build); reaproveitando $APP_DIR"
	[[ -d "$APP_DIR" ]] || { echo "ERRO: build anterior não encontrado em $APP_DIR"; exit 1; }
fi

# ─── inno_updater (necessário para o instalador) ──────────────────────────────
echo "==> [2/3] Preparando inno_updater e ícone..."
npm run gulp "vscode-win32-$ARCH-inno-updater"
echo ""

# ─── Instaladores Inno Setup ──────────────────────────────────────────────────
echo "==> [3/3] Gerando instalador(es) Inno Setup..."
GENERATED=()
for target in "${TARGETS[@]}"; do
	echo "    → $target setup"
	npm run gulp "vscode-win32-$ARCH-${target}-setup"

	SETUP_DIR="$REPO_ROOT/.build/win32-$ARCH/${target}-setup"
	SETUP_EXE="$(ls -t "$SETUP_DIR"/*.exe 2>/dev/null | head -1 || true)"
	if [[ -z "$SETUP_EXE" ]]; then
		echo "ERRO: instalador não encontrado em $SETUP_DIR"
		exit 1
	fi

	case "$target" in
		user) FINAL="$OUT_DIR/vsgoUserSetup-${ARCH}-${VERSION}.exe" ;;
		system) FINAL="$OUT_DIR/vsgoSystemSetup-${ARCH}-${VERSION}.exe" ;;
	esac
	cp -f "$SETUP_EXE" "$FINAL"
	GENERATED+=("$FINAL")
done
echo ""

echo "✅ Concluído!"
for f in "${GENERATED[@]}"; do
	echo "   $(basename "$f")  ($(du -sh "$f" | cut -f1))"
done
echo ""
echo "   O usuário baixa o .exe e dá duplo-clique. O instalador de USUÁRIO"
echo "   (vsgoUserSetup) não pede senha de administrador e é o recomendado."
