"""Agent Office backend: one read-only endpoint, GET /api/plugins/agent-office/state.

Mounted by the Hermes dashboard behind its login. The snapshot is computed in a
worker thread (never on the event loop) and cached for a few seconds, so many
open tabs cost one scan.
"""
import asyncio
import importlib.util
import json
import threading
import time
from pathlib import Path

from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse
from starlette.datastructures import UploadFile
from starlette.requests import Request as StarletteRequest

_spec = importlib.util.spec_from_file_location("agent_office_collect", Path(__file__).with_name("collect.py"))
collect = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(collect)

_uspec = importlib.util.spec_from_file_location("agent_office_usage", Path(__file__).with_name("usage.py"))
usage = importlib.util.module_from_spec(_uspec)
_uspec.loader.exec_module(usage)

_fspec = importlib.util.spec_from_file_location("agent_office_feed", Path(__file__).with_name("feed.py"))
feed = importlib.util.module_from_spec(_fspec)
_fspec.loader.exec_module(feed)

_pspec = importlib.util.spec_from_file_location("agent_office_projects", Path(__file__).with_name("projects.py"))
projects = importlib.util.module_from_spec(_pspec)
_pspec.loader.exec_module(projects)

_mspec = importlib.util.spec_from_file_location("agent_office_memory", Path(__file__).with_name("memory.py"))
memory = importlib.util.module_from_spec(_mspec)
_mspec.loader.exec_module(memory)

_ispec = importlib.util.spec_from_file_location("agent_office_inbox", Path(__file__).with_name("inbox.py"))
inbox = importlib.util.module_from_spec(_ispec)
_ispec.loader.exec_module(inbox)

_bspec = importlib.util.spec_from_file_location("agent_office_brain", Path(__file__).with_name("brain.py"))
brain = importlib.util.module_from_spec(_bspec)
_bspec.loader.exec_module(brain)

router = APIRouter()
NO_STORE = {"Cache-Control": "no-store", "Pragma": "no-cache"}
CACHE_SECS = 4.0
PROJECTS_CACHE_SECS = 30.0
_cache = {"at": 0.0, "data": None}
_pcache = {"at": 0.0, "data": None}
_lock = threading.Lock()


def _snapshot():
    with _lock:
        if _cache["data"] is None or time.time() - _cache["at"] > CACHE_SECS:
            _cache["data"] = collect.snapshot()
            _cache["at"] = time.time()
        return _cache["data"]


def _projects_snapshot():
    with _lock:
        if _pcache["data"] is None or time.time() - _pcache["at"] > PROJECTS_CACHE_SECS:
            _pcache["data"] = projects.projects()
            _pcache["at"] = time.time()
        return _pcache["data"]


@router.get("/state")
async def state():
    return await asyncio.to_thread(_snapshot)


@router.get("/projects")
async def projects_endpoint():
    """Read-only project cards (git last commit, briefs, optional projects.json registry), cached 30s."""
    return JSONResponse(await asyncio.to_thread(_projects_snapshot), headers=NO_STORE)


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
    """Redacted transcript rows (assistant text, tool calls, tool results, thinking counts), newest first.
    Unknown agent -> 404."""
    result = await asyncio.to_thread(feed.feed, agent, since, max(1, min(limit, 300)), None)
    if agent is not None and agent not in result["agents"]:
        return JSONResponse({"error": "unknown agent"}, status_code=404, headers=NO_STORE)
    return JSONResponse(result, headers={"Cache-Control": "no-store"})


@router.get("/thinking")
async def thinking_endpoint(id: str):
    """Redacted thinking text of one feed row ('<agent>:<rowid>~t'), fetched on tap. Never cached. Unknown -> 404."""
    detail = await asyncio.to_thread(feed.thinking, id, None)
    if detail is None:
        return JSONResponse({"error": "not found"}, status_code=404, headers=NO_STORE)
    return JSONResponse(detail, headers=NO_STORE)


@router.get("/comms")
async def comms_endpoint(since: float | None = None, limit: int = 100):
    """Redacted agent-to-agent messages and delegations, newest first."""
    result = await asyncio.to_thread(feed.comms, since, max(1, min(limit, 300)), None)
    return JSONResponse(result, headers={"Cache-Control": "no-store"})


@router.get("/memory")
async def memory_endpoint(q: str = Query("", max_length=200), agent: str | None = None, limit: int = 20):
    """Read-only full-text search over assistant and tool messages in every state.db (see memory.py), plus the
    drop-box text notes (agent 'inbox'). limit is clamped to 1..50; an unknown agent -> 404."""
    lim = max(1, min(limit, memory.MAX_LIMIT))
    result = await asyncio.to_thread(memory.search, q, agent, lim, None, inbox_dir=inbox.inbox_dir())
    if result["unknown_agent"]:
        return JSONResponse({"error": "unknown agent"}, status_code=404, headers=NO_STORE)
    return JSONResponse(result, headers=NO_STORE)


@router.get("/brain")
async def brain_endpoint(agent: str | None = Query(None, max_length=32)):
    """Read-only SOUL.md, MEMORY.md and USER.md per whitelisted agent (see brain.py). agent narrows to one agent;
    an unknown agent -> 404. Nothing is written."""
    result = await asyncio.to_thread(brain.snapshot, agent)
    if result["unknown_agent"]:
        return JSONResponse({"error": "unknown agent"}, status_code=404, headers=NO_STORE)
    return JSONResponse(result, headers=NO_STORE)


# ---- Memory drop box (inbox.py): POST saves, GET lists names, DELETE removes one generated name. -----------------
# Writes need the X-Requested-With header and a same-origin Origin/Sec-Fetch-Site (inbox.check_write_request).
# Refusals carry the status from inbox.InboxError; the body is {"error": ..., "detail"?} with no paths or contents.

def _forbidden(reason: str) -> JSONResponse:
    return JSONResponse({"error": "forbidden", "detail": reason}, status_code=403, headers=NO_STORE)


def _refused(e) -> JSONResponse:
    return JSONResponse({"error": e.message}, status_code=e.status, headers=NO_STORE)


async def _read_capped(request: Request) -> bytes:
    """Whole request body, refused with 413 past inbox.MAX_BODY_BYTES (checked on Content-Length and while reading)."""
    cl = request.headers.get("content-length", "")
    if cl.isdigit() and int(cl) > inbox.MAX_BODY_BYTES:
        raise inbox.InboxError(413, "request too large")
    chunks, total = [], 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > inbox.MAX_BODY_BYTES:
            raise inbox.InboxError(413, "request too large")
        chunks.append(chunk)
    return b"".join(chunks)


def _replay(body: bytes):
    """A receive callable that yields an already-read body once, so Starlette can parse multipart from it."""
    sent = False

    async def receive():
        nonlocal sent
        if sent:
            return {"type": "http.disconnect"}
        sent = True
        return {"type": "http.request", "body": body, "more_body": False}

    return receive


async def _parse_save(request: Request):
    """Returns a zero-argument callable that performs the save (run in a worker thread). Raises InboxError on bad
    input, before anything is written."""
    body = await _read_capped(request)
    ctype = request.headers.get("content-type", "").split(";")[0].strip().lower()
    if ctype == "multipart/form-data":
        form = await StarletteRequest(request.scope, receive=_replay(body)).form()
        try:
            up = form.get("file")
            if not isinstance(up, UploadFile):
                raise inbox.InboxError(422, "missing file field")
            data = await up.read()
            filename = up.filename
            title = form.get("title")
        finally:
            await form.close()
        return lambda: inbox.save_file(filename, data, title if isinstance(title, str) else None)
    if ctype == "application/json":
        try:
            payload = json.loads(body or b"{}")
        except ValueError:
            raise inbox.InboxError(422, "body is not valid JSON")
        if not isinstance(payload, dict):
            raise inbox.InboxError(422, "body must be a JSON object")
        title = payload.get("title")
        kind = payload.get("kind")
        if kind == "text":
            return lambda: inbox.save_text(payload.get("text"), title)
        if kind == "url":
            return lambda: inbox.save_url(payload.get("text"), title)
        if kind == "file":
            return lambda: inbox.save_b64(payload.get("name"), payload.get("content_b64"), title)
        raise inbox.InboxError(422, "kind must be text, url or file")
    raise inbox.InboxError(415, "send application/json or multipart/form-data")


@router.post("/inbox")
async def inbox_save(request: Request):
    reason = inbox.check_write_request(request.headers)
    if reason:
        return _forbidden(reason)
    try:
        saver = await _parse_save(request)
        meta = await asyncio.to_thread(saver)
    except inbox.InboxError as e:
        return _refused(e)
    except OSError:
        return JSONResponse({"error": "save failed"}, status_code=500, headers=NO_STORE)
    return JSONResponse(meta, status_code=201, headers=NO_STORE)


@router.get("/inbox")
async def inbox_list():
    """Saved drop-box items, newest first, max 100: name, size, kind, mtime. No contents."""
    items = await asyncio.to_thread(inbox.list_items)
    return JSONResponse({"items": items}, headers=NO_STORE)


@router.delete("/inbox/{name}")
async def inbox_delete(name: str, request: Request):
    reason = inbox.check_write_request(request.headers)
    if reason:
        return _forbidden(reason)
    try:
        await asyncio.to_thread(inbox.delete_item, name)
    except inbox.InboxError as e:
        return _refused(e)
    return JSONResponse({"deleted": name}, headers=NO_STORE)
