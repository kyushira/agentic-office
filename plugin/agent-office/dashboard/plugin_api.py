"""Agent Office backend: one read-only endpoint, GET /api/plugins/agent-office/state.

Mounted by the Hermes dashboard behind its login. The snapshot is computed in a
worker thread (never on the event loop) and cached for a few seconds, so many
open tabs cost one scan.
"""
import asyncio
import importlib.util
import threading
import time
from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import JSONResponse

_spec = importlib.util.spec_from_file_location("agent_office_collect", Path(__file__).with_name("collect.py"))
collect = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(collect)

_uspec = importlib.util.spec_from_file_location("agent_office_usage", Path(__file__).with_name("usage.py"))
usage = importlib.util.module_from_spec(_uspec)
_uspec.loader.exec_module(usage)

_fspec = importlib.util.spec_from_file_location("agent_office_feed", Path(__file__).with_name("feed.py"))
feed = importlib.util.module_from_spec(_fspec)
_fspec.loader.exec_module(feed)

router = APIRouter()
CACHE_SECS = 4.0
_cache = {"at": 0.0, "data": None}
_lock = threading.Lock()


def _snapshot():
    with _lock:
        if _cache["data"] is None or time.time() - _cache["at"] > CACHE_SECS:
            _cache["data"] = collect.snapshot()
            _cache["at"] = time.time()
        return _cache["data"]


@router.get("/state")
async def state():
    return await asyncio.to_thread(_snapshot)


@router.get("/usage")
async def usage_endpoint():
    return await asyncio.to_thread(usage.plan_usage)


@router.get("/session")
async def session(id: str):
    detail = await asyncio.to_thread(collect.session_detail, id)
    if detail is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    return detail


@router.get("/feed")
async def feed_endpoint(agent: str | None = None, since: float | None = None, limit: int = 150):
    """Redacted transcript rows (assistant text, tool calls, tool results), newest first. Unknown agent -> 404."""
    result = await asyncio.to_thread(feed.feed, agent, since, max(1, min(limit, 300)), None)
    if agent is not None and agent not in result["agents"]:
        return JSONResponse({"error": "unknown agent"}, status_code=404)
    return result


@router.get("/comms")
async def comms_endpoint(since: float | None = None, limit: int = 100):
    """Redacted agent-to-agent messages and delegations, newest first."""
    return await asyncio.to_thread(feed.comms, since, max(1, min(limit, 300)), None)
