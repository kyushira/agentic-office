#!/usr/bin/env bash
# guard-upstream.sh - makes the Claude Office chat AI watcher opt-in in the upstream checkout.
#
# Upstream scripts/start-office.sh starts scripts/chat-ai-watcher.sh unconditionally. The watcher calls
# `claude -p` every few seconds while the chat is not paused, which spends Claude tokens. This wraps that
# one spawn line in an if-block that runs it only when AGENT_OFFICE_CHAT_AI=1:
#
#   # agent-office guard: chat AI watcher is opt-in
#   if [ "${AGENT_OFFICE_CHAT_AI:-0}" = "1" ]; then
#   spawn bash "$PROJECT_DIR/scripts/chat-ai-watcher.sh" >> "$CHAT_AI_LOG" 2>&1
#   fi
#
#   bash guard-upstream.sh            apply the guard (once; a second run exits 0 "already guarded")
#   bash guard-upstream.sh --check    exit 0 when guarded, 1 when not (writes nothing)
#
# The anchor is matched as a whole line and must occur exactly once. If it does not (upstream changed),
# nothing is written and the script exits 2. Env: CLAUDE_OFFICE_DIR [/opt/data/projects/Claude-Office].
set -euo pipefail

CLAUDE_OFFICE_DIR="${CLAUDE_OFFICE_DIR:-/opt/data/projects/Claude-Office}"
TARGET="$CLAUDE_OFFICE_DIR/scripts/start-office.sh"
MARKER='# agent-office guard: chat AI watcher is opt-in'
ANCHOR='spawn bash "$PROJECT_DIR/scripts/chat-ai-watcher.sh" >> "$CHAT_AI_LOG" 2>&1'

check_only=0
case "${1:-}" in
  "") ;;
  --check) check_only=1 ;;
  *) echo "usage: guard-upstream.sh [--check]" >&2; exit 64 ;;
esac

if [ ! -f "$TARGET" ]; then
  echo "guard-upstream: $TARGET not found (set CLAUDE_OFFICE_DIR)" >&2
  exit 2
fi

if grep -qxF -- "$MARKER" "$TARGET"; then
  if [ "$check_only" = 1 ]; then echo "guarded: $TARGET"; exit 0; fi
  echo "already guarded: $TARGET"
  exit 0
fi

if [ "$check_only" = 1 ]; then
  echo "not guarded: $TARGET"
  exit 1
fi

count="$(grep -cxF -- "$ANCHOR" "$TARGET" || true)"
if [ "$count" != 1 ]; then
  echo "guard-upstream: anchor line found $count times in $TARGET (expected 1); upstream changed, nothing written" >&2
  exit 2
fi

tmp="$(mktemp "$TARGET.guard.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
# Exact whole-line replacement; awk -v passes the text through without regex or escape interpretation.
awk -v anchor="$ANCHOR" -v marker="$MARKER" '
  $0 == anchor {
    print marker
    print "if [ \"${AGENT_OFFICE_CHAT_AI:-0}\" = \"1\" ]; then"
    print $0
    print "fi"
    next
  }
  { print }
' "$TARGET" > "$tmp"

# Write through the existing file so its mode and inode are kept.
cat "$tmp" > "$TARGET"
echo "guarded: $TARGET"
