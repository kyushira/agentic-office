"""Review-fix tests for the Agent Deck brain editor: lock timeout (503), one read per file view, backup ids that survive a
clock that goes backwards, a fail-closed threat scanner (503), audit-before-replace (500 on audit failure), the
Content-Length check, and the string-'true' confirm refusal. Temp dirs only; the scanner and the backup root are
injected, and nothing under /opt/data is touched."""
import asyncio
import fcntl
import hashlib
import importlib.util
import json
import os
import sys
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

_DASH = Path(__file__).resolve().parent.parent / "plugin" / "agent-office" / "dashboard"
_NOSCAN = lambda text: []


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


brain = _load("brain_under_test_review", _DASH / "brain.py")
brain_edit = _load("brain_edit_under_test_review", _DASH / "brain_edit.py")
HDR = {"X-Requested-With": "agent-deck"}


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class _Temp(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.root = self.tmp / "office"
        self.bk = self.tmp / "bk"
        self.root.mkdir()

    def tearDown(self):
        self._tmp.cleanup()

    def target(self, agent: str, key: str) -> Path:
        return brain.paths(brain.resolve(agent), self.root)[key]

    def make(self, agent: str, key: str, data: bytes) -> Path:
        p = self.target(agent, key)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
        os.chmod(p, 0o600)
        return p

    def save(self, agent="dev", file="memory", text="hello\n", base=None, scanner=_NOSCAN):
        if base is None:
            base = _sha(self.target(agent, file).read_bytes())
        payload = {"agent": agent, "file": file, "text": text, "base_sha": base}
        return brain_edit.save(payload, root=self.root, backup_root=self.bk, scanner=scanner)

    def refused(self, status: int, fn, *args, **kwargs):
        with self.assertRaises(brain_edit.EditError) as cm:
            fn(*args, **kwargs)
        self.assertEqual(cm.exception.status, status, cm.exception.body)
        return cm.exception.body

    def backups(self, agent: str, key: str):
        d = self.bk / brain.resolve(agent) / key
        if not d.is_dir():
            return []
        return sorted(p.name for p in d.iterdir() if p.name != ".lock")


class LockTimeoutTests(_Temp):
    def test_held_lock_is_503_within_seconds_and_nothing_is_written(self):
        p = self.make("dev", "memory", b"keep\n")
        base = _sha(b"keep\n")
        fd = os.open(p.with_name(p.name + ".lock"), os.O_RDWR | os.O_CREAT, 0o600)
        fcntl.flock(fd, fcntl.LOCK_EX)  # a second open file description: the editor's own flock must not get it
        try:
            t0 = time.monotonic()
            body = self.refused(503, self.save, text="new\n", base=base)
            elapsed = time.monotonic() - t0
        finally:
            os.close(fd)
        self.assertLess(elapsed, 6.5)
        self.assertEqual(body, {"error": "busy, try again"})
        self.assertEqual(p.read_bytes(), b"keep\n")
        self.assertEqual(self.backups("dev", "memory"), [])


class OneReadViewTests(_Temp):
    def test_file_view_reads_the_file_once_and_sha_is_of_the_text(self):
        p = self.make("dev", "memory", "alpha\nbeta é\n".encode("utf-8"))
        opened = []
        real_open = os.open

        def counting(path, *a, **k):
            if Path(path) == p:
                opened.append(1)
            return real_open(path, *a, **k)

        with mock.patch.object(brain.os, "open", side_effect=counting):
            view = brain.file_view(p, "memory")
        self.assertEqual(len(opened), 1)
        self.assertTrue(view["editable"])
        self.assertEqual(view["sha"], _sha(view["text"].encode("utf-8")))
        self.assertEqual(view["sha"], _sha(p.read_bytes()))


class BackupClockTests(_Temp):
    def test_backup_id_survives_a_clock_that_goes_backwards(self):
        base = datetime(2026, 11, 9, 12, 0, 0, tzinfo=timezone.utc)

        class Clock(datetime):
            at = base

            @classmethod
            def now(cls, tz=None):
                return cls.at

        self.make("dev", "memory", b"v0\n")
        with mock.patch.object(brain_edit, "datetime", Clock):
            for i in range(1, brain_edit.BACKUP_KEEP + 1):  # ten saves at 12:00 fill the ten slots
                self.save(text=f"v{i}\n")
            Clock.at = base - timedelta(hours=2)  # clock goes back: the next backup must still be the newest
            self.save(text="after the clock went back\n")
        ids = [v["id"] for v in brain_edit.list_versions("dev", "memory", root=self.root,
                                                          backup_root=self.bk)["versions"]]
        self.assertEqual(len(ids), brain_edit.BACKUP_KEEP)
        self.assertEqual(brain_edit.get_version("dev", "memory", ids[0], root=self.root,
                                                backup_root=self.bk)["text"], "v10\n")
        self.assertEqual(ids, sorted(ids, reverse=True))


class ScannerFailClosedTests(_Temp):
    def test_unavailable_scanner_is_503_and_nothing_is_written(self):
        self.make("dev", "memory", b"keep\n")
        with mock.patch.dict(sys.modules, {"tools.threat_patterns": None}):
            self.assertEqual(self.refused(503, brain_edit._default_scanner, "hello"),
                             {"error": "safety scanner unavailable"})
            body = self.refused(503, self.save, text="hello\n", scanner=None)
        self.assertEqual(body, {"error": "safety scanner unavailable"})
        self.assertEqual(self.target("dev", "memory").read_bytes(), b"keep\n")
        self.assertEqual(self.backups("dev", "memory"), [])


class AuditOrderTests(_Temp):
    def test_audit_failure_is_500_and_nothing_is_written(self):
        self.make("dev", "memory", b"keep\n")
        with mock.patch.object(brain_edit, "_audit", side_effect=OSError("disk full")):
            body = self.refused(500, self.save, text="new\n")
        self.assertEqual(body, {"error": "audit log unavailable"})
        self.assertEqual(self.target("dev", "memory").read_bytes(), b"keep\n")
        self.assertEqual(self.backups("dev", "memory"), [])

    def test_audit_line_with_the_new_sha_is_on_disk_before_the_replace(self):
        p = self.make("dev", "memory", b"keep\n")
        seen = {}
        real_replace = os.replace

        def check(src, dst, *a, **k):
            if Path(dst) == p:
                seen["audit"] = (self.bk / brain_edit.AUDIT_NAME).read_text()
            return real_replace(src, dst, *a, **k)

        with mock.patch.object(brain_edit.os, "replace", side_effect=check):
            self.save(text="new\n")
        self.assertIn(_sha(b"new\n"), seen["audit"])


class StringConfirmTests(_Temp):
    def test_string_confirm_true_is_428_for_soul_and_default(self):
        self.make("nova", "soul", b"s\n")
        self.make("default", "memory", b"d\n")
        for agent, file in (("nova", "soul"), ("ash", "memory")):
            body = self.refused(428, self.save, agent=agent, file=file, text="x\n")
            self.assertEqual(body, {"error": "confirm token required"})
        with self.assertRaises(brain_edit.EditError) as cm:
            brain_edit.save({"agent": "nova", "file": "soul", "text": "x\n", "base_sha": _sha(b"s\n"),
                             "confirm": "true"}, root=self.root, backup_root=self.bk, scanner=_NOSCAN)
        self.assertEqual(cm.exception.status, 428)
        self.assertEqual(self.target("nova", "soul").read_bytes(), b"s\n")


class ContentLengthTests(unittest.TestCase):
    """plugin_api's body readers take Content-Length with re.fullmatch: a superscript digit is not a length."""

    class _Req:
        def __init__(self, headers, chunks):
            self.headers = headers
            self._chunks = chunks

        async def stream(self):
            for c in self._chunks:
                yield c

    @classmethod
    def setUpClass(cls):
        try:
            import fastapi  # noqa: F401
        except ImportError:
            raise unittest.SkipTest("fastapi not installed")
        cls.api = _load("plugin_api_review_test", _DASH / "plugin_api.py")

    def test_superscript_content_length_is_not_a_500_on_brain_path(self):
        req = self._Req({"content-length": "\u00b2"}, [b'{"a": 1}'])
        self.assertEqual(asyncio.run(self.api._brain_body(req)), {"a": 1})

    def test_superscript_content_length_is_not_a_500_on_inbox_path(self):
        req = self._Req({"content-length": "\u00b2"}, [b"abc"])
        self.assertEqual(asyncio.run(self.api._read_capped(req)), b"abc")

    def test_non_digit_content_length_forms_are_ignored_not_crashed(self):
        for cl in ("\u00b2", "1e3", " 5", "-1"):
            req = self._Req({"content-length": cl}, [b"{}"])
            self.assertEqual(asyncio.run(self.api._brain_body(req)), {}, cl)


class StreamedOversizeTests(unittest.TestCase):
    def setUp(self):
        try:
            from fastapi import FastAPI
            from fastapi.testclient import TestClient
        except ImportError:
            self.skipTest("fastapi / httpx not installed")
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.root = self.tmp / "office"
        self.root.mkdir()
        self._env = os.environ.get("AGENT_OFFICE_ROOT")
        self._flag = os.environ.get("DECK_BRAIN_EDIT")
        os.environ["AGENT_OFFICE_ROOT"] = str(self.tmp / "office-root")
        os.environ["DECK_BRAIN_EDIT"] = "1"  # the flag is checked before the body is read, so it must be on here
        api = _load("plugin_api_review_stream", _DASH / "plugin_api.py")
        api.brain.DEFAULT_ROOT = self.root
        api.brain_edit.DEFAULT_BACKUP_ROOT = self.tmp / "bk"
        app = FastAPI()
        app.include_router(api.router, prefix="/api/plugins/agent-office")
        self.client = TestClient(app)
        self.url = "/api/plugins/agent-office/brain"
        p = brain.paths(brain.resolve("dev"), self.root)["memory"]
        p.parent.mkdir(parents=True)
        p.write_bytes(b"keep\n")
        self.p = p

    def tearDown(self):
        if self._env is None:
            os.environ.pop("AGENT_OFFICE_ROOT", None)
        else:
            os.environ["AGENT_OFFICE_ROOT"] = self._env
        if self._flag is None:
            os.environ.pop("DECK_BRAIN_EDIT", None)
        else:
            os.environ["DECK_BRAIN_EDIT"] = self._flag
        self._tmp.cleanup()

    def test_streamed_body_over_the_cap_without_content_length_is_413(self):
        def chunks():
            for _ in range(3):
                yield b"x" * 65536  # 192 KiB total, sent chunked: no Content-Length header
        r = self.client.put(self.url, headers=HDR, content=chunks())
        self.assertEqual(r.status_code, 413, r.text)
        self.assertEqual(self.p.read_bytes(), b"keep\n")


if __name__ == "__main__":
    unittest.main()
