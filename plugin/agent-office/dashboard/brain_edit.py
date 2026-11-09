"""Agent Deck brain editor: the write side of the SOUL.md / MEMORY.md / USER.md view (brain.py holds the read side).

Routes in plugin_api.py: PUT /brain saves one file, GET /brain/versions and GET /brain/version list and read backups,
POST /brain/restore puts a backup back. Functions here take root and backup_root (None -> the module defaults) and an
optional threat scanner, so tests run entirely in temp dirs.

Agent and file names come from brain.resolve and the fixed FILES tuple; the target is always brain.paths(agent, root)[file].
No request text becomes a path piece. A write holds an flock on the target's sibling '<name>.lock' (the Hermes memory
tool's scheme), then an flock on the backup folder's '.lock', writes the current bytes to a backup, and replaces the
target through a temp file in the same folder. Backups are kept per target (newest BACKUP_KEEP). Audit lines carry
sizes, hashes and ids only, never contents, and no error body carries contents or paths.
"""
from __future__ import annotations

import fcntl
import hashlib
import importlib.util
import json
import os
import re
import secrets
import stat
import time
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

_spec = importlib.util.spec_from_file_location("agent_office_brain_core", Path(__file__).with_name("brain.py"))
brain = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(brain)

EDIT_LIMITS = brain.EDIT_LIMITS
FILES = ("soul", "memory", "user")
BACKUP_KEEP = 10
MAX_BODY_BYTES = 131072
DEFAULT_BACKUP_ROOT = Path("/opt/data/deck-backups")
AUDIT_NAME = "audit.log"
VERSION_ID_RE = re.compile(r"[0-9]{8}T[0-9]{6}_[0-9]{6}Z")
VERSION_FILE_RE = re.compile(r"[0-9]{8}T[0-9]{6}_[0-9]{6}Z\.md")
_ID_FORMAT = "%Y%m%dT%H%M%S_%fZ"
_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
_CLOEXEC = getattr(os, "O_CLOEXEC", 0)
_OPEN = os.O_RDONLY | _NOFOLLOW | _CLOEXEC
_CHUNK = 65536
LOCK_WAIT_S = 5.0  # how long a save waits for the Hermes memory tool's lock before it answers 503


class EditError(Exception):
    """A refusal: the HTTP status and the JSON body to send. Bodies never carry file contents or paths."""

    def __init__(self, status: int, body: dict):
        super().__init__(str(body.get("error", "")))
        self.status = status
        self.body = body


def _refuse(status: int, error: str, **extra) -> EditError:
    return EditError(status, {"error": error, **extra})


def _default_scanner(text: str) -> list[str]:
    """Threat-pattern findings (strict scope) from Hermes' scanner. Fails closed: if the scanner cannot be imported
    the save is refused with 503, never saved unscanned."""
    try:
        from tools.threat_patterns import scan_for_threats
    except ImportError:
        raise _refuse(503, "safety scanner unavailable")
    return list(scan_for_threats(text, scope="strict"))


def _backup_root(backup_root) -> Path:
    return DEFAULT_BACKUP_ROOT if backup_root is None else Path(backup_root)


# ---- request checks -----------------------------------------------------------------------------------------------

def _target(agent, file, root):
    aid = brain.resolve(agent)
    if aid is None:
        raise _refuse(404, "unknown agent")
    if not isinstance(file, str) or file not in FILES:
        raise _refuse(404, "unknown file")
    return aid, file, brain.paths(aid, root)[file]


def _payload(body):
    if not isinstance(body, dict):
        raise _refuse(422, "body must be a JSON object")
    return body


def _confirm(payload: dict, aid: str, key: str) -> None:
    if (key == "soul" or aid == "default") and payload.get("confirm") is not True:
        raise _refuse(428, "confirm required")


def _base_sha(payload: dict) -> str:
    base = payload.get("base_sha")
    if not isinstance(base, str):
        raise _refuse(422, "base_sha must be a string")
    return base


# ---- locks, folders, atomic writes --------------------------------------------------------------------------------

@contextmanager
def _lock(lock_path: Path, wait: float = LOCK_WAIT_S):
    """Exclusive flock on a lock file, created 0600 and never followed through a symlink. Polls for up to `wait`
    seconds, then refuses with 503: the Hermes memory tool shares these locks and must never wait on a web request."""
    try:
        fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | _NOFOLLOW | _CLOEXEC, 0o600)
    except OSError:
        raise _refuse(409, "not a regular file")
    try:
        os.fchmod(fd, 0o600)
        deadline = time.monotonic() + wait
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise _refuse(503, "busy, try again")
                time.sleep(0.05)
        yield
    finally:
        os.close(fd)  # closing the descriptor releases the flock


def _ensure_dir(p: Path) -> None:
    """A real directory, owner-only when created. A symlink or a file in its place is refused."""
    try:
        os.mkdir(p, 0o700)
    except FileExistsError:
        pass
    if not stat.S_ISDIR(os.lstat(p).st_mode):  # lstat: a symlink is not a directory here
        raise _refuse(409, "backup path is unsafe")


def _ensure_root(backup_root) -> Path:
    root = Path(backup_root)
    root.parent.mkdir(parents=True, exist_ok=True)
    _ensure_dir(root)
    return root


def _make_bdir(backup_root, aid: str, key: str) -> Path:
    root = _ensure_root(backup_root)
    _ensure_dir(root / aid)
    _ensure_dir(root / aid / key)
    return root / aid / key


def _existing_bdir(backup_root, aid: str, key: str):
    """The target's backup folder if it exists (None if not). Any symlink or non-directory on the way is refused."""
    root = Path(backup_root)
    for part in (root, root / aid, root / aid / key):
        try:
            st = os.lstat(part)
        except FileNotFoundError:
            return None
        if not stat.S_ISDIR(st.st_mode):
            raise _refuse(409, "backup path is unsafe")
    return root / aid / key


def _fsync_dir(d: Path) -> None:
    try:
        fd = os.open(d, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def _atomic_write(path: Path, data: bytes, mode: int) -> None:
    """Temp file in the same folder (O_EXCL, O_NOFOLLOW, 0600), fsync, chmod to mode, os.replace, fsync the folder.
    The temp file is removed on any failure."""
    tmp = path.parent / f".{path.name}.deck-{secrets.token_hex(8)}.tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | _NOFOLLOW | _CLOEXEC, 0o600)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
            os.fchmod(f.fileno(), mode)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise
    _fsync_dir(path.parent)


def _audit(backup_root, record: dict) -> None:
    root = _ensure_root(backup_root)
    fd = os.open(root / AUDIT_NAME, os.O_WRONLY | os.O_CREAT | os.O_APPEND | _NOFOLLOW | _CLOEXEC, 0o600)
    with os.fdopen(fd, "ab") as f:
        f.write((json.dumps(record, sort_keys=True) + "\n").encode("utf-8"))
        f.flush()
        os.fsync(f.fileno())


# ---- backups -----------------------------------------------------------------------------------------------------

def _ts(vid: str) -> float:
    return datetime.strptime(vid, _ID_FORMAT).replace(tzinfo=timezone.utc).timestamp()


def _new_id(bdir: Path) -> str:
    """UTC stamp to the microsecond, never older than the newest backup + 1 µs: a clock that went backwards must not
    make a fresh backup sort oldest, where rotation would delete it first. Bumped until no backup of that id exists.
    Called under the backup folder's lock."""
    t = datetime.now(timezone.utc)
    newest = _versions_in(bdir)
    if newest:
        last = datetime.strptime(newest[0][: -len(".md")], _ID_FORMAT).replace(tzinfo=timezone.utc)
        if t <= last:
            t = last + timedelta(microseconds=1)
    while os.path.lexists(bdir / f"{t.strftime(_ID_FORMAT)}.md"):
        t += timedelta(microseconds=1)
    return t.strftime(_ID_FORMAT)


def _versions_in(bdir: Path) -> list[str]:
    """Backup file names that match the id format and are regular files, newest first."""
    names = []
    with os.scandir(bdir) as it:
        for e in it:
            if not VERSION_FILE_RE.fullmatch(e.name):
                continue
            try:
                st = e.stat(follow_symlinks=False)
            except OSError:
                continue
            if stat.S_ISREG(st.st_mode):
                names.append(e.name)
    return sorted(names, reverse=True)


def _rotate(bdir: Path) -> None:
    for name in _versions_in(bdir)[BACKUP_KEEP:]:
        try:
            os.unlink(bdir / name)
        except FileNotFoundError:
            pass


def _write_backup(backup_root, aid: str, key: str, raw: bytes) -> str:
    bdir = _make_bdir(backup_root, aid, key)
    with _lock(bdir / ".lock"):
        vid = _new_id(bdir)
        _atomic_write(bdir / f"{vid}.md", raw, 0o600)
        _rotate(bdir)
    return vid


def _version_file(backup_root, aid: str, key: str, vid) -> Path:
    if not isinstance(vid, str) or not VERSION_ID_RE.fullmatch(vid):
        raise _refuse(404, "unknown version")
    bdir = _existing_bdir(backup_root, aid, key)
    if bdir is None:
        raise _refuse(404, "unknown version")
    p = bdir / f"{vid}.md"
    try:
        st = os.lstat(p)
    except FileNotFoundError:
        raise _refuse(404, "unknown version")
    if not VERSION_FILE_RE.fullmatch(p.name) or not stat.S_ISREG(st.st_mode):
        raise _refuse(404, "unknown version")
    return p


def _read_bytes(p: Path, cap: int) -> bytes:
    """Raw bytes of a regular file opened without following links. Missing or not regular -> 404; over cap -> 422."""
    try:
        fd = os.open(p, _OPEN)
    except OSError:
        raise _refuse(404, "unknown version")
    data = bytearray()
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise _refuse(404, "unknown version")
        while len(data) <= cap:
            chunk = os.read(fd, min(_CHUNK, cap + 1 - len(data)))
            if not chunk:
                break
            data += chunk
    finally:
        os.close(fd)
    if len(data) > cap:
        raise _refuse(422, "version too large")
    return bytes(data)


# ---- the locked compare-and-swap ----------------------------------------------------------------------------------

def _read_locked(path: Path):
    """(sha, raw) of the target as it is on disk now, read under the lock: ('', None) when missing. Anything that is
    not a regular file is 409. More than READ_CAP bytes returns a sha that never matches, so it reads as 'changed'."""
    try:
        fd = os.open(path, _OPEN)
    except FileNotFoundError:
        return "", None
    except OSError:
        raise _refuse(409, "not a regular file")
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise _refuse(409, "not a regular file")
        data = bytearray()
        while len(data) <= brain.READ_CAP:
            chunk = os.read(fd, min(_CHUNK, brain.READ_CAP + 1 - len(data)))
            if not chunk:
                break
            data += chunk
    finally:
        os.close(fd)
    if len(data) > brain.READ_CAP:
        return "over-cap", None
    return hashlib.sha256(data).hexdigest(), bytes(data)


def _discard_backup(backup_root, aid: str, key: str, vid: str) -> None:
    bdir = _existing_bdir(backup_root, aid, key)
    if bdir is None:
        return
    try:
        os.unlink(bdir / f"{vid}.md")
    except FileNotFoundError:
        pass


def _swap(aid: str, key: str, path: Path, new: bytes, base_sha: str, backup_root, action: str, same,
          version=None) -> dict:
    """Save `new` over the target if it is still the bytes base_sha names. Outside the lock: the folder check, one
    read (brain.probe), the refusals (symlink, edit block, stale sha) and the unchanged check, all on those bytes.
    Under the target lock only: re-read the bytes, check their sha is the one probed, write the backup, write the
    audit record (the intended sha_after), then the atomic replace. Redaction never runs under the lock.
    same(cur) -> True when nothing would change."""
    if path.parent.is_symlink() or not path.parent.is_dir():
        raise _refuse(409, "not editable", reason="unreadable")
    cur = brain.probe(path, key)
    if cur["kind"] in ("link", "other"):
        raise _refuse(409, "not a regular file")
    if cur["edit_block"] is not None:
        raise _refuse(409, "not editable", reason=cur["edit_block"])
    if cur["sha"] != base_sha:
        raise _refuse(409, "changed since loaded", sha=cur["sha"])
    if same(cur):
        return {"saved": False, "unchanged": True, "file": brain.file_view(path, key)}
    with _lock(path.with_name(path.name + ".lock")):
        sha_now, raw = _read_locked(path)
        if sha_now != cur["sha"]:
            raise _refuse(409, "changed since loaded", sha=sha_now)
        backup = _write_backup(backup_root, aid, key, raw) if cur["kind"] == "file" and raw is not None else None
        record = {"ts": round(time.time(), 3), "action": action, "agent": aid, "file": key,
                  "chars_before": len(cur["text"] or ""), "chars_after": len(new.decode("utf-8")),
                  "sha_before": cur["sha"], "sha_after": hashlib.sha256(new).hexdigest(), "backup": backup}
        if version is not None:
            record["version"] = version
        try:
            _audit(backup_root, record)  # before the replace: a failed audit leaves the target untouched
        except OSError:
            if backup is not None:
                _discard_backup(backup_root, aid, key, backup)
            raise _refuse(500, "audit log unavailable")
        try:
            _atomic_write(path, new, cur["mode"] if cur["mode"] is not None else 0o600)
        except BaseException:
            try:  # the audit line already promised sha_after: record that it did not happen
                _audit(backup_root, {**record, "action": action + "_aborted"})
            except OSError:
                pass
            raise
    view = brain.file_view(path, key)  # outside the lock
    out = {"saved": True, "backup": backup, "file": view}
    if version is not None:
        out["restored"] = version
    return out


# ---- public operations --------------------------------------------------------------------------------------------

def save(payload, root=None, backup_root=None, scanner=None) -> dict:
    """PUT /brain. payload: {agent, file, text, base_sha, confirm}. Checks run in this order: agent, file, confirm,
    text type, base_sha type, size, secrets, threat scan; then the locked swap."""
    payload = _payload(payload)
    aid, key, path = _target(payload.get("agent"), payload.get("file"), root)
    _confirm(payload, aid, key)
    text = payload.get("text")
    if not isinstance(text, str):
        raise _refuse(422, "text must be a string")
    base_sha = _base_sha(payload)
    text = text.replace("\r\n", "\n")  # the only normalisation: entries and their separators are kept byte-exact
    limit = EDIT_LIMITS[key]
    if len(text) > limit:
        raise _refuse(422, "over limit", chars=len(text), limit=limit)
    try:
        data = text.encode("utf-8")
    except UnicodeEncodeError:
        raise _refuse(422, "text is not valid Unicode")
    if brain.redact.redact(text) != text:
        raise _refuse(422, "text looks like it contains a secret")
    findings = (scanner or _default_scanner)(text)
    if findings:
        raise _refuse(422, "blocked pattern", findings=list(findings))
    return _swap(aid, key, path, data, base_sha, _backup_root(backup_root), "save",
                 same=lambda cur: (cur["text"] or "").replace("\r\n", "\n") == text)


def list_versions(agent, file, root=None, backup_root=None) -> dict:
    """GET /brain/versions: {versions: [{id, ts, chars, sha}]}, newest first."""
    aid, key, _ = _target(agent, file, root)
    bdir = _existing_bdir(_backup_root(backup_root), aid, key)
    if bdir is None:
        return {"versions": []}
    out = []
    for name in _versions_in(bdir):
        try:
            raw = _read_bytes(bdir / name, brain.READ_CAP)
        except EditError:
            continue  # too large or gone since the listing: not offered
        vid = name[: -len(".md")]
        out.append({"id": vid, "ts": _ts(vid), "chars": len(raw.decode("utf-8", errors="replace")),
                    "sha": hashlib.sha256(raw).hexdigest()})
    return {"versions": out}


def get_version(agent, file, vid, root=None, backup_root=None) -> dict:
    """GET /brain/version: one backup's redacted text for the diff view. restorable is False when it is over the limit
    or is not UTF-8."""
    aid, key, _ = _target(agent, file, root)
    p = _version_file(_backup_root(backup_root), aid, key, vid)
    raw = _read_bytes(p, brain.READ_CAP)
    text = raw.decode("utf-8", errors="replace")
    try:
        strict = raw.decode("utf-8")
    except UnicodeDecodeError:
        strict = None
    return {"id": vid, "ts": _ts(vid), "chars": len(text), "sha": hashlib.sha256(raw).hexdigest(),
            "text": brain.redact.redact(text),
            "restorable": strict is not None and len(strict) <= EDIT_LIMITS[key]}


def restore(payload, root=None, backup_root=None) -> dict:
    """POST /brain/restore. payload: {agent, file, id, base_sha, confirm}. The version's own bytes go back as they
    are: no redaction or threat check, since that would change what the user chose to restore. The current file is
    backed up first."""
    payload = _payload(payload)
    aid, key, path = _target(payload.get("agent"), payload.get("file"), root)
    _confirm(payload, aid, key)
    base_sha = _base_sha(payload)
    bk = _backup_root(backup_root)
    vid = payload.get("id")
    raw = _read_bytes(_version_file(bk, aid, key, vid), brain.READ_CAP)
    try:
        vtext = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise _refuse(422, "version is not UTF-8")
    limit = EDIT_LIMITS[key]
    if len(vtext) > limit:
        raise _refuse(422, "over limit", chars=len(vtext), limit=limit)
    return _swap(aid, key, path, raw, base_sha, bk, "restore", same=lambda cur: cur["raw"] == raw, version=vid)
