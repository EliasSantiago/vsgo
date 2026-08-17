#!/usr/bin/env bash
# Watchers de desenvolvimento do vsgo, em três fases.
#
# Só os que produzem artefato: o transpile esbuild, que escreve o out/, a
# compilação das extensões embutidas e o esbuild do copilot. Os dois watchers de
# type-check do `npm run watch` ficam de fora — não emitem nada que a app
# carregue, e são os que mais pesam. Quem quiser o type-check ao vivo usa
# `./scripts/dev.sh --typecheck`; sob demanda, `npm run compile-check-ts-native`.
#
# As fases existem por causa do pico. Cada watcher faz um build frio completo ao
# subir, e os builds frios ao mesmo tempo não cabem: medido em 12/08, com dois em
# paralelo o cgroup encostava no teto de 5 GB, saturava o swap e era morto pelo
# systemd-oomd com PSI acima de 70. Em série, a fase 1 fica em torno de 1 GB com
# PSI zerado. Depois do build inicial o custo é incremental e todos convivem sem
# esforço.
#
# Em 14/08 o mesmo estouro voltou, um andar abaixo: as fases 1 e 2 já eram
# seriadas, mas *dentro* da fase 2 o watch das extensões e o esbuild do copilot
# subiam juntos (`npm-run-all2 -lp`), e são justamente os dois builds frios mais
# caros que sobraram. O cgroup bateu 5 GB — o próprio MemoryHigh — com os 512 MB
# de swap saturados, e o oomd matou a unit 72 s depois de subir, no meio da
# compilação das extensões. O out/ delas tinha acabado de ser limpo e nunca foi
# reescrito: a janela abriu com quase toda extensão embutida morta em
# "Cannot find module .../out/extension.js", incluindo a agent-chat — ou seja,
# nenhum provedor de modelo registrado, e o seletor de modelos do chat vazio.
# Daí a fase 3: o copilot só sobe depois que a compilação das extensões silencia.
#
# Rodado pelo scripts/dev.sh dentro de um cgroup com teto de memória. De pé
# sozinho também funciona, sem teto nenhum.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Marcador que o build/next/index.ts imprime quando o build inicial termina e ele
# passa a só observar. É o sinal de que o out/ está completo e a máquina liberou.
PHASE1_READY_MARKER='[watch] Watching src/'
# Se o marcador não vier, seguimos assim mesmo: melhor as extensões compilarem
# tarde do que não compilarem. Um build frio do out/ leva bem menos que isto.
PHASE1_TIMEOUT=600

# O gulp watch-extensions não tem marcador de "terminei": ele compila ~46
# tsconfigs em paralelo e cada um imprime o seu próprio "Finished ... with N
# errors". O fim do build frio é o silêncio que vem depois do último — por isso
# aqui a espera é por quietude do log, e não por uma linha específica.
PHASE2_QUIET=15
PHASE2_TIMEOUT=900

# A saída de cada fase vai para um arquivo próprio, e não por um pipe, porque num
# pipe ela simplesmente não sai: medido, o transpile despeja as oito linhas dele
# em ~2,4 s quando o stdout é arquivo e não entrega nada em 20 s quando é pipe
# (o stdout do Node é assíncrono para pipes). Como é justamente dessa saída que
# sai o sinal para começar a fase seguinte, ler por pipe travaria a fase seguinte
# para sempre. O `tail -f` depois repassa o arquivo para o nosso stdout, que é o
# log do watch.
PHASE1_LOG="$(mktemp -t vsgo-watch-phase1.XXXXXX.log)"
PHASE2_LOG="$(mktemp -t vsgo-watch-phase2.XXXXXX.log)"
CHILDREN=()

function cleanup() {
	local pid
	for pid in "${CHILDREN[@]:-}"; do
		[[ -n "$pid" ]] && kill "$pid" 2> /dev/null || true
	done
	rm -f "$PHASE1_LOG" "$PHASE2_LOG"
}
trap cleanup EXIT INT TERM

# Espera o log parar de crescer por $quiet segundos seguidos. Volta 0 quando
# silenciou, 1 no timeout e 2 quando o processo observado morreu antes.
function wait_for_quiet() {
	local log="$1" pid="$2" quiet="$3" timeout="$4"
	local waited=0 still=0 size last_size=-1
	while [[ "$waited" -lt "$timeout" ]]; do
		if ! kill -0 "$pid" 2> /dev/null; then
			return 2
		fi
		size="$(stat -c %s "$log" 2> /dev/null || echo 0)"
		if [[ "$size" == "$last_size" ]]; then
			still=$((still + 2))
			[[ "$still" -ge "$quiet" ]] && return 0
		else
			still=0
			last_size="$size"
		fi
		sleep 2
		waited=$((waited + 2))
	done
	return 1
}

echo "[watch-dev] fase 1/3: transpile do out/"
npm run watch-client-transpile > "$PHASE1_LOG" 2>&1 &
PHASE1_PID=$!
CHILDREN+=("$PHASE1_PID")

tail -n +1 -f "$PHASE1_LOG" &
CHILDREN+=($!)

WAITED=0
while ! grep -Fq "$PHASE1_READY_MARKER" "$PHASE1_LOG" 2> /dev/null; do
	if [[ "$WAITED" -ge "$PHASE1_TIMEOUT" ]]; then
		echo "[watch-dev] AVISO: a fase 1 não sinalizou em ${PHASE1_TIMEOUT}s; subindo a fase 2 assim mesmo."
		break
	fi
	# O transpile morrendo derruba a fase 1 inteira; não há o que esperar.
	if ! kill -0 "$PHASE1_PID" 2> /dev/null; then
		echo "[watch-dev] ERRO: o watcher de transpile morreu antes de terminar o build inicial." >&2
		exit 1
	fi
	sleep 2
	WAITED=$((WAITED + 2))
done

echo "[watch-dev] fase 2/3: extensões embutidas"
npm run watch-extensions-lean > "$PHASE2_LOG" 2>&1 &
PHASE2_PID=$!
CHILDREN+=("$PHASE2_PID")

tail -n +1 -f "$PHASE2_LOG" &
CHILDREN+=($!)

wait_for_quiet "$PHASE2_LOG" "$PHASE2_PID" "$PHASE2_QUIET" "$PHASE2_TIMEOUT"
case "$?" in
	1) echo "[watch-dev] AVISO: a fase 2 não silenciou em ${PHASE2_TIMEOUT}s; subindo a fase 3 assim mesmo." ;;
	2) echo "[watch-dev] ERRO: o watcher das extensões morreu antes de terminar o build inicial." >&2; exit 1 ;;
esac

echo "[watch-dev] fase 3/3: esbuild do copilot"
# Direto no nosso stdout, sem pipe no meio: um pipe aqui só serviria para
# prefixar as linhas, e o stdout do Node é assíncrono para pipes — o mesmo
# motivo que fez as fases anteriores escreverem em arquivo.
npm run watch-copilot-esbuild &
CHILDREN+=($!)

# Segura o processo enquanto qualquer watcher estiver de pé. `wait` sem argumento
# volta quando todos terminarem, que é quando este script também deve sair.
wait
