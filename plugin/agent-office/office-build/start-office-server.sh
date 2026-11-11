#!/usr/bin/env bash
# start-office-server.sh - (re)starts the Claude Office server for the dashboard proxy, and stops the
# Vite dev server on 3333 (the proxy serves the built UI, so dev is not needed).
#
#   bash start-office-server.sh
#
# Env (defaults in brackets):
#   CLAUDE_OFFICE_DIR        [/opt/data/projects/Claude-Office]
#   AGENT_OFFICE_HOME        [/opt/data/home/.agent-office]   runtime dir: server.pid, server.log, auth-token,
#                                                              chat-poll-state, chat-watcher.pid, chat-ai.log
#   AGENT_OFFICE_PORT        [3334]
#   AGENT_OFFICE_PUBLIC_HOST [hermes-agent-cnfo.srv2094552.hstgr.cloud]  -> AGENT_OFFICE_ALLOWED_HOSTS
#   AGENT_OFFICE_CHAT_AI     [unset = off]  set to 1 to run the chat AI watcher. It answers office chat with
#                                           `claude -p` and SPENDS CLAUDE TOKENS on every message.
#                                           Off: any running watcher from this checkout is stopped and the
#                                           chat is paused (runtime dir chat-poll-state, "paused": true).
#                                           The pause only blocks the watcher's claude calls; the UI can
#                                           still resume it.
#
# Before starting the server this runs guard-upstream.sh, which makes the upstream start-office.sh
# stop spawning the watcher unless AGENT_OFFICE_CHAT_AI=1. If the guard fails, nothing is started.
#
# Same pid-file convention as Claude-Office/scripts/start-office.sh: the server runs in its own
# session (setsid), so its pid is its process group and stop is `kill -- -<pid>`.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_OFFICE_DIR="${CLAUDE_OFFICE_DIR:-/opt/data/projects/Claude-Office}"
RUNTIME_DIR="${AGENT_OFFICE_HOME:-/opt/data/home/.agent-office}"
# Pinned for the server too: without it the server falls back to $HOME/.agent-office, so a shell with
# another HOME would start a second office state (token, chat.db) the dashboard proxy never reads.
export AGENT_OFFICE_HOME="$RUNTIME_DIR"
PORT="${AGENT_OFFICE_PORT:-3334}"
PUBLIC_HOST="${AGENT_OFFICE_PUBLIC_HOST:-hermes-agent-cnfo.srv2094552.hstgr.cloud}"
CHAT_AI="${AGENT_OFFICE_CHAT_AI:-0}"
SERVER_PID_FILE="$RUNTIME_DIR/server.pid"
VITE_PID_FILE="$RUNTIME_DIR/vite.pid"
LOG="$RUNTIME_DIR/server.log"
WATCHER_PID_FILE="$RUNTIME_DIR/chat-watcher.pid"
WATCHER_LOG="$RUNTIME_DIR/chat-ai.log"
PAUSE_FILE="$RUNTIME_DIR/chat-poll-state"
WATCHER_SCRIPT="$CLAUDE_OFFICE_DIR/scripts/chat-ai-watcher.sh"

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

# Stop the chat AI watcher, but only one started from this checkout: the pid file first (its command
# line must name this checkout's watcher script), then a pkill -f on that exact path for this user only.
stop_watcher() {
  local pid args pattern
  if [ -f "$WATCHER_PID_FILE" ]; then
    pid="$(tr -d '[:space:]' < "$WATCHER_PID_FILE" 2>/dev/null || true)"
    case "$pid" in
      ''|*[!0-9]*) ;;
      *)
        args="$(ps -o args= -p "$pid" 2>/dev/null || true)"
        case "$args" in
          *"$WATCHER_SCRIPT"*)
            kill -TERM "$pid" 2>/dev/null || true
            for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
            kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null || true
            echo "stopped chat AI watcher (pid $pid)"
            ;;
        esac
        ;;
    esac
    rm -f "$WATCHER_PID_FILE"
  fi
  if command -v pkill >/dev/null 2>&1; then
    pattern="bash $(printf '%s' "$WATCHER_SCRIPT" | sed 's/[][\.*^$+?(){}|/]/\\&/g')\$"
    if pkill -u "$(id -u)" -TERM -f "$pattern" 2>/dev/null; then
      echo "stopped chat AI watcher (matched $WATCHER_SCRIPT)"
    fi
  fi
}

# Write the chat-poll pause flag the server reads (GET/POST /chat/cron-state). Atomic replace, mode 0600,
# and every other key already in the file is kept.
write_pause() {
  local paused="$1"
  command -v python3 >/dev/null 2>&1 || { echo "start-office-server: python3 missing, cannot write $PAUSE_FILE" >&2; return 1; }
  mkdir -p "$RUNTIME_DIR"
  python3 - "$PAUSE_FILE" "$paused" <<'PY'
import json, os, sys, tempfile
path, paused = sys.argv[1], sys.argv[2] == "true"
state = {}
try:
    with open(path, encoding="utf-8") as f:
        loaded = json.load(f)
    if isinstance(loaded, dict):
        state = loaded
except (OSError, ValueError):
    pass
state["paused"] = paused
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".chat-poll-state.")
with os.fdopen(fd, "w", encoding="utf-8") as f:
    json.dump(state, f)
    f.flush()
    os.fsync(f.fileno())
os.replace(tmp, path)
PY
}

# 1. Upstream guard: the watcher spawn line only runs when AGENT_OFFICE_CHAT_AI=1.
if ! bash "$SCRIPT_DIR/guard-upstream.sh"; then
  echo "start-office-server: guard-upstream.sh failed; not starting the office server" >&2
  exit 1
fi

# 2. Old server and Vite dev server.
stop_group "$VITE_PID_FILE" "vite dev server"
stop_group "$SERVER_PID_FILE" "office server"

# 3. Chat AI watcher: stop any running copy from this checkout (both modes), then pause or start it.
stop_watcher
if [ "$CHAT_AI" != "1" ]; then
  write_pause true
fi

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

if [ "$CHAT_AI" = "1" ]; then
  echo "WARNING: AGENT_OFFICE_CHAT_AI=1 runs the chat AI watcher. It spends Claude tokens (claude -p) on every chat message." >&2
  AGENT_OFFICE_PORT="$PORT" setsid bash "$WATCHER_SCRIPT" < /dev/null >> "$WATCHER_LOG" 2>&1 &
  echo $! > "$WATCHER_PID_FILE"
  echo "chat AI watcher: ON (pid $(cat "$WATCHER_PID_FILE"), log $WATCHER_LOG); spends Claude tokens"
else
  echo "chat AI watcher: OFF (AGENT_OFFICE_CHAT_AI unset; chat paused in $PAUSE_FILE)"
fi
