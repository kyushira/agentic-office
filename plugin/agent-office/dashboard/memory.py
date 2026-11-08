"""Agent Deck memory search: read-only full-text search over every Hermes state.db (GET /memory).

Privacy policy mirrors feed.py: only assistant and tool rows are searched, because user rows are Sir's private
messages and never leave the backend. The existing FTS5 index messages_fts (external content over messages; columns
content, tool_name, tool_calls; rowid = messages.id) is queried and joined back to messages to drop user rows.
messages_fts_trigram is not used: it indexes user rows.

When a DB has no messages_fts table (or its query fails), the search falls back to a LIKE scan over the last
SCAN_ROWS assistant/tool messages of that DB, and the response says so (fts5 false, mode 'like').

Read-only: every connection is file:...?mode=ro with PRAGMA query_only=ON. Nothing here creates tables or indexes.
User text becomes quoted word terms (\\w+) before it touches SQL; values are always bound parameters. One 1.5 s
budget covers all DBs of a search, enforced by a progress handler. Snippets (~160 chars) are redacted with
redact.redact_memory before they leave: secrets, e-mail addresses, absolute paths outside /opt/data/projects.
"""
from __future__ import annotations

import importlib.util
import re
import sqlite3
import time
from pathlib import Path


def _load(name: str):
    spec = importlib.util.spec_from_file_location(f"agent_office_{name}", Path(__file__).with_name(f"{name}.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


collect = _load("collect")
redact = _load("redact")

DEFAULT_LIMIT, MAX_LIMIT = 20, 50
Q_CAP, TERM_CAP = 200, 8
SCAN_ROWS = 5000  # LIKE fallback: last N assistant/tool rows per DB
HEAD_CAP = 8192  # text read per message (same cap as the messages_fts index for tool rows)
SNIP, TITLE_CAP = 160, 80
BUDGET_S = 1.5  # total wall time for one search across all DBs
BUSY_S = 0.25
_TERM = re.compile(r"\w+")
_PROFILE = re.compile(r"[A-Za-z0-9_\-]+")
_MATCH_COLS = "{content tool_calls} : "  # FTS column filter: skip tool_name, which would match tool names
_ROLES = "('assistant', 'tool')"


def _clamp(limit) -> int:
    try:
        n = int(limit)
    except (TypeError, ValueError):
        return DEFAULT_LIMIT
    return max(1, min(n, MAX_LIMIT))


def terms(q) -> list[str]:
    """Word terms of a query: at most Q_CAP characters, at most TERM_CAP terms. Quotes, operators and punctuation
    are dropped, so no user text can reach FTS5 syntax or SQL."""
    if not isinstance(q, str):
        return []
    return _TERM.findall(q[:Q_CAP])[:TERM_CAP]


def _agents(base) -> dict[str, Path]:
    """Profile name -> home. 'default' is the root home; a profiles/<name> directory counts even without a state.db
    (so a missing DB is reported, not treated as unknown)."""
    root = collect.root_home(None if base is None else str(base))
    out: dict[str, Path] = {"default": root}
    pdir = root / "profiles"
    if pdir.is_dir():
        for p in sorted(pdir.iterdir()):
            if p.is_dir() and _PROFILE.fullmatch(p.name):
                out.setdefault(p.name, p)
    return out


def _connect(path: Path, deadline: float) -> sqlite3.Connection:
    c = sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True, timeout=BUSY_S)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA query_only = ON")
    c.set_progress_handler(lambda: 1 if time.monotonic() > deadline else 0, 10000)
    return c


def _cols(c: sqlite3.Connection, table: str) -> set[str]:
    return {r[1] for r in c.execute(f"pragma table_info({table})")}


def _has_fts(c: sqlite3.Connection) -> bool:
    r = c.execute("select sql from sqlite_master where type = 'table' and name = 'messages_fts'").fetchone()
    return r is not None and isinstance(r[0], str) and "fts5" in r[0].lower()


def _esc_like(t: str) -> str:
    return "%" + t.replace("!", "!!").replace("%", "!%").replace("_", "!_") + "%"


def _fts_rows(c: sqlite3.Connection, ts: list[str], limit: int, title: str) -> list[tuple]:
    match = _MATCH_COLS + " ".join(f'"{t}"' for t in ts)  # terms are \w+ only, so the quotes are safe
    return c.execute(
        "select m.id, m.session_id, m.role, m.timestamp, substr(coalesce(m.content, ''), 1, ?) as content, "
        "substr(coalesce(m.tool_calls, ''), 1, ?) as tool_calls, " + title + " as title, "
        "bm25(messages_fts) as score "
        "from messages_fts join messages m on m.id = messages_fts.rowid "
        "left join sessions s on s.id = m.session_id "
        f"where messages_fts match ? and m.role in {_ROLES} order by score limit ?",
        (HEAD_CAP, HEAD_CAP, match, limit)).fetchall()


def _like_rows(c: sqlite3.Connection, ts: list[str], limit: int, title: str) -> list[tuple]:
    where = " and ".join(
        "(substr(coalesce(m.content, ''), 1, 8192) like ? escape '!' "
        "or substr(coalesce(m.tool_calls, ''), 1, 8192) like ? escape '!')" for _ in ts)
    params: list = [SCAN_ROWS]
    for t in ts:
        params += [_esc_like(t), _esc_like(t)]
    params.append(limit)
    return c.execute(
        "select m.id, m.session_id, m.role, m.timestamp, substr(coalesce(m.content, ''), 1, 8192) as content, "
        "substr(coalesce(m.tool_calls, ''), 1, 8192) as tool_calls, " + title + " as title, "
        "null as score "
        f"from (select id, session_id, role, timestamp, content, tool_calls from messages "
        f"where role in {_ROLES} order by id desc limit ?) m "
        "left join sessions s on s.id = m.session_id "
        f"where {where} order by m.timestamp desc limit ?",
        params).fetchall()


def _query_db(c: sqlite3.Connection, ts: list[str], limit: int) -> tuple[list[tuple], str, bool]:
    """(rows, mode, fts_failed). Uses messages_fts when present; a failing FTS query falls back to LIKE."""
    title = "s.title" if "title" in _cols(c, "sessions") else "null"
    if _has_fts(c):
        try:
            return _fts_rows(c, ts, limit, title), "fts5", False
        except sqlite3.OperationalError as e:
            if "interrupted" in str(e):
                raise
            return _like_rows(c, ts, limit, title), "like", True
    return _like_rows(c, ts, limit, title), "like", False


def _snippet(text: str, ts: list[str]) -> str:
    """About SNIP characters around the first hit, redacted. Redaction runs on the whole head before the window is
    cut, so a secret is never shown half-cut; the last 64 characters of a truncated head are dropped for the same
    reason."""
    raw = text[: HEAD_CAP - 64] if len(text) >= HEAD_CAP else text
    clean = redact.redact_memory(raw)
    low = clean.lower()
    hits = [low.find(t.lower()) for t in ts]
    hits = [h for h in hits if h >= 0]
    start = max(0, (min(hits) if hits else 0) - 60)
    piece = re.sub(r"\s+", " ", clean[start:start + SNIP]).strip()
    return ("…" if start > 0 else "") + piece + ("…" if start + SNIP < len(clean) else "")


def _row(name: str, r: tuple, mode: str, ts: list[str]) -> tuple[dict, tuple]:
    """(output row, sort key). FTS hits sort first by bm25 (lower is better); LIKE hits sort by time, newest first."""
    body = r["content"] if (r["content"] or "").strip() else (r["tool_calls"] or "")
    snippet = _snippet(body or "", ts)
    out = {"agent": name, "session_id": r["session_id"], "role": r["role"], "ts": float(r["timestamp"]),
           "snippet": snippet, "redacted": snippet.count(redact.MARK) + snippet.count(redact.ENV_MARK)}
    if r["title"]:
        title = redact.redact_memory(r["title"], TITLE_CAP)
        out["session_title"] = title
        out["redacted"] += title.count(redact.MARK) + title.count(redact.ENV_MARK)
    key = (0, float(r["score"]), 0.0) if mode == "fts5" else (1, 0.0, -float(r["timestamp"]))
    return out, key


def _empty(query: str) -> dict:
    return {"query": query, "results": [], "redacted_total": 0, "fts5": False, "mode": "none", "searched": [],
            "errors": [], "unknown_agent": False}


def search(q, agent: str | None = None, limit=DEFAULT_LIMIT, base=None) -> dict:
    """Search assistant and tool messages across the agents' state.db files.

    Returns {query, results: [{agent, session_id, session_title?, role, ts, snippet, redacted}], redacted_total,
    fts5 (every searched DB used messages_fts), mode ('fts5' | 'like' | 'mixed' | 'none'), searched: [agents],
    errors: [str], unknown_agent (bool)}. An unknown agent gives an error and no results; a missing DB is skipped and
    listed in errors. `redacted` counts the markers in one snippet and session title; redacted_total sums them over
    the returned rows. An empty or punctuation-only query returns no results and opens no DB."""
    query = q[:Q_CAP] if isinstance(q, str) else ""
    out = _empty(query)
    ts = terms(query)
    if not ts:
        return out
    lim = _clamp(limit)
    homes = _agents(base)
    if agent is not None and agent not in homes:
        out["errors"].append(f"unknown agent: {agent}")
        out["unknown_agent"] = True
        return out
    selected = homes if agent is None else {agent: homes[agent]}
    deadline = time.monotonic() + BUDGET_S
    cands: list[tuple[tuple, dict]] = []
    modes: set[str] = set()
    for name, home in selected.items():
        db = home / "state.db"
        if not db.is_file():
            out["errors"].append(f"{name}: state.db missing")
            continue
        if time.monotonic() > deadline:
            out["errors"].append(f"{name}: skipped, time budget used")
            continue
        try:
            c = _connect(db, deadline)
        except sqlite3.Error:
            out["errors"].append(f"{name}: cannot open state.db")
            continue
        try:
            rows, mode, fts_failed = _query_db(c, ts, lim)
        except sqlite3.Error as e:
            out["errors"].append(f"{name}: query timed out" if "interrupted" in str(e) else f"{name}: query failed")
            continue
        finally:
            c.close()
        if fts_failed:
            out["errors"].append(f"{name}: FTS query failed, used LIKE scan")
        modes.add(mode)
        out["searched"].append(name)
        for r in rows:
            row, key = _row(name, r, mode, ts)
            cands.append((key, row))
    cands.sort(key=lambda x: x[0])
    out["results"] = [row for _, row in cands[:lim]]
    out["redacted_total"] = sum(r["redacted"] for r in out["results"])
    out["fts5"] = bool(modes) and modes == {"fts5"}
    out["mode"] = "none" if not modes else (modes.pop() if len(modes) == 1 else "mixed")
    return out
