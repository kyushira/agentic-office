"""Agent Office feed and comms: read-only transcript rows and agent-to-agent messages, redacted server-side.

Pure functions over each profile's state.db (opened with mode=ro via collect._connect, parametrised SQL).
Only assistant and tool rows are read: user rows can be Sir's private messages, so they never leave here.
Every string this module returns passes through redact.redact; a .env reference (in tool-call arguments or in
the result of such a call) is replaced whole. Nothing is logged or cached.
"""
from __future__ import annotations

import importlib.util
import json
import math
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

FEED_LIMIT, COMMS_LIMIT, MAX_LIMIT = 150, 100, 300
TEXT_CAP, RESULT_CAP, ARG_CAP = 2000, 300, 160
PREVIEW_CAP, BODY_CAP = 200, 6000
ENV_DAY = 86400  # how far back to look for the call that a .env result belongs to
ARG_KEYS = ("command", "cmd", "path", "file_path", "target", "query", "goal", "url", "pattern", "name", "message")


def _clamp(limit, default: int) -> int:
    try:
        n = int(limit)
    except (TypeError, ValueError):
        return default
    return max(1, min(n, MAX_LIMIT))


def _since(since) -> float:
    try:
        s = float(since)
    except (TypeError, ValueError):
        return 0.0
    return s if math.isfinite(s) else 0.0


def _calls(raw: str | None) -> list[dict]:
    """Parsed tool calls of one assistant row: [{id, name, args (dict), blob (raw args text)}]."""
    try:
        calls = json.loads(raw or "[]")
    except (TypeError, ValueError):
        return []
    out = []
    for tc in calls if isinstance(calls, list) else []:
        if not isinstance(tc, dict):
            continue
        fn = tc.get("function", tc)
        if not isinstance(fn, dict) or not isinstance(fn.get("name"), str):
            continue
        args = fn.get("arguments")
        blob = args if isinstance(args, str) else json.dumps(args or {}, ensure_ascii=False)
        try:
            parsed = json.loads(args) if isinstance(args, str) else (args or {})
        except ValueError:
            parsed = {}
        out.append({"id": tc.get("id") or tc.get("call_id"), "name": fn["name"],
                    "args": parsed if isinstance(parsed, dict) else {}, "blob": blob})
    return out


def _pick(args: dict) -> str:
    """The most informative argument of a call: a command, path, target, query or goal (batch tasks: first task)."""
    tasks = args.get("tasks")
    sources = ([tasks[0]] if isinstance(tasks, list) and tasks and isinstance(tasks[0], dict) else []) + [args]
    for src in sources:
        for k in ARG_KEYS:
            v = src.get(k)
            if isinstance(v, str) and v.strip():
                return v.strip()
    return ""


def _env_call_ids(c: sqlite3.Connection, since: float) -> set[str]:
    """Ids of tool calls (in this profile) whose arguments reference a .env file."""
    ids = set()
    for r in c.execute("select tool_calls from messages where role = 'assistant' and tool_calls like '%.env%' "
                       "and timestamp >= ?", (since,)):
        for call in _calls(r[0]):
            if call["id"] and redact.is_env_path(call["blob"]):
                ids.add(call["id"])
    return ids


def _feed_profile(pid: str, c: sqlite3.Connection, since: float, limit: int) -> list[dict]:
    cols = {r[1] for r in c.execute("pragma table_info(messages)")}
    tcid = "tool_call_id" if "tool_call_id" in cols else "null"
    rows = c.execute(
        f"select id, session_id, role, content, tool_calls, tool_name, {tcid} as tcid, timestamp from messages "
        "where role in ('assistant', 'tool') and timestamp > ? order by timestamp desc, id desc limit ?",
        (since, limit)).fetchall()
    env_ids: set[str] = set()
    results = [r for r in rows if r["role"] == "tool"]
    if results and tcid != "null":
        env_ids = _env_call_ids(c, min(r["timestamp"] for r in results) - ENV_DAY)

    out = []

    def row(rid, r, kind, text, tool):
        return {"id": rid, "agent": pid, "ts": float(r["timestamp"]), "session_id": r["session_id"],
                "kind": kind, "text": text, "tool": tool}

    for r in rows:
        base = f"{pid}:{r['id']}"
        if r["role"] == "assistant":
            text = (r["content"] or "").strip()
            if text:
                out.append(row(base, r, "text", redact.redact(text, TEXT_CAP), None))
            for k, call in enumerate(_calls(r["tool_calls"])):
                if redact.is_env_path(call["blob"]):
                    t = redact.ENV_MARK
                else:
                    pick = _pick(call["args"])
                    t = redact.redact(f"{call['name']}: {pick}" if pick else call["name"], ARG_CAP)
                out.append(row(f"{base}#{k}", r, "call", t, call["name"]))
        else:
            content = r["content"] or ""
            if not content.strip():
                continue
            t = redact.ENV_MARK if r["tcid"] in env_ids else redact.redact(content, RESULT_CAP)
            out.append(row(base, r, "result", t, r["tool_name"]))
    return out


def _comms_profile(pid: str, c: sqlite3.Connection, ids: set[str], since: float, limit: int) -> list[dict]:
    """message_agent and delegate_task calls made by this profile (the sender's db only, so nothing is doubled)."""
    out = []
    for r in c.execute("select id, timestamp, tool_calls from messages where role = 'assistant' and timestamp > ? "
                       "and (tool_calls like '%message_agent%' or tool_calls like '%delegate_task%') "
                       "order by timestamp desc, id desc limit ?", (since, limit)):
        for k, call in enumerate(_calls(r["tool_calls"])):
            a = call["args"]
            if call["name"] == "message_agent":
                kind = "message"
                target = a.get("target") if isinstance(a.get("target"), str) else ""
                to = collect._walk_target(target, ids) or redact.redact(target.strip(), 64)
                raw = a.get("message") if isinstance(a.get("message"), str) else ""
            elif call["name"] == "delegate_task":
                kind = "delegate"
                batch = a.get("tasks")
                tasks = [t for t in batch if isinstance(t, dict)] if isinstance(batch, list) else [a]
                if not tasks:
                    continue
                to = "helper" if len(tasks) == 1 else f"helpers x{len(tasks)}"
                raw = "\n\n".join(
                    "\n".join(s for s in (str(t.get("goal") or ""), str(t.get("context") or "")) if s.strip())
                    for t in tasks)
            else:
                continue
            if not raw.strip():
                continue
            out.append({"id": f"{pid}:{r['id']}#{k}", "ts": float(r["timestamp"]), "kind": kind,
                        "from": pid, "to": to, "preview": redact.redact(raw, PREVIEW_CAP),
                        "body": redact.redact(raw, BODY_CAP)})
    return out


def _homes(root) -> list[dict]:
    return collect.discover(collect.root_home(None if root is None else str(root)))


def _each(homes: list[dict], fn) -> list[dict]:
    rows = []
    for p in homes:
        try:
            c = collect._connect(p["home"])
        except sqlite3.Error:
            continue
        try:
            rows += fn(p, c)
        except sqlite3.Error:
            pass
        finally:
            c.close()
    return rows


def feed(agent: str | None = None, since: float | None = None, limit: int = FEED_LIMIT, root=None) -> dict:
    """Newest-first assistant text, tool calls and tool results. `agent` limits to one profile (unknown -> no rows)."""
    now = time.time()
    limit, since_ts = _clamp(limit, FEED_LIMIT), _since(since)
    homes = _homes(root)
    selected = [p for p in homes if agent is None or p["id"] == agent]
    rows = _each(selected, lambda p, c: _feed_profile(p["id"], c, since_ts, limit))
    rows.sort(key=lambda r: r["ts"], reverse=True)
    return {"now": now, "agents": [p["id"] for p in homes], "rows": rows[:limit]}


def comms(since: float | None = None, limit: int = COMMS_LIMIT, root=None) -> dict:
    """Newest-first messages and delegations, read from each sender's own state.db."""
    now = time.time()
    limit, since_ts = _clamp(limit, COMMS_LIMIT), _since(since)
    homes = _homes(root)
    ids = {p["id"] for p in homes}
    rows = _each(homes, lambda p, c: _comms_profile(p["id"], c, ids, since_ts, limit))
    rows.sort(key=lambda r: r["ts"], reverse=True)
    return {"now": now, "rows": rows[:limit]}
