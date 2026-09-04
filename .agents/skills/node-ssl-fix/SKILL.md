---
name: node-ssl-fix
description: "Resolve falha de certificado SSL em comandos Node neste projeto (UNABLE_TO_GET_ISSUER_CERT_LOCALLY, unable to get local issuer certificate, self signed certificate in certificate chain). Use SEMPRE que rodar comandos Node/npm que acessem rede neste repositório - especialmente download de Electron (`npm run electron`, `build/lib/preLaunch.ts`, `./scripts/code.sh`), `npm install`, ou qualquer script que use `got`/`https`. Trigger words: 'falha de cert', 'cert SSL', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'unable to get local issuer certificate', 'baixar electron', 'preLaunch failed', 'erro de certificado'."
---

# Node SSL Certificate Fix

Neste ambiente, o Node.js (v22) não carrega o bundle de CAs do sistema por padrão. Isso quebra qualquer chamada HTTPS feita por bibliotecas como `got` (usado por `@vscode/gulp-electron`), retornando `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` mesmo quando `curl` funciona normalmente.

## Sintoma

```
RequestError: unable to get local issuer certificate
    at ClientRequest.<anonymous> (.../got/dist/source/core/index.js:...)
    ...
    code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'
[cause]: Error: unable to get local issuer certificate
    code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'
```

Comum em:
- `./scripts/code.sh` → invoca `node build/lib/preLaunch.ts` → baixa Electron
- `npm run electron`
- Qualquer script que use `got`, `node-fetch`, ou `https` direto

## Fix

Sempre prefixe o comando com `NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt`:

```bash
NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt ./scripts/code.sh
NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt node build/lib/preLaunch.ts
NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt npm run watch
NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt npm install
```

Ou exporte no início da sessão:

```bash
export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
```

## Por que isso resolve

- `curl` usa o bundle do sistema (`/etc/ssl/certs/ca-certificates.crt`) por padrão — por isso funciona.
- Node usa seu próprio bundle compilado estático. CAs corporativos/intermediários instalados via `update-ca-certificates` não são vistos pelo Node.
- `NODE_EXTRA_CA_CERTS` adiciona o bundle do sistema ao store do Node sem desabilitar verificação SSL.

## NÃO use estas alternativas

- `NODE_TLS_REJECT_UNAUTHORIZED=0` → desabilita validação SSL globalmente (inseguro). Além disso, não é respeitado por todas as libs (ex: `got` com config própria).
- `--insecure` / `strict-ssl=false` → mesma questão de segurança.
- Modificar `node_modules` ou patches → não persiste e quebra com reinstall.

## Verificação rápida

Se quiser confirmar que o bundle existe antes de rodar:

```bash
ls /etc/ssl/certs/ca-certificates.crt && echo "CA bundle OK"
```

Se não existir, instale: `sudo apt-get install ca-certificates && sudo update-ca-certificates`.

## Aplicação prática nesta sessão

Combine com outras flags conhecidas para o launch dev:

```bash
NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt \
VSCODE_SKIP_PRELAUNCH=1 \
./scripts/code.sh --no-sandbox
```

- `VSCODE_SKIP_PRELAUNCH=1` pula re-download se `.build/electron/code-oss` já existe.
- `--no-sandbox` evita erro de chrome-sandbox setuid (Linux dev build).
