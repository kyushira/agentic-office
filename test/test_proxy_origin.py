"""Agent Deck same-origin write check behind the real reverse proxy (Traefik -> uvicorn on :4860).

The dashboard runs uvicorn with proxy_headers=True and forwarded_allow_ips=[127.0.0.1, ::1, 172.16.0.0/24]
(hermes_cli/web_server.py _build_uvicorn_server; the list comes from dashboard.trusted_proxies in config.yaml).
uvicorn's ProxyHeadersMiddleware rewrites only scope["scheme"] (from X-Forwarded-Proto) and scope["client"] (from
X-Forwarded-For). It never touches the Host header, so check_write_request sees whatever Host the proxy forwards.

These tests drive a tiny Starlette route guarded by inbox.check_write_request, wrapped in the same middleware with
the same trusted peers, and assert the CURRENT behaviour for each proxy shape. Temp/no-network only: raw ASGI calls.
"""
import asyncio
import importlib.util
import unittest
from pathlib import Path

from starlette.applications import Starlette
from starlette.responses import PlainTextResponse
from starlette.routing import Route
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

_DASH = Path(__file__).resolve().parent.parent / "plugin" / "agent-office" / "dashboard"
_spec = importlib.util.spec_from_file_location("agent_office_inbox_proxy_test", _DASH / "inbox.py")
inbox = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(inbox)

PUBLIC = "srv2094552.hstgr.cloud"
ORIGIN = f"https://{PUBLIC}"
TRUSTED = ["127.0.0.1", "::1", "172.16.0.0/24"]  # dashboard.trusted_proxies + loopback defaults
TRAEFIK_PEER = "172.16.0.2"


async def _put_brain(request):
    reason = inbox.check_write_request(request.headers)
    if reason is not None:
        return PlainTextResponse(reason, status_code=403)
    return PlainTextResponse(f"allowed client={request.client.host} scheme={request.url.scheme}", status_code=200)


APP = ProxyHeadersMiddleware(
    Starlette(routes=[Route("/brain", _put_brain, methods=["PUT"])]),
    trusted_hosts=TRUSTED,
)


def _call(headers, peer=TRAEFIK_PEER):
    """Send one PUT /brain through the proxy middleware; return (status, body)."""
    raw = [(k.lower().encode("latin1"), v.encode("latin1")) for k, v in headers]
    scope = {
        "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": "PUT",
        "scheme": "http", "path": "/brain", "raw_path": b"/brain", "root_path": "", "query_string": b"",
        "headers": raw, "client": (peer, 40000), "server": ("127.0.0.1", 4860),
    }
    messages = []

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        messages.append(message)

    asyncio.run(APP(scope, receive, send))
    status = messages[0]["status"]
    body = b"".join(m.get("body", b"") for m in messages if m["type"] == "http.response.body")
    return status, body.decode()


def _public_browser_headers(**overrides):
    """What a browser sends for a same-origin save via https://PUBLIC, after Traefik passes Host through."""
    h = {
        "Host": PUBLIC, "X-Forwarded-Host": PUBLIC, "X-Forwarded-Proto": "https",
        "X-Forwarded-For": "203.0.113.7", "Origin": ORIGIN, "Sec-Fetch-Site": "same-origin",
        "X-Requested-With": "agent-deck", "Content-Type": "application/json",
    }
    h.update(overrides)
    return [(k, v) for k, v in h.items() if v is not None]


class PublicUrlWriteThroughProxy(unittest.TestCase):
    def test_traefik_passing_original_host_is_allowed(self):
        # (a) Traefik passHostHeader=true (its default): Host == public host == Origin host -> allowed.
        status, body = _call(_public_browser_headers())
        self.assertEqual(status, 200)
        # ProxyHeadersMiddleware took the client from X-Forwarded-For and the scheme from X-Forwarded-Proto.
        self.assertEqual(body, "allowed client=203.0.113.7 scheme=https")

    def test_traefik_rewriting_host_to_loopback_is_refused_today(self):
        # (b) If Traefik were configured to rewrite Host to the upstream (passHostHeader=false), Host is
        # 127.0.0.1:4860 while Origin names the public host -> refused. Current behaviour: 403.
        headers = _public_browser_headers(Host="127.0.0.1:4860")
        status, body = _call(headers)
        self.assertEqual(status, 403)
        self.assertEqual(body, "origin does not match host")

    def test_origin_with_explicit_default_port_is_refused_today(self):
        # (c) Origin 'https://host:443' vs Host 'host' -> netloc differs -> 403. Browsers omit default ports in
        # Origin, so this only matters for non-browser clients; documenting the strictness.
        status, body = _call(_public_browser_headers(Origin=f"{ORIGIN}:443"))
        self.assertEqual(status, 403)
        self.assertEqual(body, "origin does not match host")

    def test_cross_site_origin_is_refused(self):
        # (d) Origin from another site with the public Host -> 403.
        status, body = _call(_public_browser_headers(Origin="https://evil.example"))
        self.assertEqual(status, 403)
        self.assertEqual(body, "origin does not match host")

    def test_cross_site_fetch_metadata_is_refused(self):
        # (e) Matching Origin but Sec-Fetch-Site: cross-site -> 403.
        status, body = _call(_public_browser_headers(**{"Sec-Fetch-Site": "cross-site"}))
        self.assertEqual(status, 403)
        self.assertEqual(body, "cross-site request refused")

    def test_missing_agent_deck_header_is_refused(self):
        # Baseline for the 403 path: without X-Requested-With nothing else matters.
        status, body = _call(_public_browser_headers(**{"X-Requested-With": None}))
        self.assertEqual(status, 403)
        self.assertEqual(body, "missing X-Requested-With header")

    def test_untrusted_peer_cannot_spoof_scheme_or_client(self):
        # Peer outside the trusted proxies: X-Forwarded-* ignored by the middleware, so the client stays the peer.
        status, body = _call(_public_browser_headers(), peer="198.51.100.9")
        self.assertEqual(status, 200)
        self.assertEqual(body, "allowed client=198.51.100.9 scheme=http")


if __name__ == "__main__":
    unittest.main()
