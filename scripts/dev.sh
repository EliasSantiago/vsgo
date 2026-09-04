#!/usr/bin/env bash
# Sobe o vsgo em modo de desenvolvimento: garante o watch incremental rodando
# em background e abre a aplicação já compilada.
#
# Uso:
#   ./scripts/dev.sh                  # garante o watch e abre a app
#   ./scripts/dev.sh --no-watch       # só abre a app (watch por sua conta)
#   ./scripts/dev.sh --restart-watch  # reinicia o watch e abre a app
#   ./scripts/dev.sh --stop           # derruba o watch em background e sai
#   ./scripts/dev.sh --logs           # acompanha o log do watch (Ctrl+C sai)
#   ./scripts/dev.sh --clean          # abre com perfil limpo (user-data/extensões próprios)
#   ./scripts/dev.sh --typecheck      # watch completo, com type-check ao vivo (ver "Watch enxuto")
#   ./scripts/dev.sh --no-limits      # sem teto de memória (ver "Contenção de memória")
#
# Tetos de memória, ajustáveis por variável de ambiente:
#   VSGO_WATCH_MEM_HIGH=5G  VSGO_WATCH_MEM_MAX=6G  VSGO_APP_MEM_HIGH=6G  VSGO_SWAP_MAX=512M
#
# Qualquer outro argumento é repassado para o scripts/code.sh:
#   ./scripts/dev.sh ~/meu-projeto --verbose
#
# Depois de aberto, o ciclo é: editar -> o watch recompila -> Ctrl+R na janela.
# Só mudanças no processo main (src/main.ts, src/vs/code/electron-main/**)
# exigem fechar e rodar este script de novo.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WATCH_LOG="$REPO_ROOT/.build/logs/watch.log"
# Padrão exclusivo do watcher de transpile, usado para detectar o watch de pé.
WATCH_PATTERN="build/next/index.ts transpile --watch"
# O watcher de transpile apaga out/ inteiro antes do build inicial e só imprime
# o marcador de "observando" quando esse build termina. Enquanto não houver um
# marcador DEPOIS do último clean, os arquivos em out/ são de um build anterior
# e vão sumir no meio do carregamento da janela (ERR_FILE_NOT_FOUND /
# "Failed to fetch dynamically imported module").
WATCH_CLEAN_MARKER='[clean] out'
# O segundo marcador cobre buildConfig.ts com useEsbuildTranspile=false, onde
# quem escreve o out/ é o gulp watch-client e o transpile vira no-op.
WATCH_READY_MARKERS=('[watch] Watching src/' '[watch] esbuild transpile disabled')

# Arquivos gerados pela compilação; se faltarem, a janela abre em branco com
# ERR_FILE_NOT_FOUND. O .html e o preload são escritos no fim do watch-client,
# então servem de sinal de que a compilação de fato terminou — checar só os
# .js principais não basta, pois eles sobram de builds anteriores.
ENTRYPOINTS=(
	"$REPO_ROOT/out/main.js"
	"$REPO_ROOT/out/vs/code/electron-main/main.js"
	"$REPO_ROOT/out/vs/workbench/workbench.desktop.main.js"
	"$REPO_ROOT/out/vs/code/electron-browser/workbench/workbench-dev.html"
	"$REPO_ROOT/out/vs/base/parts/sandbox/electron-browser/preload.js"
)

# O out/ das extensões embutidas também é apagado e refeito a cada subida do
# watch, e ele fica pronto *depois* do out/ do core. Esperar só pelo core abre a
# janela no meio da compilação das extensões: o host de extensões ativa cada uma
# antes do .js existir e todas morrem em "Cannot find module .../out/extension.js"
# — sem erro visível na janela, só funcionalidade faltando. Foi assim que o vsgo
# abriu em 14/08 sem nenhuma extensão embutida, e portanto sem os provedores de
# modelo da agent-chat: o seletor de modelos do chat ficou vazio.
#
# O marcador é a fase 3 do scripts/watch-dev.sh, que só começa quando a
# compilação das extensões silencia. Com `--typecheck` o watch é outro e não tem
# fases, então lá a checagem é só a dos arquivos.
EXT_ENTRYPOINTS=(
	"$REPO_ROOT/extensions/agent-chat/out/extension.js"
	"$REPO_ROOT/extensions/typescript-language-features/out/extension.js"
)
WATCH_EXTENSIONS_READY_MARKER='[watch-dev] fase 3/3'
WAIT_TIMEOUT=900 # segundos de espera pela primeira compilação

# O Node deste ambiente não carrega o bundle de CAs do sistema; sem isto o
# download do Electron falha com UNABLE_TO_GET_ISSUER_CERT_LOCALLY.
SYSTEM_CA_BUNDLE="/etc/ssl/certs/ca-certificates.crt"
if [[ -z "${NODE_EXTRA_CA_CERTS:-}" && -f "$SYSTEM_CA_BUNDLE" ]]; then
	export NODE_EXTRA_CA_CERTS="$SYSTEM_CA_BUNDLE"
fi

# ─── Contenção de memória ─────────────────────────────────────────────────────
# Cada metade roda num cgroup transiente do systemd. Aqui a regra é: o build tem
# de caber no cgroup dele, e nunca produzir pressão de memória global — porque a
# pressão é global, mas a vítima que o systemd-oomd escolhe pode ser qualquer uma.
#
# A versão anterior deste bloco errava nos dois pontos. Usava só MemoryHigh, que
# é um limite *suave*: ao encostar nele o kernel não segura nada, apenas empurra
# páginas para o swap. E marcava o watch com `ManagedOOMPreference=omit` para
# protegê-lo, o que apenas o tirava da lista de candidatos — o oomd disparava do
# mesmo jeito e matava o vizinho. Medido em 12/08: watch com pico de 6,4 GB e
# 2,6 GB de swap em 68 s; às 07:54:09 o oomd matou o Chrome, às 07:54:24 matou o
# dbus.service (14 processos) e levou a sessão gráfica junto.
#
# Daí a estratégia atual:
#   MemoryHigh    folga acima do consumo real do build, não aperto. Ver abaixo;
#   MemoryMax     teto rígido — se o build passar disso, morre o build, sozinho,
#                 dentro do cgroup dele. É preferível a perder o desktop;
#   MemorySwapMax curto, porque é o thrash de swap que alimenta o sinal de PSI
#                 que faz o oomd disparar. Centenas de MB, não os 4 GB da máquina;
#   sem `omit`    no watch: ele fica elegível de propósito. Se algo escapar do
#                 teto, quem o oomd deve escolher é o build.
#
# Sobre a folga do MemoryHigh, que custou uma tentativa para entender: apertá-lo
# não é conservador, é o contrário. Com MemoryHigh=3G o build encostou nos 3 GB e
# ficou em reclaim contínuo — e reclaim contínuo *é* o sinal de PSI que o oomd lê.
# Medido em 12/08 08:09: cgroup com Pressure Avg10 de 80,04 e uso de só 3,1 GB,
# bem abaixo do MemoryMax; o oomd matou a unit por pressão de 74,12% na fatia do
# usuário. O MemoryHigh serve para frear um build que fuja da curva normal, não
# para espremer o build normal. Quem contém de fato é o MemoryMax.
#
# E a folga precisou subir de novo em 14/08, pelo mesmo motivo: com 5G/6G o watch
# encostou exatamente nos 5 GB do MemoryHigh, saturou os 512 MB de swap e foi
# morto pelo oomd em 72 s, no meio da compilação das extensões — deixando o out/
# delas vazio e a janela sem extensão embutida nenhuma. A causa do pico está no
# scripts/watch-dev.sh (dois builds frios em paralelo, agora seriados); estes
# números só devolvem a folga que faltava por cima do consumo real.
#
# A app é o caso oposto: `ManagedOOMPreference=avoid` para que a janela aberta
# não seja a vítima, e sem MemoryMax — não se quer matar o editor no meio do uso.
WATCH_UNIT=vsgo-watch
APP_UNIT=vsgo-app
WATCH_MEM_HIGH="${VSGO_WATCH_MEM_HIGH:-6G}"
WATCH_MEM_MAX="${VSGO_WATCH_MEM_MAX:-8G}"
APP_MEM_HIGH="${VSGO_APP_MEM_HIGH:-6G}"
SWAP_MAX="${VSGO_SWAP_MAX:-512M}"
APP_SWAP_MAX="${VSGO_APP_SWAP_MAX:-512M}"
USE_LIMITS=1

# ─── Watch enxuto ─────────────────────────────────────────────────────────────
# Com useEsbuildTranspile=true (build/buildConfig.ts) quem escreve o out/ é o
# watcher esbuild. Dos watchers do `npm run watch`, o watch-client só checa tipos
# e não emite nada que a app carregue: é o watchTypeCheckTask
# (build/lib/compilation.ts) — tsgo --noEmit mais o gerador de d.ts do monaco. É
# também o mais pesado, e era ele que estourava a memória junto dos demais.
#
# O padrão então é o scripts/watch-dev.sh, que sobe só o que produz artefato e
# ainda escalona as duas compilações frias em série, porque em paralelo elas não
# cabem (o porquê está lá). Erros de tipo continuam aparecendo no editor pelo
# tsserver, e sob demanda em `npm run compile-check-ts-native`. Quem quiser o
# type-check ao vivo no log usa --typecheck e volta ao `npm run watch` completo.
WATCH_CMD=("$REPO_ROOT/scripts/watch-dev.sh")

# O controlador de memória precisa estar delegado à fatia do usuário; nem toda
# distro faz isso. Sem ele, seguimos sem teto — melhor rodar sem trava do que
# não rodar.
function limits_available() {
	[[ "$USE_LIMITS" -eq 1 ]] || return 1
	command -v systemd-run > /dev/null 2>&1 || return 1
	grep -qw memory "/sys/fs/cgroup/user.slice/user-$(id -u).slice/cgroup.controllers" 2>/dev/null
}

START_WATCH=1
RESTART_WATCH=0
CLEAN_PROFILE=0
WATCH_ONLY=0
CODE_ARGS=()
for arg in "$@"; do
	case "$arg" in
		--no-watch) START_WATCH=0 ;;
		--watch-only) WATCH_ONLY=1 ;;
		--restart-watch) RESTART_WATCH=1 ;;
		--clean) CLEAN_PROFILE=1 ;;
		--typecheck) WATCH_CMD=(npm run watch) ;;
		--no-limits) USE_LIMITS=0 ;;
		--stop)
			echo "==> Derrubando o watch em background..."
			systemctl --user stop "$WATCH_UNIT.service" > /dev/null 2>&1 || true
			# As duas formas, porque não dá para saber com qual delas o watch subiu.
			cd "$REPO_ROOT"
			"$REPO_ROOT/node_modules/.bin/deemon" --kill "$REPO_ROOT/scripts/watch-dev.sh" > /dev/null 2>&1 || true
			"$REPO_ROOT/node_modules/.bin/deemon" --kill npm run watch > /dev/null 2>&1 || true
			exit 0
			;;
		--logs)
			[[ -f "$WATCH_LOG" ]] || { echo "Nenhum log em $WATCH_LOG — o watch já foi iniciado por este script?"; exit 1; }
			exec tail -f "$WATCH_LOG"
			;;
		*) CODE_ARGS+=("$arg") ;;
	esac
done

cd "$REPO_ROOT"

# ─── Watch incremental ────────────────────────────────────────────────────────
# O deemon faz o processo sobreviver ao fim deste script, com a saída no log.
# Reiniciar/derrubar é via --restart-watch / --stop. Chamado pelo caminho, e não
# pelo nome: os scripts `watchd`/`kill-watchd` do package.json fixam `npm run
# watch`, e aqui o script do watch é escolhido em tempo de execução.
DEEMON="$REPO_ROOT/node_modules/.bin/deemon"

function is_watch_running() {
	pgrep -f "$WATCH_PATTERN" > /dev/null 2>&1
}

# Ligado quando o watch é desta invocação: o log foi truncado agora e o out/
# antigo está a segundos de ser apagado, então nada nele pode ser confiado
# antes do marcador de build inicial concluído.
STRICT_WATCH_READY=0

# Com cgroup disponível o watch vira um serviço transiente do systemd em vez de
# usar o deemon: o systemd já cuida de sobreviver ao fim deste script, e é ele
# quem aplica o teto de memória. O PATH precisa ir explícito porque o node vem
# do nvm e o gerenciador de usuário do systemd não herda o PATH deste shell.
function start_watch() {
	mkdir -p "$(dirname "$WATCH_LOG")"
	local scoped=0
	if limits_available; then
		systemctl --user reset-failed "$WATCH_UNIT.service" > /dev/null 2>&1 || true
		: > "$WATCH_LOG"
		if systemd-run --user --quiet --unit="$WATCH_UNIT" \
			--working-directory="$REPO_ROOT" \
			--setenv=PATH="$PATH" \
			--setenv=NODE_EXTRA_CA_CERTS="${NODE_EXTRA_CA_CERTS:-}" \
			-p MemoryHigh="$WATCH_MEM_HIGH" \
			-p MemoryMax="$WATCH_MEM_MAX" \
			-p MemorySwapMax="$SWAP_MAX" \
			-p StandardOutput="append:$WATCH_LOG" \
			-p StandardError="append:$WATCH_LOG" \
			"${WATCH_CMD[@]}"; then
			scoped=1
			echo "    Teto de memória do watch: $WATCH_MEM_HIGH (rígido em $WATCH_MEM_MAX, swap até $SWAP_MAX)"
			watch_unit_alive_or_die
		else
			echo "    AVISO: não consegui criar o serviço do watch; seguindo sem teto de memória."
		fi
	fi
	# Sem cgroup (ou se o systemd recusou), o deemon assume: o processo sobrevive
	# ao fim deste script do mesmo jeito, só que sem trava de memória.
	if [[ "$scoped" -eq 0 ]]; then
		"$DEEMON" "${WATCH_CMD[@]}" > "$WATCH_LOG" 2>&1 < /dev/null &
		disown || true
	fi
	STRICT_WATCH_READY=1
}

# O systemd-run volta com sucesso assim que a unit é *criada*, não quando o
# comando dela vinga. Já aconteceu de o npm morrer no mesmo segundo com
# status=127 e este script ficar 900 s esperando em silêncio por uma compilação
# que ninguém estava fazendo. Um instante depois já dá para ver a diferença.
function watch_unit_alive_or_die() {
	sleep 2
	watch_unit_is_active && return 0
	echo "ERRO: o serviço do watch morreu logo depois de subir." >&2
	systemctl --user status "$WATCH_UNIT.service" --no-pager 2>&1 | head -12 >&2
	echo "--- fim de $WATCH_LOG ---" >&2
	tail -20 "$WATCH_LOG" >&2 2>/dev/null || true
	exit 1
}

function watch_unit_is_active() {
	[[ "$(systemctl --user is-active "$WATCH_UNIT.service" 2>/dev/null)" == "active" ]]
}

# Iniciar o watch apaga out/ inteiro antes do build inicial, e uma janela já
# aberta lê o out/ do disco a cada recarregamento: enquanto o build não termina,
# o Ctrl+R dela não tem de onde carregar e a janela fica sem recarregar (ou
# abre em branco, com ERR_FILE_NOT_FOUND). Avisar é melhor do que recusar — pode
# ser exatamente o que se quer, só não em silêncio.
function warn_if_window_open() {
	pgrep -f "$REPO_ROOT/.build/electron/vsgo" > /dev/null 2>&1 || return 0
	echo "    AVISO: já há uma janela do vsgo aberta. O watch apaga out/ antes de"
	echo "           recompilar, então o Ctrl+R dela só volta a funcionar quando"
	echo "           o build terminar (acompanhe com: ./scripts/dev.sh --logs)."
}

if [[ "$RESTART_WATCH" -eq 1 ]]; then
	echo "==> Reiniciando o watch..."
	warn_if_window_open
	systemctl --user stop "$WATCH_UNIT.service" > /dev/null 2>&1 || true
	"$DEEMON" --kill "$REPO_ROOT/scripts/watch-dev.sh" > /dev/null 2>&1 || true
	"$DEEMON" --kill npm run watch > /dev/null 2>&1 || true
	start_watch
	echo "    Log: $WATCH_LOG"
elif [[ "$START_WATCH" -eq 1 ]]; then
	if is_watch_running; then
		echo "==> Watch já está rodando (log: $WATCH_LOG)"
	else
		echo "==> Subindo o watch em background..."
		warn_if_window_open
		start_watch
		echo "    Log: $WATCH_LOG  (acompanhe com: ./scripts/dev.sh --logs)"
	fi
else
	echo "==> Watch não gerenciado por este script (--no-watch)"
fi

# ─── Espera a primeira compilação ─────────────────────────────────────────────
function entrypoints_ready() {
	local file
	for file in "${ENTRYPOINTS[@]}"; do
		[[ -f "$file" ]] || return 1
	done
	return 0
}

# Verdadeiro quando o out/ não está prestes a ser (ou sendo) apagado pelo watch.
function out_dir_stable() {
	local clean='' ready='' marker line
	if [[ -f "$WATCH_LOG" ]]; then
		clean="$(grep -Fn "$WATCH_CLEAN_MARKER" "$WATCH_LOG" | tail -1 | cut -d: -f1)"
		for marker in "${WATCH_READY_MARKERS[@]}"; do
			line="$(grep -Fn "$marker" "$WATCH_LOG" | tail -1 | cut -d: -f1)"
			if [[ -n "$line" && ( -z "$ready" || "$line" -gt "$ready" ) ]]; then
				ready="$line"
			fi
		done
	fi
	# Build inicial concluído e nenhum clean depois dele: out/ é desta rodada.
	if [[ -n "$ready" && ( -z "$clean" || "$ready" -gt "$clean" ) ]]; then
		return 0
	fi
	# Sem marcador de pronto só dá para confiar no out/ quando o watch não é
	# desta invocação (o log recém-truncado ainda não diz nada) e nada foi
	# apagado — caso do --no-watch ou de um watch subido à mão, sem log.
	[[ "$STRICT_WATCH_READY" -eq 0 && -z "$clean" ]]
}

# Verdadeiro quando as extensões embutidas já foram recompiladas nesta rodada.
function extensions_ready() {
	local file
	for file in "${EXT_ENTRYPOINTS[@]}"; do
		[[ -f "$file" ]] || return 1
	done
	# Os arquivos sobram da rodada anterior enquanto o watch desta invocação ainda
	# não chegou neles; só o marcador de fase distingue os dois casos.
	if [[ "$STRICT_WATCH_READY" -eq 1 && "${WATCH_CMD[0]}" == "$REPO_ROOT/scripts/watch-dev.sh" ]]; then
		grep -Fq "$WATCH_EXTENSIONS_READY_MARKER" "$WATCH_LOG" 2> /dev/null || return 1
	fi
	return 0
}

function build_ready() {
	out_dir_stable && entrypoints_ready && extensions_ready
}

if [[ "$WATCH_ONLY" -eq 1 ]]; then
	echo "==> Watch no ar; a app não será aberta (--watch-only)."
	exit 0
fi

if ! build_ready; then
	echo "==> Aguardando a primeira compilação (pode levar alguns minutos)..."
	WAITED=0
	while ! build_ready; do
		if [[ "$WAITED" -ge "$WAIT_TIMEOUT" ]]; then
			echo "ERRO: a compilação não terminou em ${WAIT_TIMEOUT}s."
			echo "      Verifique o log: $WATCH_LOG"
			exit 1
		fi
		# O watch pode morrer no meio — estourando o MemoryMax, por exemplo. Sem
		# esta checagem a espera seguiria até o timeout sem ninguém compilando.
		if [[ "$STRICT_WATCH_READY" -eq 1 ]] && limits_available && ! watch_unit_is_active; then
			echo ""
			echo "ERRO: o serviço do watch parou antes de a compilação terminar." >&2
			systemctl --user status "$WATCH_UNIT.service" --no-pager 2>&1 | head -12 >&2
			echo "      Se foi o teto de memória, suba com VSGO_WATCH_MEM_MAX=6G ./scripts/dev.sh" >&2
			exit 1
		fi
		sleep 5
		WAITED=$((WAITED + 5))
		printf '    ... %ss\r' "$WAITED"
	done
	echo ""
	echo "    Compilação pronta."
fi

# ─── Flags de abertura ────────────────────────────────────────────────────────
# O chrome-sandbox só funciona se for SUID root; o download do Electron o
# restaura como usuário comum, então detectamos e caímos para --no-sandbox.
SANDBOX_BIN="$REPO_ROOT/.build/electron/chrome-sandbox"
if [[ -f "$SANDBOX_BIN" && "$(stat -c '%U %a' "$SANDBOX_BIN" 2>/dev/null || echo '')" != "root 4755" ]]; then
	CODE_ARGS+=(--no-sandbox)
fi

if [[ "$CLEAN_PROFILE" -eq 1 ]]; then
	CODE_ARGS+=(--user-data-dir "$REPO_ROOT/.vsgo-dev/user-data" --extensions-dir "$REPO_ROOT/.vsgo-dev/extensions")
	echo "==> Perfil limpo em $REPO_ROOT/.vsgo-dev"
fi

# O preLaunch (download do Electron + compilação) já está coberto pelo watch;
# pulamos quando o Electron e os entrypoints estão no lugar.
if [[ -d "$REPO_ROOT/.build/electron" ]] && build_ready; then
	export VSCODE_SKIP_PRELAUNCH=1
fi

echo "==> Abrindo o vsgo..."
# O scope cobre a árvore inteira da app — Electron, extension host e o
# llama-server que a extensão sobe para os modelos locais, que é quem carrega os
# pesos. Sem ele o modelo em CPU soma vários GB fora de qualquer teto. Ao
# contrário do watch, aqui o nome é único por processo: abrir uma segunda janela
# não pode esbarrar no scope da primeira.
#
# `avoid` e não `omit`: a janela aberta é o que menos se quer perder, mas deixá-la
# fora da lista de candidatos só transfere o kill para o vizinho — foi assim que
# o oomd acabou no dbus.service. `avoid` a põe no fim da fila sem tirá-la dela.
# E sem MemoryMax: um teto rígido aqui mataria o editor em uso.
if limits_available; then
	echo "    Teto de memória da app: $APP_MEM_HIGH (swap até $APP_SWAP_MAX)"
	exec systemd-run --user --scope --quiet --unit="$APP_UNIT-$$" \
		-p MemoryHigh="$APP_MEM_HIGH" \
		-p MemorySwapMax="$APP_SWAP_MAX" \
		-p ManagedOOMPreference=avoid \
		"$REPO_ROOT/scripts/code.sh" "${CODE_ARGS[@]}"
fi
exec "$REPO_ROOT/scripts/code.sh" "${CODE_ARGS[@]}"
