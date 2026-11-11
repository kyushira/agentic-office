"""The Hermes team as live Claude Office characters, driven by each profile's state.db.

A daemon thread polls every team profile's state.db (opened read-only, mode=ro) every
TICK_SECS seconds, classifies the newest message row, and posts the matching office
events to the Claude Office server's POST /event, signed the way hooks/agent-tracker.py
signs them (HMAC-SHA256 over "POST\\n<path>\\n<ts ms>\\n<body>", headers
x-office-timestamp / x-office-signature). Only transitions and keepalives are sent.

Why worker agents and not session events: a session's own Claude is always drawn under the
title "Claude" (the assistant role's config title), so a team name could never reach the
character. agent_spawned carries name and role, so each team member is one worker agent
with the stable id hermes-<profile>.

States, from the newest message row younger than GONE_SECS:
  working  row within WORKING_SECS, or an assistant tool call still waiting (PENDING_SECS)
  idle     activity older than WORKING_SECS but within GONE_SECS
  gone     nothing within GONE_SECS, or no state.db at all
Office mapping: working -> agent_spawned + agent_working (types at the desk); idle and gone
-> agent_completed (walks out). Claude Office has no napping state for worker agents, so
idle is shown the same way as gone. An agent that is idle or gone at startup is not posted.

Cadence: the poller ticks every TICK_SECS while someone has the office open (a Claude Office
WebSocket viewer, counted by viewer_connected()/viewer_disconnected() from plugin_api) and every
IDLE_TICK_SECS (AGENT_OFFICE_TEAM_IDLE_SECS, default 60) otherwise. A viewer connecting wakes the
poller at once, so the office is current when it is opened.

Stdlib only. Never prints or logs the token or a signature. Set AGENT_OFFICE_TEAM_POLL=0
to disable the poller.
"""
import hashlib
import hmac
import importlib.util
import json
import logging
import os
import sqlite3
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

_log = logging.getLogger("agent_office.team")

TICK_SECS = 10
IDLE_TICK_SECS = 60
WORKING_SECS = 90
PENDING_SECS = 900
GONE_SECS = 900
STATUS_MIN_GAP_SECS = 10
KEEPALIVE_SECS = 60
RESPAWN_HOLD_SECS = 15
POST_TIMEOUT_SECS = 3
SQLITE_TIMEOUT_SECS = 2
TASK = "on the Hermes team"
THREAD_NAME = "agent-office-team-poll"

WORKING, IDLE, GONE = "working", "idle", "gone"

# ---------------------------------------------------------------------------
# Viewer-aware cadence
# ---------------------------------------------------------------------------

_viewer_lock = threading.Lock()
_viewers = 0
_wake = threading.Event()  # set when a viewer connects or the poller is stopped


def _idle_secs_from_env():
    raw = os.environ.get("AGENT_OFFICE_TEAM_IDLE_SECS")
    try:
        value = int(raw) if raw is not None else IDLE_TICK_SECS
    except ValueError:
        return IDLE_TICK_SECS
    return value if value > 0 else IDLE_TICK_SECS


def tick_interval(viewers):
    """Seconds between ticks: TICK_SECS while anyone is watching, the idle interval otherwise."""
    return TICK_SECS if viewers > 0 else _idle_secs_from_env()


def viewer_connected():
    """A Claude Office viewer opened the office: count it and wake the poller now."""
    global _viewers
    with _viewer_lock:
        _viewers += 1
    _wake.set()


def viewer_disconnected():
    """A viewer went away. The count never drops below zero."""
    global _viewers
    with _viewer_lock:
        _viewers = max(0, _viewers - 1)


def viewer_count():
    with _viewer_lock:
        return _viewers


# ---------------------------------------------------------------------------
# The Hermes team. `profile` is the state.db folder ("default" = the root profile, Ash).
TEAM = (
    {"profile": "default", "id": "hermes-ash", "name": "Ash", "role": "Chief of Staff"},
    {"profile": "dev", "id": "hermes-dev", "name": "Dev", "role": "Lead Developer"},
    {"profile": "red", "id": "hermes-red", "name": "Red", "role": "Research Assistant"},
    {"profile": "nova", "id": "hermes-nova", "name": "Nova", "role": "Head of Product and Game Design"},
    {"profile": "pixel", "id": "hermes-pixel", "name": "Pixel", "role": "Head of Creative and Content"},
    {"profile": "prism", "id": "hermes-prism", "name": "Prism", "role": "Head of UI and Visual Design"},
    {"profile": "sentinel", "id": "hermes-sentinel", "name": "Sentinel", "role": "Head of Quality and Security"},
)


def _load_collect():
    """collect.py, loaded the way plugin_api.py loads it (same module name, cached in sys.modules)."""
    mod = sys.modules.get("agent_office_collect")
    if mod is None:
        spec = importlib.util.spec_from_file_location("agent_office_collect", Path(__file__).with_name("collect.py"))
        mod = importlib.util.module_from_spec(spec)
        sys.modules["agent_office_collect"] = mod
        spec.loader.exec_module(mod)
    return mod


collect = _load_collect()


# ---------------------------------------------------------------------------
# Pure state derivation
# ---------------------------------------------------------------------------

def status_text(role, tool):
    """What the character says it is doing: a tool name in words, never arguments."""
    if role == "tool" and tool:
        return collect.VERBS.get(tool) or "using " + tool.replace("_", " ")
    return "thinking"


def classify(row, now):
    """(state, status, tool) for the newest message row, or (GONE, None, None) for None.

    row is (timestamp, role, tool_name, pending), newest first: pending means the newest row
    is an assistant message that carries tool calls, so the call has not come back yet.
    """
    if row is None:
        return GONE, None, None
    ts, role, tool, pending = row
    age = now - ts
    if age > GONE_SECS:
        return GONE, None, None
    if age <= WORKING_SECS or (pending and age <= PENDING_SECS):
        return WORKING, status_text(role, tool), tool if role == "tool" else None
    return IDLE, None, None


# ---------------------------------------------------------------------------
# Office events (the shapes server/index.js POST /event accepts)
# ---------------------------------------------------------------------------

def spawn_event(member):
    return {"type": "agent_spawned",
            "agent": {"id": member["id"], "name": member["name"], "role": member["role"], "task": TASK}}


def working_event(member, status, tool=None):
    event = {"type": "agent_working", "agentId": member["id"], "status": status}
    if tool:
        event["tool"] = tool
    return event


def completed_event(member, state):
    return {"type": "agent_completed", "agentId": member["id"], "result": f"clocked out ({state})"}


def plan(member, meta, state, status, tool, now):
    """Events to post for one member now, given what the office was last told (meta).

    Empty when the office already shows what we want. Keepalive re-sends spawn as well: a
    replayed spawn is a no-op for a known agent and re-seats one the server has forgotten
    (for example after a restart of the office server).
    """
    present = meta.get("present", False)
    if state == WORKING:
        if not present:
            if now - meta.get("left_at", float("-inf")) < RESPAWN_HOLD_SECS:
                return []  # the office is still walking the last one out; a spawn now would be ignored
            return [spawn_event(member), working_event(member, status, tool)]
        since_post = now - meta.get("last_post", 0.0)
        if since_post >= KEEPALIVE_SECS:
            return [spawn_event(member), working_event(member, status, tool)]
        if status != meta.get("status") and since_post >= STATUS_MIN_GAP_SECS:
            return [working_event(member, status, tool)]
        return []
    if present:
        return [completed_event(member, state)]
    return []


def apply_ack(meta, event, now):
    """The new meta after the office accepted `event`. Pure: returns a new dict."""
    out = dict(meta)
    kind = event["type"]
    if kind == "agent_spawned":
        out["present"] = True
        out.pop("left_at", None)
    elif kind == "agent_working":
        out["present"] = True
        out["status"] = event["status"]
        out["last_post"] = now
    elif kind == "agent_completed":
        out["present"] = False
        out["left_at"] = now
        out.pop("status", None)
    return out


# ---------------------------------------------------------------------------
# Signing and transport
# ---------------------------------------------------------------------------

def sign(token, path, ts, body):
    """HMAC-SHA256(token, 'POST\\n' + path + '\\n' + ts + '\\n' + body), hex. Matches hooks/agent-tracker.py sign_post."""
    msg = ("POST\n" + path + "\n" + ts + "\n").encode() + body
    return hmac.new(token.encode(), msg, hashlib.sha256).hexdigest()


def build_request(event, token, port, ts_ms):
    """(url, headers, body) for one POST /event. body is the exact byte string that was signed."""
    body = json.dumps(event, separators=(",", ":")).encode()
    ts = str(int(ts_ms))
    headers = {
        "Content-Type": "application/json",
        "x-office-timestamp": ts,
        "x-office-signature": sign(token, "/event", ts, body),
    }
    return f"http://127.0.0.1:{port}/event", headers, body


def read_token(token_path):
    """The office token, read on every tick so a rotated token is picked up. None when unreadable."""
    try:
        token = Path(token_path).read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return token or None


def read_row(home, since):
    """Newest message row at or after `since`, from a read-only connection: (ts, role, tool_name, pending) or None.

    Raises sqlite3.Error when the database cannot be read (the caller then keeps the last state).
    """
    path = Path(home) / "state.db"
    if not path.exists():
        return None
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=SQLITE_TIMEOUT_SECS)
    try:
        row = conn.execute(
            "select timestamp, role, tool_name, tool_calls from messages "
            "where timestamp >= ? order by timestamp desc, id desc limit 1", (since,)).fetchone()
    finally:
        conn.close()
    if row is None:
        return None
    # tool_calls is JSON text; "" or "[]" means no calls (same rule as collect.py)
    calls = row[3] or ""
    pending = row[1] == "assistant" and calls not in ("", "[]")
    return float(row[0]), row[1], row[2], pending


# ---------------------------------------------------------------------------
# The poller
# ---------------------------------------------------------------------------

class Poller:
    def __init__(self, root, token_path, port, post=None):
        self.root = Path(root)
        self.token_path = token_path
        self.port = port
        self.meta = {}
        self._post = post or self._http_post
        self._stop = threading.Event()
        self._last_error = None

    def stop(self):
        self._stop.set()
        _wake.set()

    def homes(self):
        return {p["id"]: p["home"] for p in collect.discover(self.root)}

    def _http_post(self, event, token, now):
        url, headers, body = build_request(event, token, self.port, now * 1000)
        req = urllib.request.Request(url, data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=POST_TIMEOUT_SECS) as resp:
                ok = 200 <= resp.status < 300
                self._last_error = None
                return ok
        except urllib.error.HTTPError as exc:
            self._note_error(f"office answered HTTP {exc.code}")
        except (urllib.error.URLError, OSError, ValueError) as exc:
            self._note_error(f"office unreachable ({type(exc).__name__})")
        return False

    def _note_error(self, text):
        # Log a change of error, not every tick: a down office would otherwise log every 10 s
        if text != self._last_error:
            self._last_error = text
            _log.warning("agent-office team: %s; retrying", text)

    def tick(self, now=None):
        """One pass over the team. Posts only what the office does not show yet."""
        now = time.time() if now is None else now
        token = read_token(self.token_path)
        if token is None:
            return
        homes = self.homes()
        for member in TEAM:
            home = homes.get(member["profile"])
            try:
                row = read_row(home, now - GONE_SECS) if home is not None else None
            except sqlite3.Error:
                continue  # unreadable this tick: keep what the office was told
            state, status, tool = classify(row, now)
            meta = self.meta.get(member["id"], {})
            for event in plan(member, meta, state, status, tool, now):
                if not self._post(event, token, now):
                    break
                meta = apply_ack(meta, event, now)
            self.meta[member["id"]] = meta

    def run_forever(self):
        while not self._stop.is_set():
            # Clear before the tick: a viewer that connects during the tick sets the event again,
            # so the wait below returns at once and nothing is missed.
            _wake.clear()
            try:
                self.tick()
            except Exception as exc:  # the poller must never die; log the class only
                _log.warning("agent-office team poll failed (%s); retrying", type(exc).__name__)
            if self._stop.is_set():
                break
            _wake.wait(tick_interval(viewer_count()))


_start_lock = threading.Lock()


def start(root, token_path, port):
    """Start the one poller thread. Returns the Poller, or None when disabled or already running."""
    if os.environ.get("AGENT_OFFICE_TEAM_POLL", "1") == "0":
        return None
    with _start_lock:
        if any(t.name == THREAD_NAME and t.is_alive() for t in threading.enumerate()):
            return None
        poller = Poller(root, token_path, port)
        threading.Thread(target=poller.run_forever, name=THREAD_NAME, daemon=True).start()
        return poller
