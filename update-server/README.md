# Feed de atualização do vsgo

O `worker.js` é o servidor de update do vsgo, feito para rodar como Cloudflare
Worker no plano gratuito.

## Por que ele existe

O vsgo não observa a página de releases do GitHub. De hora em hora ele pergunta:

```
GET {updateUrl}/api/update/{plataforma}/{quality}/{commit-instalado}
```

E espera **204 No Content** (já está atualizado) ou um JSON descrevendo a versão
nova. Este Worker responde isso lendo a release mais recente do GitHub na hora.

## Consequência prática

**Ele não precisa ser reimplantado a cada versão.** Publicou a release, o feed já
aponta para ela. As respostas do GitHub ficam 5 minutos em cache para não
esbarrar no limite da API.

## Plataformas

O nome vem do cliente (ver `src/vs/platform/update/electron-main/updateService.*.ts`):

| Plataforma | Arquivo devolvido |
| --- | --- |
| `win32-x64-user` | `vsgoUserSetup-x64-*.exe` |
| `win32-x64` | `vsgoSystemSetup-x64-*.exe` |
| `darwin-arm64` | `*-darwin-arm64.zip` |
| `darwin` (Mac Intel) | `*-darwin-x64.zip` |
| `linux-x64` | `*-linux-x64.tar.gz` |

No macOS o `.zip` é obrigatório: o Squirrel.Mac só instala a partir dele, nunca
de um `.dmg`. No Linux o cliente não instala nada sozinho — apenas abre a URL.

## Implantar

1. Cloudflare → **Workers & Pages** → **Create** → **Worker**
2. Nome: `vsgo-update` → **Deploy**
3. **Edit code**, colar o conteúdo de `worker.js`, **Deploy**
4. A URL fica `https://vsgo-update.<seu-subdominio>.workers.dev`

Esse endereço vai para o campo `updateUrl` do `product.json` e fica gravado em
todo instalador gerado — trocar depois só alcança quem atualizar pelo endereço
antigo pelo menos uma vez.

## Conferir

```
# deve devolver JSON com a versão nova
curl -i https://vsgo-update.<subdominio>.workers.dev/api/update/win32-x64-user/stable/0000000000000000000000000000000000000000

# deve devolver 204 (commit da release atual)
curl -i https://vsgo-update.<subdominio>.workers.dev/api/update/win32-x64-user/stable/<commit-da-release>
```
