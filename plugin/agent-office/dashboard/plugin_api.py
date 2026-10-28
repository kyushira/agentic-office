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

_spec = importlib.util.spec_from_file_location("agent_office_collect", Path(__file__).with_name("collect.py"))
collect = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(collect)

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
