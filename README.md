# vsgo

**vsgo** é uma IDE com IA construída sobre o [Code – OSS](https://github.com/microsoft/vscode),
o núcleo open source do Visual Studio Code. O agente é embutido no editor e roda
com **as suas próprias chaves de API** (BYOK) ou com **modelos locais** — não há
backend proprietário, assinatura mensal nem telemetria de código para servidores
nossos.

> **Projeto independente.** O vsgo não é afiliado à Microsoft, não é endossado por
> ela e não é o Visual Studio Code. É um fork do Code – OSS, distribuído sob a
> mesma licença MIT.

<details>
<summary><b>In English</b></summary>

**vsgo** is an AI-first IDE built on [Code – OSS](https://github.com/microsoft/vscode),
the open source core of Visual Studio Code. It embeds a coding agent that runs on
**your own API keys** (BYOK) or on **local models** — no proprietary backend, no
subscription, and no code telemetry sent to our servers.

Main features: an agentic chat with file/terminal tool calling, parallel agents
isolated in git worktrees, a background review bot, hierarchical project rules,
persistent memory, semantic and call-graph code indexing, and MCP server support.

vsgo is an independent fork of Code – OSS under the MIT license. It is not
affiliated with, endorsed by, or a distribution of Microsoft Visual Studio Code.

</details>

## O que ele faz

- **Agente no editor** — chat agêntico com chamada de ferramentas: lê e escreve
  arquivos, roda comandos no terminal e navega pelo repositório.
- **BYOK, sem intermediário** — Anthropic, OpenAI, Google Gemini, DeepSeek, Groq,
  Mistral, xAI, Ollama e qualquer endpoint compatível com a API da OpenAI. A chave
  fica no cofre de segredos do sistema operacional e a chamada vai direto ao
  provedor.
- **Modelos locais** — detecção de hardware, download e gerenciamento do servidor
  de inferência, para trabalhar sem conexão e sem custo por token.
- **Agents Window** — vários agentes em paralelo, cada um numa branch isolada via
  `git worktree`, sem disputar a sua árvore de trabalho.
- **Bug Bot** — revisão contínua em segundo plano, com os apontamentos como
  comentários inline no código.
- **Regras hierárquicas** — arquivos `.agents/rules/*.md` com frontmatter, aplicados
  por glob, definem o comportamento do agente por pasta e por tipo de arquivo.
- **Memória persistente** — o que o agente aprendeu sobre o projeto sobrevive entre
  sessões, com editor visual.
- **Índice semântico e de grafo** — busca por significado e navegação por grafo de
  chamadas, para o agente achar o código certo em repositório grande.
- **Servidores MCP** — conecta ferramentas externas pelo Model Context Protocol.
- **Split changes into PRs** — quebra a árvore de trabalho em pull requests
  separados, agrupados por feature.
- **Figma** — leitura de design direto do arquivo do Figma.

Por ser um fork do Code – OSS, todo o resto continua: extensões, temas,
depuradores, terminal integrado, Git, remote e o mapeamento de teclado a que você
já está acostumado. A galeria de extensões aponta para o
[Open VSX](https://open-vsx.org).

## Instalação

Baixe o instalador do seu sistema na
[página de releases](https://github.com/EliasSantiago/vsgo/releases/latest).

| Sistema | Arquivo |
|---|---|
| Windows | `vsgoUserSetup-x64-<versão>.exe` — instala sem senha de administrador |
| Ubuntu/Debian | `vsgo_<versão>_amd64.deb` — `sudo apt install ./vsgo_<versão>_amd64.deb` |
| Linux (qualquer distro) | `vsgo-<versão>-linux-x64.tar.gz` — extraia e execute |

O passo a passo detalhado, incluindo como conferir a integridade do download com
`SHA256SUMS.txt`, está em [COMO-INSTALAR.md](scripts/dist-templates/COMO-INSTALAR.md).
A documentação completa fica em [vsgo.orkestrai.com.br](https://vsgo.orkestrai.com.br/docs).

Para atualizar, instale a versão nova por cima: o instalador reconhece a
instalação anterior.

## Primeiros passos

1. Abra a paleta de comandos (`Ctrl+Shift+P`) e rode **Agent Chat: Add API Key...**
   para cadastrar a chave do provedor que você usa.
2. Sem chave? Rode **Agent Chat: Gerenciar Modelos Locais** e baixe um modelo para
   rodar na sua máquina.
3. Descreva a tarefa no chat. O agente lê o repositório, propõe as mudanças e pede
   confirmação antes de escrever arquivos ou rodar comandos.

Para ajustar o comportamento do agente no seu projeto, crie
`.agents/rules/<nome>.md`:

```markdown
---
description: Idioma padrão
alwaysApply: true
---
Responda em português brasileiro.
```

## Compilando a partir do código-fonte

Requer **Node.js 22.22.1** (veja [`.nvmrc`](.nvmrc)) e as dependências nativas de
build da sua plataforma.

```bash
git clone https://github.com/EliasSantiago/vsgo.git
cd vsgo
npm ci
node build/lib/builtInExtensions.ts
```

Para rodar em modo desenvolvimento:

```bash
bash scripts/dev.sh
```

Para gerar os instaladores:

```bash
bash scripts/build-linux.sh --min     # .deb + .tar.gz
bash scripts/build-win.sh --min --all # .exe (rode no Windows)
```

Cada pacote precisa ser compilado **no seu próprio sistema operacional**: os
módulos nativos (`node-pty`, `spdlog`, `sqlite3`, `native-keymap`,
`@parcel/watcher`) não cruzam de um SO para outro. O caminho normal de publicação
é o GitHub Actions — veja
[`.github/workflows/release.yml`](.github/workflows/release.yml).

## Contribuindo

Issues e pull requests são bem-vindos em
[github.com/EliasSantiago/vsgo](https://github.com/EliasSantiago/vsgo).
Toda contribuição externa passa por revisão de um mantenedor antes do merge.

Reporte problemas em [Issues](https://github.com/EliasSantiago/vsgo/issues/new).
Para questões de segurança, veja [SECURITY.md](SECURITY.md).

## Privacidade

O vsgo não coleta telemetria para servidores do projeto. O seu código só sai da
máquina quando você usa um provedor de IA remoto — e vai direto para o provedor
que você configurou, com a sua chave. Usando modelos locais, nada sai da máquina.

Detalhes na [Política de Privacidade](https://vsgo.orkestrai.com.br/privacidade) e nos
[Termos de Uso](https://vsgo.orkestrai.com.br/termos).

## Licença

[MIT](LICENSE.txt).

Este projeto deriva do [Code – OSS](https://github.com/microsoft/vscode) da
Microsoft Corporation, também sob licença MIT. O aviso de copyright original está
preservado em [LICENSE.txt](LICENSE.txt).

"Visual Studio Code" e "Microsoft" são marcas da Microsoft Corporation. O vsgo não
usa essas marcas na sua identidade nem se apresenta como produto da Microsoft.
