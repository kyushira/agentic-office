"""Agent Deck wiki, read-only: the data behind GET /api/plugins/agent-office/wiki/{index,list,page,search,log}.

Reads the wiki root (WIKI_ROOT, or AGENT_DECK_WIKI_ROOT read per call). Nothing is written, nothing is run (no
subprocess, shell or eval), and no content is logged.

Path rules: a page path is either one root file (SCHEMA.md, index.md, log.md) or <whitelisted dir>/<name>.md, with
no '..', backslash, NUL, control character or raw '%', at most 200 characters. Every component is checked with
os.lstat, so a symlink anywhere on the path is refused; the final file is opened with O_NOFOLLOW and must be a
regular file. A refused path and a missing file give the same answer (WikiError 404, "not found"). Symlinked
entries are skipped silently by list, search, links, backlinks and log.

Redaction: every text that leaves this module (index text, page titles, frontmatter values, bodies, link labels,
snippets, log actions, subjects and bodies) goes through redact.redact() with no length cap, so provider keys,
bearer tokens, key=value secrets and PEM blocks are replaced before a response is built. Paths and dates are
not redacted: they are file names and digits that this module has already checked.
"""
import importlib.util
import os
import re
import stat
from datetime import datetime, timezone
from pathlib import Path

WIKI_ROOT = "/opt/data/wiki"
ROOT_ENV = "AGENT_DECK_WIKI_ROOT"
ROOT_FILES = ("SCHEMA.md", "index.md", "log.md")
DIRS = ("entities", "concepts", "comparisons", "queries")
INDEX_MAX = 64 * 1024
BODY_MAX = 256 * 1024
READ_MAX = 1024 * 1024  # bytes read from one page before it is parsed
LIST_READ_MAX = 64 * 1024  # bytes read from one page for its list row (frontmatter and first heading)
LIST_MAX = 500
SEARCH_MAX = 20
SNIPPET_LEN = 160
PATH_MAX = 200
NOT_FOUND = "not found"

_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*\.md")
_LINK = re.compile(r"\[\[([^\[\]\n|]+)(?:\|[^\[\]\n]*)?\]\]")
_H1 = re.compile(r"^# +(\S.*?)\s*$", re.M)
_LOG_HEAD = re.compile(r"^## \[([0-9]{4}-[0-9]{2}-[0-9]{2})\] ([^|]+?) \| (.*)$")
_ANY_HEADING = re.compile(r"#{1,6}(?:\s|$)")
_FM_KEY = re.compile(r"[A-Za-z0-9_.\-]+")

_rspec = importlib.util.spec_from_file_location("agent_office_redact_wiki", Path(__file__).with_name("redact.py"))
_redact = importlib.util.module_from_spec(_rspec)
_rspec.loader.exec_module(_redact)


class WikiError(Exception):
    """A refusal the route turns into {"error": message} with this status. The message is a fixed short string."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def _clean(s):
    """Redaction for any text that leaves the server (no length cap)."""
    return _redact.redact(s)


def _root(root=None):
    """The real path of the wiki root, or None when it is not a directory. root=None reads AGENT_DECK_WIKI_ROOT."""
    if root is None:
        root = os.environ.get(ROOT_ENV) or WIKI_ROOT
    try:
        real = os.path.realpath(root)
    except (OSError, ValueError):
        return None
    return real if os.path.isdir(real) else None


def _safe_path(root, parts):
    """Absolute path of parts under root, or None when a component is missing, a symlink, or not a directory where
    one is needed. Each component is checked with lstat; the real path must stay inside root."""
    cur = root
    for i, part in enumerate(parts):
        cur = os.path.join(cur, part)
        try:
            st = os.lstat(cur)
        except OSError:
            return None
        if stat.S_ISLNK(st.st_mode):
            return None
        if i < len(parts) - 1 and not stat.S_ISDIR(st.st_mode):
            return None
    real = os.path.realpath(cur)
    if real != root and not real.startswith(root + os.sep):
        return None
    return cur


def _is_regular(root, parts) -> bool:
    p = _safe_path(root, parts)
    if p is None:
        return False
    try:
        return stat.S_ISREG(os.lstat(p).st_mode)
    except OSError:
        return False


def _read(root, parts, cap):
    """(data, mtime) for a regular, non-symlink file: at most cap+1 bytes are read, so len(data) > cap means the file
    is over the cap. None when the path is refused or the file is missing or not regular."""
    p = _safe_path(root, parts)
    if p is None:
        return None
    try:
        fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_NONBLOCK", 0))
    except OSError:
        return None
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            return None
        chunks, total = [], 0
        while total <= cap:
            chunk = os.read(fd, min(65536, cap + 1 - total))
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
        return b"".join(chunks), st.st_mtime
    except OSError:
        return None
    finally:
        os.close(fd)


def _unquote(v: str) -> str:
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
        return v[1:-1]
    return v


def _parse(text: str):
    """(frontmatter, body). Frontmatter is the 'key: value' lines between a leading '---' line and the next '---'
    line; values are strings, with one pair of matching quotes removed. No YAML library. No closing '---' means no
    frontmatter."""
    lines = text.split("\n")
    if not lines or lines[0].rstrip("\r") != "---":
        return {}, text
    for i in range(1, len(lines)):
        if lines[i].rstrip("\r") == "---":
            fm = {}
            for line in lines[1:i]:
                key, sep, val = line.partition(":")
                key = key.strip()
                if sep and _FM_KEY.fullmatch(key):
                    fm[key] = _unquote(val.strip())
            return fm, "\n".join(lines[i + 1:])
    return {}, text


def _title(fm, body, stem):
    """frontmatter title, else the first '# ' heading, else the file name stem."""
    if fm.get("title"):
        return fm["title"]
    m = _H1.search(body)
    if m:
        return m.group(1)
    return stem


def _date_of(mtime: float) -> str:
    return datetime.fromtimestamp(mtime, timezone.utc).strftime("%Y-%m-%d")


def _load(root, parts, cap):
    """One page as a dict: rel path, stem, frontmatter, body (raw, not redacted), over (file longer than cap), mtime.
    None when the file cannot be served."""
    got = _read(root, parts, cap)
    if got is None:
        return None
    data, mtime = got
    over = len(data) > cap
    text = data[:cap].decode("utf-8", "replace")
    fm, body = _parse(text)
    name = parts[-1]
    return {"path": "/".join(parts), "stem": name[:-3], "fm": fm, "body": body, "over": over, "mtime": mtime}


def _md_names(root, dir_name):
    """Sorted file names of servable *.md regular files directly in one whitelisted dir (no symlinks)."""
    p = _safe_path(root, [dir_name])
    if p is None:
        return []
    try:
        if not stat.S_ISDIR(os.lstat(p).st_mode):
            return []
        names = os.listdir(p)
    except OSError:
        return []
    return sorted(n for n in names if _NAME.fullmatch(n) and _is_regular(root, [dir_name, n]))


def _servable(root):
    """Relative paths of every servable page: root files first, then the 4 dirs, each sorted."""
    out = [f for f in ROOT_FILES if _is_regular(root, [f])]
    for d in DIRS:
        out.extend(f"{d}/{n}" for n in _md_names(root, d))
    return out


def _valid_path(path):
    """The path split into parts when it has an allowed shape, else None. Applied after URL decoding."""
    if not isinstance(path, str) or not path or len(path) > PATH_MAX:
        return None
    if "%" in path or "\\" in path or "\x00" in path or path.startswith("/"):
        return None
    if any(ord(c) < 32 or ord(c) == 127 for c in path):
        return None
    parts = path.split("/")
    if ".." in parts:
        return None
    if len(parts) == 1 and parts[0] in ROOT_FILES:
        return parts
    if len(parts) == 2 and parts[0] in DIRS and _NAME.fullmatch(parts[1]):
        return parts
    return None


def _cap_bytes(s: str, cap: int):
    """(s, False) when s fits cap bytes of UTF-8; otherwise the cut text (on a character boundary) and True."""
    b = s.encode("utf-8")
    if len(b) <= cap:
        return s, False
    return b[:cap].decode("utf-8", "ignore"), True


def _stem_targets(root):
    """Stem -> path over the 4 dirs (first dir in DIRS order wins a clash)."""
    stems = {}
    for d in DIRS:
        for n in _md_names(root, d):
            stems.setdefault(n[:-3], f"{d}/{n}")
    return stems


def _links(root, raw_body):
    """Unique [[slug]] / [[slug|label]] targets in order, each with the path of the page it names (None if unresolved)."""
    stems = _stem_targets(root)
    seen = []
    for m in _LINK.finditer(raw_body):
        slug = m.group(1).strip()
        if slug and slug not in seen:
            seen.append(slug)
    return [{"slug": _clean(s), "path": stems.get(s)} for s in seen]


def _backlinks(root, stem):
    """Servable pages whose body contains [[stem]] or [[stem|, sorted by path."""
    plain, labelled = "[[" + stem + "]]", "[[" + stem + "|"
    out = []
    for rel in _servable(root):
        pg = _load(root, rel.split("/"), READ_MAX)
        if pg is None:
            continue
        if plain in pg["body"] or labelled in pg["body"]:
            out.append({"path": rel, "title": _clean(_title(pg["fm"], pg["body"], pg["stem"]))})
    out.sort(key=lambda i: i["path"])
    return out


def index(root=None):
    """{"text": index.md}. 413 when index.md is over INDEX_MAX bytes; 404 when it is missing or refused."""
    r = _root(root)
    if r is None:
        raise WikiError(404, NOT_FOUND)
    got = _read(r, ["index.md"], INDEX_MAX)
    if got is None:
        raise WikiError(404, NOT_FOUND)
    data = got[0]
    if len(data) > INDEX_MAX:
        raise WikiError(413, "too large")
    return {"text": _clean(data.decode("utf-8", "replace"))}


def list_pages(dir_name, root=None):
    """{"items": [{path, title, type, updated}]} for one of the 4 dirs, sorted by title, capped at LIST_MAX."""
    if dir_name not in DIRS:
        raise WikiError(400, "bad parameter")
    r = _root(root)
    if r is None:
        return {"items": []}
    items = []
    for name in _md_names(r, dir_name):
        pg = _load(r, [dir_name, name], LIST_READ_MAX)
        if pg is None:
            continue
        fm = pg["fm"]
        items.append({
            "path": pg["path"],
            "title": _clean(_title(fm, pg["body"], pg["stem"])),
            "type": _clean(fm["type"]) if fm.get("type") else None,
            "updated": _clean(fm["updated"]) if fm.get("updated") else _date_of(pg["mtime"]),
        })
    items.sort(key=lambda i: (i["title"].lower(), i["path"]))
    return {"items": items[:LIST_MAX]}


def page(path, root=None):
    """One page: title, redacted frontmatter, body (capped at BODY_MAX bytes), links out, backlinks in."""
    if path is None:
        raise WikiError(400, "bad parameter")
    parts = _valid_path(path)
    if parts is None:
        raise WikiError(404, NOT_FOUND)
    r = _root(root)
    if r is None:
        raise WikiError(404, NOT_FOUND)
    pg = _load(r, parts, READ_MAX)
    if pg is None:
        raise WikiError(404, NOT_FOUND)
    raw_body = pg["body"]
    body, cut = _cap_bytes(_clean(raw_body), BODY_MAX)
    return {
        "path": pg["path"],
        "title": _clean(_title(pg["fm"], raw_body, pg["stem"])),
        "frontmatter": {_clean(k): _clean(v) for k, v in pg["fm"].items()},
        "body": body,
        "links": _links(r, raw_body),
        "backlinks": _backlinks(r, pg["stem"]),
        "truncated": bool(pg["over"] or cut),
    }


def _snippet(clean_body: str, idx: int) -> str:
    """About SNIPPET_LEN characters of plain text around idx (or from the start when idx < 0), whitespace collapsed.
    clean_body is already redacted, so a cut cannot expose a partial secret."""
    start = max(0, idx - 60) if idx >= 0 else 0
    return " ".join(clean_body[start:start + SNIPPET_LEN].split())


def search(q, root=None):
    """{"results": [{path, title, snippet}]}: case-insensitive substring over titles and bodies of servable pages.
    Title hits come first, then body-only hits, each in servable order; at most SEARCH_MAX results."""
    if not isinstance(q, str):
        raise WikiError(400, "bad parameter")
    q = q.strip()
    if not 2 <= len(q) <= 100:
        raise WikiError(400, "bad parameter")
    r = _root(root)
    if r is None:
        return {"results": []}
    needle = q.lower()
    title_hits, body_hits = [], []
    for rel in _servable(r):
        pg = _load(r, rel.split("/"), READ_MAX)
        if pg is None:
            continue
        title = _title(pg["fm"], pg["body"], pg["stem"])
        clean_body = _clean(pg["body"])
        if needle in title.lower():
            title_hits.append((rel, title, clean_body, clean_body.lower().find(needle)))
        else:
            idx = clean_body.lower().find(needle)
            if idx >= 0:
                body_hits.append((rel, title, clean_body, idx))
    results = []
    for rel, title, clean_body, idx in (title_hits + body_hits)[:SEARCH_MAX]:
        results.append({"path": rel, "title": _clean(title), "snippet": _snippet(clean_body, idx)})
    return {"results": results}


def log(tail=None, root=None):
    """{"entries": [{date, action, subject, body}]} from log.md '## [YYYY-MM-DD] action | subject' headings, newest
    first. tail is the raw query text: None means 50; otherwise digits 1..200, else 400."""
    if tail is None:
        n = 50
    elif isinstance(tail, str) and re.fullmatch(r"[0-9]+", tail) and 1 <= int(tail) <= 200:
        n = int(tail)
    else:
        raise WikiError(400, "bad parameter")
    r = _root(root)
    pg = _load(r, ["log.md"], READ_MAX) if r is not None else None
    if pg is None:
        return {"entries": []}
    entries, current = [], None
    for line in pg["body"].split("\n"):
        m = _LOG_HEAD.match(line.rstrip("\r"))
        if m:
            current = {"date": m.group(1), "action": m.group(2).strip(), "subject": m.group(3).strip(), "lines": []}
            entries.append(current)
        elif _ANY_HEADING.match(line):
            current = None
        elif current is not None:
            current["lines"].append(line)
    entries.reverse()  # later in the file is newer; the stable sort below keeps that order within one date
    entries.sort(key=lambda e: e["date"], reverse=True)
    return {"entries": [
        {"date": e["date"], "action": _clean(e["action"]), "subject": _clean(e["subject"]),
         "body": _clean("\n".join(e["lines"]).strip())}
        for e in entries[:n]
    ]}
