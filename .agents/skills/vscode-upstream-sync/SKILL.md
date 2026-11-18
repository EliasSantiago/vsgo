---
name: vscode-upstream-sync
description: "Atualiza o vsgo com uma versão nova do VS Code (microsoft/vscode) via merge da tag estável, sem perder as customizações do vsgo. Use quando o usuário pedir para atualizar/sincronizar o vsgo com o VS Code, puxar as novidades do upstream, trazer a versão 1.x.y da Microsoft, fazer rebase/merge do vscode, ou resolver conflitos de um sync em andamento. Trigger words: 'atualizar com o vscode', 'sync upstream', 'nova versão do vscode', 'merge do vscode', 'puxar atualizações da microsoft', 'conflitos do sync'."
---

# Sync do vsgo com o VS Code (upstream)

O vsgo é um fork do `microsoft/vscode`. A atualização é um **merge da tag estável** do upstream numa branch
`sync/<versão>`, com as regras fixas do vsgo aplicadas por script e os conflitos restantes resolvidos juntando
as duas intenções. Nada chega à `main` sem validação e sem aprovação do usuário.

Arquivos desta skill:
- `scripts/resolve-policy.sh` — resolve os conflitos que têm regra fixa (caminhos removidos, workflows, renomes confusos).
- `scripts/check-invariants.sh` — confere que nada do vsgo sumiu e que nada do upstream foi corrompido.
- `removed-paths.txt` — o que o vsgo removeu de propósito do VS Code (manter atualizado).
- `conflict-rules.md` — como resolver cada conflito à mão (leia antes de resolver; passe para subagentes).
- `HISTORY.md` — registro de cada sync feito (base, tag, decisões). Acrescente uma entrada no fim de cada sync.

## 0. Configuração (uma vez por clone)

```bash
git remote add upstream https://github.com/microsoft/vscode.git
git remote set-url --push upstream DISABLED          # impossível dar push na Microsoft por engano
git config remote.upstream.fetch '+refs/heads/main:refs/remotes/upstream/main'
git config --add remote.upstream.fetch '+refs/heads/release/*:refs/remotes/upstream/release/*'
git config rerere.enabled true                        # o Git lembra cada resolução de conflito
git config rerere.autoUpdate true
git config diff.renameLimit 20000
git config merge.renameLimit 20000
```

O histórico do vsgo já está ligado ao upstream (merge `-s ours` de `7de7ea84561`, feito no sync 1.139.1 — ver
`HISTORY.md`). **Nunca refaça essa ligação.** Confira com `git merge-base main upstream/main` (deve retornar um
commit da Microsoft, não falhar).

## 1. Escolher a versão alvo

```bash
git fetch upstream --tags                              # a 1ª vez baixa ~1 GB; depois é incremental
git tag -l '1.*' --sort=-v:refname | head -5           # tags estáveis da Microsoft (sem "v"; as do vsgo têm "v")
git describe --tags --abbrev=0 --match '1.*' $(git merge-base main upstream/main)   # de qual versão o vsgo está
```

Use sempre a **tag estável mais recente** (`1.X.Y`), nunca `upstream/main`. O VS Code lança versão estável quase
toda semana; um sync a cada 4–6 semanas é um bom ritmo.

Dimensione antes de começar:

```bash
T=1.X.Y; B=$(git merge-base main $T)
git rev-list --count $B..$T                             # commits da Microsoft que vão entrar
LC_ALL=C comm -12 <(git diff --no-renames --name-only $B main | sort) <(git diff --no-renames --name-only $B $T | sort) | grep -vE "$(grep -v '^#' .agents/skills/vscode-upstream-sync/removed-paths.txt | sed '/^$/d' | paste -sd'|')" | wc -l   # arquivos mexidos pelos dois lados
```

## 2. Preparar (backup + branch)

```bash
git switch main && git status --short                  # tem que estar limpo
T=1.X.Y
git tag backup/pre-sync-$T main                        # ponto de retorno
git switch -c sync/$T main
```

## 3. Merge

```bash
git merge --no-commit --no-ff $T
.agents/skills/vscode-upstream-sync/scripts/resolve-policy.sh
```

O script:
1. mantém removido tudo de `removed-paths.txt` (inclusive arquivos que a Microsoft **adicionou** lá dentro);
2. deixa `.github/workflows/` exatamente como no vsgo (só workflows próprios, restritos ao dono);
3. aceita arquivos novos da Microsoft que o Git confundiu com renome de arquivo removido (conflito DU);
4. restaura das árvores originais os pares AU/UA confundidos por conteúdo idêntico (os estágios do índice vêm
   com marcadores misturando os dois arquivos — **nunca use `git checkout --ours/--theirs` nesses casos**).

Depois liste o que sobrou, com tamanho:

```bash
git diff --name-only --diff-filter=U | sort -u | while read f; do echo "$(grep -c '^<<<<<<<' "$f") $f"; done | sort -rn
git status --porcelain | grep -E '^(UD|DU) '           # apagados de um lado e alterados do outro
```

## 4. Resolver os conflitos restantes

Siga `conflict-rules.md`. Resumo: **parta da versão da Microsoft e reaplique a intenção do vsgo**; identidade do
produto sempre do vsgo; não reintroduzir Copilot/GitHub login; em dúvida real, marque
`// vsgo-sync: DECISÃO PENDENTE` e pergunte ao usuário.

Com muitos arquivos, divida em grupos **disjuntos** e resolva em paralelo com subagentes (general-purpose),
cada um com a lista exata de arquivos, o caminho de `conflict-rules.md` e a proibição de rodar comandos git
no repositório inteiro. Divisão que funcionou:
1. build/CI/raiz (`build/`, `eslint.config.js`, `package.json`, `product.json`, `README.md`, `.gitignore`, `.vscode/`, `scripts/`);
2. AI Customization (`contrib/chat/browser/aiCustomization/**`, `*aiCustomizationWorkspaceService*`, `customizationHarnessService`);
3. núcleo do chat (demais `contrib/chat/**`);
4. sessions, autenticação, API, onboarding, localização, extensões.
Peça a cada um um relatório por arquivo + seção "DECISÕES PENDENTES".

`package-lock.json`: não resolver à mão.

```bash
git checkout MERGE_HEAD -- package-lock.json
NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt npm install   # regenera a partir do package.json resolvido
git add package-lock.json
```

Versão: em `package.json`, `version` passa a ser a versão do upstream (`1.X.Y`). O `scripts/release.sh` faz
`npm version patch` a cada release, então os releases do vsgo seguem como `v1.X.(Y+1)`, `v1.X.(Y+2)`…

## 5. Verificar antes de commitar

```bash
git diff --name-only --diff-filter=U                   # tem que estar vazio
.agents/skills/vscode-upstream-sync/scripts/check-invariants.sh   # explicar cada arquivo listado
grep -rn "vsgo-sync: DECISÃO PENDENTE" src build extensions        # levar ao usuário
git diff --stat backup/pre-sync-$T -- src/vs/workbench/contrib/vsgo extensions/agent-chat extensions/agent-pr-review extensions/theme-omni   # código só do vsgo não deve mudar
```

Commit do merge (ainda na branch `sync/$T`):

```bash
git commit -m "Merge VS Code $T into vsgo" -m "<resumo das decisões de conflito>" -m "Co-Authored-By: ..."
```

## 6. Validar

Nesta ordem, corrigindo tudo antes de seguir (commits normais em cima do merge, na mesma branch):

```bash
export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
npm install                                            # dependências novas do upstream
npm run typecheck-client        # (ou compile-check-ts-native, se ainda existir) — tipos de src/
npm run gulp compile-extensions                        # extensões embutidas (agent-chat etc.)
(cd build && npm run typecheck)                        # scripts de build
npm run valid-layers-check
scripts/test.sh --grep "<áreas tocadas>"               # testes das áreas com conflito
```

Depois, rodar o app de verdade (skill `launch`) e testar as funcionalidades do vsgo: chat com agent-chat e
provedores de modelo, abas de histórico do chat, Personalização do Agente (AI Customization), Spec Driven,
medidor de tokens, login desligado com `accountSignIn:false`, tema omni, pt-BR no build empacotado.

## 7. Entregar

1. Mostrar ao usuário: versão antiga → nova, nº de commits do upstream, conflitos resolvidos por área, decisões
   pendentes, resultado da validação.
2. **Só com aprovação:** `git switch main && git merge --ff-only sync/$T` (ou PR `sync/$T` → `main`).
3. `git push origin main` — **nunca `git push --tags`** (enviaria as tags da Microsoft para o origin).
4. Release normal com `scripts/release.sh`.
5. Acrescentar uma entrada em `HISTORY.md` e atualizar `removed-paths.txt`/`conflict-rules.md` com o que se aprendeu.
6. Apagar o backup quando o release estiver estável: `git tag -d backup/pre-sync-$T`.

## Desfazer

```bash
git merge --abort                                      # durante o merge, antes do commit
git switch main && git branch -D sync/$T               # descartar o sync inteiro (main nunca foi tocada)
git reset --hard backup/pre-sync-$T                    # se a main já recebeu o merge e ainda não houve push
```

## Armadilhas conhecidas

- `.claude/skills` e `.claude/CLAUDE.md` são symlinks locais para `.agents/skills` e
  `.github/copilot-instructions.md`; o merge atualiza as instruções do repositório junto com o upstream.
- A detecção de renome confunde arquivos novos com arquivos apagados de conteúdo parecido (ver passo 3).
- A Microsoft adiciona workflows novos com frequência; o script os remove. Se quiser adotar algum, acrescente no
  vsgo com o filtro de dono do repositório (commit 018cc6b5) antes do sync seguinte.
- O upstream troca a versão do Node (`.nvmrc`); o `preinstall` recusa versões antigas. Use a do `.nvmrc`
  (ex.: `export PATH=$HOME/.nvm/versions/node/v24.x/bin:$PATH`). O `release.yml` já lê `.nvmrc`.
- Troca de versão do Electron no upstream afeta os módulos nativos; o build roda em runners nativos (ver release).
- `extensions/mermaid-chat-features/` pode sobrar localmente como saída de build (a Microsoft renomeou a extensão);
  é ignorada pelo git e pode ser apagada.
