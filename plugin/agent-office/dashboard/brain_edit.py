"""Agent Deck brain editor: the write side of the SOUL.md / MEMORY.md / USER.md view (brain.py holds the read side).

Routes in plugin_api.py: PUT /brain saves one file, GET /brain/versions and GET /brain/version list and read backups,
POST /brain/restore puts a backup back. Functions here take root and backup_root (None -> the module defaults) and an
optional threat scanner, so tests run entirely in temp dirs.

Feature flag (edit_enabled): the env var DECK_BRAIN_EDIT decides when it is set and non-empty; otherwise the JSON file
DECK_CONFIG must say {"brain_edit": true}. The file is read on every request. Off: PUT /brain and POST /brain/restore
answer 403, and GET /brain marks every file editable=false with edit_block 'disabled'.

Confirm tokens: a save or restore of SOUL.md, or of any file of agent 'default', needs a one-time token. GET /brain and
GET /brain/version issue it (issue_token), bound to the agent, the file and the sha the write is based on. Tokens live
in memory for TOKEN_TTL_S seconds. The first successful write spends one; a refusal before the write does not, and a
write that fails before it is done gives the token back.

Threat scan: a restore is scanned (Hermes' scanner, strict scope) before the bytes go back. Findings refuse it unless
the request sets override_findings true, and the audit line then says so. A scanner that cannot be imported fails
closed (503) even with the override. GET /brain/version reports the findings for the diff view.

Target paths: the target is always brain.paths(agent, root)[file]; no request text becomes a path piece. A write holds
an flock on the target's sibling '<name>.lock' (the Hermes memory tool's scheme), then an flock on the backup folder's
'.lock', writes the current bytes to a backup, and replaces the target through a temp file in the same folder. Backups
are kept per target (newest BACKUP_KEEP). Audit lines (audit.log, rotated at AUDIT_MAX_BYTES, AUDIT_KEEP old files
kept) carry sizes, hashes, ids and the author only, never contents, and no error body carries contents or paths.
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
import threading
import time
import unicodedata
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
AUDIT_MAX_BYTES = 1048576  # audit.log is rotated before an append once it holds this many bytes
AUDIT_KEEP = 3  # rotated files kept: audit.log.1 (newest) .. audit.log.3
AUTHOR_MAX = 128
VERSION_ID_RE = re.compile(r"[0-9]{8}T[0-9]{6}_[0-9]{6}Z")
VERSION_FILE_RE = re.compile(r"[0-9]{8}T[0-9]{6}_[0-9]{6}Z\.md")
_ID_FORMAT = "%Y%m%dT%H%M%S_%fZ"
_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
_CLOEXEC = getattr(os, "O_CLOEXEC", 0)
_OPEN = os.O_RDONLY | _NOFOLLOW | _CLOEXEC
_CHUNK = 65536
LOCK_WAIT_S = 5.0  # how long a save waits for the Hermes memory tool's lock before it answers 503

ENV_FLAG = "DECK_BRAIN_EDIT"
DECK_CONFIG = Path("/opt/data/deck-config.json")
CONFIG_CAP = 4096  # bytes; a larger config file counts as off
_TRUTHY = frozenset({"1", "true", "yes", "on"})

TOKEN_TTL_S = 300
TOKEN_CAP = 256
_clock = time.monotonic  # read at call time, so tests can move time by replacing it
_tokens: dict = {}  # token -> {"aid", "key", "sha", "exp"}; dict order is issue order
_tokens_lock = threading.Lock()


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
    the write is refused with 503, never saved unscanned."""
    try:
        from tools.threat_patterns import scan_for_threats
    except ImportError:
        raise _refuse(503, "safety scanner unavailable")
    return list(scan_for_threats(text, scope="strict"))


def _backup_root(backup_root) -> Path:
    return DEFAULT_BACKUP_ROOT if backup_root is None else Path(backup_root)


# ---- feature flag -------------------------------------------------------------------------------------------------

def _read_upto(fd: int, cap: int) -> bytes:
    data = bytearray()
    while len(data) < cap:
        chunk = os.read(fd, min(_CHUNK, cap - len(data)))
        if not chunk:
            break
        data += chunk
    return bytes(data)


def _config_flag(path: Path) -> bool:
    """True only for a regular, non-symlink, UTF-8 JSON object of at most CONFIG_CAP bytes whose "brain_edit" is the
    literal true. Anything else, including a missing or unreadable file, is off."""
    try:
        fd = os.open(path, _OPEN)  # O_NOFOLLOW: a symlink fails here
    except OSError:
        return False
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            return False
        raw = _read_upto(fd, CONFIG_CAP + 1)
    except OSError:
        return False
    finally:
        os.close(fd)
    if len(raw) > CONFIG_CAP:
        return False
    try:
        doc = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError, RecursionError):
        return False
    return isinstance(doc, dict) and doc.get("brain_edit") is True


def edit_enabled(config_path=None) -> bool:
    """Whether brain editing is on, evaluated on every call. DECK_BRAIN_EDIT, when set and non-empty, decides alone:
    1/true/yes/on (any case) is on, anything else is off, and the file is not read. Otherwise the config file decides
    (see _config_flag). config_path overrides DECK_CONFIG (tests)."""
    env = os.environ.get(ENV_FLAG)
    if env:
        return env.lower() in _TRUTHY
    return _config_flag(DECK_CONFIG if config_path is None else Path(config_path))


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


def _needs_token(aid: str, key: str) -> bool:
    return key == "soul" or aid == "default"


def _base_sha(payload: dict) -> str:
    base = payload.get("base_sha")
    if not isinstance(base, str):
        raise _refuse(422, "base_sha must be a string")
    return base


# ---- one-time confirm tokens --------------------------------------------------------------------------------------

def issue_token(aid: str, key: str, sha: str) -> str:
    """A token bound to (aid, key, sha), valid for TOKEN_TTL_S. An unexpired, unspent token for the same binding is
    returned again, so polling GET /brain does not grow the store. Expired tokens are pruned; past TOKEN_CAP the
    oldest are dropped."""
    with _tokens_lock:
        now = _clock()
        for tok in [t for t, e in _tokens.items() if e["exp"] <= now]:
            del _tokens[tok]
        for tok, e in _tokens.items():
            if e["aid"] == aid and e["key"] == key and e["sha"] == sha:
                return tok
        tok = secrets.token_urlsafe(32)
        _tokens[tok] = {"aid": aid, "key": key, "sha": sha, "exp": now + TOKEN_TTL_S}
        while len(_tokens) > TOKEN_CAP:
            del _tokens[next(iter(_tokens))]
        return tok


def _matches(e: dict, aid: str, key: str, sha: str) -> bool:
    return e["aid"] == aid and e["key"] == key and e["sha"] == sha


def _check_token(token: str, aid: str, key: str, sha: str) -> bool:
    """Read-only: the token is live and bound to (aid, key, sha). An expired token is dropped on the way."""
    with _tokens_lock:
        e = _tokens.get(token)
        if e is None:
            return False
        if e["exp"] <= _clock():
            del _tokens[token]
            return False
        return _matches(e, aid, key, sha)


def _spend_token(token: str, aid: str, key: str, sha: str):
    """Removes the token and returns its entry if it is live and bound to (aid, key, sha); None otherwise."""
    with _tokens_lock:
        e = _tokens.pop(token, None)
    if e is None or e["exp"] <= _clock() or not _matches(e, aid, key, sha):
        return None
    return e


def _unspend_token(token: str, e: dict) -> None:
    """Gives a spent token back after a write that did not happen, unless it has expired meanwhile."""
    with _tokens_lock:
        if e["exp"] > _clock():
            _tokens[token] = e


def _require_token(payload: dict, aid: str, key: str, base_sha: str) -> None:
    """Early check, before any read of the target: a file that needs a token must carry one that is live and bound to
    this agent, file and the payload's base_sha. Absent -> 428 'required'; otherwise 428 'invalid or expired'."""
    if not _needs_token(aid, key):
        return
    tok = payload.get("confirm_token")
    if tok is None:
        raise _refuse(428, "confirm token required")
    if not isinstance(tok, str) or not _check_token(tok, aid, key, base_sha):
        raise _refuse(428, "confirm token invalid or expired")


def mark_snapshot(snap: dict, enabled: bool) -> dict:
    """GET /brain: adds edit_enabled and, on every file, the edit state. Off: each file is editable=false with
    edit_block 'disabled' and carries no token. On: each file that needs a token gets one bound to its current sha."""
    snap["edit_enabled"] = enabled
    for ag in snap.get("agents", []):
        for key in FILES:
            f = ag[key]
            f.pop("confirm_token", None)
            if not enabled:
                f.update(editable=False, edit_block="disabled")
            elif _needs_token(ag["id"], key):
                f["confirm_token"] = issue_token(ag["id"], key, f["sha"])
    return snap


def live_state(agent, file, root=None, enabled: bool = False) -> dict:
    """GET /brain/version's restore fields: base_sha, the live file's sha now, and (when editing is on and the file
    needs one) confirm_token bound to that sha."""
    aid, key, path = _target(agent, file, root)
    sha = brain.probe(path, key)["sha"]
    out = {"base_sha": sha}
    if enabled and _needs_token(aid, key):
        out["confirm_token"] = issue_token(aid, key, sha)
    return out


# ---- audit author -------------------------------------------------------------------------------------------------

def _clean_author(author):
    """The author for an audit line: control and format characters removed, at most AUTHOR_MAX characters; None when
    nothing is left."""
    if not isinstance(author, str):
        return None
    cleaned = "".join(c for c in author if not unicodedata.category(c).startswith("C"))[:AUTHOR_MAX]
    return cleaned or None


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


# ---- audit log ----------------------------------------------------------------------------------------------------

def _rotate_audit(root: Path) -> None:
    """audit.log -> .1 -> .2 -> .3 once audit.log holds AUDIT_MAX_BYTES; the old last file is replaced. Caller holds
    the audit lock."""
    cur = root / AUDIT_NAME
    try:
        st = os.lstat(cur)
    except FileNotFoundError:
        return
    if not stat.S_ISREG(st.st_mode):
        raise OSError("audit log is not a regular file")
    if st.st_size < AUDIT_MAX_BYTES:
        return
    for n in range(AUDIT_KEEP - 1, 0, -1):  # .2 -> .3 first, so .3 is overwritten, then .1 -> .2
        try:
            os.replace(root / f"{AUDIT_NAME}.{n}", root / f"{AUDIT_NAME}.{n + 1}")
        except FileNotFoundError:
            pass
    os.replace(cur, root / f"{AUDIT_NAME}.1")


def _audit(backup_root, record: dict) -> None:
    """Appends one JSON line under the audit lock, rotating first when the log is full."""
    root = _ensure_root(backup_root)
    with _lock(root / "audit.lock"):
        _rotate_audit(root)
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


def _swap(aid: str, key: str, path: Path, new: bytes, base_sha: str, backup_root, action: str, same, *,
          version=None, token=None, extra=None, author=None) -> dict:
    """Save `new` over the target if it is still the bytes base_sha names. Outside the lock: the folder check, one
    read (brain.probe), the refusals (symlink, edit block, stale sha) and the unchanged check, all on those bytes.
    Under the target lock only: re-read the bytes, check their sha is the one probed, spend the token (if any, bound
    to that sha), write the backup, write the audit record (the intended sha_after), then the atomic replace. A
    failure before the replace gives the token back. Redaction never runs under the lock.
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
        spent = None
        if token is not None:
            spent = _spend_token(token, aid, key, sha_now)
            if spent is None:  # consumed or expired since the early check
                raise _refuse(428, "confirm token invalid or expired")
        try:
            backup = _write_backup(backup_root, aid, key, raw) if cur["kind"] == "file" and raw is not None else None
            record = {"ts": round(time.time(), 3), "action": action, "agent": aid, "file": key,
                      "chars_before": len(cur["text"] or ""), "chars_after": len(new.decode("utf-8")),
                      "sha_before": cur["sha"], "sha_after": hashlib.sha256(new).hexdigest(), "backup": backup,
                      "author": _clean_author(author)}
            if version is not None:
                record["version"] = version
            if extra:
                record.update(extra)
            try:
                _audit(backup_root, record)  # before the replace: a failed audit leaves the target untouched
            except EditError:
                if backup is not None:
                    _discard_backup(backup_root, aid, key, backup)
                raise
            except OSError:
                if backup is not None:
                    _discard_backup(backup_root, aid, key, backup)
                raise _refuse(500, "audit log unavailable")
            try:
                _atomic_write(path, new, cur["mode"] if cur["mode"] is not None else 0o600)
            except BaseException:
                try:  # the audit line already promised sha_after: record that it did not happen
                    _audit(backup_root, {**record, "action": action + "_aborted"})
                except (OSError, EditError):
                    pass
                raise
        except BaseException:
            if spent is not None:
                _unspend_token(token, spent)
            raise
    view = brain.file_view(path, key)  # outside the lock
    out = {"saved": True, "backup": backup, "file": view}
    if version is not None:
        out["restored"] = version
    return out


# ---- public operations --------------------------------------------------------------------------------------------

def save(payload, root=None, backup_root=None, scanner=None, author=None) -> dict:
    """PUT /brain. payload: {agent, file, text, base_sha, confirm_token?}. Checks run in this order: agent, file,
    base_sha type, token (soul and default only), text type, size, secrets, threat scan; then the locked swap.
    author is the audit author (see plugin_api._author)."""
    payload = _payload(payload)
    aid, key, path = _target(payload.get("agent"), payload.get("file"), root)
    base_sha = _base_sha(payload)
    _require_token(payload, aid, key, base_sha)
    text = payload.get("text")
    if not isinstance(text, str):
        raise _refuse(422, "text must be a string")
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
                 same=lambda cur: (cur["text"] or "").replace("\r\n", "\n") == text,
                 token=payload.get("confirm_token") if _needs_token(aid, key) else None, author=author)


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


def _findings_or_none(text: str, scanner):
    """(findings, scan_unavailable). The scanner cannot run -> (None, True); the diff view still works on that."""
    try:
        return list((scanner or _default_scanner)(text)), False
    except EditError as e:
        if e.status == 503:
            return None, True
        raise


def get_version(agent, file, vid, root=None, backup_root=None, scanner=None) -> dict:
    """GET /brain/version: one backup's redacted text for the diff view. restorable is False when it is over the limit
    or is not UTF-8. findings is the scanner's list on the stored text (strict decode, else replace-decoded), or None
    with scan_unavailable True when the scanner cannot run."""
    aid, key, _ = _target(agent, file, root)
    p = _version_file(_backup_root(backup_root), aid, key, vid)
    raw = _read_bytes(p, brain.READ_CAP)
    text = raw.decode("utf-8", errors="replace")
    try:
        strict = raw.decode("utf-8")
    except UnicodeDecodeError:
        strict = None
    findings, unavailable = _findings_or_none(strict if strict is not None else text, scanner)
    return {"id": vid, "ts": _ts(vid), "chars": len(text), "sha": hashlib.sha256(raw).hexdigest(),
            "text": brain.redact.redact(text),
            "restorable": strict is not None and len(strict) <= EDIT_LIMITS[key],
            "findings": findings, "scan_unavailable": unavailable}


def restore(payload, root=None, backup_root=None, scanner=None, author=None) -> dict:
    """POST /brain/restore. payload: {agent, file, id, base_sha, confirm_token?, override_findings?}. The version's own
    bytes go back as they are: no redaction. The bytes are scanned: findings refuse with 422 (overridable) unless
    override_findings is true, and then the audit line records the override and the finding count. A scanner that
    cannot run is 503 even with the override. The current file is backed up first."""
    payload = _payload(payload)
    aid, key, path = _target(payload.get("agent"), payload.get("file"), root)
    base_sha = _base_sha(payload)
    _require_token(payload, aid, key, base_sha)
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
    findings = (scanner or _default_scanner)(vtext)
    extra = None
    if findings:
        if payload.get("override_findings") is not True:
            raise _refuse(422, "blocked pattern", findings=list(findings), overridable=True)
        extra = {"override": True, "findings": len(findings)}
    return _swap(aid, key, path, raw, base_sha, bk, "restore", same=lambda cur: cur["raw"] == raw, version=vid,
                 token=payload.get("confirm_token") if _needs_token(aid, key) else None, extra=extra, author=author)
