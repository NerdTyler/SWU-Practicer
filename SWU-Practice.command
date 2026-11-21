#!/usr/bin/env bash
# SWU Practice — one-file launcher for the offline Star Wars: Unlimited app.
#
# Double-click on macOS (or run from a terminal anywhere). It:
#   1. runs the fail-soft updater (update.sh) — offline/failed updates never
#      block the launch for long,
#   2. HARD-RESTARTS the stack: any already-running server / client /
#      bot-host processes are stopped first, then started fresh, so stale
#      code from a previous version can never keep serving,
#   3. starts the Forceteki game server (localhost:9500),
#   4. starts the Karabast web client (localhost:3000),
#   5. starts the bot host (watches for lobbies named "BOT..." and sends
#      the practice bot into them),
#   6. opens Karabast (localhost:3000) in the default browser. Everything
#      happens there — there is no separate practice page (Stage 7).
#
# Layout it expects (the Stage 5 install creates exactly this):
#   <root>/forceteki/  forceteki-client/  node26/  swu-forge-app/ (this file)
# Overrides: SWU_ROOT, SWU_NODE_DIR, SWU_NO_OPEN=1, SWU_DRY_RUN=1,
#            SWU_UPDATE_WAIT=<sec>.  Also: --stop, --status.
#
# NOTE: because of the hard restart, double-clicking the launcher while a
# game is in progress ends that game. That is deliberate — a fresh launch
# always means a fresh stack.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$SCRIPT_DIR"
ROOT="${SWU_ROOT:-$(dirname "$APP_DIR")}"
ENGINE_DIR="$ROOT/forceteki"
CLIENT_DIR="$ROOT/forceteki-client"
NODE_DIR="${SWU_NODE_DIR:-$ROOT/node26}"
SERVER_URL="http://localhost:9500"
CLIENT_URL="http://localhost:3000"
UPDATE_WAIT="${SWU_UPDATE_WAIT:-90}"

say() { echo "[SWU Practice] $*"; }

# ---- Node 26 selection -------------------------------------------------------
node_in_range() {
    # $1 = node binary; ok if >=26.12.1 and <27
    local v
    v="$("$1" --version 2>/dev/null)" || return 1
    "$1" -e "const p=process.version.slice(1).split('.').map(Number); process.exit((p[0]===26 && (p[1]>12 || (p[1]===12 && p[2]>=1))) ? 0 : 1)" 2>/dev/null
}
if [ -x "$NODE_DIR/bin/node" ] && node_in_range "$NODE_DIR/bin/node"; then
    export PATH="$NODE_DIR/bin:$PATH"
elif command -v node >/dev/null 2>&1 && node_in_range "$(command -v node)"; then
    say "Using system node $(node --version) (bundled node26 not found at $NODE_DIR)"
else
    say "ERROR: Node >=26.12.1 <27 is required but was not found."
    say "Looked for $NODE_DIR/bin/node and a system node. Install Node 26 into $NODE_DIR and retry."
    exit 1
fi
# The engine build OOMs on small-RAM machines (incl. the 8 GB MacBook Air)
# without a bigger heap.
export NODE_OPTIONS="--max-old-space-size=5120"
say "node: $(node --version), root: $ROOT"

# ---- health checks -------------------------------------------------------------
server_ok()   { curl -fs --max-time 3 "$SERVER_URL/api/health" >/dev/null 2>&1; }
client_ok()   { [ "$(curl -s --max-time 3 -o /dev/null -w '%{http_code}' "$CLIENT_URL" 2>/dev/null)" = "200" ]; }
bot_host_ok() {
    local pidfile="$APP_DIR/bot-host.pid" pid
    [ -f "$pidfile" ] || return 1
    pid="$(cat "$pidfile" 2>/dev/null)"
    [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

wait_for() {
    # $1 label, $2 check function, $3 timeout seconds
    local label="$1" fn="$2" timeout="$3" waited=0
    while ! "$fn"; do
        if [ "$waited" -ge "$timeout" ]; then
            say "WARNING: $label did not come up within ${timeout}s (continuing anyway)"
            return 1
        fi
        sleep 3; waited=$((waited + 3))
    done
    say "$label is up."
    return 0
}

start_bg() {
    # $1 pidfile, $2 logfile, $3 workdir, rest: command
    # The pidfile records the DAEMON's own pid (nohup execs the command in
    # place) — not a wrapper shell's — so status checks and targeted kills
    # always hit the real process. The subshell exits immediately; the
    # daemon is orphaned to init on purpose (it must outlive the launcher).
    local pidfile="$1" logfile="$2" dir="$3"; shift 3
    ( cd "$dir" || exit 1
      nohup "$@" >>"$logfile" 2>&1 &
      echo $! >"$pidfile" )
}

# ---- stopping ------------------------------------------------------------------
stop_one() {
    # $1 = component name (pidfile is $APP_DIR/$1.pid)
    local name="$1" pidfile="$APP_DIR/$1.pid" pid
    if [ -f "$pidfile" ]; then
        pid="$(cat "$pidfile" 2>/dev/null)"
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            pkill -P "$pid" 2>/dev/null
            kill "$pid" 2>/dev/null
            say "stopped $name (pid $pid)"
        fi
        rm -f "$pidfile"
    fi
}

port_pids() {
    # PIDs listening on a TCP port: lsof first (the macOS path), ss as a
    # fallback (some Linux sandboxes' lsof misses IPv6 listeners).
    local port="$1" pids=""
    if command -v lsof >/dev/null 2>&1; then
        pids="$(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null)"
    fi
    if [ -z "$pids" ] && command -v ss >/dev/null 2>&1; then
        pids="$(ss -tlnp "sport = :$port" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u)"
    fi
    echo "$pids"
}

sweep_port() {
    # Kill whatever still listens on a stack port (a stale process whose
    # pidfile was lost). Only our own stack ever uses these ports here.
    local port="$1" pids
    pids="$(port_pids "$port")"
    if [ -n "$pids" ]; then
        say "clearing stale listener(s) on port $port: $(echo $pids | tr '\n' ' ')"
        kill $pids 2>/dev/null
        sleep 1
        pids="$(port_pids "$port")"
        [ -n "$pids" ] && kill -9 $pids 2>/dev/null
    fi
}

sweep_stack_patterns() {
    # Last-resort sweep: any process whose command line runs from inside
    # this install's engine / client / bot folders is ours by definition.
    local dir
    for dir in "$ENGINE_DIR" "$CLIENT_DIR" "$APP_DIR/bot"; do
        if [ -d "$dir" ] && pgrep -f "$dir" >/dev/null 2>&1; then
            say "clearing leftover process(es) running from $dir"
            pkill -f "$dir" 2>/dev/null
        fi
    done
    # The bot host is started with a RELATIVE command line
    # ("node bot-host.mjs" from inside the bot folder), so the path sweep
    # above cannot see it; match its exact invocation instead. It has no
    # port to sweep and must never survive a restart as a duplicate.
    if pgrep -f "node bot-host\.mjs" >/dev/null 2>&1; then
        say "clearing leftover bot-host process(es)"
        pkill -f "node bot-host\.mjs" 2>/dev/null
    fi
}

stop_stack() {
    stop_one bot-host
    stop_one client
    stop_one server
    stop_one practice   # legacy Stage 4-6 practice page, if one is still around
    sweep_port 9500
    sweep_port 3000
    sweep_stack_patterns
    # Wait until the ports actually answer no more (max ~20s).
    local waited=0
    while [ "$waited" -lt 20 ]; do
        if ! server_ok && ! client_ok; then return 0; fi
        sleep 2; waited=$((waited + 2))
    done
    say "WARNING: old stack processes did not fully stop; starting anyway."
}

# ---- --stop / --status ------------------------------------------------------------
if [ "${1:-}" = "--stop" ]; then
    stop_stack
    say "Stack stopped."
    exit 0
fi
if [ "${1:-}" = "--status" ]; then
    server_ok   && say "server:   UP $SERVER_URL"   || say "server:   down"
    client_ok   && say "client:   UP $CLIENT_URL"   || say "client:   down"
    bot_host_ok && say "bot-host: UP (sends the bot into lobbies named BOT...)" || say "bot-host: down"
    exit 0
fi
if [ "${SWU_DRY_RUN:-0}" = "1" ]; then
    say "DRY RUN — resolved configuration:"
    say "  APP_DIR=$APP_DIR"
    say "  ENGINE_DIR=$ENGINE_DIR ($( [ -d "$ENGINE_DIR" ] && echo present || echo MISSING))"
    say "  CLIENT_DIR=$CLIENT_DIR ($( [ -d "$CLIENT_DIR" ] && echo present || echo MISSING))"
    say "  node=$(command -v node) $(node --version), NODE_OPTIONS=$NODE_OPTIONS"
    say "  would stop any running stack processes (hard restart), run update.sh (wait up to ${UPDATE_WAIT}s)"
    say "  would start the server from $ENGINE_DIR, the client from $CLIENT_DIR, and the bot host from $APP_DIR/bot"
    say "  would open: $CLIENT_URL in the default browser"
    exit 0
fi

# ---- 0. first-run dependency install (only when node_modules are missing) ----
# A fresh copy of this app ships without node_modules for the engine and
# the client (they are platform-specific and huge). Install them once, with
# the bundled Node, the first time the launcher runs. Needs internet; every
# later launch skips this. The bot's dependencies are BUNDLED in the
# package (bot/node_modules — pure JS, platform-independent), so the bot
# needs no install step and can never fail to start over missing deps.
if [ "$(uname -s)" = "Darwin" ]; then
    xattr -dr com.apple.quarantine "$ROOT" 2>/dev/null || true
fi
for dep_dir in "$ENGINE_DIR" "$CLIENT_DIR"; do
    if [ ! -d "$dep_dir/node_modules" ]; then
        say "First run: installing dependencies in $dep_dir (needs internet, takes a few minutes)..."
        if ! ( cd "$dep_dir" && npm install ); then
            say "ERROR: dependency install failed in $dep_dir."
            say "The first launch needs an internet connection. Connect and double-click again — finished parts are kept."
            exit 1
        fi
        say "Dependencies installed for $dep_dir."
    fi
done
if [ ! -d "$APP_DIR/bot/node_modules/socket.io-client" ]; then
    say "WARNING: bot/node_modules is missing from this package — the bot host will not be able to send the bot into games."
    say "Re-apply the latest patch zip, which bundles the bot's dependencies."
fi

# ---- 1. hard restart: stop whatever is running ----------------------------------
say "Stopping any running stack processes (every launch starts fresh)..."
stop_stack

# ---- 2. updater (fail-soft; bounded wait, then it finishes in the background) -----
say "Running the updater first (fail-soft — offline is fine)..."
( cd "$APP_DIR" && ./update.sh >/dev/null 2>&1 ) &
update_pid=$!
waited=0
while kill -0 "$update_pid" 2>/dev/null && [ "$waited" -lt "$UPDATE_WAIT" ]; do
    sleep 3; waited=$((waited + 3))
done
if kill -0 "$update_pid" 2>/dev/null; then
    say "Updater still running after ${UPDATE_WAIT}s — launching anyway (it finishes in the background)."
else
    say "Updater finished."
fi

# ---- 3. game server ------------------------------------------------------------------
say "Starting the game server (first start builds for a few minutes)..."
start_bg "$APP_DIR/server.pid" "$APP_DIR/server-launcher.log" "$ENGINE_DIR" npm run dev
wait_for "Game server" server_ok 360

# ---- 4. client env (create .env.local once, never overwrite) ---------------------------
if [ ! -f "$CLIENT_DIR/.env.local" ]; then
    secret="$(grep -E '^NEXTAUTH_SECRET=' "$ENGINE_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2-)"
    if [ -n "$secret" ]; then
        {
            echo "NEXT_PUBLIC_ROOT_URL=$SERVER_URL"
            echo "NEXTAUTH_URL=$CLIENT_URL"
            echo "NEXTAUTH_SECRET=$secret"
        } > "$CLIENT_DIR/.env.local"
        say "Created the client's .env.local (secret synced from the server's .env)."
    else
        say "WARNING: client .env.local is missing and no NEXTAUTH_SECRET was found in $ENGINE_DIR/.env yet."
    fi
fi

# ---- 5. web client ---------------------------------------------------------------------
say "Starting the web client..."
start_bg "$APP_DIR/client.pid" "$APP_DIR/client-launcher.log" "$CLIENT_DIR" npm run dev
wait_for "Web client" client_ok 240

# ---- 6. bot host ------------------------------------------------------------------------
say "Starting the bot host..."
start_bg "$APP_DIR/bot-host.pid" "$APP_DIR/bot-host-launcher.log" "$APP_DIR/bot" node bot-host.mjs
sleep 2
if bot_host_ok; then
    say "Bot host is up (create a public lobby named BOT... in Karabast and the bot will join)."
else
    say "WARNING: the bot host did not stay up — see $APP_DIR/bot-host-launcher.log"
fi

# ---- 7. open Karabast ---------------------------------------------------------------------
if [ "${SWU_NO_OPEN:-0}" = "1" ]; then
    say "Ready. Karabast: $CLIENT_URL (browser open skipped)"
else
    case "$(uname -s)" in
        Darwin) open "$CLIENT_URL" ;;
        Linux)  command -v xdg-open >/dev/null 2>&1 && xdg-open "$CLIENT_URL" >/dev/null 2>&1 ;;
        *)      say "Open this URL in your browser: $CLIENT_URL" ;;
    esac
    say "Ready. Karabast: $CLIENT_URL — create a public lobby named BOT... and the bot will join."
fi
