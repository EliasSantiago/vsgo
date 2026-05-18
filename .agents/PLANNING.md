# Planejamento — IDE com IA (fork de VS Code)

> Documento vivo. Última atualização: 2026-05-15.
> Fonte: análise comparativa Cursor 3.0 (abr/2026) e 3.3 (mai/2026) + diagnóstico do código atual.

## Visão

Transformar este fork de VS Code em uma IDE com IA BYOK competitiva com Cursor, sem depender de backend proprietário. Aproveitar `vs/sessions/`, `extensions/agent-chat/` e a infra nativa do VS Code (CommentController, InlineEditsView, IGitService, vscode-pull-request-github).

## Base atual (confirmado por diagnóstico)

- `vs/sessions/` já tem `agentHostSessionsProvider` + sessões persistentes
- `extensions/agent-chat/` tem loop agêntico de 12 turns com tool calling (read/write/list/run_command)
- BYOK funciona via `vscode.lm.registerLanguageModelChatProvider` (Anthropic, OpenAI, Gemini, Ollama)
- **`AGENTS.md` NÃO é lido** — SYSTEM_PROMPT está hardcoded em `chatHandler.ts`
- Multimodal: `LanguageModelImagePart` existe na infra do VS Code mas agent-chat não usa
- `InlineEditsView` + `CommentController` prontos para reuso
- `vscode-pull-request-github` bundled em `extensions/github/`
- Worktree git: sem API formal — `git worktree add` via `run_command`

## Features (9 totais)

### 🥇 Alta prioridade
1. **Agents Window com worktrees** — múltiplos agentes em branches isoladas
2. **Build in Parallel** — agente principal decompõe plano em DAG, subagentes async
3. **Rules hierárquicas** (`.agents/rules/*.md` com frontmatter)
4. **Bug Bot em background** — review contínuo, comentários inline
5. **PR Review embutido** — abas Reviews/Commits/Changes + AI assist

### 🥈 Média prioridade
6. **Chat multimodal** — drag-and-drop de imagem/PDF
7. **Memória persistente UI** — editor visual para `.claude/memory/`
8. **Split changes into PRs** — quick action que agrupa por feature
9. **Multi-folder workspace context** — agente enxerga todas as raízes

## Dependências

```
3 (Rules) ──┬─► 1 (Agents Window) ──► 2 (Build in Parallel)
            │                       └─► 8 (Split PRs)
            └─► 4 (Bug Bot)
6 (Multimodal) ─ independente
7 (Memória UI) ─ independente
9 (Multi-root) ─► melhora qualidade de 1, 2, 4
5 (PR Review)  ─ paralelo (usa comments infra)
```

## Cronograma (5 ondas, ~6 semanas)

| Onda | Features | Esforço | Prazo |
|---|---|---|---|
| 1 — Fundação | 3, 6, 7, 9 | 4 dias | sprint 1 |
| 2 — Agents Window v1 | 1 | 7-8 dias | sprints 2-3 |
| 3 — Paralelismo | 2 | 5 dias | sprint 4 |
| 4 — Qualidade contínua | 4 | 5 dias | sprint 5 |
| 5 — Colaboração | 5, 8 | 8 dias | sprints 6-7 |

## Marcos demonstráveis

- **Semana 1**: drag de imagem no chat + rules/AGENTS.md carregando + Memória UI
- **Semana 2**: esqueleto do Agents Window aberto, multi-root context
- **Semana 3-4**: 3 agentes paralelos em worktrees, HITL gate funcionando
- **Semana 5**: Build in Parallel: 1 prompt → 3 subagentes em paralelo
- **Semana 6**: Bug Bot opinando + 1ª versão de PR Review

---

## Onda 1 — Fundação

### Feature 3 — Rules hierárquicas `.agents/rules/`

**Objetivo:** substituir SYSTEM_PROMPT hardcoded por loader de regras com glob match e frontmatter.

**Arquivos:**
- `extensions/agent-chat/src/rules/types.ts` (novo)
- `extensions/agent-chat/src/rules/rulesLoader.ts` (novo)
- `extensions/agent-chat/src/chatHandler.ts` (editar)
- `extensions/agent-chat/src/commands.ts` (editar — comando reload)
- `extensions/agent-chat/src/extension.ts` (editar — instanciar loader)
- `extensions/agent-chat/package.json` (editar — registrar comando)

**Formato `.agents/rules/<nome>.md`:**
```markdown
---
description: Regras para arquivos Python
globs: ["**/*.py", "**/*.pyi"]
alwaysApply: false
---
- Use type hints sempre.
- Prefira pathlib sobre os.path.
```

**Tarefas:**
1. Parser de frontmatter mínimo (sem deps externas)
2. Glob → regex local (~15 linhas)
3. Loader + cache + file watcher em `.agents/rules/**/*.md`
4. Builder do system prompt: SYSTEM_PROMPT base + AGENTS.md + alwaysApply + matched-by-active-file
5. Comando "Agent Chat: Reload Rules"

**Critério de aceite:** com `.agents/rules/python.md` apontando globs Python, ao mandar prompt com `.py` ativo, regras aparecem no system; com `.ts` ativo, não aparecem.

**Esforço:** 🟢 1-1.5 dias

### Feature 6 — Chat multimodal

**Objetivo:** anexar imagem/PDF ao chat; agente vê.

**Arquivos:**
- `extensions/agent-chat/src/chatHandler.ts` (editar — processar references como image parts)
- `extensions/agent-chat/src/providers/anthropic.ts` (editar — mapear image part para `source.base64`)
- `extensions/agent-chat/src/providers/openai.ts` (editar — `image_url`)
- `extensions/agent-chat/src/providers/gemini.ts` (editar — `inline_data`)

**Tarefas:**
1. Detectar attachments em `vscode.ChatRequest.references`
2. Ler arquivo → base64 + mime
3. PDF: base64 nativo para Anthropic/Gemini; fallback texto para OpenAI
4. Limite de tamanho com mensagem clara

**Critério de aceite:** drag de PNG no chat, agente comenta sobre conteúdo.

**Esforço:** 🟢 1 dia

### Feature 9 — Multi-folder workspace context

**Objetivo:** agente enxerga todas as roots, não só a primeira.

**Arquivos:**
- `extensions/agent-chat/src/tools.ts` (editar — resolver paths em multi-root)
- `extensions/agent-chat/src/chatHandler.ts` (editar — incluir lista de roots no prompt)

**Tarefas:**
1. Expor `workspace.workspaceFolders` no prompt inicial
2. Tools resolvem paths ambíguos com hint de folder
3. Mensagem clara quando há ambiguidade

**Critério de aceite:** workspace com 2 roots; agente lê arquivo do segundo root sem qualificar manualmente.

**Esforço:** 🟢 0.5 dia

### Feature 7 — Memória persistente UI

**Objetivo:** editor visual para `.claude/memory/MEMORY.md` e arquivos linkados.

**Arquivos:**
- `extensions/agent-chat/src/memory/memoryEditor.ts` (novo — webview view container)
- `extensions/agent-chat/media/memory.html` (novo)
- `extensions/agent-chat/package.json` (editar — view container)

**Tarefas:**
1. Listar entradas do MEMORY.md (parse markdown)
2. Editor textarea com save direto
3. Botão "Forget" remove arquivo + linha do índice
4. Activity bar entry no chat

**Critério de aceite:** abrir view → ver memórias atuais → editar uma → arquivo no disco atualizado.

**Esforço:** 🟢 1.5 dias

---

## Onda 2 — Agents Window v1

### Feature 1 — Agents Window com worktrees

**Objetivo:** painel mostrando múltiplas sessões de agente, cada uma em worktree própria.

**Arquivos:**
- `src/vs/sessions/contrib/agentHost/` (estender provider)
- `src/vs/sessions/contrib/agentsWindow/agentsWindowView.ts` (novo)
- `src/vs/sessions/contrib/agentsWindow/worktreeService.ts` (novo)
- `src/vs/sessions/contrib/agentsWindow/agentSession.ts` (novo)

**Tarefas (em ordem):**
1. **Schema da sessão** (0.5d): `IAgentSession`, persistência em `IStorageService`
2. **WorktreeService** (1d): `create/remove/list` via Bash. Convenção `~/.agent-worktrees/<repo>/<session-id>`
3. **AgentSession runtime** (1.5d): chat instance per session com `workspaceFolder` override
4. **TreeView** (1.5d): sidebar cards com nome, branch, status, diff summary
5. **Promote to foreground** (1d): troca workspace ativo
6. **HITL gate** (1d): deny-list em run_command (rm, git push, npm install, sudo) com confirmação UI
7. **Polish** (1.5d): status bar indicator, notificações, ícones

**Critério de aceite:** "New Agent" → escolho task → cria worktree → agente roda → vejo progresso → posso promover ou descartar; 3 agentes simultâneos; `git push` exige confirmação.

**Esforço:** 🔴 7-8 dias

**Riscos:**
- Hooks customizados em repo podem quebrar worktree
- Performance com 8 agentes paralelos (memória do extension host)

---

## Onda 3 — Paralelismo

### Feature 2 — Build in Parallel

**Objetivo:** agente principal emite plano JSON com DAG, runner dispara subagentes nos nós independentes.

**Arquivos:**
- `extensions/agent-chat/src/planner/planSchema.ts` (novo)
- `extensions/agent-chat/src/planner/planRunner.ts` (novo)
- `extensions/agent-chat/src/chatHandler.ts` (editar — tool `submit_plan`)

**Tarefas:**
1. **Schema do plano** (0.5d): `{ nodes: [{id, description, dependsOn, files}] }`
2. **Prompt de planning** (1d): modo "plan-then-do"
3. **Runner topológico** (1.5d): frontier, dispara subagentes em paralelo
4. **Merge de resultados** (1d): worktrees ou writes sequenciais
5. **UI de plano** (1d): TreeView com status por nó

**Critério de aceite:** "implemente login com email e password" → plano com 4 nós (UI/hash/endpoint/test) → 3 primeiros em paralelo, teste depois.

**Esforço:** 🟡 5 dias

**Dependência:** Feature 1

---

## Onda 4 — Qualidade contínua

### Feature 4 — Bug Bot

**Objetivo:** review contínuo em background, comentários inline com fix sugerido.

**Arquivos:**
- `extensions/agent-chat/src/bugBot/bugBotService.ts` (novo)
- `extensions/agent-chat/src/bugBot/bugBotProvider.ts` (novo — CommentController)
- `extensions/agent-chat/package.json` (editar — setting `agent-chat.bugBot.enabled`)

**Tarefas:**
1. **Watcher** (0.5d): `onDidChangeActiveTextEditor` + `onDidChangeTextDocument` com debounce 3s
2. **Filtros** (0.5d): skip binários, > 500 linhas (chunk), node_modules, .git
3. **Prompt focado** (1d): arquivo + linhas mudadas → modelo rápido (Haiku/Flash/4o-mini); saída JSON `[{line, severity, message, fix?}]`
4. **Comments inline** (1.5d): `CommentController("bugBot")` + ação "Apply Fix"
5. **Apply Fix** (1d): `WorkspaceEdit`
6. **Throttle / cost guard** (0.5d): limite N req/min, indicador de gasto

**Critério de aceite:** edito função com bug clássico → após 3s aparece comment inline → "Apply Fix" corrige.

**Esforço:** 🟡 5 dias

---

## Onda 5 — Colaboração

### Feature 5 — PR Review embutido

**Objetivo:** abas Reviews/Commits/Changes + AI assist no diff.

**Arquivos:**
- `extensions/github/` (fork/estender ou wrap)
- `src/vs/sessions/contrib/codeReview/aiAssist.ts` (novo)

**Tarefas:**
1. **PR Detail view** (2d): reusar UI da extensão GitHub PR
2. **AI suggest review** (2d): diff → BYOK → comentários por arquivo como rascunho
3. **Inline AI fix** (1d): "Generate fix" gera suggestion block

**Critério de aceite:** abrir PR → ver 3 abas → "AI Review" → comentários como rascunho editável.

**Esforço:** 🔴 5 dias

**Risco maior:** investigar viabilidade de extensão vs fork antes de prometer escopo.

### Feature 8 — Split changes into PRs

**Objetivo:** working tree → N branches/PRs por feature.

**Arquivos:**
- `extensions/agent-chat/src/splitPR/splitService.ts` (novo)
- `extensions/agent-chat/src/splitPR/groupClassifier.ts` (novo)

**Tarefas:**
1. **Coleta** (0.5d): `IGitService` ou `git status`
2. **Agrupamento** (1.5d): LLM agrupa por feature
3. **UI** (1d): QuickPick multi-select com grupos sugeridos
4. **Execução** (1d): cria branches, commits, `gh pr create`

**Critério de aceite:** working tree com 12 arquivos (3 features misturadas) → comando "Split into PRs" → 3 PRs.

**Esforço:** 🟡 3 dias

---

## Status

| # | Feature | Status |
|---|---|---|
| 3 | Rules hierárquicas | ✅ concluída (2026-05-15) |
| 6 | Chat multimodal | ✅ concluída (2026-05-15) |
| 9 | Multi-folder context | ✅ concluída (2026-05-15) |
| 7 | Memória UI | ✅ concluída (2026-05-15) |
| 1 | Agents Window | ✅ v1 concluída (2026-05-15) — falta "Stop" para futuro com background agents |
| 2 | Build in Parallel | ✅ concluída (2026-05-15) |
| 4 | Bug Bot | ✅ concluída (2026-05-15) |
| 5 | PR Review | ✅ v1 concluída (2026-05-15) — extensão agent-pr-review com AI Review inline; webview rica fica para v2 |
| 8 | Split PRs | ✅ concluída (2026-05-15) |
