# Build/launch flags

O ambiente tem FortiClient interceptando TLS; sempre setar:

```
NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
```

Para rodar via `scripts/code.sh`:

- `--no-sandbox` (Chromium recusa caso contrário)
- `VSCODE_SKIP_PRELAUNCH=1` quando o build já existe
