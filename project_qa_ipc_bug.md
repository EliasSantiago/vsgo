# QA IPC Bug — `Browser failed to launch within 30000ms`

> **Status:** Aberto. Tentativas múltiplas de correção não resolveram. Documentado em 2026-05-20.

## TL;DR

Ao acionar **QA: Run AI Test…**, o navegador nunca abre. Após 30s, o usuário recebe a notificação:

```
QA run failed: Browser failed to launch within 30000ms (Playwright/Chromium not available?)
```

O bug está no pipeline IPC entre o renderer e o utility process worker que hospeda o `QaDriverService`. A primeira RPC (`launch`) é silenciosamente engolida; chamadas subsequentes (`close`, depois do timeout) percorrem o pipeline normalmente.

---

## Arquitetura envolvida

```
[renderer]                              [utility process worker]
qaService.executeRun                    qaDriverMain.ts
  └─ raceLaunch(driver.launch, 30s)       ├─ new UtilityProcessServer()
       └─ qaDriver.ts                     ├─ new QaDriverService()
            └─ ensureWorker()             └─ server.registerChannel('qaDriver',
                 └─ createWorker(...) ────────► ProxyChannel.fromService(service, ...))
                 └─ client.getChannel('qaDriver')
            └─ remote.launch(opts) ─── (RPC over MessagePort) ───► ❌ NUNCA chama service.launch
```

Arquivos relevantes:

| Arquivo | Papel |
|---|---|
| `src/vs/workbench/contrib/qa/browser/qaService.ts` | Serviço renderer-side, orquestra o run |
| `src/vs/workbench/contrib/qa/browser/qaDriver.ts` | `PlaywrightQaDriver` (proxy renderer-side) |
| `src/vs/workbench/contrib/qa/node/qaDriverMain.ts` | `QaDriverService` (worker-side, expõe canal `qaDriver`) |
| `src/vs/workbench/services/utilityProcess/electron-browser/utilityProcessWorkerWorkbenchService.ts` | `createWorker` (spawn + MessagePort handshake) |
| `src/vs/base/parts/ipc/node/ipc.mp.ts` | `UtilityProcessServer` + `Protocol` (worker-side) |
| `src/vs/base/parts/ipc/common/ipc.ts` | `IPCServer`, `IPCClient`, `ChannelServer`, `ChannelClient`, `ProxyChannel` |
| `src/vs/base/parts/ipc/common/ipc.mp.ts` | `Protocol` (common, usado pelo renderer-side `MessagePortClient`) |

---

## Sintoma observado (com instrumentação)

Logs do worker (`/tmp/qa-driver.log`) durante um run:

```
[T+0.000ms] module loaded pid=N
[T+1ms]    channel 'qaDriver' registered      ← IPCServer.registerChannel('qaDriver', proxyChannel)
[T+2ms]    [ipc.mp] Protocol constructed       ← novo Protocol(port) via Event.map
[T+3ms]    [ipc.mp] Protocol.onMessage subscribed, buffered=0   ← Event.once(protocol.onMessage) — first subscriber
[T+3ms]    [ipc.mp] Protocol got message: 59 bytes, hasSub=true ← ctx do renderer (handshake IPCClient)
[T+4ms]    [ipc.mp] Protocol.onMessage subscribed, buffered=0   ← ChannelServer.protocolListener
[T+4ms]    [ipc.mp] Protocol.onMessage subscribed, buffered=0   ← ChannelClient.protocolListener
[T+5ms]    [ipc.mp] Protocol got message: 6 bytes, hasSub=true  ← Initialize do renderer (ChannelServer)
[T+5ms]    [ipc.mp] Protocol got message: 28 bytes, hasSub=true ← launch RPC (Promise type, channelName='qaDriver', name='launch')
                                                                  ❌ NÃO dispara channel.call para o wrappedChannel
... 30s passam ...
[T+30s]    [ipc.mp] Protocol got message: 25 bytes, hasSub=true ← close RPC (do finally de executeRun)
[T+30s]    channel.call: close                                  ← ✅ wrappedChannel.call disparado
```

**A grande pergunta:** por que `28 bytes` (launch) não dispara `channel.call`, mas `25 bytes` (close, 30s depois) dispara?

---

## Hipóteses descartadas

### 1. `require` em módulo ESM (`qaDriverMain.ts`)
- **Sintoma**: `loadPlaywright()` lançava `ReferenceError: require is not defined` silenciosamente.
- **Fix aplicado**: `createRequire(import.meta.url)` (mantido).
- **Resultado**: corrigiu o erro de carregamento do Playwright, mas o `launch` ainda não chega ao worker — então não era a causa raiz do hang.

### 2. `port.start()` antes do listener
Per docs do Electron `MessagePortMain`:
> When no listeners are attached, message events are silently discarded.

`Protocol` em `ipc.mp.ts` faz `Event.fromNodeEventEmitter(...)` (lazy subscribe) e depois `port.start()`. Em teoria, mensagens entregues entre `start()` e o primeiro subscriber seriam perdidas.

- **Fix tentado**: reescrevi `Protocol` para anexar `port.on('message', ...)` antes de `start()`, com buffer interno que replaya mensagens quando o primeiro subscriber se inscreve.
- **Resultado**: buffered=0 nos logs (o subscriber se inscreveu antes das mensagens chegarem), então o race teórico não acontecia. Sem efeito no bug.
- **Status**: revertido (mudanças no `ipc.mp.ts` Protocol foram desfeitas).

### 3. Race entre Initialize do worker e launch RPC
Hipótese: o renderer envia `launch` antes do worker registrar o canal no `ChannelServer.channels`.

Olhando `IPCServer.onDidClientConnect`:
```ts
const channelServer = new ChannelServer(protocol, ctx, ...);  // subscribes + sends Initialize
const channelClient = new ChannelClient(protocol, ...);        // subscribes
this.channels.forEach((channel, name) => channelServer.registerChannel(name, channel));
```

`ChannelServer.constructor` envia `Initialize` ANTES de `channels.forEach`. Se o renderer receber Initialize → state Idle → enviar `launch` rápido o suficiente, o worker pode processar o `launch` no `ChannelServer.protocolListener` antes de `channels.forEach` ter rodado.

- **Fix tentado**: `await timeout(500)` e `await timeout(2000)` antes de `client.getChannel('qaDriver')` no renderer; `getNextTickChannel`.
- **Resultado**: sem efeito. O launch continua sem chegar ao `channel.call`.
- **Status**: revertido.

### 4. `pendingRequests` com timeout 1s
`ChannelServer.collectPendingRequest` enfileira requests para canais não registrados e dispara `Unknown channel` após 1s (`timeoutDelay = 1000`). `ChannelServer.registerChannel` chama `setTimeout(() => flushPendingRequests(channelName), 0)`.

Se o launch caiu em `pendingRequests`, o flush no próximo tick deveria re-invocar `onPromise`. Mas mesmo com o flush, `channel.call('launch')` não dispara.

- **Não testado diretamente**: mas a instrumentação confirma que `channel.call` para launch nunca é invocado, então ou o flush não roda, ou re-roda mas channels.get continua undefined.

### 5. `client.getChannel('qaDriver')` retorna canal já-cancelado?
Quando `raceLaunch` time out, ele rejeita a promise. A promise interna do ChannelClient cancela. Mas isso é depois do timeout — não explica por que `channel.call` jamais é invocado nos primeiros segundos.

---

## Diferenças observáveis entre `launch` (falha) e `close` (sucesso)

| Aspecto | launch RPC | close RPC |
|---|---|---|
| Quando enviado | logo após `Initialize` do worker (ms depois do spawn) | depois de 30s, dentro do `finally` |
| Request ID | 0 (primeira chamada) | 1 (segunda chamada) |
| Body | `[{headless: false}]` (~28 bytes total) | `[]` (~25 bytes total) |
| Chega ao Protocol | ✅ sim (`hasSub=true`) | ✅ sim |
| Chega ao `channel.call` | ❌ não | ✅ sim |

A única diferença observável é **timing** e **request id**. Não há tratamento especial para id=0 em `ChannelServer.onPromise`. Algo no pipeline `Protocol → IPCServer → ChannelServer → onRawMessage → onPromise → channels.get → channel.call` está pulando ou consumindo o launch sem chegar ao final.

---

## Fixes que permanecem aplicados (úteis)

| Arquivo | Mudança | Por quê |
|---|---|---|
| `src/vs/workbench/contrib/qa/node/qaDriverMain.ts` | `import { createRequire } from 'module'; const nodeRequire = createRequire(import.meta.url);` | `require` não existe em ESM; sem isso `loadPlaywright()` lança `ReferenceError` silencioso |
| `src/vs/workbench/contrib/qa/browser/qaService.ts` | `raceLaunch(this.driver.launch({ headless }), 30000)` + função `raceLaunch` helper | Sem timeout, run trava em "step 0" para sempre sem feedback ao usuário |
| `build/gulpfile.extensions.ts` | inclui `extensions/agent-chat/tsconfig.json` e `extensions/agent-pr-review/tsconfig.json` em `compilations` | Senão essas extensions não eram compiladas no `npm run watch`/`gulp compile-extensions` |

---

## Caminhos para resolver

### Opção A — Reimplementar QA como extensão (recomendada)
Mover `QaDriverService` (incluindo Playwright launch) para a extension `extensions/agent-chat/` ou nova extension dedicada. Extension host é processo Node — Playwright roda direto, sem precisar do utility worker MessagePort IPC.

A QA View no renderer chamaria a extensão via `vscode.commands.executeCommand` ou tool da API de chat.

**Vantagens:**
- Bypassa o IPC do utility worker entirely
- Extension host IPC é battle-tested (todas as extensions usam)
- Permite empacotar como extensão separada eventualmente

**Custo:** refactor médio. Precisa portar `qaDriverMain.ts`, mover IPC RPC para Commands/Tools API, ajustar `qaService` no renderer para chamar via command.

### Opção B — Trocar para `child_process.fork` direto via main process
`watcherClient.ts` (Node-side) usa `Client` do `vs/base/parts/ipc/node/ipc.cp.ts` que faz `cp.fork(bootstrap-fork.js, ...)` direto. Bypassa o `UtilityProcessWorkerWorkbenchService`.

Mas o renderer não pode chamar `cp.fork` direto (sandbox). Teria que ir via `INativeHostService` → main process → spawn. Mais complexo do que A.

### Opção C — Debug profundo do IPC pipeline
Instrumentar `IPCServer.onPromise` e `ChannelServer.onRawMessage` em `src/vs/base/parts/ipc/common/ipc.ts` para descobrir EXATAMENTE o que acontece com a launch RPC de 28 bytes. Áreas suspeitas:

- `ChannelServer.constructor` (linha ~337): subscribe a `protocol.onMessage` e envio de `Initialize`
- `ChannelServer.onRawMessage` (linha ~385): deserialização e dispatch
- `ChannelServer.onPromise` (linha ~407): channels.get
- `ChannelServer.collectPendingRequest` (linha ~473): enfileiramento
- `ChannelServer.flushPendingRequests` (linha ~496): replay via setTimeout(0)

Suspeita: race entre `setTimeout(flushPendingRequests, 0)` e algum outro setTimeout/microtask que limpa o pendingRequests antes do flush.

---

## Comandos para reproduzir

```bash
# Limpar logs anteriores
rm -f /tmp/qa-driver.log

# Build (se necessário)
NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt node build/next/index.ts transpile

# Compilar agent-chat (provider OpenAI/Anthropic/etc)
NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt ./node_modules/.bin/tsc -p extensions/agent-chat

# Lançar vsgo
unset ELECTRON_RUN_AS_NODE
NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt \
  VSCODE_SKIP_PRELAUNCH=1 \
  ./scripts/code.sh --no-sandbox --remote-debugging-port=9224

# Na UI:
# 1. Manage AI Providers... → adicionar provider funcional (Ollama é gratuito local)
# 2. Command Palette → "QA: Run AI Test..."
# 3. Inserir prompt qualquer, URL qualquer, Enter
# 4. Aguardar 30s → notification "QA run failed: Browser failed to launch..."
```

Para diagnosticar via instrumentação, reativar logging temporário em:

```ts
// qaDriverMain.ts (worker-side)
import * as fs from 'fs';
function qalog(msg: string) { fs.appendFileSync('/tmp/qa-driver.log', `[${new Date().toISOString()}] ${msg}\n`); }
// ...em QaDriverService.launch: qalog(`LAUNCH INVOKED`);

// Wrap channel pra logar dispatches:
const innerChannel = ProxyChannel.fromService(service, new DisposableStore());
const wrappedChannel = {
  call(ctx, command, args, token) { qalog(`channel.call: ${command}`); return innerChannel.call(ctx, command, args, token); },
  listen(ctx, event, arg) { qalog(`channel.listen: ${event}`); return innerChannel.listen(ctx, event, arg); }
};
server.registerChannel('qaDriver', wrappedChannel as any);
```

---

## Notas de contexto

- Pré-requisito separado pra QA funcionar (independente do bug IPC): **AI provider configurado** (OpenAI/Anthropic/Gemini/Ollama com chave válida). A QA service usa `pickModel` → se nenhum provider tiver model, falha com "No AI model is available".
- Testado em: Linux + Wayland + Electron utility process + Node 22. Behavior provavelmente similar em outras plataformas, mas não verificado.
- Outras utility workers do VS Code (file watcher, extension host, etc.) usam o MESMO pipeline IPC e funcionam. Pode haver algo específico no setup do QA driver (timing, naming, dependencies) que dispara este bug.
