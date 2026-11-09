"""Agent Deck server card: server_stats.py parsing, top-3 RSS selection and sanitization, the read allowlist (only
meminfo, loadavg and <pid>/status under proc_root are ever opened; cmdline and environ never), the source scan
for forbidden calls, and the GET /api/plugins/agent-office/server route through fastapi TestClient.

Every filesystem fixture lives in a temp dir. /proc is touched only by two tests: the one that reads the real host
tree through the route (types only) and the audit-hook test that runs snapshot() against the live /proc to prove it
opens nothing outside /proc and starts no process. The hook is installed once at import with a module-level flag,
because audit hooks cannot be removed.
"""
import ast
import builtins
import importlib.util
import json
import os
import re
import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

_DASH = Path(__file__).resolve().parent.parent / "plugin" / "agent-office" / "dashboard"
_SRC = _DASH / "server_stats.py"
SECRET = "SUPERSECRET-TOKEN-123"

MEMINFO = (
    "MemTotal:       16000000 kB\n"
    "MemFree:          500000 kB\n"
    "MemAvailable:    4000000 kB\n"
    "Buffers:          100000 kB\n"
)
LOADAVG = "0.52 0.58 0.59 1/1234 5678\n"


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


ss = _load("server_stats_under_test", _SRC)


def status(name, rss_kb):
    body = f"Name:\t{name}\nState:\tS (sleeping)\nTgid:\t1\nPid:\t1\n"
    if rss_kb is not None:
        body += f"VmPeak:\t  999 kB\nVmRSS:\t{rss_kb:>8} kB\n"
    return body


class _Fake:
    """Builds a fake proc tree under a temp dir. Secrets go into cmdline and environ, which must never be read."""

    def __init__(self, tmp: Path):
        self.root = tmp / "proc"
        self.root.mkdir()

    def write(self, rel, text):
        p = self.root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)

    def proc(self, pid, body, secret=True):
        self.write(f"{pid}/status", body)
        if secret:
            self.write(f"{pid}/cmdline", f"python\0--token={SECRET}\0")
            self.write(f"{pid}/environ", f"API_KEY={SECRET}\0")


def _statvfs(frsize=4096, blocks=1000, bavail=250):
    return lambda path: SimpleNamespace(f_frsize=frsize, f_blocks=blocks, f_bavail=bavail)


class ParseTests(unittest.TestCase):
    def test_meminfo_uses_memavailable_not_memfree(self):
        m = ss.parse_meminfo(MEMINFO)
        self.assertEqual(m["total_mb"], 16000000 // 1024)
        self.assertEqual(m["available_mb"], 4000000 // 1024)
        self.assertEqual(m["used_mb"], m["total_mb"] - m["available_mb"])
        self.assertEqual(m["used_pct"], round(100 * 12000000 / 16000000, 1))

    def test_meminfo_rejects_missing_or_bad_fields(self):
        bad = [
            "MemTotal: 100 kB\n",                       # MemAvailable missing
            "MemTotal: 100 kB\nMemAvailable: 200 kB\n",  # available > total
            "MemTotal: x kB\nMemAvailable: 1 kB\n",      # not a number
            "MemTotal: 100 MB\nMemAvailable: 1 kB\n",    # wrong unit
            "MemTotal: 0 kB\nMemAvailable: 0 kB\n",      # zero total
            "",
        ]
        for text in bad:
            with self.subTest(text=text), self.assertRaises(ValueError):
                ss.parse_meminfo(text)

    def test_loadavg_parses_first_three_and_rejects_junk(self):
        self.assertEqual(ss.parse_loadavg(LOADAVG), (0.52, 0.58, 0.59))
        for text in ["", "1.0 2.0", "nan inf 1", "1e9 2 3", "-1 0 0"]:
            with self.subTest(text=text), self.assertRaises(ValueError):
                ss.parse_loadavg(text)


class SanitizeTests(unittest.TestCase):
    def test_keeps_only_allowed_characters(self):
        self.assertEqual(ss.clean_name("node:worker/1.2-x_y"), "node:worker/1.2-x_y")
        self.assertEqual(ss.clean_name("a\x1b[31mb\x00c;rm -rf $(id)`x`"), "a31mbcrm -rf idx")
        self.assertEqual(ss.clean_name("héllo\u200bthere"), "hllothere")

    def test_truncates_to_32(self):
        self.assertEqual(len(ss.clean_name("n" * 100)), 32)

    def test_blank_becomes_question_mark(self):
        for raw in ["", None, "\x00\x1b", "!!!"]:
            with self.subTest(raw=raw):
                self.assertEqual(ss.clean_name(raw), "?")


class TopProcessTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="sstats-"))
        self.fake = _Fake(self.tmp)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_top_three_sorted_desc_and_kernel_threads_skipped(self):
        f = self.fake
        f.proc(101, status("small", 1024))
        f.proc(102, status("kthreadd-like", None))  # kernel thread: no VmRSS line
        f.proc(103, status("big", 900 * 1024))
        f.proc(104, status("mid", 300 * 1024))
        f.proc(105, status("tiny", 10))  # 10 kB -> 0 MB, below the top three
        top = ss.top_processes(str(f.root))
        self.assertEqual(top, [
            {"name": "big", "rss_mb": 900},
            {"name": "mid", "rss_mb": 300},
            {"name": "small", "rss_mb": 1},
        ])

    def test_non_numeric_entries_and_vanished_pids_skipped(self):
        f = self.fake
        f.proc(201, status("alive", 5 * 1024))
        (f.root / "self").mkdir()
        (f.root / "self" / "status").write_text(status("notapid", 9999 * 1024))
        (f.root / "202").mkdir()  # pid dir with no status file: vanished mid-scan
        (f.root / "cpuinfo").write_text("x")
        self.assertEqual(ss.top_processes(str(f.root)), [{"name": "alive", "rss_mb": 5}])

    def test_unreadable_status_is_skipped_not_fatal(self):
        f = self.fake
        f.proc(301, status("ok", 2048))
        (f.root / "302").mkdir()
        (f.root / "302" / "status").mkdir()  # a directory where the file should be: OSError on read
        self.assertEqual(ss.top_processes(str(f.root)), [{"name": "ok", "rss_mb": 2}])

    def test_names_are_sanitized_in_output(self):
        f = self.fake
        f.proc(401, status("bad;$(id)", 4096))
        f.proc(402, status("x" * 60, 3072))
        top = ss.top_processes(str(f.root))
        self.assertEqual(top[0], {"name": "badid", "rss_mb": 4})
        self.assertEqual(top[1], {"name": "x" * 32, "rss_mb": 3})

    def test_missing_proc_root_gives_none(self):
        self.assertIsNone(ss.top_processes(str(self.tmp / "does-not-exist")))


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="sstats-"))
        self.fake = _Fake(self.tmp)
        self.fake.write("meminfo", MEMINFO)
        self.fake.write("loadavg", LOADAVG)
        self.fake.proc(501, status("agent", 700 * 1024))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_full_payload_shape_and_types(self):
        before = time.time()
        snap = ss.snapshot(str(self.fake.root), statvfs=_statvfs(), cpu_count=lambda: 8)
        after = time.time()
        self.assertIsInstance(snap["ts"], float)
        self.assertTrue(before <= snap["ts"] <= after)
        self.assertEqual(set(snap["mem"]), {"total_mb", "available_mb", "used_mb", "used_pct"})
        self.assertEqual(snap["disk"], {
            "path": "/", "total_gb": round(4096 * 1000 / 1024 ** 3, 1),
            "free_gb": round(4096 * 250 / 1024 ** 3, 1), "free_pct": 25.0,
        })
        self.assertEqual(snap["load"], {"one": 0.52, "five": 0.58, "fifteen": 0.59, "cores": 8})
        self.assertEqual(snap["top"], [{"name": "agent", "rss_mb": 700}])

    def test_loadavg_missing_gives_null_load_but_snapshot_stays(self):
        os.remove(self.fake.root / "loadavg")
        snap = ss.snapshot(str(self.fake.root), statvfs=_statvfs(), cpu_count=lambda: 8)
        self.assertIsNotNone(snap)
        self.assertIsNone(snap["load"])

    def test_cores_unknown_gives_null_load(self):
        self.assertIsNone(ss.snapshot(str(self.fake.root), statvfs=_statvfs(), cpu_count=lambda: None)["load"])

    def test_disk_failure_gives_null_disk(self):
        def boom(path):
            raise OSError("statvfs failed")
        snap = ss.snapshot(str(self.fake.root), statvfs=boom, cpu_count=lambda: 2)
        self.assertIsNone(snap["disk"])
        self.assertIsNotNone(snap["mem"])

    def test_meminfo_missing_or_bad_gives_none(self):
        os.remove(self.fake.root / "meminfo")
        self.assertIsNone(ss.snapshot(str(self.fake.root), statvfs=_statvfs(), cpu_count=lambda: 2))
        self.fake.write("meminfo", "garbage\n")
        self.assertIsNone(ss.snapshot(str(self.fake.root), statvfs=_statvfs(), cpu_count=lambda: 2))

    def test_only_allowed_files_are_opened_and_secrets_never_read(self):
        opened = []
        real_open = builtins.open

        def recording(file, *a, **k):
            opened.append(str(file))
            return real_open(file, *a, **k)

        with mock.patch("builtins.open", side_effect=recording):
            snap = ss.snapshot(str(self.fake.root), statvfs=_statvfs(), cpu_count=lambda: 2)
        self.assertTrue(opened)
        root = str(self.fake.root)
        for path in opened:
            self.assertTrue(path.startswith(root + os.sep), path)
            rel = os.path.relpath(path, root)
            self.assertTrue(rel in ("meminfo", "loadavg") or re.fullmatch(r"[0-9]+/status", rel), rel)
        self.assertFalse(any(p.endswith(("cmdline", "environ")) for p in opened))
        self.assertNotIn(SECRET, json.dumps(snap))

    def test_read_helper_refuses_other_paths(self):
        for rel in ["cmdline", "1/cmdline", "1/environ", "../meminfo", "/etc/passwd", "self/status", "1/status/x"]:
            with self.subTest(rel=rel), self.assertRaises(ValueError):
                ss._read(str(self.fake.root), rel)


class SourceScanTests(unittest.TestCase):
    FORBIDDEN = ["subprocess", "os.system", "os.popen", "os.exec", "os.spawn", "shell=True",
                 "eval", "exec", "pty", "psutil", "logging", "query_params"]

    def setUp(self):
        self.src = _SRC.read_text()
        self.tree = ast.parse(self.src)

    def test_no_forbidden_tokens(self):
        for token in self.FORBIDDEN:
            with self.subTest(token=token):
                self.assertNotIn(token, self.src)

    def test_single_open_call_inside_read_helper(self):
        opens = [n for n in ast.walk(self.tree)
                 if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "open"]
        self.assertEqual(len(opens), 1)
        owner = [fn for fn in ast.walk(self.tree) if isinstance(fn, ast.FunctionDef)
                 and any(n is opens[0] for n in ast.walk(fn))]
        self.assertEqual([fn.name for fn in owner], ["_read"])
        arg = ast.unparse(opens[0].args[0])
        self.assertEqual(arg, "os.path.join(root, rel)")


class RouteTests(unittest.TestCase):
    def setUp(self):
        try:
            from fastapi import FastAPI
            from fastapi.testclient import TestClient
        except ImportError as e:  # pragma: no cover - fastapi is a dashboard dependency
            raise AssertionError(f"fastapi / httpx required for route tests: {e}")
        self.tmp = Path(tempfile.mkdtemp(prefix="sstats-route-"))
        self.fake = _Fake(self.tmp)
        self.fake.write("meminfo", MEMINFO)
        self.fake.write("loadavg", LOADAVG)
        self.fake.proc(601, status("dashboard", 512 * 1024))
        self.api = _load("plugin_api_server_stats_test", _DASH / "plugin_api.py")
        self._patch = mock.patch.object(self.api.server_stats, "PROC", str(self.fake.root))
        self._patch.start()
        app = FastAPI()
        app.include_router(self.api.router, prefix="/api/plugins/agent-office")
        self.client = TestClient(app)
        self.url = "/api/plugins/agent-office/server"

    def tearDown(self):
        self._patch.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_get_200_json_contract_and_no_store(self):
        r = self.client.get(self.url)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers["cache-control"], "no-store")
        self.assertEqual(r.headers["pragma"], "no-cache")
        body = r.json()
        self.assertEqual(set(body), {"ts", "mem", "disk", "load", "top"})
        self.assertIsInstance(body["ts"], float)
        self.assertEqual(body["mem"]["total_mb"], 15625)
        self.assertEqual(body["top"], [{"name": "dashboard", "rss_mb": 512}])
        self.assertEqual(body["load"]["cores"], os.cpu_count())
        self.assertNotIn(SECRET, r.text)
        self.assertNotIn(str(self.tmp), r.text)

    def test_missing_meminfo_is_503_with_clean_body(self):
        os.remove(self.fake.root / "meminfo")
        r = self.client.get(self.url)
        self.assertEqual(r.status_code, 503)
        self.assertEqual(r.headers["cache-control"], "no-store")
        self.assertEqual(r.json(), {"error": "server stats unavailable"})
        self.assertNotIn(str(self.tmp), r.text)
        self.assertNotIn("Traceback", r.text)

    def test_missing_loadavg_gives_200_with_null_load(self):
        os.remove(self.fake.root / "loadavg")
        r = self.client.get(self.url)
        self.assertEqual(r.status_code, 200)
        self.assertIsNone(r.json()["load"])
        self.assertIsNotNone(r.json()["mem"])

    def test_query_params_are_ignored(self):
        for q in ["?x=;id&y=$(id)&z=`id`", "?path=/etc/passwd", "?pid=1"]:
            with self.subTest(q=q):
                r = self.client.get(self.url + q)
                self.assertEqual(r.status_code, 200)
                self.assertEqual(set(r.json()), {"ts", "mem", "disk", "load", "top"})

    def test_other_methods_are_405(self):
        for method in ["post", "put", "delete", "patch"]:
            with self.subTest(method=method):
                r = getattr(self.client, method)(self.url)
                self.assertEqual(r.status_code, 405)


# --- audit-hook guard: the real /proc path must open only /proc files and start nothing ----------------------
# strace is not installed here, so a process-wide audit hook stands in for it. Hooks cannot be removed once
# installed, so a module-level flag keeps the recorder off for every other test in this file.
_PROC_EVENTS = frozenset({
    "subprocess.Popen", "os.system", "os.exec", "os.posix_spawn",
    "os.spawn", "os.fork", "os.forkpty", "pty.spawn",
})
_AUDIT = {"active": False, "proc": [], "opens": []}


def _audit_hook(event, args):
    if not _AUDIT["active"]:
        return
    if event in _PROC_EVENTS:
        _AUDIT["proc"].append(event)
    elif event == "open":
        path = args[0] if args else None
        if isinstance(path, int):
            _AUDIT["opens"].append(("fd", path))
        elif isinstance(path, (str, bytes)):
            _AUDIT["opens"].append(os.fsdecode(path))
        else:
            _AUDIT["opens"].append(repr(path))


sys.addaudithook(_audit_hook)


class RealProcAuditTest(unittest.TestCase):
    """snapshot() against the live /proc: reads stay under /proc/ and no process-spawning event fires."""

    def test_snapshot_opens_only_proc_files_and_starts_nothing(self):
        _AUDIT["proc"].clear()
        _AUDIT["opens"].clear()
        _AUDIT["active"] = True
        try:
            snap = ss.snapshot()  # no proc_root: the real one
        finally:
            _AUDIT["active"] = False
        self.assertIsNotNone(snap)
        self.assertEqual(set(snap), {"ts", "mem", "disk", "load", "top"})
        self.assertIsInstance(snap["mem"]["total_mb"], int)
        self.assertEqual(_AUDIT["proc"], [])
        opens = _AUDIT["opens"]
        self.assertTrue(opens, "expected at least /proc/meminfo to be opened")
        bad = [p for p in opens if not (isinstance(p, str) and p.startswith("/proc/"))]
        self.assertEqual(bad, [], f"opened outside /proc: {bad[:5]}")


if __name__ == "__main__":
    unittest.main()
