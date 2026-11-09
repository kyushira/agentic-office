"""Agent Deck brain: read-only view of each agent's SOUL.md, MEMORY.md and USER.md (GET /brain in plugin_api.py).

Only a fixed whitelist of agents is readable, and each agent maps to a fixed set of files built from the root:
no request text ever becomes a path piece. Symlinks and non-regular files count as missing. Each file is read
with O_NOFOLLOW, at most READ_CAP bytes; the text is redacted (redact.py) before it leaves, then capped at TEXT_CAP
characters. Nothing here writes.
"""
from __future__ import annotations

import errno
import hashlib
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
EDIT_LIMITS = {"soul": 20000, "memory": 2200, "user": 1375}  # chars after CRLF->LF; brain_edit.py enforces them on PUT
READ_CAP = 65536  # bytes read per file
TEXT_CAP = 20000  # characters of redacted text returned per file (a SOUL up to EDIT_LIMITS['soul'] comes back whole)
_CHUNK = 65536
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

    return _view(data, st.st_size, st.st_mtime, limit)


def _view(data: bytes, size: int, mtime, limit) -> dict:
    """read_file's dict, built from bytes already read: data is at most READ_CAP bytes, size the file's full size."""
    big = size > READ_CAP
    raw = data.decode("utf-8", errors="replace")
    if big and "\n" in raw:
        # Drop the cut-off last line: a secret split at READ_CAP would otherwise pass redaction unseen.
        raw = raw[: raw.rfind("\n") + 1]
    chars = size if big else len(raw)
    full = redact.redact(raw)
    text = redact.redact(raw, TEXT_CAP)
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    return {
        "exists": True,
        "mtime": mtime,
        "chars": chars,
        "limit": limit,
        "pct": round(100 * chars / limit, 1) if limit else None,
        "text": text,
        "truncated": big or len(full) > TEXT_CAP,
        "first": redact.cap(lines[0], FIRST_CAP) if lines else "",
        "redacted": text.count("[redacted"),
        "error": None,
    }


def _blocked(out: dict, why: str) -> dict:
    out.update(edit_block=why, editable=False)
    return out


_PRIVATE = ("view_data", "size", "mtime", "unreadable")


def _slurp(fd: int):
    """Every byte of an open file, read once: (sha256 hex of all of them, the first READ_CAP+1 of them, total count)."""
    digest = hashlib.sha256()
    data = bytearray()
    total = 0
    while True:
        chunk = os.read(fd, _CHUNK)
        if not chunk:
            break
        total += len(chunk)
        digest.update(chunk)  # the whole file is hashed, so sha is of the bytes on disk
        if len(data) <= READ_CAP:
            data += chunk[: READ_CAP + 1 - len(data)]
    return digest.hexdigest(), bytes(data), total


def _state(path, key: str) -> dict:
    """The one read of a file that every editor view is built from. kind is 'missing', 'file', 'link', 'other' or
    'blocked' (parent folder missing or symlinked, or the file cannot be opened). Keys that probe() hides: view_data,
    size and mtime (from the same descriptor as sha), unreadable (an OS error on open or read)."""
    out = {"kind": "blocked", "sha": "", "mode": None, "raw": None, "text": None,
           "edit_limit": EDIT_LIMITS[key], "edit_block": "unreadable", "editable": False}
    path = Path(path)
    try:
        if path.parent.is_symlink() or not path.parent.is_dir():
            return out
        st = os.lstat(path)
    except FileNotFoundError:
        out.update(kind="missing", edit_block=None, editable=True)
        return out
    except OSError:
        out["unreadable"] = True
        return out
    if not stat.S_ISREG(st.st_mode):
        out["kind"] = "link" if stat.S_ISLNK(st.st_mode) else "other"
        return out
    try:
        fd = os.open(path, _OPEN_FLAGS)
    except OSError:
        out["unreadable"] = True
        return out
    try:
        fst = os.fstat(fd)
        if not stat.S_ISREG(fst.st_mode):
            out["kind"] = "other"
            return out
        sha, data, total = _slurp(fd)
    except OSError:
        out["unreadable"] = True
        return out
    finally:
        os.close(fd)
    out.update(kind="file", sha=sha, mode=stat.S_IMODE(fst.st_mode), size=total, mtime=fst.st_mtime, view_data=data)
    if total > READ_CAP:
        return _blocked(out, "too_large")
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return _blocked(out, "unreadable")
    full = redact.redact(text)
    if len(full) > TEXT_CAP:
        return _blocked(out, "too_large")
    if full != text:
        return _blocked(out, "redacted")
    out.update(raw=data, text=text, edit_block=None, editable=True)
    return out


def probe(path, key: str) -> dict:
    """Write-side state of one file, read-only. kind is 'missing', 'file', 'link', 'other' or 'blocked' (parent folder
    missing or symlinked, or the file cannot be opened). sha is sha256 of the raw bytes on disk ('' when missing),
    mode the permission bits (None when missing). raw and text are kept only when editable.
    edit_block is None when editable, else:
      'redacted'   the redacted view differs from the file, so saving it would write [redacted] over real text;
      'too_large'  over READ_CAP bytes or TEXT_CAP characters, so the view is partial;
      'unreadable' not a regular file, not UTF-8, or no folder to write into."""
    return {k: v for k, v in _state(path, key).items() if k not in _PRIVATE}


def file_view(path, key: str) -> dict:
    """One file as GET /brain and PUT /brain show it. Every field comes from the single read in _state, so sha is
    always the sha of the text shown."""
    st = _state(path, key)
    limit = None if key == "soul" else LIMITS[key]
    if st["kind"] == "file":
        view = _view(st["view_data"][:READ_CAP], st["size"], st["mtime"], limit)
    else:
        view = _missing(limit, "unreadable" if st.get("unreadable") else None)
    view.update(sha=st["sha"], edit_limit=st["edit_limit"], editable=st["editable"], edit_block=st["edit_block"])
    return view


def agent(agent_id: str, root=None) -> dict:
    p = paths(agent_id, root)
    return {
        "id": agent_id,
        "name": display_name(agent_id),
        "soul": file_view(p["soul"], "soul"),
        "memory": file_view(p["memory"], "memory"),
        "user": file_view(p["user"], "user"),
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
