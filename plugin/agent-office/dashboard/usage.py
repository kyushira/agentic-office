"""Read-only Claude plan usage (5-hour session + 7-day week) for the Agent Office dashboard.

Wraps ``agent.account_usage.fetch_account_usage('anthropic', read_only=True)`` behind a
60-second cache (failures are cached too, so a broken credential cannot be hammered).
Only whitelisted fields leave this module: no tokens, keys, emails or account identity.
"""
import threading
import time
from datetime import datetime
from typing import Callable, Optional

CACHE_SECS = 60.0
_lock = threading.Lock()
_cache = {"at": None, "result": None}

# AccountUsageWindow.label values emitted by agent.account_usage for Anthropic.
_LABELS = {"five_hour": "Current session", "seven_day": "Current week"}


def _empty(fetched_at: float) -> dict:
    return {
        "available": False,
        "five_hour": {"pct": None, "resets_at": None},
        "seven_day": {"pct": None, "resets_at": None},
        "fetched_at": fetched_at,
    }


def _default_fetch():
    from agent.account_usage import fetch_account_usage  # lazy: hermes lives outside this plugin

    return fetch_account_usage("anthropic", read_only=True)


def _iso(value) -> Optional[str]:
    if isinstance(value, datetime):
        return value.isoformat()
    return None


def _map(snapshot, fetched_at: float) -> dict:
    result = _empty(fetched_at)
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
    except Exception:
        return _empty(now)
    if snapshot is None:
        return _empty(now)
    try:
        return _map(snapshot, now)
    except Exception:
        return _empty(now)


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
