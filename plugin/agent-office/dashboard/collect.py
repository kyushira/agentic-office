"""Agent Office data collector: read-only snapshot of every Hermes profile.

Pure functions over the filesystem and each profile's state.db (opened with
mode=ro). No network, no writes. Only short summaries leave this module:
session titles (already short LLM summaries, trimmed), tool *names* (never
arguments), counts and timestamps. Message text, tool arguments, config
secrets and .env are never read.
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import time
from pathlib import Path

# Events (toasts, Brain trips) are reported for this many seconds after they happen.
EVENT_WINDOW = 600
BRAIN_WINDOW = 300
_STEP = re.compile(r"^\d\d:\d\d:\d\d (\w+)\s*\|\s*(?:-> ([A-Za-z0-9_\-]+)\()?")

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


def _parse_local(ts: str | None) -> float | None:
    try:
        return time.mktime(time.strptime(ts, "%Y-%m-%d %H:%M:%S")) if ts else None
    except (TypeError, ValueError):
        return None


def _tail(path: Path, n: int = 4096) -> list[str]:
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            f.seek(max(0, f.tell() - n))
            return f.read().decode("utf-8", "replace").splitlines()
    except OSError:
        return []


def task_step(lines: list[str]) -> tuple[str, bool]:
    """(current step, finished) from a helper's live log: only the line kind and tool *name* are used."""
    for line in reversed(lines):
        if " end status=" in line:
            return "done", True
        m = _STEP.match(line)
        if not m:
            continue
        kind, tool = m.group(1), m.group(2)
        if kind == "tool" and tool:
            return VERBS.get(tool, "using " + tool.replace("_", " ")), False
        if kind in ("think", "assistant", "result"):
            return "thinking", False
        if kind in ("user", "start"):
            return "starting", False
    return "starting", False


def delegations(home: Path, now: float, window: int = EVENT_WINDOW) -> tuple[list[dict], list[dict]]:
    """Live helpers and helper events from <home>/cache/delegation/live/*/manifest.json.

    Exported per helper: a short goal (first words), model chip, current step (tool name only).
    """
    live = home / "cache" / "delegation" / "live"
    helpers: list[dict] = []
    events: list[dict] = []
    try:
        dirs = sorted((d for d in live.iterdir() if d.is_dir()), key=lambda d: d.stat().st_mtime, reverse=True)[:12]
    except OSError:
        return helpers, events
    for d in dirs:
        try:
            if now - d.stat().st_mtime > 6 * 3600:
                continue
            m = json.loads((d / "manifest.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        tasks = [t for t in (m.get("tasks") or []) if isinstance(t, dict)]
        started, done = _parse_local(m.get("started")), _parse_local(m.get("completed"))
        n = len(tasks)
        if started and 0 <= now - started < window:
            events.append({"id": f"{d.name}-s", "at": started, "kind": "helpers",
                           "text": f"{n} helper{'s' if n != 1 else ''} started"})
        if done and 0 <= now - done < window:
            events.append({"id": f"{d.name}-e", "at": done, "kind": "helpers", "text": "helpers finished"})
        if done or not started or now - started > 3 * 3600:
            continue
        for t in tasks:
            idx = int(t.get("index", 0) or 0)
            step, finished = task_step(_tail(d / f"task-{idx}.log"))
            if finished or t.get("status") not in (None, "running"):
                continue
            helpers.append({"id": f"{d.name[-6:]}-{idx}", "task": _short(t.get("goal"), 38),
                            "model": chip(t.get("model") or m.get("model") or ""), "activity": step, "since": started})
    return helpers, events


def push_events(root: Path, now: float, window: int = EVENT_WINDOW) -> list[dict]:
    """'warehouse-run · pushed main' from each project's remote-ref reflog (no commit messages)."""
    out = []
    proj = root / "projects"
    try:
        repos = [p for p in proj.iterdir() if (p / ".git" / "logs" / "refs" / "remotes").is_dir()]
    except OSError:
        return out
    for repo in repos:
        base = repo / ".git" / "logs" / "refs" / "remotes"
        for log in base.rglob("*"):
            if not log.is_file():
                continue
            try:
                if now - log.stat().st_mtime > window:
                    continue
            except OSError:
                continue
            branch = "/".join(log.relative_to(base).parts[1:])
            for line in _tail(log, 2048):
                m = re.search(r"> (\d+) [+-]\d{4}\tupdate by push", line)
                if m and 0 <= now - int(m.group(1)) < window:
                    ts = int(m.group(1))
                    out.append({"id": f"push-{repo.name}-{branch}-{ts}", "at": ts, "kind": "push", "agent": None,
                                "text": f"{repo.name} · pushed {branch}"})
    return out


WALK_WINDOW = 300
# Handles other agents use for a profile (message_agent targets).
ALIASES = {"hermes": "default", "ash": "default", "default": "default"}
_BRIEF = re.compile(r"^\s*(?:\[[^\]]*\]\s*)?(?:(?:research\s+)?(?:brief|task)\s+)?from\s+ash\b", re.I)
_DM = re.compile(r"^\s*Message from \S*\s*[^(\n]{0,40}\(@([\w\-]+)\)", re.I)


def subject(text: str | None, words: int = 5, n: int = 30) -> str:
    """First few words of a message as its subject: no paths, URLs, code or secrets-looking tokens."""
    text = re.sub(r"^\s*Message from [^\n]{0,60}?\(@[\w\-]+\)\s*:?\s*", "", text or "", flags=re.I)
    t = re.sub(r"^\s*(?:\[[^\]]*\]\s*)?(?:message\s+)?(?:(?:research\s+)?(?:brief|task)\s+)?from\s+\S+?[.:,]?\s+(?:\([^)]*\)\s*)?[.:,]?\s*", "", text or "", flags=re.I)
    t = re.sub(r"^(?:\(?[^)]{0,40}\)\s*)?(?:resume|task|brief)\s*[.:]\s*", "", t, flags=re.I)
    out = []
    for w in re.split(r"\s+", t.strip()):
        if not w:
            continue
        if re.search(r"[/\\@=`{}<>]|https?:|[A-Za-z0-9_\-]{24,}", w):
            break
        out.append(w.strip("\"'*_#"))
        if len(out) >= words:
            break
    return _short(" ".join(x for x in out if x), n)


def _walk_target(raw: str, ids: set[str]) -> str | None:
    t = (raw or "").strip().lstrip("@").split("@")[0].lower()
    t = ALIASES.get(t, t)
    return t if t in ids else None


def messages_walks(pid: str, c: sqlite3.Connection, ids: set[str], now: float, window: int = WALK_WINDOW) -> list[dict]:
    """Agent-to-agent hand-offs seen from this profile's state.db, newest first.

    - message_agent calls this profile made (target from the call; subject = first words of the message);
    - briefs it received from Ash (a user message starting "From Ash" / "Research brief from Ash");
    - the end of the turn that answered such a brief = a report walking back to Ash.
    Only the sender, receiver, time and a 5-word subject leave this function.
    """
    walks = []
    since = now - window
    for r in c.execute("select id, session_id, timestamp, tool_calls from messages where role = 'assistant' and timestamp >= ? "
                       "and tool_calls like '%message_agent%' order by timestamp desc limit 10", (since,)):
        try:
            calls = json.loads(r["tool_calls"] or "[]")
        except ValueError:
            continue
        for tc in calls if isinstance(calls, list) else []:
            fn = tc.get("function", tc) if isinstance(tc, dict) else {}
            if fn.get("name") != "message_agent":
                continue
            try:
                args = fn.get("arguments")
                args = json.loads(args) if isinstance(args, str) else (args or {})
            except ValueError:
                continue
            to = _walk_target(args.get("target", ""), ids)
            if to and to != pid:
                walks.append({"id": f"ma-{pid}-{r['id']}", "at": r["timestamp"], "from": pid, "to": to,
                              "kind": "reply" if to == "default" else "message", "subject": subject(args.get("message"))})
    # Inbound hand-offs: Ash's relayed briefs ("From Ash ...") and bot DMs ("Message from 🤖 X (@handle):").
    # A brief is drawn here (Ash ran a CLI command, so Ash's db has no message_agent for it); a bot DM is
    # already drawn from the sender's db. Either way, the end of the turn that answers it walks back.
    inbound = c.execute("select id, session_id, timestamp, substr(content, 1, 400) as head from messages where role = 'user' "
                        "and timestamp >= ? order by timestamp desc limit 20", (since - 3600,)).fetchall()
    for r in inbound:
        head = r["head"] or ""
        dm = _DM.match(head)
        sender = _walk_target(dm.group(1), ids) if dm else ("default" if pid != "default" and _BRIEF.match(head) else None)
        if not sender or sender == pid:
            continue
        if not dm and r["timestamp"] >= since:
            walks.append({"id": f"br-{pid}-{r['id']}", "at": r["timestamp"], "from": sender, "to": pid,
                          "kind": "brief", "subject": subject(head)})
        # The turn is over when its last message (before the next user message) is a plain assistant answer.
        nxt = c.execute("select min(timestamp) from messages where session_id = ? and role = 'user' and timestamp > ?",
                        (r["session_id"], r["timestamp"])).fetchone()[0] or now + 1
        last = c.execute("select id, timestamp, role, tool_calls from messages where session_id = ? and timestamp > ? "
                         "and timestamp < ? order by timestamp desc limit 1", (r["session_id"], r["timestamp"], nxt)).fetchone()
        done = last is not None and last["role"] == "assistant" and (last["tool_calls"] or "") in ("", "[]")
        replied = any(w["from"] == pid and w["to"] == sender and r["timestamp"] <= w["at"] < nxt for w in walks)
        if done and last["timestamp"] >= since and not replied:
            walks.append({"id": f"rp-{pid}-{last['id']}", "at": last["timestamp"], "from": pid, "to": sender,
                          "kind": "reply", "subject": "report"})
    return walks


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
        "tools": [], "skills": _skills(home), "platforms": [], "events": [], "brainTrips": [],
    }
    live_helpers, helper_events = delegations(home, now)
    a["events"] = [dict(e, agent=pid) for e in helper_events]
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
        # Helpers: the delegation manifests are authoritative; child sessions are the fallback.
        a["helpers"] = live_helpers[:6] or [
            {"id": r["id"][-6:], "task": _short(re.sub(r"^Subagent:\s*", "", r["title"] or ""), 38),
             "model": chip(r["model"] or ""), "activity": activity_text(r["descr"], None).split(" · ")[0],
             "since": r["started_at"]} for r in live_subs][:6]
        # Latest tool step (name + time only) for agents whose sessions carry no live description.
        lt = c.execute("select tool_name, timestamp from messages where role = 'tool' and tool_name is not null "
                       "order by timestamp desc limit 1").fetchone()
        last_verb = VERBS.get(lt["tool_name"], "using " + lt["tool_name"].replace("_", " ")) if lt else ""
        last = (leads or rows or [None])[0]
        if last is not None:
            a["lastActive"] = max(last["act"] or 0, lt["timestamp"] if lt else 0) or None
        n_help = len(a["helpers"])
        if live_leads:
            cur = live_leads[0]
            a["activity"] = activity_text(cur["descr"], cur["title"])
            if a["activity"].startswith("working") and lt and lt["timestamp"] >= now - WORKING_SECS:
                a["activity"] = a["activity"].replace("working", last_verb, 1)
            a["status"] = "waiting" if a["activity"].startswith("waiting") else "working"
        elif lt and lt["timestamp"] >= now - WORKING_SECS:
            a["status"], a["activity"] = "working", last_verb
        elif n_help:
            a["status"] = "waiting"
        elif last_verb:
            a["activity"] = "idle · last: " + last_verb
        elif last is not None:
            a["activity"] = "idle · last: " + (_short(last["title"], 34) or "session")
        if n_help:
            a["activity"] = f"delegating · {n_help} helper{'s' if n_help > 1 else ''}"
            a["status"] = "working"
        # Toast events: lead sessions starting / finishing (no titles, just the platform).
        for r in leads[:40]:
            if r["started_at"] and 0 <= now - r["started_at"] < EVENT_WINDOW:
                a["events"].append({"id": f"{pid}-s-{r['id']}", "at": r["started_at"], "kind": "session", "agent": pid,
                                    "text": f"session started · {r['source'] or 'chat'}"})
            if r["ended_at"] and 0 <= now - r["ended_at"] < EVENT_WINDOW:
                a["events"].append({"id": f"{pid}-e-{r['id']}", "at": r["ended_at"], "kind": "session", "agent": pid,
                                    "text": f"session finished · {r['source'] or 'chat'}"})
        # Brain trips: memory writes / history searches, and vault reads/writes. The tool_calls JSON
        # is only pattern-matched here; nothing from it is exported except read vs write.
        trips = []
        for r in c.execute("select id, tool_name, timestamp from messages where timestamp >= ? and role = 'tool' "
                           "and tool_name in ('memory', 'session_search') order by timestamp desc limit 6",
                           (now - BRAIN_WINDOW,)):
            trips.append({"id": f"{pid}-m{r['id']}", "at": r["timestamp"],
                          "kind": "write" if r["tool_name"] == "memory" else "read"})
        for r in c.execute("select id, timestamp, (tool_calls like '%write_file%' or tool_calls like '%\"patch\"%' "
                           "or tool_calls like '%vault-sync%') as w from messages where timestamp >= ? and "
                           "role = 'assistant' and tool_calls like '%obsidian-vault%' order by timestamp desc limit 6",
                           (now - BRAIN_WINDOW,)):
            trips.append({"id": f"{pid}-v{r['id']}", "at": r["timestamp"], "kind": "write" if r["w"] else "read"})
        a["brainTrips"] = sorted(trips, key=lambda t: -t["at"])[:6]
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


def all_walks(root: Path, ids: list[str], now: float) -> list[dict]:
    """Hand-offs across every profile, newest first, with the same hop seen twice (sender and receiver) merged."""
    out: list[dict] = []
    for p in discover(root):
        if p["id"] not in ids:
            continue
        try:
            c = _connect(p["home"])
        except sqlite3.Error:
            continue
        try:
            out += messages_walks(p["id"], c, set(ids), now)
        except sqlite3.Error:
            pass
        finally:
            c.close()
    out.sort(key=lambda w: w["at"], reverse=True)
    merged: list[dict] = []
    for w in out:
        if not any(m["from"] == w["from"] and m["to"] == w["to"] and abs(m["at"] - w["at"]) < 45 for m in merged):
            merged.append(w)
    return merged[:8]


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
    walks = all_walks(root, [a["id"] for a in agents], now)
    names = {a["id"]: a["name"] for a in agents}
    label = {"brief": "new brief", "reply": "report", "message": "message"}
    events = [e for a in agents for e in a.pop("events", [])] + push_events(root, now) + [
        {"id": "w-" + w["id"], "at": w["at"], "kind": "walk", "agent": w["from"],
         "text": f"→ {names.get(w['to'], w['to'])} · {label[w['kind']]}"} for w in walks]
    events.sort(key=lambda e: e["at"], reverse=True)
    return {
        "ts": now,
        "agents": agents,
        "events": events[:12],
        "walks": walks,
        "brain": {"notes": vault_notes(root)},
        "runsOn": chips,
        "counts": {"agents": len(agents), "running": sum(a["status"] in ("working", "waiting") for a in agents),
                   "helpers": sum(len(a["helpers"]) for a in agents)},
    }
