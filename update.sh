#!/usr/bin/env bash
# update.sh — fail-soft updater for the SWU offline practice app.
#
# Run at app launch (Stage 4 launcher) or by hand. Steps:
#   1. Connectivity check — if offline, log it and exit 0.
#   2. git pull --ff-only in forceteki and forceteki-client, but ONLY when the
#      working tree is clean. Dirty repos are skipped (local changes are never
#      stashed, reset, or discarded). npm install runs only in a repo that
#      actually pulled new commits.
#   3. npm run get-cards in forceteki (refresh card definitions).
#   4. node refresh-community-decks.mjs (refresh the community deck list;
#      that script itself never empties the list on failure).
# Every step logs to update.log and the script ALWAYS exits 0 — a failed
# update must never block launching the app offline with existing data.

set -u

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE="$(dirname "$APP_DIR")"
ENGINE_DIR="$WORKSPACE/forceteki"
CLIENT_DIR="$WORKSPACE/forceteki-client"
NODE_HOME="$WORKSPACE/node26"
LOG="$APP_DIR/update.log"

# Node 26 (engine requires >=26.12.1 <27; system node is v24).
export PATH="$NODE_HOME/bin:$PATH"
# tsc / get-cards OOM on small-RAM machines without a bigger heap.
export NODE_OPTIONS="--max-old-space-size=5120"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] $*" | tee -a "$LOG"; }

log "=== update.sh run started (app dir: $APP_DIR) ==="
log "node: $(node --version 2>/dev/null || echo 'NOT FOUND')  npm: $(npm --version 2>/dev/null || echo 'NOT FOUND')"

# --- 1. Connectivity check ---------------------------------------------------
online=0
for url in https://github.com https://registry.npmjs.org https://sw-unlimited-db.com; do
  if curl -fs --max-time 10 -o /dev/null "$url" 2>/dev/null; then
    log "Connectivity: OK ($url reachable)"
    online=1
    break
  fi
done
if [ "$online" -eq 0 ]; then
  log "Connectivity: OFFLINE (no endpoint reachable) — skipping update, app data unchanged."
  log "=== update.sh finished (offline) ==="
  exit 0
fi

# --- 2. Repo updates ----------------------------------------------------------
update_repo() {
  local dir="$1" name="$2"
  if [ ! -d "$dir/.git" ]; then
    log "SKIP $name: no git repo at $dir"
    return 0
  fi
  local dirty
  dirty="$(git -C "$dir" status --porcelain 2>/dev/null)"
  if [ -n "$dirty" ]; then
    log "SKIP $name: working tree dirty, leaving local changes untouched. Changed: $(echo "$dirty" | head -5 | tr '\n' ';')"
    return 0
  fi
  local before after
  before="$(git -C "$dir" rev-parse --short HEAD 2>/dev/null)"
  log "PULL $name (clean tree, HEAD $before)..."
  if git -C "$dir" pull --ff-only >>"$LOG" 2>&1; then
    after="$(git -C "$dir" rev-parse --short HEAD 2>/dev/null)"
    if [ "$before" != "$after" ]; then
      log "UPDATED $name: $before -> $after; running npm install..."
      if (cd "$dir" && npm install >>"$LOG" 2>&1); then
        log "OK $name: npm install done"
      else
        log "WARN $name: npm install failed (continuing)"
      fi
    else
      log "OK $name: already up to date ($before), no npm install needed"
    fi
  else
    log "WARN $name: git pull --ff-only failed (continuing; output in log above)"
  fi
}

update_repo "$ENGINE_DIR" "forceteki"
update_repo "$CLIENT_DIR" "forceteki-client"

# --- 3. Card definitions -------------------------------------------------------
log "Running get-cards in forceteki (refresh card definitions)..."
# The upstream API intermittently serves brotli-encoded responses whose
# streams get cut mid-transfer through some egress proxies (ECONNRESET in
# BrotliDecompress); uncompressed responses succeed reliably, so retry —
# a later attempt usually lands an uncompressed response.
get_cards_ok=0
for attempt in 1 2 3; do
  if (cd "$ENGINE_DIR" && npm run get-cards >>"$LOG" 2>&1); then
    get_cards_ok=1
    log "OK get-cards (attempt $attempt)"
    break
  fi
  log "WARN get-cards attempt $attempt failed"
  [ "$attempt" -lt 3 ] && sleep 10
done
[ "$get_cards_ok" -eq 0 ] && log "WARN get-cards failed after 3 attempts (continuing; existing card data intact)"

# --- 4. Community decks ---------------------------------------------------------
log "Refreshing community decks (node refresh-community-decks.mjs)..."
if (cd "$APP_DIR" && node refresh-community-decks.mjs >>"$LOG" 2>&1); then
  log "OK community decks refreshed"
else
  log "WARN community-deck refresh failed — existing community-decks.json preserved (script never empties the list)"
fi

log "=== update.sh finished ==="
exit 0
