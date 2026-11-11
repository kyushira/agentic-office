"""Agent Office backend: one read-only endpoint, GET /api/plugins/agent-office/state.

Mounted by the Hermes dashboard behind its login. The snapshot is computed in a
worker thread (never on the event loop) and cached for a few seconds, so many
open tabs cost one scan.
"""
import asyncio
import hashlib
import importlib.util
import json
import re
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

_ebspec = importlib.util.spec_from_file_location("agent_office_brain_edit", Path(__file__).with_name("brain_edit.py"))
brain_edit = importlib.util.module_from_spec(_ebspec)
_ebspec.loader.exec_module(brain_edit)

_sspec = importlib.util.spec_from_file_location("agent_office_server_stats", Path(__file__).with_name("server_stats.py"))
server_stats = importlib.util.module_from_spec(_sspec)
_sspec.loader.exec_module(server_stats)

_wspec = importlib.util.spec_from_file_location("agent_office_wiki", Path(__file__).with_name("wiki.py"))
wiki = importlib.util.module_from_spec(_wspec)
_wspec.loader.exec_module(wiki)

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


@router.get("/server")
async def server_endpoint():
    """Read-only server card: RAM, root disk, load and top-3 RSS processes. Query params are ignored. Unreadable
    meminfo -> 503 with a fixed body; any other failing section is null."""
    result = await asyncio.to_thread(server_stats.snapshot)
    if result is None:
        return JSONResponse({"error": "server stats unavailable"}, status_code=503, headers=NO_STORE)
    return JSONResponse(result, headers=NO_STORE)


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


def _brain_view(agent):
    """The GET /brain payload: the read-only snapshot with the edit state of every file (brain_edit.mark_snapshot)."""
    return brain_edit.mark_snapshot(brain.snapshot(agent), brain_edit.edit_enabled())


@router.get("/brain")
async def brain_endpoint(agent: str | None = Query(None, max_length=32)):
    """Read-only SOUL.md, MEMORY.md and USER.md per whitelisted agent (see brain.py), with edit_enabled and each file's
    editable / edit_block / confirm_token (brain_edit.mark_snapshot). agent narrows to one agent; an unknown agent ->
    404. Nothing is written."""
    result = await asyncio.to_thread(_brain_view, agent)
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
    if re.fullmatch(r"[0-9]+", cl) and int(cl) > inbox.MAX_BODY_BYTES:
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


# ---- Brain editor (brain_edit.py): PUT /brain saves one file, GET /brain/versions and /brain/version list and read
# backups, POST /brain/restore puts a backup back. Writes need the same headers as the inbox (check_write_request).
# Refusals carry brain_edit.EditError's status and body: no file contents, no paths.

def _edit_refused(e) -> JSONResponse:
    return JSONResponse(e.body, status_code=e.status, headers=NO_STORE)


def _edit_disabled() -> JSONResponse:
    return JSONResponse({"error": "brain edit disabled"}, status_code=403, headers=NO_STORE)


def _author(request: Request) -> str:
    """Who an audit line names. A dashboard session: 'user:<Session.user_id>' (dashboard_auth/base.py). A bearer
    token or native-app grant: only the path and the principal's type name, since the principal's fields belong to
    the auth provider. Otherwise the client address and the first 16 hex of sha256(User-Agent); the raw User-Agent
    is never kept. brain_edit cleans the text."""
    sess = getattr(request.state, "session", None)
    if sess is not None:
        return f"user:{getattr(sess, 'user_id', '')}"
    tp = getattr(request.state, "token_principal", None)
    if tp is not None:
        return f"token:{type(tp).__name__}"
    grant = getattr(request.state, "native_http_principal", None)
    if grant is not None:
        return f"native:{grant.get('purpose', '') if isinstance(grant, dict) else ''}"
    host = request.client.host if request.client else "unknown"
    ua = request.headers.get("user-agent", "").encode("utf-8", errors="replace")
    return f"addr:{host} ua:{hashlib.sha256(ua).hexdigest()[:16]}"


def _version_view(agent, file, vid) -> dict:
    """GET /brain/version: the backup (get_version) plus its restore fields (live_state): base_sha always, and a
    confirm_token only while editing is on."""
    enabled = brain_edit.edit_enabled()
    out = brain_edit.get_version(agent, file, vid, root=brain.DEFAULT_ROOT)
    out.update(brain_edit.live_state(agent, file, root=brain.DEFAULT_ROOT, enabled=enabled))
    return out


async def _brain_body(request: Request) -> dict:
    """JSON object body, refused with 413 past brain_edit.MAX_BODY_BYTES (checked on Content-Length and while reading)."""
    cl = request.headers.get("content-length", "")
    if re.fullmatch(r"[0-9]+", cl) and int(cl) > brain_edit.MAX_BODY_BYTES:
        raise brain_edit.EditError(413, {"error": "request too large"})
    chunks, total = [], 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > brain_edit.MAX_BODY_BYTES:
            raise brain_edit.EditError(413, {"error": "request too large"})
        chunks.append(chunk)
    try:
        payload = json.loads(b"".join(chunks))
    except (ValueError, RecursionError):
        raise brain_edit.EditError(422, {"error": "body is not valid JSON"})
    if not isinstance(payload, dict):
        raise brain_edit.EditError(422, {"error": "body must be a JSON object"})
    return payload


@router.put("/brain")
async def brain_save(request: Request):
    """Saves one file. 403 'brain edit disabled' when the flag is off (checked before the body is read)."""
    if not brain_edit.edit_enabled():
        return _edit_disabled()
    reason = inbox.check_write_request(request.headers)
    if reason:
        return _forbidden(reason)
    try:
        payload = await _brain_body(request)
        author = _author(request)
        result = await asyncio.to_thread(brain_edit.save, payload, root=brain.DEFAULT_ROOT, author=author)
    except brain_edit.EditError as e:
        return _edit_refused(e)
    except OSError:
        return JSONResponse({"error": "save failed"}, status_code=500, headers=NO_STORE)
    return JSONResponse(result, headers=NO_STORE)


@router.post("/brain/restore")
async def brain_restore(request: Request):
    """Puts a backup back. 403 'brain edit disabled' when the flag is off (checked before the body is read)."""
    if not brain_edit.edit_enabled():
        return _edit_disabled()
    reason = inbox.check_write_request(request.headers)
    if reason:
        return _forbidden(reason)
    try:
        payload = await _brain_body(request)
        author = _author(request)
        result = await asyncio.to_thread(brain_edit.restore, payload, root=brain.DEFAULT_ROOT, author=author)
    except brain_edit.EditError as e:
        return _edit_refused(e)
    except OSError:
        return JSONResponse({"error": "restore failed"}, status_code=500, headers=NO_STORE)
    return JSONResponse(result, headers=NO_STORE)


@router.get("/brain/versions")
async def brain_versions(agent: str | None = Query(None, max_length=32), file: str | None = Query(None, max_length=16)):
    """Backups of one file, newest first: {versions: [{id, ts, chars, sha}]}. Unknown agent or file -> 404."""
    try:
        result = await asyncio.to_thread(brain_edit.list_versions, agent, file, root=brain.DEFAULT_ROOT)
    except brain_edit.EditError as e:
        return _edit_refused(e)
    return JSONResponse(result, headers=NO_STORE)


@router.get("/brain/version")
async def brain_version(agent: str | None = Query(None, max_length=32), file: str | None = Query(None, max_length=16),
                        version_id: str | None = Query(None, alias="id", max_length=64)):
    """One backup's redacted text, its scan findings (findings, or scan_unavailable), and base_sha / confirm_token for a
    restore (the token only while editing is on). The id must match the backup listing, else 404."""
    try:
        result = await asyncio.to_thread(_version_view, agent, file, version_id)
    except brain_edit.EditError as e:
        return _edit_refused(e)
    return JSONResponse(result, headers=NO_STORE)


# ---- Wiki (wiki.py): read-only GET routes over the wiki root. Every refusal is {"error": fixed string}, no paths.

async def _wiki_result(fn, *args):
    try:
        body = await asyncio.to_thread(fn, *args)
    except wiki.WikiError as e:
        return JSONResponse({"error": e.message}, status_code=e.status, headers=NO_STORE)
    except OSError:
        return JSONResponse({"error": "read failed"}, status_code=500, headers=NO_STORE)
    return JSONResponse(body, headers=NO_STORE)


@router.get("/wiki/index")
async def wiki_index():
    """index.md as {"text"}. 413 past 64 KB; 404 when missing or refused."""
    return await _wiki_result(wiki.index)


@router.get("/wiki/list")
async def wiki_list(dir: str | None = Query(None)):
    """Pages in one of entities, concepts, comparisons, queries: {"items": [{path, title, type, updated}]}. 400 otherwise."""
    return await _wiki_result(wiki.list_pages, dir)


@router.get("/wiki/page")
async def wiki_page(path: str | None = Query(None)):
    """One page: frontmatter, redacted body (256 KB cap), links and backlinks. Any refused path or missing file -> 404."""
    return await _wiki_result(wiki.page, path)


@router.get("/wiki/search")
async def wiki_search(q: str | None = Query(None)):
    """Case-insensitive substring search over titles and bodies: {"results": [{path, title, snippet}]}, max 20. q must be 2..100 chars."""
    return await _wiki_result(wiki.search, q)


@router.get("/wiki/log")
async def wiki_log(tail: str | None = Query(None)):
    """Parsed log.md headings, newest first: {"entries": [{date, action, subject, body}]}. tail is 1..200, default 50."""
    return await _wiki_result(wiki.log, tail)


# ---------------------------------------------------------------------------
# Claude Office under /api/plugins/agent-office/office/
#
# The office UI (built by office-build/build-office.mjs) is served from OFFICE_DIST.
# Every other request under /office/ is reverse-proxied to the office server on
# loopback, with the office token added here, server side. Auth is the dashboard's:
#   * HTTP: the dashboard's gated middleware already ran (no cookie -> 302 /login).
#   * WebSocket: the dashboard gate does not run for upgrades, so office_ws checks the
#     dashboard session cookie itself (same verify path as the native bearer leg).
# Refused outright unless the dashboard runs with auth_required: an open dashboard must
# not hand the office token to anyone who can reach its port.
# The browser never sees the office token; the dashboard Authorization header is not
# forwarded either (the dashboard gate would read it as its own credential).
# ---------------------------------------------------------------------------

import os

import httpx
from fastapi import WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from starlette.responses import Response

OFFICE_UPSTREAM_PORT = int(os.environ.get("AGENT_OFFICE_PORT", "3334"))
OFFICE_PUBLIC_HOST = os.environ.get("AGENT_OFFICE_PUBLIC_HOST", "hermes-agent-cnfo.srv2094552.hstgr.cloud")
OFFICE_DIST = Path(os.environ.get("AGENT_OFFICE_DIST", Path(__file__).with_name("office-dist")))
OFFICE_HOME = Path(os.environ.get("AGENT_OFFICE_HOME", "/opt/data/home/.agent-office"))
OFFICE_WS_PROTOCOL = "agent-office"
OFFICE_TOKEN_PROTOCOL_PREFIX = "agent-office.token."

# Hop-by-hop, dashboard credentials and proxy markers: never forwarded upstream. The
# office server treats any X-Forwarded-* / Forwarded / Tailscale-* header as "came through a
# reverse proxy", so the dashboard's own proxy headers are dropped too.
_OFFICE_DROP_REQUEST = {
    "host", "authorization", "cookie", "connection", "keep-alive", "transfer-encoding", "te",
    "upgrade", "proxy-authorization", "proxy-connection", "content-length", "accept-encoding",
    "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-port", "x-real-ip",
    "forwarded", "x-office-timestamp", "x-office-signature", "x-hermes-gateway-ticket",
    "sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions", "sec-websocket-protocol",
}
_OFFICE_DROP_RESPONSE = {"connection", "keep-alive", "transfer-encoding", "content-length", "content-encoding"}
_OFFICE_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
_NO_STORE_HEADERS = {"Cache-Control": "no-store"}


def _office_token() -> str | None:
    """The office file token, read per use so a rotated token is picked up. Never logged."""
    try:
        token = (OFFICE_HOME / "auth-token").read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return token or None


# The Hermes team as Claude Office characters: one daemon poller, started once (AGENT_OFFICE_TEAM_POLL=0 disables).
_tspec = importlib.util.spec_from_file_location("agent_office_team", Path(__file__).with_name("office_team.py"))
team = importlib.util.module_from_spec(_tspec)
_tspec.loader.exec_module(team)
team.start(collect.root_home(), OFFICE_HOME / "auth-token", OFFICE_UPSTREAM_PORT)


def _office_gate_open(conn) -> bool:
    """True only when the dashboard runs with its auth gate engaged (see the block comment)."""
    from hermes_cli.web_server import app as dashboard_app
    return bool(getattr(dashboard_app.state, "auth_required", False))


def _office_ws_session_ok(ws: WebSocket) -> bool:
    """WebSocket upgrades bypass the dashboard HTTP middleware: verify the session cookie here."""
    if not _office_gate_open(ws):
        return False
    from hermes_cli.dashboard_auth.cookies import read_session_cookies, read_session_provider
    from hermes_cli.dashboard_auth.middleware import _verify_access_token
    access_token, _refresh = read_session_cookies(ws)
    if not access_token:
        return False
    try:
        return _verify_access_token(
            ws, access_token=access_token, provider_hint=read_session_provider(ws), audit=False) is not None
    except Exception:  # a provider outage is a refusal, never an open door
        return False


def _office_static_file(rel: str) -> Path | None:
    """A file of the built UI, or None. Traversal-safe: the resolved path must stay under OFFICE_DIST."""
    if not OFFICE_DIST.is_dir():
        return None
    root = OFFICE_DIST.resolve()
    target = (root / (rel.strip("/") or "index.html")).resolve()
    try:
        target.relative_to(root)
    except ValueError:
        return None
    return target if target.is_file() else None


@router.api_route("/office", methods=_OFFICE_METHODS, include_in_schema=False)
@router.api_route("/office/{path:path}", methods=_OFFICE_METHODS, include_in_schema=False)
async def office_http(request: Request, path: str = ""):
    if not _office_gate_open(request):
        return JSONResponse({"error": "office proxy needs dashboard auth"}, status_code=403)
    if request.method in ("GET", "HEAD"):
        static = _office_static_file(path)
        if static is not None:
            headers = _NO_STORE_HEADERS if static.name == "index.html" else None
            return FileResponse(static, headers=headers)
    token = _office_token()
    if token is None:
        return JSONResponse({"error": "office token unavailable"}, status_code=503)
    headers = {k: v for k, v in request.headers.items() if k.lower() not in _OFFICE_DROP_REQUEST}
    headers["host"] = OFFICE_PUBLIC_HOST
    headers["authorization"] = f"Bearer {token}"
    url = f"http://127.0.0.1:{OFFICE_UPSTREAM_PORT}/{path}"
    body = await request.body()
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(30.0), follow_redirects=False) as client:
            upstream = await client.request(
                request.method, url, params=request.query_params, headers=headers, content=body or None)
    except httpx.HTTPError:
        return JSONResponse({"error": "office server unreachable"}, status_code=502)
    response = Response(content=upstream.content, status_code=upstream.status_code)
    for key, value in upstream.headers.multi_items():
        if key.lower() not in _OFFICE_DROP_RESPONSE:
            response.headers.append(key, value)
    return response


@router.websocket("/office/ws")
async def office_ws(ws: WebSocket):
    if not _office_ws_session_ok(ws):
        await ws.close(code=1008)  # refused before accept: the client sees a handshake 403
        return
    token = _office_token()
    if token is None:
        await ws.close(code=1011)
        return
    import websockets

    offered = ws.scope.get("subprotocols") or []
    chosen = OFFICE_WS_PROTOCOL if OFFICE_WS_PROTOCOL in offered else None
    origin = ws.headers.get("origin") or f"https://{OFFICE_PUBLIC_HOST}"
    try:
        upstream = await websockets.connect(
            f"ws://127.0.0.1:{OFFICE_UPSTREAM_PORT}/ws",
            subprotocols=[OFFICE_WS_PROTOCOL, f"{OFFICE_TOKEN_PROTOCOL_PREFIX}{token}"],
            additional_headers={"Host": OFFICE_PUBLIC_HOST, "Origin": origin},
            max_size=None,
            open_timeout=10,
        )
    except Exception:
        await ws.close(code=1011)
        return
    await ws.accept(subprotocol=chosen)

    async def upstream_to_client():
        async for message in upstream:
            if isinstance(message, bytes):
                await ws.send_bytes(message)
            else:
                await ws.send_text(message)

    async def client_to_upstream():
        while True:
            message = await ws.receive()
            if message["type"] == "websocket.disconnect":
                return
            if message.get("text") is not None:
                await upstream.send(message["text"])
            elif message.get("bytes") is not None:
                await upstream.send(message["bytes"])

    tasks = [asyncio.ensure_future(upstream_to_client()), asyncio.ensure_future(client_to_upstream())]
    try:
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for task in tasks:
            task.cancel()
        await upstream.close()
        try:
            await ws.close()
        except (RuntimeError, WebSocketDisconnect):
            pass
