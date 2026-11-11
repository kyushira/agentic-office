#!/usr/bin/env bash
# install-office-service.sh - installs the Claude Office server as an s6 longrun in the live /run/service scandir.
#
#   bash install-office-service.sh            install and rescan (run as root in the container)
#   bash install-office-service.sh --remove   rollback: stop the service and remove it from /run/service
#
# /run/service is tmpfs: a container restart wipes this install (see README "Office server service").
# Source of truth: s6/agent-office-server/ in this checkout. @OFFICE_BUILD_DIR@ in its run file is replaced with
# this checkout's office-build directory.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$SCRIPT_DIR/s6/agent-office-server"
SCANDIR="${S6_SCANDIR:-/run/service}"
NAME="agent-office-server"
DEST="$SCANDIR/$NAME"

if [ "${1:-}" = "--remove" ]; then
  if [ -d "$DEST" ]; then
    s6-svc -d "$DEST" 2>/dev/null || true
    s6-svc -D "$DEST" 2>/dev/null || true
    rm -rf "$DEST"
    s6-svscanctl -a "$SCANDIR"
    echo "removed $NAME from $SCANDIR"
  else
    echo "$NAME is not installed in $SCANDIR"
  fi
  exit 0
fi

[ -d "$SRC" ] || { echo "install-office-service: missing $SRC" >&2; exit 1; }
[ -d "$SCANDIR" ] || { echo "install-office-service: $SCANDIR is not an s6 scandir here" >&2; exit 1; }
command -v s6-svscanctl >/dev/null 2>&1 || { echo "install-office-service: s6-svscanctl not found" >&2; exit 1; }

tmp="$SCANDIR/.$NAME.tmp"
rm -rf "$tmp"
mkdir -p "$tmp"
cp "$SRC/type" "$tmp/type"
cp "$SRC/finish" "$tmp/finish"
sed "s|@OFFICE_BUILD_DIR@|$SCRIPT_DIR|g" "$SRC/run" > "$tmp/run"
chmod 0755 "$tmp/run" "$tmp/finish"
# Replace in one step so an interrupted copy never leaves a half-built service directory.
if [ -d "$DEST" ]; then
  s6-svc -d "$DEST" 2>/dev/null || true
  rm -rf "$DEST"
fi
mv "$tmp" "$DEST"
s6-svscanctl -a "$SCANDIR"
echo "installed $NAME into $SCANDIR (run: $SCRIPT_DIR/start-office-server.sh --foreground)"
