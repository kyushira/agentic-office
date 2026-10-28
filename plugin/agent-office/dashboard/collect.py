"""Agent Office data collector: read-only snapshot of every Hermes profile.

Pure functions over the filesystem and each profile's state.db (opened with
mode=ro). No network, no writes. Only short summaries leave this module:
session titles (already short LLM summaries, trimmed), tool *names* (never
arguments), counts and timestamps. Message text, tool arguments, config
secrets and .env are never read.
"""
from __future__ import annotations

import os
import re
import sqlite3
import time
from pathlib import Path

# Seconds since the last recorded activity for an agent to count as working.
WORKING_SECS = 90
# Agents the team calls by name; everything else uses the profile name.
NAMES = {"default": "Ash"}
ROLES = {"default": "Chief of Staff"}
PALETTE = ["blue", "green", "orange", "purple", "red", "teal", "pink", "yellow"]

# Tool name -> what it looks like from outside (no arguments are ever read).
VERBS = {
    "terminal": "running commands", "execute_code": "running code", "process_manage": "watching a job",
    "browser_exec": "testing in a browser", "patch": "editing code", "write_file": "writing files",
    "read_file": "reading files", "search_files": "searching code", "web_search": "researching",
    "web_extract": "reading the web", "delegate_task": "delegating", "message_agent": "messaging a teammate",
    "skill_view": "loading a skill", "skill_manage": "updating skills", "memory": "updating memory",
    "session_search": "checking history", "vision_analyze": "looking at an image", "clarify": "asking a question",
    "tool_call": "using a connector", "text_to_speech": "recording audio", "todo_list": "planning",
}
_RUNNING = re.compile(r"tool (running|started|completed): ([A-Za-z0-9_\-]+)")


def _short(text: str | None, n: int = 48) -> str:
    text = re.sub(r"[\s.…]+$", "", re.sub(r"\s+", " ", (text or "")).strip())
    return text if len(text) <= n else text[: n - 1].rstrip() + "…"


def root_home(home: str | None = None) -> Path:
    """The root Hermes home (the default profile), even when called from a profile."""
    h = Path(home or os.environ.get("AGENT_OFFICE_ROOT") or os.environ.get("HERMES_HOME") or Path.home() / ".hermes")
    return h.parent.parent if h.parent.name == "profiles" else h


def discover(root: Path) -> list[dict]:
    """Every profile with a state.db: the root (default) plus profiles/*."""
    out = []
    if (root / "state.db").exists():
        out.append({"id": "default", "home": root})
    pdir = root / "profiles"
    if pdir.is_dir():
        for p in sorted(pdir.iterdir()):
            if p.is_dir() and (p / "state.db").exists():
                out.append({"id": p.name, "home": p})
    return out


def _role(pid: str, home: Path) -> str:
    if pid in ROLES:
        return ROLES[pid]
    try:
        txt = (home / "profile.yaml").read_text(encoding="utf-8")
        m = re.search(r"description:\s*'?([^:'\n]+)", txt)
        if m:
            return _short(m.group(1).strip().capitalize(), 32)
    except OSError:
        pass
    return "Agent"


def _config_models(home: Path) -> dict:
    """model.default and the delegation model(s), from config.yaml (only those keys)."""
    out = {"model": "", "helpers": []}
    try:
        txt = (home / "config.yaml").read_text(encoding="utf-8")
    except OSError:
        return out
    sect, sub = None, None
    for line in txt.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        indent = len(line) - len(line.lstrip())
        if indent == 0:
            sect = line.split(":")[0].strip()
            continue
        m = re.match(r"\s*-?\s*model:\s*['\"]?([^'\"\s#]+)", line)
        if m and sect == "delegation":
            out["helpers"].append(m.group(1))
    m = re.search(r"^model:\s*\n(?:[ \t]+.*\n)*?[ \t]+default:\s*['\"]?([^'\"\s#]+)", txt, re.M)
    if m:
        out["model"] = m.group(1)
    return out


def chip(model: str) -> str:
    """Friendly chip name for a model id."""
    m = (model or "").lower()
    for key, name in (("opus", "Opus"), ("sonnet", "Sonnet"), ("haiku", "Haiku"), ("gemini", "Gemini"),
                      ("gpt", "GPT"), ("llama", "Llama"), ("qwen", "Qwen"), ("deepseek", "DeepSeek")):
        if key in m:
            if key == "gemini" and "flash" in m:
                return "Gemini Flash"
            return name
    return _short(model, 16) if model else ""


def activity_text(desc: str | None, title: str | None) -> str:
    """'running commands · PokeSurvivor' from the session's live activity line and title."""
    desc = desc or ""
    m = _RUNNING.search(desc)
    if m:
        verb = VERBS.get(m.group(2), "using " + m.group(2).replace("_", " "))
        if m.group(1) == "completed":
            verb = "thinking"
    elif "stream" in desc or "response" in desc or "thinking" in desc:
        verb = "thinking"
    elif "approval" in desc or "waiting" in desc:
        verb = "waiting for approval"
    else:
        verb = "working"
    t = _short(re.sub(r"^Subagent:\s*", "", title or ""), 40)
    return f"{verb} · {t}" if t else verb


def _skills(home: Path) -> list[dict]:
    """Installed skills per category (folder names only)."""
    out = []
    sd = home / "skills"
    if not sd.is_dir():
        return out
    for cat in sorted(sd.iterdir()):
        if not cat.is_dir() or cat.name.startswith("."):
            continue
        n = sum(1 for _ in cat.glob("**/SKILL.md"))
        if n:
            out.append({"name": cat.name, "count": n})
    out.sort(key=lambda s: -s["count"])
    return out[:8]


def _connect(home: Path) -> sqlite3.Connection:
    c = sqlite3.connect(f"file:{home / 'state.db'}?mode=ro", uri=True, timeout=2)
    c.row_factory = sqlite3.Row
    return c


def agent_snapshot(pid: str, home: Path, now: float | None = None, color: str = "blue") -> dict:
    now = now or time.time()
    day0 = time.mktime(time.localtime(now)[:3] + (0, 0, 0, 0, 0, -1))
    models = _config_models(home)
    a = {
        "id": pid, "name": NAMES.get(pid, pid.capitalize()), "role": _role(pid, home), "color": color,
        "model": chip(models["model"]), "helperModels": [chip(m) for m in models["helpers"] if chip(m)],
        "status": "idle", "activity": "idle", "lastActive": None, "helpers": [], "recent": [],
        "today": {"sessions": 0, "toolCalls": 0, "tokens": 0}, "spark": {"sessions": [], "toolCalls": [], "tokens": []},
        "tools": [], "skills": _skills(home), "platforms": [],
    }
    try:
        c = _connect(home)
    except sqlite3.Error:
        a["status"] = "offline"; a["activity"] = "no data"
        return a
    try:
        cols = {r[1] for r in c.execute("pragma table_info(sessions)")}
        has_live = "last_activity_at" in cols
        act = "coalesce(last_activity_at, started_at)" if has_live else "started_at"
        desc = "last_activity_description" if has_live else "''"
        rows = c.execute(
            f"select id, source, title, model, started_at, ended_at, parent_session_id, {act} as act, {desc} as descr "
            f"from sessions where {act} >= ? or ended_at is null order by act desc limit 200", (now - 86400 * 2,)).fetchall()
        leases = set()
        try:
            leases = {r[0] for r in c.execute("select conversation_id from session_turn_leases where expires_at > ?", (now,))}
        except sqlite3.Error:
            pass
        leads = [r for r in rows if r["source"] != "subagent" and not r["parent_session_id"]]
        subs = [r for r in rows if r["source"] == "subagent" or r["parent_session_id"]]
        live_leads = [r for r in leads if (r["act"] or 0) >= now - WORKING_SECS or r["id"] in leases]
        live_subs = [r for r in subs if not r["ended_at"] and (r["act"] or 0) >= now - WORKING_SECS * 2]
        a["helpers"] = [{"id": r["id"][-6:], "task": _short(re.sub(r"^Subagent:\s*", "", r["title"] or ""), 44),
                         "model": chip(r["model"] or ""), "activity": activity_text(r["descr"], None),
                         "since": r["started_at"]} for r in live_subs][:6]
        last = (leads or rows or [None])[0]
        if last is not None:
            a["lastActive"] = last["act"]
        if live_leads:
            cur = live_leads[0]
            a["activity"] = activity_text(cur["descr"], cur["title"])
            a["status"] = "waiting" if a["activity"].startswith(("delegating", "waiting")) else "working"
        elif live_subs:
            a["status"] = "waiting"
            a["activity"] = f"waiting on {len(live_subs)} helper{'s' if len(live_subs) > 1 else ''}"
        elif last is not None:
            a["activity"] = "idle · last: " + (_short(last["title"], 34) or "session")
        # Today's numbers and 12 hourly buckets for the sparklines.
        hours = [now - 3600 * (12 - i) for i in range(13)]
        bucket = lambda ts: min(11, max(0, int((ts - hours[0]) // 3600)))
        sess_sp, tool_sp, tok_sp = [0] * 12, [0] * 12, [0] * 12
        # "Today" = sessions active today (a chat opened yesterday and used today counts).
        for r in c.execute(f"select started_at, {act} as act, input_tokens, output_tokens, source, parent_session_id "
                           f"from sessions where {act} >= ?", (min(day0, hours[0]),)):
            sub = r["source"] == "subagent" or r["parent_session_id"]
            if (r["act"] or 0) >= day0:
                a["today"]["tokens"] += (r["input_tokens"] or 0) + (r["output_tokens"] or 0)
                if not sub:
                    a["today"]["sessions"] += 1
            if r["started_at"] >= hours[0] and not sub:
                sess_sp[bucket(r["started_at"])] += 1
        tool_counts: dict[str, int] = {}
        for r in c.execute("select tool_name, timestamp, token_count from messages where timestamp >= ?", (min(day0, hours[0]),)):
            ts = r["timestamp"]
            if ts >= hours[0]:
                tok_sp[bucket(ts)] += r["token_count"] or 0
            if r["tool_name"]:
                if ts >= hours[0]:
                    tool_sp[bucket(ts)] += 1
                if ts >= day0:
                    a["today"]["toolCalls"] += 1
                    tool_counts[r["tool_name"]] = tool_counts.get(r["tool_name"], 0) + 1
        a["spark"] = {"sessions": sess_sp, "toolCalls": tool_sp, "tokens": tok_sp}
        a["tools"] = [{"name": k, "label": VERBS.get(k, k.replace("_", " ")), "count": v}
                      for k, v in sorted(tool_counts.items(), key=lambda kv: -kv[1])[:6]]
        a["platforms"] = sorted({r["source"] for r in leads if r["source"]})[:5]
        a["recent"] = [{"title": _short(r["title"], 44) or "(untitled)", "source": r["source"], "at": r["act"],
                        "open": not r["ended_at"]} for r in leads[:6]]
    except sqlite3.Error as e:
        a["status"] = "offline"; a["activity"] = "data unavailable"; a["error"] = type(e).__name__
    finally:
        c.close()
    return a


def vault_notes(root: Path) -> int:
    vault = Path(os.environ.get("AGENT_OFFICE_VAULT") or root / "obsidian-vault")
    n = 0
    for dirpath, dirnames, files in os.walk(vault):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        n += sum(1 for f in files if f.endswith(".md"))
    return n


def snapshot(home: str | None = None, now: float | None = None) -> dict:
    now = now or time.time()
    root = root_home(home)
    agents = [agent_snapshot(p["id"], p["home"], now, PALETTE[i % len(PALETTE)]) for i, p in enumerate(discover(root))]
    chips = []
    for a in agents:
        for m in [a["model"], *a["helperModels"]]:
            if m and m not in chips:
                chips.append(m)
    return {
        "ts": now,
        "agents": agents,
        "brain": {"notes": vault_notes(root)},
        "runsOn": chips,
        "counts": {"agents": len(agents), "running": sum(a["status"] in ("working", "waiting") for a in agents),
                   "helpers": sum(len(a["helpers"]) for a in agents)},
    }
