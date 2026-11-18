#!/usr/bin/env bash
# Resolve, durante um merge do upstream, os conflitos que têm regra fixa no vsgo:
#   1. caminhos removidos de propósito (removed-paths.txt) continuam removidos;
#   2. .github/workflows fica exatamente como no vsgo (só workflows próprios,
#      todos restritos ao dono do repositório) — novos workflows da Microsoft saem.
# Não toca em nenhum outro conflito. Rode na raiz do repo com o merge em andamento.
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$(git rev-parse --show-toplevel)"

if ! git rev-parse -q --verify MERGE_HEAD >/dev/null; then
	echo "Nenhum merge em andamento." >&2
	exit 1
fi

echo "== Caminhos removidos pelo vsgo"
grep -v '^\s*#' "$SKILL_DIR/removed-paths.txt" | sed '/^\s*$/d' | while read -r path; do
	count=$(git ls-files -- "$path" | sort -u | wc -l)
	if [ "$count" -gt 0 ]; then
		git rm -rfq --ignore-unmatch -- "$path"
		echo "  removido: $path ($count arquivos)"
	fi
done

echo "== .github/workflows = versão do vsgo"
git ls-files -- .github/workflows | sort -u | while read -r file; do
	if ! git cat-file -e "HEAD:$file" 2>/dev/null; then
		git rm -fq -- "$file"
		echo "  removido (não existe no vsgo): $file"
	fi
done
git checkout HEAD -- .github/workflows
echo "  restaurado a partir do vsgo"

echo "== Arquivos novos do upstream confundidos com renome de arquivo removido"
# Conflito "deleted by us" em arquivo que não existe na base nem no vsgo: a detecção
# de renome pareou um arquivo novo da Microsoft com um arquivo que o vsgo apagou.
BASE=$(git merge-base HEAD MERGE_HEAD)
git status --porcelain | awk '$1=="DU"{print $2}' | while read -r file; do
	if ! git cat-file -e "$BASE:$file" 2>/dev/null && ! git cat-file -e "HEAD:$file" 2>/dev/null; then
		git checkout MERGE_HEAD -- "$file"
		echo "  upstream: $file"
	fi
done

echo "== Pares add/add confundidos com renome (AU/UA)"
# O Git às vezes pareia um arquivo novo do vsgo com um arquivo novo do upstream de mesmo
# conteúdo. Os estágios do índice vêm com marcadores misturando os dois; restaurar das árvores.
git status --porcelain | awk '$1=="AU"||$1=="UA"{print $1" "$2}' | while read -r kind file; do
	if [ "$kind" = "AU" ] && git cat-file -e "HEAD:$file" 2>/dev/null && ! git cat-file -e "MERGE_HEAD:$file" 2>/dev/null; then
		git checkout HEAD -- "$file"
		echo "  vsgo: $file"
	elif [ "$kind" = "UA" ] && git cat-file -e "MERGE_HEAD:$file" 2>/dev/null && ! git cat-file -e "HEAD:$file" 2>/dev/null; then
		git checkout MERGE_HEAD -- "$file"
		echo "  upstream: $file"
	fi
done

echo
echo "== Conflitos restantes"
git diff --name-only --diff-filter=U | sort -u
