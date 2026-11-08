"""Unit and endpoint tests for the memory drop box (inbox.py, POST/GET/DELETE /inbox in plugin_api.py) and the inbox
search in memory.search. Every test writes to a temp inbox folder (AGENT_DECK_INBOX_DIR or an explicit base), so the
real /opt/data/memory/inbox is never touched. Run via unittest discover."""
import asyncio
import importlib.util
import json
import os
import re
import stat
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

_DASH = Path(__file__).resolve().parent.parent / "plugin" / "agent-office" / "dashboard"


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


inbox = _load("inbox_under_test", _DASH / "inbox.py")
memory = _load("memory_under_test", _DASH / "memory.py")

NAME_SHAPE = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{6}Z-[a-z0-9][a-z0-9-]{0,39}(?:-[0-9]{1,3})?\.(?:txt|md|pdf)$")
FIXED = datetime(2026, 11, 8, 21, 30, 0, tzinfo=timezone.utc)
HDR = {"X-Requested-With": "agent-deck"}
PDF = b"%PDF-1.4\n%fake body for a test\n"


class _Temp(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.dir = self.root / "inbox"

    def tearDown(self):
        self._tmp.cleanup()


class SaveTests(_Temp):
    def test_text_is_saved_with_generated_name_and_mode_0600(self):
        meta = inbox.save_text("hello deck", title="Ops Notes!", base=self.dir, now=FIXED)
        self.assertEqual(meta["name"], "2026-11-08T213000Z-ops-notes.txt")
        self.assertEqual(meta["kind"], "text")
        self.assertEqual(meta["size"], len("hello deck".encode()))
        p = self.dir / meta["name"]
        self.assertEqual(p.read_text(), "hello deck")
        self.assertEqual(stat.S_IMODE(os.stat(p).st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(os.stat(self.dir).st_mode), 0o700)
        self.assertEqual([x.name for x in self.dir.iterdir()], [meta["name"]])  # no temp file left behind

    def test_url_is_saved_as_md_note_and_never_fetched(self):
        import socket
        real = socket.socket.connect

        def no_network(*a, **k):
            raise AssertionError("inbox must not open network connections")

        socket.socket.connect = no_network
        try:
            meta = inbox.save_url("https://example.com/a/b?x=1", base=self.dir, now=FIXED)
        finally:
            socket.socket.connect = real
        self.assertEqual(meta["kind"], "markdown")
        self.assertTrue(meta["name"].endswith("-example-com.md"))
        self.assertIn("Source: https://example.com/a/b?x=1", (self.dir / meta["name"]).read_text())

    def test_url_must_be_http_or_https_without_whitespace(self):
        for bad in ("javascript:alert(1)", "file:///etc/passwd", "https://", "https://a b.com", "ftp://x.org", "",
                    "https://x.org/\nX: y"):
            with self.assertRaises(inbox.InboxError, msg=bad) as ctx:
                inbox.save_url(bad, base=self.dir)
            self.assertEqual(ctx.exception.status, 422)

    def test_md_file_is_saved(self):
        meta = inbox.save_file("notes.md", b"# heading\n\nbody\n", base=self.dir, now=FIXED)
        self.assertEqual(meta["kind"], "markdown")
        self.assertEqual(meta["name"], "2026-11-08T213000Z-notes.md")

    def test_pdf_with_magic_is_saved(self):
        meta = inbox.save_file("paper.PDF", PDF, base=self.dir, now=FIXED)
        self.assertEqual(meta["kind"], "pdf")
        self.assertEqual((self.dir / meta["name"]).read_bytes(), PDF)

    def test_pdf_without_magic_is_refused(self):
        with self.assertRaises(inbox.InboxError) as ctx:
            inbox.save_file("fake.pdf", b"<html>not a pdf</html>", base=self.dir)
        self.assertEqual(ctx.exception.status, 415)
        self.assertEqual(list(self.dir.glob("*")) if self.dir.exists() else [], [])

    def test_executable_and_web_types_are_refused(self):
        for name in ("tool.exe", "page.html", "app.js", "pic.svg", "run.sh", "x.htm", "README", "a.txt.exe"):
            with self.assertRaises(inbox.InboxError, msg=name) as ctx:
                inbox.save_file(name, b"data", base=self.dir)
            self.assertEqual(ctx.exception.status, 415, name)
        self.assertEqual(list(self.dir.iterdir()) if self.dir.exists() else [], [])

    def test_text_file_with_nul_or_bad_utf8_is_refused(self):
        for data in (b"ab\x00cd", b"\xff\xfe\xfa"):
            with self.assertRaises(inbox.InboxError) as ctx:
                inbox.save_file("bin.txt", data, base=self.dir)
            self.assertEqual(ctx.exception.status, 415)

    def test_over_size_is_refused_with_413(self):
        with self.assertRaises(inbox.InboxError) as ctx:
            inbox.save_file("big.txt", b"a" * (inbox.MAX_FILE_BYTES + 1), base=self.dir)
        self.assertEqual(ctx.exception.status, 413)
        with self.assertRaises(inbox.InboxError) as ctx:
            inbox.save_text("a" * (inbox.MAX_TEXT_BYTES + 1), base=self.dir)
        self.assertEqual(ctx.exception.status, 413)
        with self.assertRaises(inbox.InboxError) as ctx:
            inbox.save_b64("big.txt", "A" * (((inbox.MAX_FILE_BYTES + 2) // 3) * 4 + 4), base=self.dir)
        self.assertEqual(ctx.exception.status, 413)

    def test_exact_size_limit_is_accepted(self):
        meta = inbox.save_file("edge.txt", b"a" * inbox.MAX_FILE_BYTES, base=self.dir, now=FIXED)
        self.assertEqual(meta["size"], inbox.MAX_FILE_BYTES)

    def test_base64_upload_round_trips(self):
        import base64
        meta = inbox.save_b64("p.pdf", base64.b64encode(PDF).decode(), base=self.dir, now=FIXED)
        self.assertEqual((self.dir / meta["name"]).read_bytes(), PDF)
        with self.assertRaises(inbox.InboxError) as ctx:
            inbox.save_b64("p.pdf", "%%%not base64", base=self.dir)
        self.assertEqual(ctx.exception.status, 422)

    def test_traversal_style_file_names_are_refused(self):
        for name in ("../x.txt", "/etc/passwd", "..%2fx.txt", "..%2F..%2Fetc%2Fpasswd", "a/b.txt", "a\\b.txt",
                     "x\x00.txt", "..", "../x", "/etc/passwd.txt"):
            with self.assertRaises(inbox.InboxError, msg=name) as ctx:
                inbox.save_file(name, b"data", base=self.dir)
            self.assertIn(ctx.exception.status, (415, 422), name)
        self.assertEqual(list(self.dir.iterdir()) if self.dir.exists() else [], [])

    def test_title_is_slugged_and_bounded(self):
        meta = inbox.save_text("x", title="../../Etc Passwd " + "z" * 100, base=self.dir, now=FIXED)
        stem = meta["name"][len("2026-11-08T213000Z-"):-len(".txt")]
        self.assertRegex(stem, r"^[a-z0-9][a-z0-9-]{0,39}$")
        with self.assertRaises(inbox.InboxError):
            inbox.save_text("x", title="t" * (inbox.MAX_TITLE_CHARS + 1), base=self.dir)

    def test_no_overwrite_on_same_name(self):
        a = inbox.save_text("first", title="same", base=self.dir, now=FIXED)["name"]
        b = inbox.save_text("second", title="same", base=self.dir, now=FIXED)["name"]
        self.assertNotEqual(a, b)
        self.assertEqual(b, "2026-11-08T213000Z-same-2.txt")
        self.assertEqual((self.dir / a).read_text(), "first")
        self.assertEqual((self.dir / b).read_text(), "second")
        for n in (a, b):
            self.assertRegex(n, NAME_SHAPE)

    def test_inbox_dir_comes_from_env_or_default(self):
        saved = os.environ.get(inbox.DIR_ENV)
        try:
            os.environ[inbox.DIR_ENV] = str(self.dir)
            self.assertEqual(inbox.inbox_dir(), self.dir)
            os.environ.pop(inbox.DIR_ENV)
            self.assertEqual(inbox.inbox_dir(), Path("/opt/data/memory/inbox"))
        finally:
            if saved is None:
                os.environ.pop(inbox.DIR_ENV, None)
            else:
                os.environ[inbox.DIR_ENV] = saved

    def test_module_has_no_network_or_exec_imports(self):
        src = (_DASH / "inbox.py").read_text()
        for banned in ("import socket", "urllib.request", "import httpx", "import subprocess", "import requests",
                       "import pickle", "eval(", "exec("):
            self.assertNotIn(banned, src)


class ListAndDeleteTests(_Temp):
    def test_list_is_newest_first_and_names_only(self):
        a = inbox.save_text("a", title="one", base=self.dir, now=FIXED)["name"]
        b = inbox.save_text("b", title="two", base=self.dir, now=FIXED)["name"]
        os.utime(self.dir / a, (1_800_000_000, 1_800_000_000))
        os.utime(self.dir / b, (1_900_000_000, 1_900_000_000))
        (self.dir / "stray.txt").write_text("not ours")
        rows = inbox.list_items(base=self.dir)
        self.assertEqual([r["name"] for r in rows], [b, a])
        self.assertEqual(set(rows[0]), {"name", "size", "kind", "mtime"})
        self.assertNotIn("stray.txt", [r["name"] for r in rows])

    def test_list_is_capped_at_100(self):
        for i in range(105):
            inbox.save_text(f"n{i}", title=f"item {i}", base=self.dir, now=FIXED)
        self.assertEqual(len(inbox.list_items(base=self.dir)), 100)
        self.assertEqual(len(inbox.list_items(base=self.dir, limit=5)), 5)

    def test_list_on_missing_folder_is_empty(self):
        self.assertEqual(inbox.list_items(base=self.dir / "nope"), [])

    def test_delete_removes_the_item(self):
        name = inbox.save_text("gone", title="gone", base=self.dir, now=FIXED)["name"]
        inbox.delete_item(name, base=self.dir)
        self.assertFalse((self.dir / name).exists())
        with self.assertRaises(inbox.InboxError) as ctx:
            inbox.delete_item(name, base=self.dir)
        self.assertEqual(ctx.exception.status, 404)

    def test_delete_refuses_traversal_and_foreign_names(self):
        sentinel = self.root / "sentinel.txt"
        sentinel.write_text("keep me")
        # the folder sits in root, so ../sentinel.txt would be an escape
        for name in ("../sentinel.txt", "/etc/passwd", "..%2fsentinel.txt", "..%2F..%2Fx", "..", "../", "x",
                     "sentinel.txt", "2026-11-08T213000Z-ok.txt/../../sentinel.txt"):
            with self.assertRaises(inbox.InboxError, msg=name) as ctx:
                inbox.delete_item(name, base=self.dir)
            self.assertEqual(ctx.exception.status, 400, name)
        self.assertEqual(sentinel.read_text(), "keep me")

    def test_delete_refuses_symlink_even_with_valid_name(self):
        target = self.root / "outside.txt"
        target.write_text("outside")
        self.dir.mkdir(parents=True)
        link = self.dir / "2026-11-08T213000Z-link.txt"
        os.symlink(target, link)
        with self.assertRaises(inbox.InboxError) as ctx:
            inbox.delete_item(link.name, base=self.dir)
        self.assertEqual(ctx.exception.status, 404)
        self.assertEqual(target.read_text(), "outside")
        self.assertEqual([r["name"] for r in inbox.list_items(base=self.dir)], [])


class WriteGuardTests(unittest.TestCase):
    def test_guard_accepts_same_origin_request(self):
        self.assertIsNone(inbox.check_write_request({"x-requested-with": "agent-deck", "host": "localhost:9119",
                                                     "origin": "http://localhost:9119",
                                                     "sec-fetch-site": "same-origin"}))

    def test_guard_requires_custom_header(self):
        self.assertEqual(inbox.check_write_request({"host": "localhost:9119"}), "missing X-Requested-With header")
        self.assertIsNotNone(inbox.check_write_request({"x-requested-with": "fetch", "host": "h"}))

    def test_origin_mismatch_is_refused(self):
        # The scheme is not compared (a proxy can rewrite it), so only host:port decides.
        for origin in ("http://evil.example", "http://localhost:1", "null", "file:///x", "ftp://localhost:9119"):
            reason = inbox.check_write_request({"x-requested-with": "agent-deck", "host": "localhost:9119",
                                                "origin": origin})
            self.assertEqual(reason, "origin does not match host", origin)

    def test_cross_site_fetch_metadata_is_refused(self):
        reason = inbox.check_write_request({"x-requested-with": "agent-deck", "host": "h",
                                            "sec-fetch-site": "cross-site"})
        self.assertEqual(reason, "cross-site request refused")


class EndpointTests(_Temp):
    """POST/GET/DELETE /api/plugins/agent-office/inbox through the real router, with AGENT_DECK_INBOX_DIR set."""

    def setUp(self):
        super().setUp()
        self._env = os.environ.get(inbox.DIR_ENV)
        os.environ[inbox.DIR_ENV] = str(self.dir)
        self._env_root = os.environ.get("AGENT_OFFICE_ROOT")
        os.environ["AGENT_OFFICE_ROOT"] = str(self.root / "office-root")  # plugin_api loads collect with this root
        try:
            from fastapi import FastAPI
            from fastapi.testclient import TestClient
        except ImportError:
            self.skipTest("fastapi / httpx not installed")
        spec = importlib.util.spec_from_file_location("plugin_api_inbox_test", _DASH / "plugin_api.py")
        api = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(api)
        app = FastAPI()
        app.include_router(api.router, prefix="/api/plugins/agent-office")
        self.client = TestClient(app)
        self.base = "/api/plugins/agent-office/inbox"

    def tearDown(self):
        for key, val in ((inbox.DIR_ENV, self._env), ("AGENT_OFFICE_ROOT", self._env_root)):
            if val is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = val
        super().tearDown()

    def test_post_json_text_then_list_then_delete(self):
        r = self.client.post(self.base, headers=HDR, json={"kind": "text", "text": "remember this", "title": "Idea"})
        self.assertEqual(r.status_code, 201, r.text)
        name = r.json()["name"]
        self.assertRegex(name, NAME_SHAPE)
        self.assertEqual(r.headers.get("cache-control"), "no-store")
        r = self.client.get(self.base)
        self.assertEqual(r.status_code, 200)
        self.assertEqual([i["name"] for i in r.json()["items"]], [name])
        self.assertNotIn("content", r.json()["items"][0])
        r = self.client.delete(f"{self.base}/{name}", headers=HDR)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.client.get(self.base).json()["items"], [])

    def test_post_json_url_and_b64_file(self):
        r = self.client.post(self.base, headers=HDR, json={"kind": "text", "text": "https://example.org/x"})
        self.assertEqual(r.status_code, 201)
        import base64
        r = self.client.post(self.base, headers=HDR,
                             json={"kind": "file", "name": "paper.pdf", "content_b64": base64.b64encode(PDF).decode()})
        self.assertEqual(r.status_code, 201, r.text)
        self.assertEqual(r.json()["kind"], "pdf")

    def test_post_multipart_file(self):
        r = self.client.post(self.base, headers=HDR, data={"title": "Doc"},
                             files={"file": ("doc.md", b"# hi\n", "text/markdown")})
        self.assertEqual(r.status_code, 201, r.text)
        self.assertTrue(r.json()["name"].endswith("-doc.md"))
        r = self.client.post(self.base, headers=HDR, files={"file": ("bad.exe", b"MZ", "application/octet-stream")})
        self.assertEqual(r.status_code, 415)
        r = self.client.post(self.base, headers=HDR, files={"file": ("fake.pdf", b"<html>", "application/pdf")})
        self.assertEqual(r.status_code, 415)
        r = self.client.post(self.base, headers=HDR, files={"file": ("../x.txt", b"x", "text/plain")})
        self.assertEqual(r.status_code, 422)

    def test_post_over_size_is_413_and_bad_type_is_415(self):
        r = self.client.post(self.base, headers=HDR,
                             json={"kind": "text", "text": "a" * (inbox.MAX_TEXT_BYTES + 10)})
        self.assertEqual(r.status_code, 413)
        js = {**HDR, "content-type": "application/json"}
        r = self.client.post(self.base, content=b"x" * (inbox.MAX_BODY_BYTES + 1), headers=js)
        self.assertEqual(r.status_code, 413)
        r = self.client.post(self.base, content=b"hi", headers={**HDR, "content-type": "text/plain"})
        self.assertEqual(r.status_code, 415)
        r = self.client.post(self.base, content=b"[1,2]", headers=js)
        self.assertEqual(r.status_code, 422)
        r = self.client.post(self.base, content=b"{nope", headers=js)
        self.assertEqual(r.status_code, 422)

    def test_post_without_custom_header_is_403(self):
        r = self.client.post(self.base, json={"kind": "text", "text": "x"})
        self.assertEqual(r.status_code, 403)
        self.assertEqual(list(self.dir.iterdir()) if self.dir.exists() else [], [])

    def test_origin_mismatch_is_403_and_matching_origin_passes(self):
        r = self.client.post(self.base, headers={**HDR, "Origin": "http://evil.example"},
                             json={"kind": "text", "text": "x"})
        self.assertEqual(r.status_code, 403)
        self.assertEqual(r.json()["detail"], "origin does not match host")
        r = self.client.post(self.base, headers={**HDR, "Origin": "http://testserver"},
                             json={"kind": "text", "text": "x"})
        self.assertEqual(r.status_code, 201)

    def test_cross_site_fetch_metadata_is_403(self):
        r = self.client.post(self.base, headers={**HDR, "Sec-Fetch-Site": "cross-site"},
                             json={"kind": "text", "text": "x"})
        self.assertEqual(r.status_code, 403)

    def test_delete_traversal_names_are_refused_over_http(self):
        sentinel = self.root / "sentinel.txt"
        sentinel.write_text("keep")
        for name in ("..%2Fsentinel.txt", "..%2F..%2Fetc%2Fpasswd", "passwd"):
            r = self.client.delete(f"{self.base}/{name}", headers=HDR)
            self.assertIn(r.status_code, (400, 404), name)
        self.assertEqual(sentinel.read_text(), "keep")
        r = self.client.delete(f"{self.base}/2026-11-08T213000Z-missing.txt")
        self.assertEqual(r.status_code, 403)  # guard first: no header, no delete
        r = self.client.delete(f"{self.base}/2026-11-08T213000Z-missing.txt", headers=HDR)
        self.assertEqual(r.status_code, 404)


class InboxSearchTests(_Temp):
    """memory.search with inbox_dir: .txt and .md notes are searched, PDFs are not, snippets are redacted."""

    def test_inbox_notes_are_found_and_pdfs_are_not(self):
        inbox.save_text("the deck roadmap is Thursday", title="roadmap", base=self.dir, now=FIXED)
        inbox.save_file("deck.md", b"# deck\nmore deck notes\n", base=self.dir, now=FIXED)
        inbox.save_file("deck-paper.pdf", b"%PDF-1.4 deck deck deck", base=self.dir, now=FIXED)
        out = memory.search("deck roadmap", base=self.root / "empty-home", inbox_dir=self.dir)
        hits = [r for r in out["results"] if r["agent"] == "inbox"]
        self.assertEqual(len(hits), 1)
        self.assertIn("roadmap", hits[0]["snippet"])
        self.assertEqual(hits[0]["role"], "note")
        self.assertRegex(hits[0]["session_id"], NAME_SHAPE)
        self.assertEqual(out["inbox_scanned"], 2)

    def test_no_inbox_scan_without_inbox_dir(self):
        inbox.save_text("deck secret plan", base=self.dir, now=FIXED)
        out = memory.search("deck", base=self.root / "empty-home")
        self.assertEqual([r for r in out["results"] if r["agent"] == "inbox"], [])
        self.assertEqual(out["inbox_scanned"], 0)

    def test_inbox_snippets_are_redacted(self):
        inbox.save_text("deck owner ops@example.org key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 done",
                        base=self.dir, now=FIXED)
        out = memory.search("deck", base=self.root / "empty-home", inbox_dir=self.dir)
        snip = out["results"][0]["snippet"]
        self.assertNotIn("ops@example.org", snip)
        self.assertNotIn("sk-ant-api03", snip)
        self.assertGreaterEqual(out["results"][0]["redacted"], 2)

    def test_agent_filter_excludes_inbox(self):
        inbox.save_text("deck note", base=self.dir, now=FIXED)
        out = memory.search("deck", agent="default", base=self.root / "empty-home", inbox_dir=self.dir)
        self.assertEqual(out["results"], [])


if __name__ == "__main__":
    unittest.main()
