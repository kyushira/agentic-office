"""Agent Deck memory drop box: save, list and delete notes in the inbox folder (/api/plugins/agent-office/inbox).

Pure functions and one error type; no FastAPI here (plugin_api.py owns the routes). Items are text (.txt), markdown
(.md) or PDF (.pdf). A URL is saved as a .md note holding the URL; it is never fetched by this module.

Names are generated on the server: <UTC stamp>-<slug><ext>, slug [a-z0-9-] up to 40 characters, with a -N suffix on
collision. Client file names are checked (no path separators, no '..', no '%', no NUL) and contribute only an
allowlisted extension and a slug. Files are written 0o600 through a dotted temp file in the inbox and linked into
place with os.link, which refuses to overwrite. Contents are never executed or parsed beyond these checks: PDFs must
start with '%PDF-'; text must be UTF-8 with no NUL bytes.

Writes are guarded by check_write_request (defence in depth; the dashboard's own auth runs first).
"""
from __future__ import annotations

import base64
import binascii
import os
import re
import secrets
import stat
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Mapping
from urllib.parse import urlsplit

MAX_FILE_BYTES = 2 * 1024 * 1024  # per item (files and URL/text notes alike)
MAX_TEXT_BYTES = 256 * 1024  # pasted text
MAX_BODY_BYTES = 3 * 1024 * 1024  # whole request body: base64 of a 2 MiB file plus JSON or multipart overhead
MAX_URL_CHARS = 2048
MAX_TITLE_CHARS = 120
SLUG_MAX = 40
LIST_MAX = 100
DIR_ENV = "AGENT_DECK_INBOX_DIR"
DEFAULT_DIR = Path("/opt/data/memory/inbox")
REQUIRED_HEADER, REQUIRED_VALUE = "x-requested-with", "agent-deck"

EXT_KIND = {".txt": "text", ".md": "markdown", ".pdf": "pdf"}
# Generated names only. [0-9] and [a-z] rather than \d and \w, which match non-ASCII digits and letters.
NAME_RE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{6}Z-[a-z0-9][a-z0-9-]{0,39}(?:-[0-9]{1,3})?\.(?:txt|md|pdf)")


class InboxError(Exception):
    """A refusal with the HTTP status the route should answer with."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def inbox_dir() -> Path:
    """The inbox folder: $AGENT_DECK_INBOX_DIR when set (tests, other hosts), else /opt/data/memory/inbox."""
    raw = os.environ.get(DIR_ENV, "").strip()
    return Path(raw) if raw else DEFAULT_DIR


def _dir(base) -> Path:
    d = Path(base) if base is not None else inbox_dir()
    d.mkdir(mode=0o700, parents=True, exist_ok=True)
    return d


def slugify(text: str | None) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")[:SLUG_MAX].strip("-")
    return s or "note"


def _title(title, fallback: str) -> str:
    """Slug for the file name: from the client title when given, else from fallback. Validates the title type."""
    if title is None or title == "":
        return slugify(fallback)
    if not isinstance(title, str) or len(title) > MAX_TITLE_CHARS or "\x00" in title:
        raise InboxError(422, "title must be a short string")
    return slugify(title)


def _check_text(data: bytes) -> None:
    if b"\x00" in data:
        raise InboxError(415, "binary content in a text file")
    try:
        data.decode("utf-8")
    except UnicodeDecodeError:
        raise InboxError(415, "text file must be UTF-8")


def _check_pdf(data: bytes) -> None:
    if data[:5] != b"%PDF-":
        raise InboxError(415, "not a PDF (missing %PDF- header)")


def _write(d: Path, data: bytes, ext: str, slug: str, now: datetime | None) -> str:
    """Write data under a generated name and return it. Never overwrites: os.link fails on an existing name."""
    stamp = (now or datetime.now(timezone.utc)).strftime("%Y-%m-%dT%H%M%SZ")
    tmp = d / f".tmp-{secrets.token_hex(8)}"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        for n in range(1, 1000):
            name = f"{stamp}-{slug}{ext}" if n == 1 else f"{stamp}-{slug}-{n}{ext}"
            if not NAME_RE.fullmatch(name):
                raise InboxError(500, "internal naming error")
            final = _inside(d, name)
            try:
                os.link(tmp, final)
            except FileExistsError:
                continue
            return name
        raise InboxError(409, "too many items share this name")
    finally:
        try:
            tmp.unlink()
        except FileNotFoundError:
            pass


def _inside(d: Path, name: str) -> Path:
    """Resolved path of name; refuses anything that does not sit directly in the inbox folder."""
    final = (d / name).resolve()
    if final.parent != d.resolve():
        raise InboxError(400, "path escapes the inbox")
    return final


def _save(data: bytes, ext: str, slug: str, base, now) -> dict:
    d = _dir(base)
    name = _write(d, data, ext, slug, now)
    return {"name": name, "size": len(data), "kind": EXT_KIND[ext]}


def save_text(text, title=None, base=None, now=None) -> dict:
    if not isinstance(text, str):
        raise InboxError(422, "text must be a string")
    if "\x00" in text:
        raise InboxError(422, "text contains NUL")
    if not text.strip():
        raise InboxError(422, "empty text")
    try:
        data = text.encode("utf-8")
    except UnicodeEncodeError:
        raise InboxError(422, "text is not valid Unicode")
    if len(data) > MAX_TEXT_BYTES:
        raise InboxError(413, "text too large")
    return _save(data, ".txt", _title(title, "note"), base, now)


def save_url(url, title=None, base=None, now=None) -> dict:
    """Save a .md note that holds the URL. The URL is validated and stored; it is not fetched."""
    if not isinstance(url, str) or not url or len(url) > MAX_URL_CHARS:
        raise InboxError(422, "url must be a non-empty string up to 2048 characters")
    if any(ord(ch) < 0x21 or ord(ch) == 0x7F for ch in url):
        raise InboxError(422, "url contains whitespace or control characters")
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise InboxError(422, "url must be http or https with a host")
    slug = _title(title, parts.hostname)  # validates the title type and length
    clean_title = " ".join(title.split()) if isinstance(title, str) else ""
    stamp = (now or datetime.now(timezone.utc)).strftime("%Y-%m-%d %H:%M UTC")
    body = (f"# {clean_title}\n\n" if clean_title else "") + f"Source: {url}\n\nSaved: {stamp}\n"
    return _save(body.encode("utf-8"), ".md", slug, base, now)


def save_file(filename, data: bytes, title=None, base=None, now=None) -> dict:
    """Save an uploaded file. Only .txt, .md and .pdf (with the %PDF- header) are accepted."""
    if not isinstance(filename, str) or "\x00" in filename:
        raise InboxError(422, "file name missing or invalid")
    if any(bad in filename for bad in ("/", "\\", "..", "%")):
        raise InboxError(422, "file name must not contain path separators, '..' or '%'")
    base_name = PurePosixPath(filename).name
    stem, ext = os.path.splitext(base_name)
    ext = ext.lower()
    if ext not in EXT_KIND:
        raise InboxError(415, "unsupported file type (allowed: .txt, .md, .pdf)")
    if len(data) > MAX_FILE_BYTES:
        raise InboxError(413, "file too large")
    if ext == ".pdf":
        _check_pdf(data)
    else:
        _check_text(data)
    return _save(data, ext, _title(title, stem or "note"), base, now)


def save_b64(filename, content_b64, title=None, base=None, now=None) -> dict:
    """JSON variant of a file upload: {kind:'file', name, content_b64}. Size is checked before decoding."""
    if not isinstance(content_b64, str):
        raise InboxError(422, "content_b64 must be a string")
    if len(content_b64) > ((MAX_FILE_BYTES + 2) // 3) * 4:
        raise InboxError(413, "file too large")
    try:
        data = base64.b64decode(content_b64, validate=True)
    except (binascii.Error, ValueError):
        raise InboxError(422, "content_b64 is not valid base64")
    return save_file(filename, data, title, base, now)


def list_items(base=None, limit: int = LIST_MAX) -> list[dict]:
    """Saved items, newest first, names and metadata only (no contents). Symlinks and foreign names are skipped."""
    d = Path(base) if base is not None else inbox_dir()
    if not d.is_dir():
        return []
    rows = []
    with os.scandir(d) as it:
        for e in it:
            if not NAME_RE.fullmatch(e.name):
                continue
            try:
                st = e.stat(follow_symlinks=False)
            except OSError:
                continue
            if not stat.S_ISREG(st.st_mode):
                continue
            rows.append({"name": e.name, "size": st.st_size, "kind": EXT_KIND[os.path.splitext(e.name)[1]],
                         "mtime": st.st_mtime})
    rows.sort(key=lambda r: (r["mtime"], r["name"]), reverse=True)
    return rows[:max(0, min(int(limit), LIST_MAX))]


def delete_item(name, base=None) -> None:
    """Delete one generated name that sits directly in the inbox folder. Anything else is refused."""
    if not isinstance(name, str) or not NAME_RE.fullmatch(name):
        raise InboxError(400, "invalid name")
    d = _dir(base)
    target = d / name
    try:
        st = os.lstat(target)
    except FileNotFoundError:
        raise InboxError(404, "not found")
    if not stat.S_ISREG(st.st_mode):  # a symlink or directory under a valid name is not an inbox item
        raise InboxError(404, "not found")
    _inside(d, name)
    os.unlink(target)


def check_write_request(headers: Mapping[str, str]) -> str | None:
    """Reason a write request is refused, or None. Defence in depth behind the dashboard's auth:
    - X-Requested-With: agent-deck is required. A cross-site form cannot set it, and a cross-origin fetch needs a
      CORS preflight, which the dashboard only answers for localhost origins.
    - An Origin header, when present, must name the Host the request was sent to (opaque 'null' is refused).
    - Sec-Fetch-Site, when present, must be same-origin or none (user-typed navigation)."""
    if (headers.get(REQUIRED_HEADER) or "").strip() != REQUIRED_VALUE:
        return "missing X-Requested-With header"
    host = (headers.get("host") or "").strip().lower()
    origin = headers.get("origin")
    if origin is not None:
        parts = urlsplit(origin.strip())
        if parts.scheme not in ("http", "https") or not host or parts.netloc.lower() != host:
            return "origin does not match host"
    fetch_site = headers.get("sec-fetch-site")
    if fetch_site is not None and fetch_site.strip().lower() not in ("same-origin", "none"):
        return "cross-site request refused"
    return None
