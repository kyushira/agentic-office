"""Agent Deck brain: read-only view of each agent's SOUL.md, MEMORY.md and USER.md (GET /brain in plugin_api.py).

Only a fixed whitelist of agents is readable, and each agent maps to a fixed set of files built from the root:
no request text ever becomes a path piece. Symlinks and non-regular files count as missing. Each file is read
with O_NOFOLLOW, at most READ_CAP bytes; the text is redacted (redact.py) before it leaves, then capped at TEXT_CAP
characters. Nothing here writes.
"""
from __future__ import annotations

import errno
import importlib.util
import os
import stat
from pathlib import Path


def _load(name: str):
    spec = importlib.util.spec_from_file_location(f"agent_office_{name}", Path(__file__).with_name(f"{name}.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


redact = _load("redact")

DEFAULT_ROOT = Path("/opt/data")
AGENTS = ("default", "dev", "nova", "pixel", "prism", "red", "sentinel")
ALIASES = {"ash": "default", "hermes": "default"}
LIMITS = {"memory": 2200, "user": 1375}
READ_CAP = 65536  # bytes read per file
TEXT_CAP = 16000  # characters of redacted text returned per file
FIRST_CAP = 140
_OPEN_FLAGS = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)


def _root(root) -> Path:
    return DEFAULT_ROOT if root is None else Path(root)


def display_name(agent_id: str) -> str:
    return "Ash" if agent_id == "default" else agent_id[:1].upper() + agent_id[1:]


def resolve(agent):
    """Canonical agent id, or None. Anything that is not an exact whitelisted id (after lower/strip and aliases)
    is refused, so traversal strings like '../default' or 'dev/../nova' never resolve."""
    if not isinstance(agent, str):
        return None
    key = agent.strip().lower()
    key = ALIASES.get(key, key)
    return key if key in AGENTS else None


def paths(agent_id: str, root=None) -> dict[str, Path]:
    """Fixed file map for a whitelisted agent id. Callers must pass an id from resolve()."""
    base = _root(root)
    if agent_id != "default":
        base = base / "profiles" / agent_id
    return {"soul": base / "SOUL.md", "memory": base / "memories" / "MEMORY.md", "user": base / "memories" / "USER.md"}


def _missing(limit, error=None) -> dict:
    return {
        "exists": False,
        "mtime": None,
        "chars": 0,
        "limit": limit,
        "pct": 0.0 if limit else None,
        "text": "",
        "truncated": False,
        "first": "",
        "redacted": 0,
        "error": error,
    }


def read_file(path, limit=None) -> dict:
    """One file, read-only and redacted. Missing, symlinked or non-regular -> exists False. Any other OSError ->
    exists False with error 'unreadable'."""
    path = Path(path)
    try:
        if path.is_symlink():
            return _missing(limit)
        fd = os.open(path, _OPEN_FLAGS)
    except (FileNotFoundError, NotADirectoryError):
        return _missing(limit)
    except OSError as exc:
        if exc.errno == errno.ELOOP:
            return _missing(limit)
        return _missing(limit, "unreadable")
    try:
        st = os.fstat(fd)  # checked on the fd, before any read: open() on a directory already fails
        if not stat.S_ISREG(st.st_mode):
            return _missing(limit)
        data = b""
        while len(data) < READ_CAP:
            chunk = os.read(fd, READ_CAP - len(data))
            if not chunk:
                break
            data += chunk
    except OSError:
        return _missing(limit, "unreadable")
    finally:
        os.close(fd)

    big = st.st_size > READ_CAP
    raw = data.decode("utf-8", errors="replace")
    if big and "\n" in raw:
        # Drop the cut-off last line: a secret split at READ_CAP would otherwise pass redaction unseen.
        raw = raw[: raw.rfind("\n") + 1]
    chars = st.st_size if big else len(raw)
    full = redact.redact(raw)
    text = redact.redact(raw, TEXT_CAP)
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    return {
        "exists": True,
        "mtime": st.st_mtime,
        "chars": chars,
        "limit": limit,
        "pct": round(100 * chars / limit, 1) if limit else None,
        "text": text,
        "truncated": big or len(full) > TEXT_CAP,
        "first": redact.cap(lines[0], FIRST_CAP) if lines else "",
        "redacted": text.count("[redacted"),
        "error": None,
    }


def agent(agent_id: str, root=None) -> dict:
    p = paths(agent_id, root)
    return {
        "id": agent_id,
        "name": display_name(agent_id),
        "soul": read_file(p["soul"], None),
        "memory": read_file(p["memory"], LIMITS["memory"]),
        "user": read_file(p["user"], LIMITS["user"]),
    }


_agent = agent  # snapshot's `agent` parameter shadows the function name


def snapshot(agent=None, root=None) -> dict:
    """All whitelisted agents in order, or the one named. An agent that does not resolve -> no agents and
    unknown_agent True."""
    limits = dict(LIMITS)
    if agent is None:
        return {"agents": [_agent(a, root) for a in AGENTS], "limits": limits, "unknown_agent": False}
    aid = resolve(agent)
    if aid is None:
        return {"agents": [], "limits": limits, "unknown_agent": True}
    return {"agents": [_agent(aid, root)], "limits": limits, "unknown_agent": False}
