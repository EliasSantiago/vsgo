#!/usr/bin/env bash
# Durante (ou logo após) um merge do upstream, confere que:
#   - arquivos que só existem no vsgo continuam idênticos ao vsgo;
#   - arquivos que só existem no upstream estão idênticos ao upstream;
#   - não sobrou marcador de conflito em nenhum arquivo rastreado.
# Diferenças listadas não são necessariamente erro (ex.: renome do upstream que levou
# junto uma alteração do vsgo), mas cada uma precisa ser explicada.
# Uso: check-invariants.sh [<ref-vsgo> <ref-upstream>]  (padrão: HEAD MERGE_HEAD)
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OURS=${1:-HEAD}
THEIRS=${2:-MERGE_HEAD}
BASE=$(git merge-base "$OURS" "$THEIRS")
REMOVED=$(grep -v '^\s*#' "$SKILL_DIR/removed-paths.txt" | sed '/^\s*$/d' | sed 's/[.]/\\./g; s/^/^/' | paste -sd'|')

echo "== Arquivos exclusivos do vsgo que mudaram"
git diff --no-renames --name-only --diff-filter=A "$BASE" "$OURS" | while read -r f; do
	git cat-file -e "$THEIRS:$f" 2>/dev/null && continue
	if [ ! -e "$f" ]; then echo "  SUMIU: $f"; continue; fi
	git diff --quiet "$OURS" -- "$f" || echo "  $f"
done

echo "== Arquivos exclusivos do upstream que mudaram"
git diff --no-renames --name-only --diff-filter=A "$BASE" "$THEIRS" | grep -vE "$REMOVED|^\.github/workflows/" | while read -r f; do
	git cat-file -e "$OURS:$f" 2>/dev/null && continue
	if [ ! -e "$f" ]; then echo "  SUMIU: $f"; continue; fi
	git diff --quiet "$THEIRS" -- "$f" || echo "  $f"
done

echo "== Marcadores de conflito"
git grep -lE '^(<<<<<<<|>>>>>>>) ' -- ':!*.md' ':!**/test/**/fixtures/**' || echo "  nenhum"
