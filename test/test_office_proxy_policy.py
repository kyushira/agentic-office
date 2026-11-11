"""Sentinel fixes 2 and 3: the office proxy's browser allowlist, the HTML CSP, and the /office/ws Origin check.

Imports plugin_api.py (fastapi + httpx from the hermes venv). The upstream is never contacted: httpx.AsyncClient is
replaced with a recorder, and the WebSocket close is a fake. Run with /opt/hermes/.venv/bin/python -I.
"""
import asyncio
import importlib.util
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

os.environ.setdefault("AGENT_OFFICE_TEAM_POLL", "0")  # the team poller thread is not needed here

import httpx  # noqa: E402
from starlette.requests import Request  # noqa: E402
from starlette.responses import JSONResponse  # noqa: E402

_DASH = Path(__file__).resolve().parent.parent / "plugin" / "agent-office" / "dashboard"
_spec = importlib.util.spec_from_file_location("agent_office_plugin_api_policy_test", _DASH / "plugin_api.py")
api = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(api)

ALLOWED = [
    ("GET", ""), ("GET", "assets/app.js"), ("HEAD", "assets/app.js"), ("GET", "chat"), ("GET", "settings"),
    ("GET", "permission/abc"), ("POST", "chat"), ("POST", "/chat/"), ("POST", "//chat"), ("POST", "Chat"),
    ("POST", "settings"), ("POST", "permission/abc"), ("POST", "permission/abc/allow"),
    ("GET", "clearx"),  # a different route name, not /clear
]
BLOCKED = [
    # /clear, /event, /status, /a2a: refused for GET and POST, with duplicate slashes, trailing slashes and
    # case changes
    ("POST", "clear"), ("POST", "/clear"), ("POST", "//clear"), ("POST", "clear/"), ("POST", "Clear"),
    ("GET", "clear"), ("POST", "event"), ("GET", "event"), ("GET", "status"), ("GET", "status/"),
    ("POST", "status"), ("GET", "a2a"), ("POST", "a2a"), ("GET", "/a2a/agents"), ("POST", "a2a/x"),
    # '..' tricks
    ("POST", "chat/../clear"), ("POST", "/chat/../clear"), ("GET", "clear/..//x"), ("POST", "clear/../chat"),
    # percent-encoded tricks: the router decodes once, so a literal '%' means a double-encoded byte
    ("POST", "%63lear"), ("POST", "%2e%2e/clear"), ("POST", "chat%2F..%2Fclear"), ("POST", "chat/..%2fclear"),
    # separators and characters that change how the upstream reads the path
    ("POST", "chat\\..\\clear"), ("POST", "chat?x=/clear"), ("POST", "chat#x"), ("POST", "chat "),
    ("POST", "chat\x00"),
    # methods: PUT, PATCH, DELETE and OPTIONS are refused anywhere
    ("PUT", "chat"), ("PATCH", "settings"), ("DELETE", "permission/1"), ("PUT", "assets/app.js"),
    ("OPTIONS", "chat"),
    # POST only to chat, settings and permission: anything else is refused
    ("POST", ""), ("POST", "settings/x"), ("POST", "chat/x"), ("POST", "permission"),
    ("POST", "assets/app.js"), ("POST", "info"), ("POST", "x/chat"),
]


class RouteAllowlistTest(unittest.TestCase):
    def test_allowed_routes(self):
        for method, path in ALLOWED:
            with self.subTest(method=method, path=path):
                self.assertTrue(api.office_route_allowed(method, path))

    def test_blocked_routes(self):
        for method, path in BLOCKED:
            with self.subTest(method=method, path=path):
                self.assertFalse(api.office_route_allowed(method, path))

    def test_non_string_path_refused(self):
        self.assertFalse(api.office_route_allowed("GET", None))  # type: ignore[arg-type]


class ChatBodyTest(unittest.TestCase):
    def test_privileged_clear_refused(self):
        for text in ("/clear", "  /clear", "/CLEAR", "/clear now"):
            with self.subTest(text=text):
                self.assertFalse(api.office_chat_body_allowed(('{"text": "%s"}' % text).encode()))

    def test_plain_chat_allowed(self):
        self.assertTrue(api.office_chat_body_allowed(b'{"text": "hello"}'))
        self.assertTrue(api.office_chat_body_allowed(b""))  # the upstream answers the empty body with 400

    def test_unparseable_body_refused(self):
        self.assertFalse(api.office_chat_body_allowed(b"{not json"))


class _FakeClient:
    """Stands in for httpx.AsyncClient. Records every upstream call; never opens a socket."""
    calls: list = []
    response: httpx.Response = httpx.Response(200, json={"ok": True})

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def request(self, method, url, **kwargs):
        _FakeClient.calls.append((method, url))
        return _FakeClient.response


def _request(method: str, path: str, body: bytes = b"") -> Request:
    scope = {"type": "http", "method": method, "path": "/office/" + path, "headers": [],
             "query_string": b"", "root_path": "", "scheme": "http", "server": ("test", 80)}
    sent = {"done": False}

    async def receive():
        if sent["done"]:
            return {"type": "http.disconnect"}
        sent["done"] = True
        return {"type": "http.request", "body": body, "more_body": False}

    return Request(scope, receive)


class OfficeHttpPolicyTest(unittest.TestCase):
    def setUp(self):
        _FakeClient.calls = []
        _FakeClient.response = httpx.Response(200, json={"ok": True})
        self._patches = [
            mock.patch.object(api, "_office_gate_open", return_value=True),
            mock.patch.object(api, "_office_token", return_value="tok"),
            mock.patch.object(api.httpx, "AsyncClient", _FakeClient),
        ]
        for p in self._patches:
            p.start()
        self.addCleanup(lambda: [p.stop() for p in self._patches])

    def _run(self, method, path, body=b""):
        return asyncio.run(api.office_http(_request(method, path, body), path=path))

    def test_post_clear_is_403_and_upstream_is_not_called(self):
        resp = self._run("POST", "clear")
        self.assertEqual(resp.status_code, 403)
        self.assertEqual(_FakeClient.calls, [])

    def test_post_chat_with_clear_body_is_403_and_upstream_is_not_called(self):
        resp = self._run("POST", "chat", b'{"text": "/clear"}')
        self.assertEqual(resp.status_code, 403)
        self.assertEqual(_FakeClient.calls, [])

    def test_put_is_405_and_upstream_is_not_called(self):
        resp = self._run("PUT", "chat", b"{}")
        self.assertEqual(resp.status_code, 405)
        self.assertEqual(resp.headers.get("allow"), "GET, HEAD, POST")
        self.assertEqual(_FakeClient.calls, [])

    def test_bypass_paths_do_not_reach_upstream(self):
        for method, path in (("POST", "chat/../clear"), ("GET", "status"), ("POST", "%2e%2e/clear")):
            with self.subTest(method=method, path=path):
                self.assertEqual(self._run(method, path).status_code, 403)
        self.assertEqual(_FakeClient.calls, [])

    def test_plain_chat_post_reaches_upstream(self):
        resp = self._run("POST", "chat", b'{"text": "hello"}')
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(len(_FakeClient.calls), 1)
        self.assertEqual(_FakeClient.calls[0][0], "POST")


class CspTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR"))
        self.addCleanup(self._tmp.cleanup)
        root = Path(self._tmp.name)
        (root / "index.html").write_text("<!doctype html><script type=\"module\" src=\"/assets/app.js\"></script>")
        (root / "assets").mkdir()
        (root / "assets" / "app.js").write_text("console.log(1)")
        _FakeClient.calls = []
        _FakeClient.response = httpx.Response(200, json={"ok": True})
        self._patches = [
            mock.patch.object(api, "_office_gate_open", return_value=True),
            mock.patch.object(api, "_office_token", return_value="tok"),
            mock.patch.object(api, "OFFICE_DIST", root),
            mock.patch.object(api.httpx, "AsyncClient", _FakeClient),
        ]
        for p in self._patches:
            p.start()
        self.addCleanup(lambda: [p.stop() for p in self._patches])

    def _get(self, path):
        return asyncio.run(api.office_http(_request("GET", path), path=path))

    def test_csp_policy_text(self):
        csp = api.OFFICE_CSP
        for directive in ("frame-ancestors 'self'", "connect-src 'self'", "object-src 'none'", "base-uri 'self'"):
            self.assertIn(directive, csp)
        self.assertNotIn("script-src", csp)  # the built bundle is one external module script, no inline script

    def test_csp_on_served_index_html(self):
        resp = self._get("")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.headers.get("content-security-policy"), api.OFFICE_CSP)

    def test_no_csp_on_other_static_assets(self):
        resp = self._get("assets/app.js")
        self.assertEqual(resp.status_code, 200)
        self.assertNotIn("content-security-policy", resp.headers)

    def test_csp_on_proxied_html_only(self):
        _FakeClient.response = httpx.Response(200, headers={"content-type": "text/html; charset=utf-8"},
                                              content=b"<html></html>")
        self.assertEqual(self._proxied("chat").headers.get("content-security-policy"), api.OFFICE_CSP)
        _FakeClient.response = httpx.Response(200, json={"ok": True})
        self.assertNotIn("content-security-policy", self._proxied("chat").headers)

    def _proxied(self, path):
        return asyncio.run(api.office_http(_request("POST", path, b"{}"), path=path))


class _FakeWS:
    def __init__(self, headers):
        self.headers = headers
        self.closed = []

    async def close(self, code=1000):
        self.closed.append(code)


class WsOriginTest(unittest.TestCase):
    PUBLIC = "hermes-agent-cnfo.srv2094552.hstgr.cloud"

    def test_helper_table(self):
        pub = self.PUBLIC
        good = [
            (f"https://{pub}", pub, pub),
            (f"http://{pub}", pub, pub),
            (f"https://{pub}", "127.0.0.1:3334", pub),  # the request's own Host also works
        ]
        for origin, host, public in good:
            with self.subTest(origin=origin, host=host):
                self.assertTrue(api.office_ws_origin_allowed(origin, host, public))
        bad = [
            (None, pub, pub),  # missing Origin
            ("", pub, pub),
            ("null", pub, pub),
            (f"https://evil.{pub}", pub, pub),  # lookalike: suffix
            (f"https://evil-{pub}", pub, pub),  # lookalike: hyphen prefix
            (f"https://{pub}.evil.com", pub, pub),  # lookalike: host as a label of another domain
            ("https://evil.com", pub, pub),
            (f"https://{pub}@evil.com", pub, pub),  # userinfo trick
            (f"https://{pub}/x", pub, pub),  # a path is not an Origin
            (f"https://{pub}?x=1", pub, pub),
            (f"https://{pub}:443", pub, pub),  # browsers omit default ports in Origin; an explicit :443 is refused
            (f"ftp://{pub}", pub, pub),
            ("", "", ""),
        ]
        for origin, host, public in bad:
            with self.subTest(origin=origin, host=host):
                self.assertFalse(api.office_ws_origin_allowed(origin, host, public))

    def _run_ws(self, headers):
        ws = _FakeWS(headers)
        session_calls = []

        def session_ok(_ws):
            session_calls.append(1)
            return False

        with mock.patch.object(api, "OFFICE_PUBLIC_HOST", self.PUBLIC), \
                mock.patch.object(api, "_office_ws_session_ok", session_ok):
            asyncio.run(api.office_ws(ws))
        return ws, session_calls

    def test_foreign_origin_closed_before_session_check(self):
        ws, session_calls = self._run_ws({"origin": "https://evil.com", "host": self.PUBLIC})
        self.assertEqual(ws.closed, [1008])
        self.assertEqual(session_calls, [])

    def test_missing_origin_closed(self):
        ws, session_calls = self._run_ws({"host": self.PUBLIC})
        self.assertEqual(ws.closed, [1008])
        self.assertEqual(session_calls, [])

    def test_lookalike_hosts_closed(self):
        for origin in (f"https://evil-{self.PUBLIC}", f"https://{self.PUBLIC}.evil.com"):
            with self.subTest(origin=origin):
                ws, session_calls = self._run_ws({"origin": origin, "host": self.PUBLIC})
                self.assertEqual(ws.closed, [1008])
                self.assertEqual(session_calls, [])

    def test_good_origin_passes_to_session_check(self):
        ws, session_calls = self._run_ws({"origin": f"https://{self.PUBLIC}", "host": self.PUBLIC})
        self.assertEqual(session_calls, [1])  # origin accepted: the session check runs (it is mocked to refuse)
        self.assertEqual(ws.closed, [1008])


if __name__ == "__main__":
    unittest.main()
