# Como instalar o vsgo

Baixe o arquivo do seu sistema operacional e siga o passo a passo.

Documentação, política de privacidade e termos de uso: <https://vsgo.orkestrai.com.br>

## Windows

1. Baixe `vsgoUserSetup-x64-<versão>.exe`.
2. Dê **duplo-clique** no arquivo.
3. O **Microsoft Defender SmartScreen** pode mostrar uma tela azul dizendo que
   impediu um aplicativo não reconhecido. Isso é normal: o instalador ainda não
   passou pelo reconhecimento automático da Microsoft. Clique em
   **"Mais informações"** e depois em **"Executar assim mesmo"**.
4. Siga o instalador (avançar → concluir). Não é preciso senha de administrador.

Existe também o `vsgoSystemSetup-x64-<versão>.exe`, que instala para **todos os
usuários** do computador e pede senha de administrador. Use-o só se precisar disso.

Para atualizar, baixe a versão mais nova e execute o instalador por cima — ele
reconhece a instalação anterior e atualiza.

<!-- macOS: build desativado no CI por custo de runner (10x o Linux).
     Ao reativar o job "macos" em .github/workflows/release.yml, descomente
     esta seção.

## macOS

1. Baixe o `.dmg` da sua arquitetura:
   - Macs com chip **M1/M2/M3/M4** → `vsgo-<versão>-darwin-arm64.dmg`
   - Macs **Intel** → `vsgo-<versão>-darwin-x64.dmg`
2. Abra o `.dmg` e **arraste o vsgo para a pasta Applications**.
3. Na primeira abertura, clique com o **botão direito** no vsgo dentro de
   Applications e escolha **"Abrir"** (o macOS avisa que o desenvolvedor não foi
   verificado porque o app não é notarizado pela Apple).

Se o macOS bloquear mesmo assim, rode no Terminal:

```
xattr -dr com.apple.quarantine /Applications/vsgo.app
```
-->

## Linux (Ubuntu/Debian)

```
sudo apt install ./vsgo_<versão>_amd64.deb
```

Para atualizar, instale o `.deb` da versão nova por cima — o apt reconhece como
atualização.

## Linux (qualquer distro, sem instalar)

```
tar -xzf vsgo-<versão>-linux-x64.tar.gz
./vsgo-linux-x64/vsgo
```

## Conferir a integridade do download

```
sha256sum -c SHA256SUMS.txt
```

No macOS: `shasum -a 256 -c SHA256SUMS.txt`
