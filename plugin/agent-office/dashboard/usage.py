"""Read-only Claude plan usage (5-hour session + 7-day week) for the Agent Office dashboard.

Wraps ``agent.account_usage.fetch_account_usage('anthropic', read_only=True)`` behind a
60-second cache (failures are cached too, so a broken credential cannot be hammered).
Only whitelisted fields leave this module: no tokens, keys, emails or account identity.
"""
import copy
import glob
import importlib.util
import os
import sqlite3
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Callable, Optional

CACHE_SECS = 60.0
_lock = threading.Lock()
_cache = {"at": None, "result": None}

# AccountUsageWindow.label values emitted by agent.account_usage for Anthropic.
_LABELS = {"five_hour": "Current session", "seven_day": "Current week"}

# The plugin that owns the Claude login; its fetch_usage() asks the user's own Claude Code CLI for plan limits.
PLUGIN_ID = "claude-subscription-directsdk-experimental"
_PLUGIN_PATTERNS = ("/opt/data/plugins/" + PLUGIN_ID, "/opt/data/profiles/*/plugins/" + PLUGIN_ID)
_LIMIT_KINDS = {"session": "Current session", "weekly_all": "Current week"}
_LEGACY_KEYS = (("five_hour", "Current session"), ("seven_day", "Current week"))
REASON_MAX = 200


def _clip(reason) -> Optional[str]:
    if not isinstance(reason, str) or not reason:
        return None
    return reason[:REASON_MAX]


def _empty(fetched_at: float, reason=None) -> dict:
    return {
        "available": False,
        "five_hour": {"pct": None, "resets_at": None},
        "seven_day": {"pct": None, "resets_at": None},
        "fetched_at": fetched_at,
        "reason": _clip(reason),
    }


def _plugin_dir() -> Optional[str]:
    for pattern in _PLUGIN_PATTERNS:
        for path in sorted(glob.glob(pattern)):
            if os.path.isfile(os.path.join(path, "directsdk_setup.py")):
                return path
    return None


def _load_setup(path: str):
    spec = importlib.util.spec_from_file_location("agent_office_directsdk_setup",
                                                  os.path.join(path, "directsdk_setup.py"))
    module = importlib.util.module_from_spec(spec)
    # The module's flat fallback imports (`from admission import ...`) resolve only from its own dir,
    # and they run at load time, so the entry is dropped again straight after.
    sys.path.insert(0, path)
    try:
        spec.loader.exec_module(module)
    finally:
        sys.path.remove(path)
    return module


def _pct(value, fraction: bool = False) -> Optional[float]:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if value != value or value in (float("inf"), float("-inf")):
        return None
    return float(value) * 100.0 if fraction and value <= 1 else float(value)


def _when(value) -> Optional[datetime]:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None


def _windows(limits: dict) -> list:
    """Plan-limits body (`rate_limits`) -> window objects with label/used_percent/reset_at."""
    out = []
    entries = limits.get("limits")
    if isinstance(entries, list):
        for entry in entries:
            label = _LIMIT_KINDS.get(entry.get("kind")) if isinstance(entry, dict) else None
            if label:
                out.append(SimpleNamespace(label=label, used_percent=_pct(entry.get("percent")),
                                           reset_at=_when(entry.get("resets_at"))))
        return out
    # Older top-level windows: utilization is a 0-1 fraction (same scale rule as the plugin's usage_windows).
    for key, label in _LEGACY_KEYS:
        window = limits.get(key)
        if isinstance(window, dict):
            out.append(SimpleNamespace(label=label, used_percent=_pct(window.get("utilization"), fraction=True),
                                       reset_at=_when(window.get("resets_at"))))
    return out


_BUNDLED_CLAUDE = "/opt/hermes/tools/node-26.12.1-linux-x64/bin/claude"
_TOOLS_ROOT = "/opt/hermes/tools"
_TOOLS_GLOB = "node-*/bin/claude"


def _candidates(exe: Optional[str] = None) -> list:
    """Ordered Claude Code paths: pinned bundle, newest bundled node tool, then the sibling tools dir of `exe`."""
    out = [_BUNDLED_CLAUDE]
    out += sorted(glob.glob(os.path.join(_TOOLS_ROOT, _TOOLS_GLOB)), reverse=True)
    # Walk up from the running interpreter (e.g. <root>/.venv/bin/python -> <root>/tools/), max 4 levels.
    parent = os.path.dirname(os.path.realpath(exe if exe is not None else sys.executable))
    for _ in range(4):
        out += sorted(glob.glob(os.path.join(parent, "tools", _TOOLS_GLOB)), reverse=True)
        up = os.path.dirname(parent)
        if up == parent:
            break
        parent = up
    return out


def _claude_command(candidates: Optional[list] = None, exe: Optional[str] = None) -> Optional[list]:
    """argv for the bundled Claude Code binary, or None to let fetch_usage() do its own PATH lookup."""
    if candidates is None:
        candidates = _candidates(exe)
    for path in candidates:
        if os.path.isfile(path) and os.access(path, os.X_OK):
            return [path]
    return None


def _default_fetch():
    path = _plugin_dir()
    if path is None:
        return SimpleNamespace(windows=(), unavailable_reason="Claude Subscription DirectSDK plugin not found")
    limits, reason = _load_setup(path).fetch_usage(command=_claude_command(), timeout=8)
    if not isinstance(limits, dict):
        return SimpleNamespace(windows=(), unavailable_reason=reason or "Claude Code returned no plan limits")
    return SimpleNamespace(windows=_windows(limits), unavailable_reason=None)


def _iso(value) -> Optional[str]:
    if isinstance(value, datetime):
        return value.isoformat()
    return None


def _map(snapshot, fetched_at: float) -> dict:
    result = _empty(fetched_at, getattr(snapshot, "unavailable_reason", None))
    found = False
    windows = list(getattr(snapshot, "windows", None) or ())
    for key, label in _LABELS.items():
        for window in windows:
            if getattr(window, "label", None) != label:
                continue
            pct = getattr(window, "used_percent", None)
            if isinstance(pct, bool) or not isinstance(pct, (int, float)):
                break
            result[key] = {
                "pct": max(0.0, min(100.0, float(pct))),
                "resets_at": _iso(getattr(window, "reset_at", None)),
            }
            found = True
            break
    result["available"] = found
    return result


def _compute(now: float, fetch: Callable) -> dict:
    try:
        snapshot = fetch()
        result = _empty(now, "usage lookup returned nothing") if snapshot is None else _map(snapshot, now)
    except Exception as exc:
        # Class name only: exception messages can carry paths or account details.
        result = _empty(now, f"usage lookup failed: {type(exc).__name__}")
    result["tokens"] = _tokens_or_none(now)
    return result


def plan_usage(now: Optional[float] = None, fetch: Optional[Callable] = None) -> dict:
    """Return Claude plan usage; cached for 60s per process (failures included)."""
    ts = time.time() if now is None else float(now)
    fetch_fn = fetch or _default_fetch
    with _lock:
        at, cached = _cache["at"], _cache["result"]
        if cached is not None and at is not None and 0 <= ts - at <= CACHE_SECS:
            return dict(cached, five_hour=dict(cached["five_hour"]), seven_day=dict(cached["seven_day"]))
        result = _compute(ts, fetch_fn)
        _cache["at"] = ts
        _cache["result"] = result
    return dict(result, five_hour=dict(result["five_hour"]), seven_day=dict(result["seven_day"]))


def _reset_cache() -> None:
    """Test hook: drop the cached result."""
    with _lock:
        _cache["at"] = None
        _cache["result"] = None


# ---- Token estimates from Hermes state.db (Agent Deck usage rings, fallback when no plan % is available) ----
# Read-only: every connection is file:...?mode=ro with PRAGMA query_only=ON, and a missing file is never created.
# Tokens = input_tokens + output_tokens. Cache read/write tokens are deliberately EXCLUDED: they are large, bill at
# a different rate, and would make the estimate look like plan usage. A row counts toward a window by its last_seen,
# so a row whose work straddles a window edge counts in full (an estimate, not an exact meter).
CLAUDE_PROVIDER = "claude-subscription-directsdk-experimental"
DEEPSEEK_PROVIDER = "deepseek"
_PROVIDERS = {"claude": CLAUDE_PROVIDER, "deepseek": DEEPSEEK_PROVIDER}
_HOUR, _DAY = 3600.0, 86400.0
_BUSY_S = 0.25
_TOKEN_SQL = (
    "SELECT "
    "COALESCE(SUM(CASE WHEN last_seen >= :five THEN COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) ELSE 0 END), 0), "
    "COALESCE(SUM(CASE WHEN last_seen >= :week THEN COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) ELSE 0 END), 0), "
    "COALESCE(SUM(CASE WHEN last_seen >= :prev AND last_seen < :week THEN COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) ELSE 0 END), 0), "
    "COUNT(DISTINCT CASE WHEN last_seen >= :week THEN session_id END) "
    "FROM session_model_usage WHERE billing_provider = :provider AND last_seen >= :prev"
)


def _load_collect():
    spec = importlib.util.spec_from_file_location("agent_office_collect", Path(__file__).with_name("collect.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _state_dbs(root: Path) -> list:
    """The root state.db plus every profiles/<name>/state.db that exists (same layout as collect.discover)."""
    out = []
    if (root / "state.db").is_file():
        out.append(root / "state.db")
    pdir = root / "profiles"
    if pdir.is_dir():
        out += [p / "state.db" for p in sorted(pdir.iterdir()) if (p / "state.db").is_file()]
    return out


def _default_dbs() -> list:
    return _state_dbs(_load_collect().root_home(None))


def _read_db(path: Path, now: float) -> dict:
    """Window sums for one DB: {provider: (five, week, prev, sessions)}. Empty dict when the DB is unusable."""
    out = {}
    try:
        conn = sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True, timeout=_BUSY_S)
    except sqlite3.Error:
        return out
    try:
        conn.execute("PRAGMA query_only = ON")
        has_table = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_model_usage'").fetchone()
        if has_table is None:
            return out
        for key, provider in _PROVIDERS.items():
            params = {"five": now - 5 * _HOUR, "week": now - 7 * _DAY, "prev": now - 14 * _DAY, "provider": provider}
            row = conn.execute(_TOKEN_SQL, params).fetchone()
            out[key] = tuple(int(v or 0) for v in row)
    except sqlite3.Error:
        return {}
    finally:
        conn.close()
    return out


def token_usage(now: Optional[float] = None, db_paths: Optional[list] = None) -> dict:
    """Claude and DeepSeek token totals over the 5h, 7d and previous-7d windows, summed across every state.db.

    Integers only; no model names, session ids or paths leave this function. Missing, unreadable or table-less DBs
    are skipped without raising.
    """
    ts = time.time() if now is None else float(now)
    paths = _default_dbs() if db_paths is None else [Path(p) for p in db_paths]
    totals = {k: {"five_hour": 0, "seven_day": 0, "prev_seven_day": 0, "sessions_7d": 0} for k in _PROVIDERS}
    for path in paths:
        if not path.is_file():
            continue
        for key, (five, week, prev, sessions) in _read_db(path, ts).items():
            t = totals[key]
            t["five_hour"] += five
            t["seven_day"] += week
            t["prev_seven_day"] += prev
            t["sessions_7d"] += sessions  # summed per DB: a session id is only unique inside one DB
    return dict(totals, source="state.db", fetched_at=ts)


def _tokens_or_none(now: float) -> Optional[dict]:
    try:
        return token_usage(now)
    except Exception:
        return None


# ---- Per-agent token and cost breakdown (GET /usage/breakdown) ----
# Same source and enumeration as token_usage(): session_model_usage in the root state.db and profiles/*/state.db,
# every connection read-only. Agent names: the root profile is "ash" (the Ash of office_team.TEAM), a profile is
# named by its folder. Cost per row is COALESCE(actual_cost_usd, estimated_cost_usd); the response says which kind
# the agent's cost came from. Only numbers, provider names and agent names leave this module: no session ids,
# model names, titles or message text.
BREAKDOWN_CACHE_SECS = 60.0
BREAKDOWN_DAYS_MIN, BREAKDOWN_DAYS_MAX, BREAKDOWN_DAYS_DEFAULT = 1, 30, 7
ROOT_AGENT = "ash"
_BREAKDOWN_SQL = (
    "SELECT session_id, billing_provider, last_seen, "
    "COALESCE(input_tokens, 0), COALESCE(output_tokens, 0), COALESCE(cache_read_tokens, 0), "
    "COALESCE(cache_write_tokens, 0), COALESCE(reasoning_tokens, 0), COALESCE(api_call_count, 0), "
    "actual_cost_usd, estimated_cost_usd "
    "FROM session_model_usage WHERE last_seen >= ?"
)
_breakdown_cache: dict = {}
_breakdown_lock = threading.Lock()


def parse_days(raw) -> int:
    """The `days` query value as an int (1..30 clamp applied). Raises ValueError for a non-integer."""
    if raw is None:
        return BREAKDOWN_DAYS_DEFAULT
    return clamp_days(int(str(raw).strip()))


def clamp_days(days) -> int:
    return max(BREAKDOWN_DAYS_MIN, min(BREAKDOWN_DAYS_MAX, int(days)))


def _open_ro(path: Path) -> sqlite3.Connection:
    """A read-only connection: mode=ro in the URI, and query_only so even a write through this handle fails."""
    conn = sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True, timeout=_BUSY_S)
    try:
        conn.execute("PRAGMA query_only = ON")
    except sqlite3.Error:
        conn.close()
        raise
    return conn


def _read_breakdown_rows(path: Path, since: float) -> list:
    """Raw breakdown rows for one state.db. Raises sqlite3.Error (locked, missing table or column)."""
    conn = _open_ro(path)
    try:
        return conn.execute(_BREAKDOWN_SQL, (since,)).fetchall()
    finally:
        conn.close()


def _new_acc() -> dict:
    return {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0, "reasoning": 0, "api_calls": 0,
            "sessions": set(), "cost": 0.0, "cost_n": 0, "n_actual": 0, "n_est": 0, "by_provider": {}}


def _utc_day(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d")


def _day_range(since: float, now: float) -> list:
    """Every UTC calendar day from the day of `since` through the day of `now`, oldest first."""
    day = datetime.fromtimestamp(since, tz=timezone.utc).date()
    last = datetime.fromtimestamp(now, tz=timezone.utc).date()
    out = []
    while day <= last:
        out.append(day.strftime("%Y-%m-%d"))
        day += timedelta(days=1)
    return out


def _cost_kind(acc: dict) -> str:
    if acc["n_actual"] and acc["n_est"]:
        return "mixed"
    if acc["n_actual"]:
        return "actual"
    if acc["n_est"]:
        return "estimated"
    return "none"


def token_breakdown(root, days=7, now: Optional[float] = None) -> dict:
    """Per-agent tokens, calls and cost over the last `days` days, plus a per-UTC-day trend and totals.

    `root` is the Hermes root home. A state.db that cannot be read is skipped and named in `errors` by agent and
    exception class only. Tokens = input + output (as in token_usage). Cost is None when no row has any cost.
    """
    ts = time.time() if now is None else float(now)
    days = clamp_days(days)
    since = ts - days * _DAY
    root = Path(root)
    accs: dict = {}
    trend = {d: {"tokens": 0, "cost": 0.0, "cost_n": 0, "by_agent": {}} for d in _day_range(since, ts)}
    errors = []
    for path in _state_dbs(root):
        agent = ROOT_AGENT if path.parent == root else path.parent.name
        try:
            rows = _read_breakdown_rows(path, since)
        except sqlite3.Error as exc:
            errors.append({"agent": agent, "error": type(exc).__name__})
            continue
        acc = accs.setdefault(agent, _new_acc())
        for sid, provider, last_seen, inp, out, cread, cwrite, reasoning, calls, actual, est in rows:
            tokens = inp + out
            cost = actual if actual is not None else est
            acc["input"] += inp
            acc["output"] += out
            acc["cache_read"] += cread
            acc["cache_write"] += cwrite
            acc["reasoning"] += reasoning
            acc["api_calls"] += calls
            acc["sessions"].add(sid)
            key = provider or "unknown"
            acc["by_provider"][key] = acc["by_provider"].get(key, 0) + tokens
            if cost is not None:
                acc["cost"] += cost
                acc["cost_n"] += 1
                if actual is not None:
                    acc["n_actual"] += 1
                else:
                    acc["n_est"] += 1
            # a row stamped after `now` (clock skew) lands in today's bucket rather than off the trend
            bucket = trend.setdefault(_utc_day(min(last_seen, ts)),
                                      {"tokens": 0, "cost": 0.0, "cost_n": 0, "by_agent": {}})
            bucket["tokens"] += tokens
            if cost is not None:
                bucket["cost"] += cost
                bucket["cost_n"] += 1
            if tokens:
                bucket["by_agent"][agent] = bucket["by_agent"].get(agent, 0) + tokens

    agents = []
    for name, acc in accs.items():
        agents.append({
            "agent": name,
            "input": acc["input"], "output": acc["output"],
            "cache_read": acc["cache_read"], "cache_write": acc["cache_write"], "reasoning": acc["reasoning"],
            "tokens": acc["input"] + acc["output"],
            "api_calls": acc["api_calls"],
            "sessions": len(acc["sessions"]),
            "cost_usd": round(acc["cost"], 6) if acc["cost_n"] else None,
            "cost_kind": _cost_kind(acc),
            "by_provider": dict(sorted(acc["by_provider"].items())),
        })
    agents.sort(key=lambda a: (-a["tokens"], a["agent"]))

    trend_out = [{"day": day, "tokens": b["tokens"],
                  "cost_usd": round(b["cost"], 6) if b["cost_n"] else None,
                  "by_agent": dict(sorted(b["by_agent"].items()))}
                 for day, b in sorted(trend.items())]

    total_cost = [a for a in agents if a["cost_usd"] is not None]
    totals = {
        "tokens": sum(a["tokens"] for a in agents),
        "cost_usd": round(sum(a["cost_usd"] for a in total_cost), 6) if total_cost else None,
        "api_calls": sum(a["api_calls"] for a in agents),
    }
    return {"days": days, "since": since, "fetched_at": ts, "source": "state.db",
            "agents": agents, "trend": trend_out, "totals": totals, "errors": errors}


def _default_root() -> Path:
    return _load_collect().root_home(None)


def breakdown_usage(days=BREAKDOWN_DAYS_DEFAULT, now: Optional[float] = None) -> dict:
    """token_breakdown() of the default root, cached per clamped `days` value for 60s (per-DB errors are in the result)."""
    days = clamp_days(days)
    ts = time.time() if now is None else float(now)
    with _breakdown_lock:
        hit = _breakdown_cache.get(days)
        if hit is not None and 0 <= ts - hit[0] <= BREAKDOWN_CACHE_SECS:
            return copy.deepcopy(hit[1])
        result = token_breakdown(_default_root(), days, ts)
        _breakdown_cache[days] = (ts, result)
    return copy.deepcopy(result)


def _reset_breakdown_cache() -> None:
    """Test hook: drop every cached breakdown."""
    with _breakdown_lock:
        _breakdown_cache.clear()
