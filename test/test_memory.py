"""Unit tests for memory.search (GET /memory): query sanitising, read-only connections, redaction of snippets, unknown
and missing agents, the limit clamp, the FTS and LIKE paths, and the endpoint. Builds temp state.db files with the real
messages / sessions columns; the FTS table mirrors the real messages_fts DDL. Run via unittest discover."""
import asyncio
import hashlib
import importlib.util
import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path

_DASH = Path(__file__).resolve().parent.parent / "plugin" / "agent-office" / "dashboard"
_spec = importlib.util.spec_from_file_location("memory", _DASH / "memory.py")
memory = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(memory)

BASE_SCHEMA = """
CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, title TEXT, started_at REAL NOT NULL);
CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT,
    tool_call_id TEXT,
    tool_calls TEXT,
    tool_name TEXT,
    timestamp REAL NOT NULL
);
"""
# Same shape as the real messages_fts (external content over a view that caps tool content at 8192).
FTS_SCHEMA = """
CREATE VIEW messages_fts_src AS
    SELECT id,
           CASE WHEN role = 'tool' THEN substr(COALESCE(content, ''), 1, 8192) ELSE content END AS content,
           tool_name, tool_calls
    FROM messages;
CREATE VIRTUAL TABLE messages_fts USING fts5(
    content, tool_name, tool_calls, content='messages_fts_src', content_rowid='id');
"""


def make_home(root: Path, name: str, rows, fts: bool = True, titles: dict | None = None) -> Path:
    """rows: (session_id, role, content, tool_calls_or_None). name 'default' writes root/state.db."""
    home = root if name == "default" else root / "profiles" / name
    home.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(home / "state.db")
    c.executescript(BASE_SCHEMA)
    for sid, title in (titles or {}).items():
        c.execute("insert into sessions (id, source, title, started_at) values (?, 'cli', ?, 1)", (sid, title))
    for i, (sid, role, content, calls) in enumerate(rows):
        c.execute("insert into messages (session_id, role, content, tool_calls, timestamp) values (?, ?, ?, ?, ?)",
                  (sid, role, content, calls, 1_800_000_000.0 + i))
    if fts:
        c.executescript(FTS_SCHEMA)
        c.execute("insert into messages_fts(messages_fts) values ('rebuild')")
    c.commit()
    c.close()
    return home


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class SanitiseTests(unittest.TestCase):
    def test_operators_and_quotes_are_dropped(self):
        ts = memory.terms('deck" OR NOT (x) NEAR/2 * ^ : -foo "bar')
        self.assertEqual(ts, ["deck", "OR", "NOT", "x", "NEAR", "2", "foo", "bar"])
        self.assertEqual(memory.terms('a {content} "b" c'), ["a", "content", "b", "c"])
        for t in ts:
            self.assertRegex(t, r"^\w+$")

    def test_eight_terms_and_200_chars_at_most(self):
        self.assertEqual(len(memory.terms("a " * 300)), 8)
        self.assertEqual(len(memory.terms("x" * 250)), 1)
        self.assertEqual(len(memory.terms("x" * 250)[0]), 200)

    def test_empty_or_punctuation_query_returns_empty_and_opens_nothing(self):
        with tempfile.TemporaryDirectory() as d:
            make_home(Path(d), "default", [("s1", "assistant", "deck", None)])
            for q in ("", "   ", '""*()', None):
                out = memory.search(q, base=d)
                self.assertEqual(out["results"], [])
                self.assertEqual(out["searched"], [])
                self.assertEqual(out["errors"], [])

    def test_operator_laden_query_is_safe(self):
        with tempfile.TemporaryDirectory() as d:
            make_home(Path(d), "default", [("s1", "assistant", "deck scheduling notes", None)])
            # An injected OR would match this row through 'deck'; quoted terms are ANDed, so nothing matches.
            injected = memory.search('deck" OR zzzqqq', base=d)
            self.assertEqual(injected["errors"], [])
            self.assertEqual(injected["results"], [])
            plain = memory.search('deck" scheduling ) ( * ^', base=d)
            self.assertEqual(plain["errors"], [])
            self.assertEqual(len(plain["results"]), 1)


class ReadOnlyTests(unittest.TestCase):
    def test_connection_refuses_writes(self):
        with tempfile.TemporaryDirectory() as d:
            home = make_home(Path(d), "default", [("s1", "assistant", "deck", None)])
            c = memory._connect(home / "state.db", deadline=float("inf"))
            try:
                with self.assertRaises(sqlite3.OperationalError):
                    c.execute("insert into messages (session_id, role, content, timestamp) values ('x','assistant','y',1)")
                with self.assertRaises(sqlite3.OperationalError):
                    c.execute("create table evil (x)")
            finally:
                c.close()

    def test_search_leaves_file_bytes_unchanged(self):
        with tempfile.TemporaryDirectory() as d:
            home = make_home(Path(d), "default", [("s1", "assistant", "deck", None)])
            before = digest(home / "state.db")
            memory.search("deck", base=d)
            memory.search("nothing-here-xyz", base=d)
            self.assertEqual(digest(home / "state.db"), before)
            self.assertFalse((home / "state.db-journal").exists())
            self.assertFalse((home / "state.db-wal").exists())


class RedactionTests(unittest.TestCase):
    def test_secret_email_and_path_are_redacted_and_counted(self):
        key = "sk-ant-api03-ABCDEFGHIJKLMNOP1234"
        text = f"deck rotation {key} owner ops@example.org config /opt/data/secret/app.env done"
        with tempfile.TemporaryDirectory() as d:
            make_home(Path(d), "default", [("s1", "assistant", text, None)])
            out = memory.search("deck", base=d)
        snip = out["results"][0]["snippet"]
        self.assertNotIn("sk-ant", snip)
        self.assertNotIn("ops@example.org", snip)
        self.assertNotIn("/opt/data/secret", snip)
        self.assertEqual(out["results"][0]["redacted"], 3)
        self.assertEqual(out["redacted_total"], 3)

    def test_project_paths_and_urls_are_kept(self):
        self.assertEqual(memory.redact.redact_memory("see /opt/data/projects/agent-office/x.py"),
                         "see /opt/data/projects/agent-office/x.py")
        self.assertEqual(memory.redact.redact_memory("open https://example.com/a/b now"),
                         "open https://example.com/a/b now")

    def test_redact_memory_marks_email_home_and_outside_paths(self):
        out = memory.redact.redact_memory("mail a.b@c.io, ~/notes/x.md, /var/log/app.log")
        self.assertEqual(out, "mail [redacted], [redacted], [redacted]")

    def test_snippet_is_bounded(self):
        body = "deck " + "lorem ipsum " * 500
        with tempfile.TemporaryDirectory() as d:
            make_home(Path(d), "default", [("s1", "assistant", body, None)])
            out = memory.search("deck", base=d)
        self.assertLessEqual(len(out["results"][0]["snippet"]), memory.SNIP + 2)


class AgentAndDbTests(unittest.TestCase):
    def test_unknown_agent_is_an_error_not_a_crash(self):
        with tempfile.TemporaryDirectory() as d:
            make_home(Path(d), "default", [("s1", "assistant", "deck", None)])
            out = memory.search("deck", agent="nobody", base=d)
        self.assertTrue(out["unknown_agent"])
        self.assertEqual(out["results"], [])
        self.assertIn("unknown agent: nobody", out["errors"])

    def test_missing_db_is_skipped_and_listed(self):
        with tempfile.TemporaryDirectory() as d:
            make_home(Path(d), "default", [("s1", "assistant", "deck", None)])
            (Path(d) / "profiles" / "red").mkdir(parents=True)  # profile dir without state.db
            out = memory.search("deck", base=d)
            self.assertIn("red: state.db missing", out["errors"])
            self.assertEqual(out["searched"], ["default"])
            self.assertEqual(len(out["results"]), 1)
            only = memory.search("deck", agent="red", base=d)
            self.assertFalse(only["unknown_agent"])
            self.assertEqual(only["searched"], [])
            self.assertEqual(only["results"], [])

    def test_agent_filter_and_profile_attribution(self):
        with tempfile.TemporaryDirectory() as d:
            make_home(Path(d), "default", [("s1", "assistant", "deck root", None)])
            make_home(Path(d), "dev", [("s2", "assistant", "deck dev", None)])
            out = memory.search("deck", agent="dev", base=d)
            self.assertEqual([r["agent"] for r in out["results"]], ["dev"])
            self.assertEqual(out["searched"], ["dev"])
            both = memory.search("deck", base=d)
            self.assertEqual(sorted(r["agent"] for r in both["results"]), ["default", "dev"])

    def test_time_budget_exhausted_skips_remaining_dbs(self):
        with tempfile.TemporaryDirectory() as d:
            make_home(Path(d), "default", [("s1", "assistant", "deck", None)])
            saved = memory.BUDGET_S
            memory.BUDGET_S = -1.0
            try:
                out = memory.search("deck", base=d)
            finally:
                memory.BUDGET_S = saved
        self.assertEqual(out["results"], [])
        self.assertIn("default: skipped, time budget used", out["errors"])


class RoleAndModeTests(unittest.TestCase):
    ROWS = [
        ("s1", "user", "deck private question", None),
        ("s1", "assistant", "deck answer from assistant", None),
        ("s1", "tool", "deck tool output", None),
        ("s1", "assistant", None, json.dumps([{"id": "c1", "function": {"name": "terminal", "arguments": "{\"command\": \"ls deck\"}"}}])),
    ]

    def test_user_rows_never_appear(self):
        with tempfile.TemporaryDirectory() as d:
            make_home(Path(d), "default", self.ROWS, fts=True)
            out = memory.search("deck", base=d)
        roles = sorted(r["role"] for r in out["results"])
        self.assertEqual(roles, ["assistant", "assistant", "tool"])
        self.assertFalse(any("private question" in r["snippet"] for r in out["results"]))

    def test_fts_path_is_used_when_index_exists(self):
        with tempfile.TemporaryDirectory() as d:
            make_home(Path(d), "default", self.ROWS, fts=True)
            out = memory.search("deck", base=d)
        self.assertTrue(out["fts5"])
        self.assertEqual(out["mode"], "fts5")
        self.assertEqual(out["errors"], [])

    def test_like_fallback_without_fts(self):
        with tempfile.TemporaryDirectory() as d:
            make_home(Path(d), "default", self.ROWS, fts=False)
            out = memory.search("deck", base=d)
        self.assertFalse(out["fts5"])
        self.assertEqual(out["mode"], "like")
        self.assertEqual(sorted(r["role"] for r in out["results"]), ["assistant", "assistant", "tool"])

    def test_tool_call_arguments_are_searchable(self):
        with tempfile.TemporaryDirectory() as d:
            make_home(Path(d), "default", self.ROWS, fts=True)
            out = memory.search("terminal", base=d)
        self.assertEqual(len(out["results"]), 1)
        self.assertIn("terminal", out["results"][0]["snippet"])

    def test_like_treats_percent_and_underscore_literally(self):
        with tempfile.TemporaryDirectory() as d:
            make_home(Path(d), "default", [("s1", "assistant", "100% done in my_file", None),
                                           ("s1", "assistant", "1000 done in myXfile", None)], fts=False)
            out = memory.search("my_file", base=d)
        self.assertEqual([r["snippet"].count("my_file") for r in out["results"]], [1])

    def test_titles_are_redacted(self):
        with tempfile.TemporaryDirectory() as d:
            make_home(Path(d), "default", [("s1", "assistant", "deck notes", None)],
                      titles={"s1": "deck for ops@example.org"})
            out = memory.search("deck", base=d)
        self.assertEqual(out["results"][0]["session_title"], "deck for [redacted]")
        self.assertEqual(out["results"][0]["redacted"], 1)


class LimitTests(unittest.TestCase):
    def test_clamp_values(self):
        self.assertEqual(memory._clamp(0), 1)
        self.assertEqual(memory._clamp(-5), 1)
        self.assertEqual(memory._clamp(999), 50)
        self.assertEqual(memory._clamp("abc"), memory.DEFAULT_LIMIT)
        self.assertEqual(memory._clamp(None), memory.DEFAULT_LIMIT)

    def test_result_count_follows_clamp(self):
        rows = [("s1", "assistant", f"deck entry {i}", None) for i in range(60)]
        with tempfile.TemporaryDirectory() as d:
            make_home(Path(d), "default", rows)
            self.assertEqual(len(memory.search("deck", limit=0, base=d)["results"]), 1)
            self.assertEqual(len(memory.search("deck", limit=999, base=d)["results"]), 50)
            self.assertEqual(len(memory.search("deck", base=d)["results"]), memory.DEFAULT_LIMIT)


class EndpointTests(unittest.TestCase):
    """GET /memory through plugin_api.memory_endpoint, with AGENT_OFFICE_ROOT pointed at a temp root."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        make_home(Path(self._tmp.name), "default", [("s1", "assistant", "deck note", None)])
        self._env = os.environ.get("AGENT_OFFICE_ROOT")
        os.environ["AGENT_OFFICE_ROOT"] = self._tmp.name
        self._inbox_env = os.environ.get("AGENT_DECK_INBOX_DIR")
        os.environ["AGENT_DECK_INBOX_DIR"] = str(Path(self._tmp.name) / "no-inbox")  # never the real drop box
        spec = importlib.util.spec_from_file_location("plugin_api_under_test", _DASH / "plugin_api.py")
        self.api = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.api)

    def tearDown(self):
        if self._env is None:
            os.environ.pop("AGENT_OFFICE_ROOT", None)
        else:
            os.environ["AGENT_OFFICE_ROOT"] = self._env
        if self._inbox_env is None:
            os.environ.pop("AGENT_DECK_INBOX_DIR", None)
        else:
            os.environ["AGENT_DECK_INBOX_DIR"] = self._inbox_env
        self._tmp.cleanup()

    def call(self, **kw):
        resp = asyncio.run(self.api.memory_endpoint(**kw))
        return resp.status_code, dict(resp.headers), json.loads(resp.body)

    def test_no_store_and_payload(self):
        status, headers, body = self.call(q="deck", agent=None, limit=20)
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("cache-control"), "no-store")
        self.assertEqual(len(body["results"]), 1)

    def test_unknown_agent_is_404(self):
        status, _, body = self.call(q="deck", agent="nobody", limit=20)
        self.assertEqual(status, 404)
        self.assertEqual(body, {"error": "unknown agent"})

    def test_limit_is_clamped_at_the_endpoint(self):
        status, _, body = self.call(q="deck", agent=None, limit=10_000)
        self.assertEqual(status, 200)
        self.assertLessEqual(len(body["results"]), 50)

    def test_query_over_200_chars_is_rejected_by_the_router(self):
        try:
            from fastapi import FastAPI
            from fastapi.testclient import TestClient
        except ImportError:
            self.skipTest("fastapi / httpx not installed")
        app = FastAPI()
        app.include_router(self.api.router, prefix="/api/plugins/agent-office")
        client = TestClient(app)
        r = client.get("/api/plugins/agent-office/memory", params={"q": "x" * 201})
        self.assertEqual(r.status_code, 422)
        r = client.get("/api/plugins/agent-office/memory", params={"q": "deck", "limit": 5})
        self.assertEqual(r.status_code, 200)


if __name__ == "__main__":
    unittest.main()
