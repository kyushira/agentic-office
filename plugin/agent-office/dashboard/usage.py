"""Read-only Claude plan usage (5-hour session + 7-day week) for the Agent Office dashboard.

Wraps ``agent.account_usage.fetch_account_usage('anthropic', read_only=True)`` behind a
60-second cache (failures are cached too, so a broken credential cannot be hammered).
Only whitelisted fields leave this module: no tokens, keys, emails or account identity.
"""
import glob
import importlib.util
import os
import sys
import threading
import time
from datetime import datetime
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
        if snapshot is None:
            return _empty(now, "usage lookup returned nothing")
        return _map(snapshot, now)
    except Exception as exc:
        # Class name only: exception messages can carry paths or account details.
        return _empty(now, f"usage lookup failed: {type(exc).__name__}")


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
