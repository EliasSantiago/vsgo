/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Conteúdo dos arquivos gerados pelo scaffolding de Spec Driven Development (SDD).
 * Todos os modelos são em branco (placeholders) e escritos em português do Brasil (pt-BR).
 * Tecnologia só aparece no plan.md; a spec descreve apenas o "o quê" e o "por quê".
 */

export const CONSTITUTION_CONTENT = `# Constituição do Projeto

> Princípios não-negociáveis que governam como este projeto é especificado, planejado e construído.
> Este documento já vem preenchido com um padrão de referência. Ajuste-o à realidade do seu produto;
> alterações seguem governança por **semver** (ver seção final).

**Versão:** 1.0.0
**Status:** Vigente
**Última atualização:** 2026-01-01

## Princípios não-negociáveis

1. **Spec antes de código.** Nenhuma linha de implementação começa sem uma \`spec.md\` com **Status: Aprovada**. A spec é a fonte da verdade; código que diverge dela é defeito, não decisão.
2. **Spec livre de implementação.** A spec descreve **o quê** e **o porquê**, nunca o **como**. Nomes de bibliotecas, frameworks, esquemas de banco e endpoints vivem exclusivamente no \`plan.md\`.
3. **Testes orientam a implementação.** Cada critério de aceitação (Given/When/Then) vira um teste **antes** do código que o satisfaz. Um RF sem teste correspondente é considerado incompleto.
4. **Tipagem estrita.** Sem tipos implícitos, \`any\` ou escapatórias equivalentes. O domínio é fortemente tipado e os limites do sistema validam suas entradas.
5. **Domínio isolado de frameworks/infra.** Regras de negócio não importam frameworks, drivers de banco ou detalhes de transporte. Infraestrutura depende do domínio, nunca o contrário.
6. **Simplicidade / YAGNI.** Construa o que a spec pede e nada além. Generalizações e abstrações só entram quando há um segundo caso de uso real, não antecipado.
7. **Privacidade por padrão.** Coleta-se o mínimo de dados pessoais necessário, com proteção em repouso e em trânsito. Nada é exposto, logado ou compartilhado sem necessidade explícita registrada na spec.

## Restrições técnicas

- Toda mudança entra por revisão de código com pelo menos uma aprovação.
- A suíte de testes e o type-check devem passar antes do merge na branch principal.
- Sem segredos versionados no repositório; configuração sensível vem de variáveis de ambiente ou cofre.
- Compatibilidade e versões mínimas de runtime são definidas no \`plan.md\` de cada spec e mantidas estáveis dentro de uma MAJOR.

## Papéis do produto

- **Product Owner** — prioriza o backlog e é quem aprova a \`spec.md\` (muda Status para Aprovada).
- **Tech Lead** — valida o \`plan.md\` contra esta constituição e aprova o início da implementação.
- **Equipe de desenvolvimento** — escreve testes e código a partir das \`tasks.md\`, mantendo a rastreabilidade.

## Processo

- Toda dúvida vira \`[NEEDS CLARIFICATION: ...]\` na spec e deve ser resolvida **antes** de aprová-la.
- Só escreva \`plan.md\` depois da spec **Aprovada**; só escreva código depois de spec **e** plan aprovados.
- Mantenha tecnologia somente no \`plan.md\`.
- Cada arquivo tem campo **Status**; mantenha rastreabilidade **RF → critérios → tarefas → testes**.
- Numere specs como \`NNN-slug\` e declare dependências entre elas.

## Governança (semver)

- **MAJOR** — remoção ou redefinição de um princípio não-negociável.
- **MINOR** — adição de princípio, papel ou restrição.
- **PATCH** — esclarecimentos e correções sem mudança de regra.
`;

export const SPEC_TEMPLATE_CONTENT = `# Spec: NNN-slug — _(título)_

**Status:** Rascunho _(Rascunho · Em revisão · Aprovada)_
**Depende de:** _(NNN-slug de outras specs, ou "nenhuma")_

> O quê e por quê — **sem tecnologia**. Qualquer dúvida vira \`[NEEDS CLARIFICATION: ...]\`.

## Resumo
_(Uma a três frases descrevendo o domínio.)_

## Problema e objetivo
_(Qual problema é resolvido e qual resultado se espera.)_

## Papéis
_(Quem interage com esta funcionalidade.)_

## Histórias de usuário
- Como _(papel)_, quero _(ação)_, para que _(benefício)_.

## Requisitos funcionais (RF)
- **RF-001:** _(comportamento observável)_

## Requisitos não-funcionais (RNF)
- **RNF-001:** _(desempenho, segurança, privacidade, disponibilidade, usabilidade...)_

## Regras de negócio (RN)
- **RN-001:** _(invariante ou política do domínio)_

## Critérios de aceitação (Given/When/Then)
- **CA-001** (cobre RF-001):
  - **Dado** _(pré-condição)_
  - **Quando** _(ação)_
  - **Então** _(resultado esperado)_

## Fora de escopo
- _(O que esta spec deliberadamente não cobre.)_

## Dependências
- _(Specs, sistemas ou decisões externas das quais esta depende.)_

## Questões em aberto
- \`[NEEDS CLARIFICATION: ...]\`
`;

export const PLAN_TEMPLATE_CONTENT = `# Plan: NNN-slug — _(título)_

**Status:** Rascunho _(Rascunho · Em revisão · Aprovado)_
**Spec:** ./spec.md _(deve estar Aprovada antes de preencher este plano)_

> Como — decisões técnicas. Só preencher após a spec ser Aprovada.

## Checklist de conformidade com a constituição
- [ ] Spec correspondente está Aprovada e livre de implementação
- [ ] Critérios de aceitação mapeados para testes
- [ ] Tipagem estrita
- [ ] Domínio isolado de frameworks/infra
- [ ] Simplicidade / YAGNI respeitados
- [ ] Privacidade por padrão considerada

## Abordagem / arquitetura
_(Visão geral da solução técnica. Diagrama ASCII/Mermaid se ajudar.)_

## Modelo de dados
_(Entidades, atributos e relacionamentos.)_

## Contratos / API
_(Endpoints, mensagens ou interfaces públicas e seus formatos.)_

## Componentes de frontend
_(Telas, componentes e estados — se aplicável.)_

## Decisões e alternativas
- **Decisão:** _(escolha)_ — **Alternativas consideradas:** _(...)_ — **Motivo:** _(...)_

## Riscos e mitigações
- **Risco:** _(...)_ — **Mitigação:** _(...)_

## Estratégia de testes
_(Unidade, integração, e2e; quais critérios de aceitação cada nível cobre.)_
`;

export const TASKS_TEMPLATE_CONTENT = `# Tasks: NNN-slug — _(título)_

**Status:** Rascunho _(Rascunho · Em andamento · Concluído)_
**Spec:** ./spec.md · **Plan:** ./plan.md

> Tarefas \`Tnnn\`. Marque \`[P]\` quando puderem rodar em paralelo. Referencie o RF/critério coberto.

## Fase 1 — Preparação
- [ ] **T001** _(descrição)_ — _(ref: —)_

## Fase 2 — Domínio / dados
- [ ] **T010** _(descrição)_ — _(ref: RF-001)_

## Fase 3 — Backend / API
- [ ] **T020** _(descrição)_ — _(ref: RF-001)_

## Fase 4 — Frontend
- [ ] **T030 [P]** _(descrição)_ — _(ref: RF-001)_

## Fase 5 — Testes
- [ ] **T040** _(teste que cobre CA-001)_ — _(ref: CA-001)_

## Fase 6 — Finalização
- [ ] **T050** _(documentação, revisão, release)_ — _(ref: —)_
`;

export const SPECS_README_CONTENT = `# Specs

Uma pasta \`NNN-slug\` por domínio (ex.: \`001-autenticacao\`, \`002-pagamentos\`).
Cada pasta contém \`spec.md\`, \`plan.md\` e \`tasks.md\`.

Fluxo: escreva e aprove a \`spec.md\` → escreva e aprove o \`plan.md\` → só então execute as \`tasks.md\`.
Modelos em branco ficam em \`.specify/templates/\`. Princípios do projeto em \`memory/constitution.md\`.
`;

export const EXAMPLE_SPEC_SLUG = '001-exemplo';
