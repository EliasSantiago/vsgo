# Regras para resolver conflitos de um sync com o VS Code

Objetivo: **nenhuma funcionalidade do vsgo se perde** e **o código novo da Microsoft entra inteiro**.
Resolver um conflito é juntar as duas intenções, não escolher um lado.

## Como investigar cada arquivo

Durante o merge, `HEAD` é o vsgo, `MERGE_HEAD` é a tag do upstream e a base é `git merge-base HEAD MERGE_HEAD`.

```bash
BASE=$(git merge-base HEAD MERGE_HEAD)
git diff $BASE HEAD -- <arquivo>          # o que o vsgo mudou (a intenção a preservar)
git log --oneline $BASE..HEAD -- <arquivo> # por que o vsgo mudou (mensagens dos commits)
git diff $BASE MERGE_HEAD -- <arquivo>    # o que a Microsoft mudou
git log --oneline $BASE..MERGE_HEAD -- <arquivo>  # por que a Microsoft mudou
git show HEAD:<arquivo> / git show MERGE_HEAD:<arquivo>  # versões inteiras
```

Arquivo renomeado pela Microsoft: `git log --follow --name-status $BASE..MERGE_HEAD -- <novo-caminho>`.

## Regras

1. **Parta da versão da Microsoft e reaplique a intenção do vsgo por cima.** O upstream muda mais código;
   é mais seguro reaplicar a diferença do vsgo (geralmente pequena) sobre a versão nova.
2. **Mudança do vsgo = intenção, não texto.** Se a Microsoft renomeou, moveu ou refatorou o código que
   o vsgo alterava, reaplique a mesma alteração no lugar novo, com os nomes/APIs novos.
3. **Identidade do produto é sempre do vsgo:** nome, ícones, URLs, `product.json` (nameShort, applicationName,
   dataFolderName, urls, flags como `accountSignIn`, auto-update), marca, textos pt-BR, tema `omni`.
4. **O vsgo não depende do GitHub Copilot.** A extensão `extensions/copilot` foi removida; o chat do vsgo vem
   de `extensions/agent-chat`. Não reintroduza referências à extensão Copilot, a login GitHub obrigatório, a
   entitlement/quota Copilot nem a endpoints `copilot_internal` que o vsgo tinha removido ou desligado.
   O agent host (`src/vs/platform/agentHost`, pacote `@github/copilot` CLI) continua existindo.
5. **Arquivo apagado pela Microsoft que o vsgo alterou (UD):** descubra para onde o código foi
   (`git log --diff-filter=D --name-status $BASE..MERGE_HEAD -- <arquivo>` e o commit seguinte), porte a
   alteração do vsgo para o lugar novo e então `git rm` o arquivo antigo. Se a funcionalidade inteira sumiu
   no upstream, pare e registre como decisão para o usuário.
6. **Imports:** junte os dois conjuntos, sem duplicar e sem deixar import não usado.
7. **CSS:** mantenha as regras novas do upstream e reaplique os valores visuais do vsgo nos seletores
   (ou nos seletores renomeados equivalentes).
8. **Testes:** mantenha os testes novos da Microsoft; ajuste os que o vsgo alterou para o comportamento do vsgo.
9. **`package-lock.json` não se resolve à mão:** pegue a versão do upstream e regenere com `npm install`
   depois de resolver `package.json`.
10. **Na dúvida real (as duas intenções são incompatíveis), não adivinhe:** escolha a opção que preserva o
    vsgo funcionando, deixe um comentário `// vsgo-sync: DECISÃO PENDENTE ...` e registre no relatório.
11. Siga as regras de código do repositório (tabs, aspas, nls, disposables) — veja `.github/copilot-instructions.md`.

## Terminar cada arquivo

- Nenhum `<<<<<<<`, `=======`, `>>>>>>>` pode sobrar.
- `git add <arquivo>` (ou `git rm` para UD) **apenas nos arquivos que você resolveu**.
- Não rode `git checkout`/`git reset`/`git merge`/`git commit`/`git stash` no repositório inteiro.
