#!/usr/bin/env bash
# start-office-server.sh - (re)starts the Claude Office server for the dashboard proxy, and stops the
# Vite dev server on 3333 (the proxy serves the built UI, so dev is not needed).
#
#   bash start-office-server.sh
#
# Env (defaults in brackets):
#   CLAUDE_OFFICE_DIR        [/opt/data/projects/Claude-Office]
#   AGENT_OFFICE_HOME        [/opt/data/home/.agent-office]   runtime dir: server.pid, server.log, auth-token
#   AGENT_OFFICE_PORT        [3334]
#   AGENT_OFFICE_PUBLIC_HOST [hermes-agent-cnfo.srv2094552.hstgr.cloud]  -> AGENT_OFFICE_ALLOWED_HOSTS
#
# Same pid-file convention as Claude-Office/scripts/start-office.sh: the server runs in its own
# session (setsid), so its pid is its process group and stop is `kill -- -<pid>`.
set -euo pipefail

CLAUDE_OFFICE_DIR="${CLAUDE_OFFICE_DIR:-/opt/data/projects/Claude-Office}"
RUNTIME_DIR="${AGENT_OFFICE_HOME:-/opt/data/home/.agent-office}"
# Pinned for the server too: without it the server falls back to $HOME/.agent-office, so a shell with
# another HOME would start a second office state (token, chat.db) the dashboard proxy never reads.
export AGENT_OFFICE_HOME="$RUNTIME_DIR"
PORT="${AGENT_OFFICE_PORT:-3334}"
PUBLIC_HOST="${AGENT_OFFICE_PUBLIC_HOST:-hermes-agent-cnfo.srv2094552.hstgr.cloud}"
SERVER_PID_FILE="$RUNTIME_DIR/server.pid"
VITE_PID_FILE="$RUNTIME_DIR/vite.pid"
LOG="$RUNTIME_DIR/server.log"

export PATH="/opt/hermes/tools/node-26.12.1-linux-x64/bin:$PATH"

stop_group() {
  local file="$1" name="$2" pid
  [ -f "$file" ] || return 0
  pid="$(cat "$file" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
    kill -0 "$pid" 2>/dev/null && kill -KILL -- "-$pid" 2>/dev/null || true
    echo "stopped $name (pid $pid)"
  fi
  rm -f "$file"
}

stop_group "$VITE_PID_FILE" "vite dev server"
stop_group "$SERVER_PID_FILE" "office server"

cd "$CLAUDE_OFFICE_DIR"
mkdir -p "$RUNTIME_DIR"
AGENT_OFFICE_ALLOWED_HOSTS="$PUBLIC_HOST" AGENT_OFFICE_PORT="$PORT" \
  setsid node server/index.js < /dev/null >> "$LOG" 2>&1 &
echo $! > "$SERVER_PID_FILE"

for _ in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 "http://127.0.0.1:$PORT/" || true)"; if [ -n "$code" ] && [ "$code" != "000" ]; then break; fi
  sleep 0.5
done
echo "office server pid $(cat "$SERVER_PID_FILE") on 127.0.0.1:$PORT (allowed host: $PUBLIC_HOST)"
