#!/usr/bin/env bash
# Gera os artefatos de distribuição do vsgo para macOS:
#   - vsgo-<versao>-darwin-<arch>.dmg   → o que o usuário baixa e arrasta para Applications
#   - vsgo-<versao>-darwin-<arch>.zip   → mesmo app compactado (usado pelo auto-update)
#
# PRECISA rodar no macOS: o .app é assinado com codesign e o .dmg é criado com
# hdiutil, ferramentas que só existem lá. No CI use .github/workflows/release.yml.
#
# A assinatura é ad-hoc (sem conta Apple Developer). Isso é o suficiente para o
# app ABRIR em Apple Silicon, mas o Gatekeeper ainda avisa que o desenvolvedor
# não foi verificado — as instruções para o usuário saem no fim do script.
#
# Uso:
#   bash scripts/build-mac.sh                  # arquitetura desta máquina
#   bash scripts/build-mac.sh --arch x64       # Macs Intel
#   bash scripts/build-mac.sh --arch arm64     # Apple Silicon
#   bash scripts/build-mac.sh --min            # build de produção minificado
#   bash scripts/build-mac.sh --skip-build     # reaproveita o build anterior
#   bash scripts/build-mac.sh --no-dmg         # só o .zip
#   bash scripts/build-mac.sh --no-zip         # só o .dmg
#   bash scripts/build-mac.sh --out DIR        # destino dos arquivos (padrão: ./dist)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_ROOT="$(dirname "$REPO_ROOT")"

if [[ "$(uname -s)" != "Darwin" ]]; then
	echo "ERRO: este script precisa rodar no macOS (SO atual: $(uname -s))."
	echo ""
	echo "Não dá para gerar um pacote macOS a partir do Linux/Windows: os módulos"
	echo "nativos (node-pty, spdlog, sqlite3…) exigem o SDK do Xcode, e o codesign"
	echo "e o hdiutil só existem no macOS."
	echo ""
	echo "Para gerar o .dmg sem ter um Mac, dispare o workflow:"
	echo "  bash scripts/release.sh --tag"
	exit 1
fi

# Arquitetura padrão: a da máquina.
case "$(uname -m)" in
	arm64) ARCH="arm64" ;;
	x86_64) ARCH="x64" ;;
	*) ARCH="arm64" ;;
esac

MINIFIED=0
SKIP_BUILD=0
WANT_DMG=1
WANT_ZIP=1
OUT_DIR="$REPO_ROOT/dist"
while [[ $# -gt 0 ]]; do
	case "$1" in
		--arch) shift; ARCH="$1" ;;
		--min) MINIFIED=1 ;;
		--skip-build) SKIP_BUILD=1 ;;
		--no-dmg) WANT_DMG=0 ;;
		--no-zip) WANT_ZIP=0 ;;
		--out) shift; OUT_DIR="$1" ;;
		*) echo "Argumento desconhecido: $1"; exit 1 ;;
	esac
	shift
done

if [[ "$ARCH" != "arm64" && "$ARCH" != "x64" ]]; then
	echo "ERRO: arquitetura inválida '$ARCH' (use arm64 ou x64)."
	exit 1
fi

BUILD_TASK="vscode-darwin-$ARCH"
[[ "$MINIFIED" -eq 1 ]] && BUILD_TASK="vscode-darwin-$ARCH-min"

cd "$REPO_ROOT"
VERSION="$(node -p "require('./package.json').version")"
APP_NAME="$(node -p "require('./product.json').nameLong").app"
APP_DIR="$BUILD_ROOT/vsgo-darwin-$ARCH"   # deve casar com destinationFolderName do gulpfile.vscode.ts
APP_PATH="$APP_DIR/$APP_NAME"
DMG_FILE="$OUT_DIR/vsgo-${VERSION}-darwin-${ARCH}.dmg"
ZIP_FILE="$OUT_DIR/vsgo-${VERSION}-darwin-${ARCH}.zip"

echo "==> vsgo — build macOS $ARCH"
echo "    Repo    : $REPO_ROOT"
echo "    Versão  : $VERSION"
echo "    Task    : $BUILD_TASK"
echo "    Destino : $OUT_DIR"
echo ""

mkdir -p "$OUT_DIR"

# ─── Build da aplicação ───────────────────────────────────────────────────────
if [[ "$SKIP_BUILD" -eq 0 ]]; then
	echo "==> [1/4] Gerando aplicação macOS ($BUILD_TASK)..."
	npm run gulp "$BUILD_TASK"
	echo ""
else
	echo "==> [1/4] Build ignorado (--skip-build); reaproveitando $APP_DIR"
fi

if [[ ! -d "$APP_PATH" ]]; then
	echo "ERRO: bundle não encontrado em $APP_PATH"
	exit 1
fi

# ─── Assinatura ad-hoc ────────────────────────────────────────────────────────
# Em Apple Silicon o macOS recusa executáveis sem NENHUMA assinatura. A assinatura
# ad-hoc ("-") não exige conta Apple e é o mínimo para o app abrir.
echo "==> [2/4] Assinando o bundle (ad-hoc)..."
codesign --force --deep --sign - "$APP_PATH"
codesign --verify --deep --strict "$APP_PATH" || {
	echo "ERRO: a verificação da assinatura falhou."
	exit 1
}
echo ""

# ─── .zip ─────────────────────────────────────────────────────────────────────
if [[ "$WANT_ZIP" -eq 1 ]]; then
	echo "==> [3/4] Empacotando .zip..."
	rm -f "$ZIP_FILE"
	# ditto preserva symlinks, permissões e a assinatura do bundle — o "zip" comum não.
	ditto -c -k --sequesterRsrc --keepParent "$APP_PATH" "$ZIP_FILE"
	echo ""
else
	echo "==> [3/4] .zip ignorado (--no-zip)"
	ZIP_FILE=""
fi

# ─── .dmg ─────────────────────────────────────────────────────────────────────
if [[ "$WANT_DMG" -eq 1 ]]; then
	echo "==> [4/4] Empacotando .dmg..."
	STAGE_DIR="$(mktemp -d)"
	trap 'rm -rf "$STAGE_DIR"' EXIT
	# O conteúdo do .dmg: o app + um atalho para /Applications, o gesto que o
	# usuário de Mac já conhece (arrastar de um lado para o outro).
	ditto "$APP_PATH" "$STAGE_DIR/$APP_NAME"
	ln -s /Applications "$STAGE_DIR/Applications"

	rm -f "$DMG_FILE"
	hdiutil create \
		-volname "vsgo $VERSION" \
		-srcfolder "$STAGE_DIR" \
		-fs HFS+ \
		-format UDZO \
		-ov \
		"$DMG_FILE" >/dev/null
	rm -rf "$STAGE_DIR"
	trap - EXIT
	echo ""
else
	echo "==> [4/4] .dmg ignorado (--no-dmg)"
	DMG_FILE=""
fi

echo "✅ Concluído!"
[[ -n "$DMG_FILE" ]] && echo "   $(basename "$DMG_FILE")  ($(du -sh "$DMG_FILE" | cut -f1))"
[[ -n "$ZIP_FILE" ]] && echo "   $(basename "$ZIP_FILE")  ($(du -sh "$ZIP_FILE" | cut -f1))"
echo ""
echo "   Como o app não é notarizado pela Apple, na primeira abertura o usuário"
echo "   precisa clicar com o botão direito no vsgo e escolher \"Abrir\", ou rodar:"
echo "     xattr -dr com.apple.quarantine /Applications/$APP_NAME"
