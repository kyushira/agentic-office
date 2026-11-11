#!/usr/bin/env bash
# start-office-server.sh - (re)starts the Claude Office server for the dashboard proxy, and stops the
# Vite dev server on 3333 (the proxy serves the built UI, so dev is not needed).
#
#   bash start-office-server.sh               background: the server runs in its own session (setsid)
#   bash start-office-server.sh --foreground  foreground: exec's node, so a supervisor (s6) owns that process
#   AGENT_OFFICE_FOREGROUND=1 bash ...        same as --foreground
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
#   AGENT_OFFICE_FOREGROUND  [0]            1 = foreground mode (see above)
#   AGENT_OFFICE_NODE_BIN    [node]         node binary to run (test hook: tests point it at a stub)
#   AGENT_OFFICE_START_TRIES [30]           polls, 0.5 s apart, to wait for the server to start and answer
#
# Server environment (Sentinel fix 1): node and the watcher start under `env -i` with only PATH, HOME, LANG
# (when set) and AGENT_OFFICE_* from the caller. ADMIN_*, DASHBOARD_*, HERMES_* and other secrets in the caller's
# environment are not inherited.
#
# Before starting the server this runs guard-upstream.sh, which makes the upstream start-office.sh
# stop spawning the watcher unless AGENT_OFFICE_CHAT_AI=1. If the guard fails, nothing is started.
#
# server.pid (in AGENT_OFFICE_HOME) holds the pid of the node process. Background: `setsid` is exec'd, so that
# pid is the process group leader and stop is `kill -- -<pid>`. Foreground: the shell writes its own pid, then
# exec's env -> node, so the pid is the same process. Before stopping or replacing a server, the pid must still
# be a running `server/index.js` whose cwd is CLAUDE_OFFICE_DIR (checked in /proc). A stale or reused pid is
# never signalled.
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
NODE_BIN="${AGENT_OFFICE_NODE_BIN:-node}"
START_TRIES="${AGENT_OFFICE_START_TRIES:-30}"
FOREGROUND="${AGENT_OFFICE_FOREGROUND:-0}"
SERVER_PID_FILE="$RUNTIME_DIR/server.pid"
VITE_PID_FILE="$RUNTIME_DIR/vite.pid"
LOG="$RUNTIME_DIR/server.log"
WATCHER_PID_FILE="$RUNTIME_DIR/chat-watcher.pid"
WATCHER_LOG="$RUNTIME_DIR/chat-ai.log"
PAUSE_FILE="$RUNTIME_DIR/chat-poll-state"
WATCHER_SCRIPT="$CLAUDE_OFFICE_DIR/scripts/chat-ai-watcher.sh"

for arg in "$@"; do
  case "$arg" in
    --foreground) FOREGROUND=1 ;;
    *) echo "usage: start-office-server.sh [--foreground]" >&2; exit 64 ;;
  esac
done
case "$FOREGROUND" in 1|true|yes) FOREGROUND=1 ;; *) FOREGROUND=0 ;; esac

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

# Is pid a running office server from CLAUDE_OFFICE_DIR? Read from /proc (cwd and cmdline), so a pid the OS has
# since handed to another process fails the check. Linux only; without /proc nothing is ever signalled.
is_office_server() {
  local pid="$1" cwd cmd want
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  kill -0 "$pid" 2>/dev/null || return 1
  cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
  want="$(readlink -f "$CLAUDE_OFFICE_DIR" 2>/dev/null || true)"
  [ -n "$cwd" ] && [ "$cwd" = "$want" ] || return 1
  cmd="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
  case "$cmd" in *"server/index.js"*) return 0 ;; *) return 1 ;; esac
}

# Stop the office server named by server.pid, but only if that pid is still an office server from this checkout.
# A pid file naming anything else is left alone (warning). The file is removed either way.
stop_office_server() {
  local pid
  [ -f "$SERVER_PID_FILE" ] || return 0
  pid="$(tr -d '[:space:]' < "$SERVER_PID_FILE" 2>/dev/null || true)"
  if is_office_server "$pid"; then
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
    kill -0 "$pid" 2>/dev/null && kill -KILL -- "-$pid" 2>/dev/null || true
    echo "stopped office server (pid $pid)"
  elif [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    echo "start-office-server: $SERVER_PID_FILE names pid $pid, which is not an office server from $CLAUDE_OFFICE_DIR; left running" >&2
  fi
  rm -f "$SERVER_PID_FILE"
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

# The environment for node and the watcher: PATH, HOME, LANG (when set) and AGENT_OFFICE_* from the caller.
# Fills the array server_env_args for `env -i`.
server_env() {
  local name
  server_env_args=(PATH="$PATH" HOME="${HOME:-/}")
  if [ -n "${LANG:-}" ]; then server_env_args+=(LANG="$LANG"); fi
  while IFS= read -r name; do
    [ -n "$name" ] && server_env_args+=("$name=${!name}")
  done < <(compgen -e | grep '^AGENT_OFFICE_' || true)
  server_env_args+=(AGENT_OFFICE_HOME="$RUNTIME_DIR" AGENT_OFFICE_ALLOWED_HOSTS="$PUBLIC_HOST" AGENT_OFFICE_PORT="$PORT")
}

# 1. Upstream guard: the watcher spawn line only runs when AGENT_OFFICE_CHAT_AI=1.
if ! bash "$SCRIPT_DIR/guard-upstream.sh"; then
  echo "start-office-server: guard-upstream.sh failed; not starting the office server" >&2
  exit 1
fi

# node is resolved to an absolute path now: `env -i` looks commands up in the scrubbed PATH.
NODE_ABS="$(command -v "$NODE_BIN" 2>/dev/null || true)"
if [ -z "$NODE_ABS" ]; then
  echo "start-office-server: node not found ($NODE_BIN)" >&2
  exit 1
fi

# 2. Old server and Vite dev server.
stop_group "$VITE_PID_FILE" "vite dev server"
stop_office_server

# 3. Chat AI watcher: stop any running copy from this checkout (both modes), then pause or start it.
stop_watcher
if [ "$CHAT_AI" != "1" ]; then
  write_pause true
fi

cd "$CLAUDE_OFFICE_DIR"
mkdir -p "$RUNTIME_DIR"
server_env

# 4. The server.
if [ "$FOREGROUND" = 1 ]; then
  # The shell writes its own pid, then exec's env, which exec's node: one process, one pid. Output goes to the
  # supervisor (stdout/stderr), not server.log.
  echo "$$" > "$SERVER_PID_FILE"
  echo "office server (foreground) on 127.0.0.1:$PORT (allowed host: $PUBLIC_HOST)"
  exec env -i "${server_env_args[@]}" "$NODE_ABS" server/index.js < /dev/null
fi

(
  exec setsid env -i "${server_env_args[@]}" "$NODE_ABS" server/index.js
) < /dev/null >> "$LOG" 2>&1 &
pid=$!
echo "$pid" > "$SERVER_PID_FILE"

started=0
for _ in $(seq 1 "$START_TRIES"); do
  if is_office_server "$pid"; then started=1; break; fi
  kill -0 "$pid" 2>/dev/null || break
  sleep 0.5
done
if [ "$started" != 1 ]; then
  rm -f "$SERVER_PID_FILE"
  echo "start-office-server: the office server (pid $pid) did not start; see $LOG" >&2
  exit 1
fi

for _ in $(seq 1 "$START_TRIES"); do
  code="$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 "http://127.0.0.1:$PORT/" 2>/dev/null || true)"
  if [ -n "$code" ] && [ "$code" != "000" ]; then break; fi
  kill -0 "$pid" 2>/dev/null || break
  sleep 0.5
done
echo "office server pid $pid on 127.0.0.1:$PORT (allowed host: $PUBLIC_HOST)"

if [ "$CHAT_AI" = "1" ]; then
  echo "WARNING: AGENT_OFFICE_CHAT_AI=1 runs the chat AI watcher. It spends Claude tokens (claude -p) on every chat message." >&2
  (
    exec setsid env -i "${server_env_args[@]}" bash "$WATCHER_SCRIPT"
  ) < /dev/null >> "$WATCHER_LOG" 2>&1 &
  echo $! > "$WATCHER_PID_FILE"
  echo "chat AI watcher: ON (pid $(cat "$WATCHER_PID_FILE"), log $WATCHER_LOG); spends Claude tokens"
else
  echo "chat AI watcher: OFF (AGENT_OFFICE_CHAT_AI unset; chat paused in $PAUSE_FILE)"
fi
