"""Unit tests for collect.session_detail (the /session route's payload). Run via unittest discover."""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

_SRC = Path(__file__).resolve().parent.parent / "plugin" / "agent-office" / "dashboard" / "collect.py"
_spec = importlib.util.spec_from_file_location("collect", _SRC)
collect = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(collect)

import sqlite3

NOW = 1_800_000_000.0
SCHEMA = """
    create table sessions (id text primary key, source text, title text, started_at real, ended_at real,
                           parent_session_id text, model text, last_activity_at real,
                           last_activity_description text);
    create table messages (id integer primary key, session_id text, role text, content text,
                           tool_calls text, tool_name text, timestamp real);
"""
SECRET = "SECRET123"


class SessionDetailTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        home = Path(self._tmp.name) / "dev"
        home.mkdir()
        self.homes = [{"id": "dev", "home": home}]
        db = sqlite3.connect(str(home / "state.db"))
        db.executescript(SCHEMA)
        db.execute("insert into sessions (id, source, title, started_at, parent_session_id, model, last_activity_at, "
                   "last_activity_description) values ('s-main', 'chat', 'Main task', ?, null, 'claude-opus-4', ?, "
                   "'writing report')", (NOW - 100, NOW - 5))
        db.execute("insert into sessions (id, source, title, started_at, parent_session_id, model, last_activity_at) "
                   "values ('h-1', 'chat', 'Helper', ?, 's-main', 'claude-haiku-5-5', ?)", (NOW - 30, NOW - 10))
        # Message content and tool-call arguments both carry the secret; neither may reach the payload.
        args = json.dumps({"cmd": f"echo {SECRET}"})
        calls = json.dumps([{"function": {"name": "terminal", "arguments": args}}])
        db.execute("insert into messages (session_id, role, content, tool_calls, tool_name, timestamp) "
                   "values ('s-main', 'user', ?, null, null, ?)", (f"{SECRET} please", NOW - 60))
        for i in range(10):
            ts = NOW - 50 + i
            if i % 2:
                db.execute("insert into messages (session_id, role, content, tool_calls, tool_name, timestamp) "
                           "values ('s-main', 'assistant', ?, ?, 'terminal', ?)", (f"{SECRET} {i}", calls, ts))
            else:
                db.execute("insert into messages (session_id, role, content, tool_calls, tool_name, timestamp) "
                           "values ('s-main', 'assistant', ?, null, null, ?)", (f"{SECRET} reply {i}", ts))
        db.execute("insert into messages (session_id, role, content, tool_calls, tool_name, timestamp) "
                   "values ('s-main', 'tool', ?, null, 'terminal', ?)", (f"{SECRET} output", NOW - 1))
        db.commit()
        db.close()

    def tearDown(self):
        self._tmp.cleanup()

    def _detail(self, sid="s-main"):
        return collect.session_detail(sid, homes=self.homes, now=NOW)

    def test_payload_has_only_whitelisted_fields_and_no_content(self):
        out = self._detail()
        self.assertIsNotNone(out)
        self.assertEqual(set(out), {"id", "profile", "status", "activity", "last_tool", "helpers", "events"})
        self.assertEqual(out["id"], "s-main")
        self.assertEqual(out["profile"], "dev")
        self.assertNotIn(SECRET, json.dumps(out))
        for e in out["events"]:
            self.assertEqual(set(e), {"at", "kind", "name"})

    def test_last_tool_and_helpers(self):
        out = self._detail()
        self.assertEqual(out["last_tool"]["name"], "terminal")
        self.assertEqual(out["last_tool"]["at"], NOW - 1)
        self.assertEqual([h["id"] for h in out["helpers"]], ["h-1"])
        self.assertEqual(set(out["helpers"][0]), {"id", "status", "model"})
        self.assertEqual(out["helpers"][0]["model"], "Haiku")
        self.assertIn(out["helpers"][0]["status"], {"working", "idle", "done"})

    def test_events_newest_first_and_capped_at_eight(self):
        events = self._detail()["events"]
        self.assertLessEqual(len(events), 8)
        self.assertEqual(len(events), collect.EVENT_LIMIT)
        ats = [e["at"] for e in events]
        self.assertEqual(ats, sorted(ats, reverse=True))
        self.assertEqual(events[0]["kind"], "tool")  # the tool row at NOW-1
        self.assertEqual(events[0]["name"], "terminal")

    def test_invalid_ids_return_none(self):
        for bad in ["../x", "a" * 200, "", "x y", "s-main/../../etc", None, 42]:
            with self.subTest(sid=bad):
                self.assertIsNone(collect.session_detail(bad, homes=self.homes, now=NOW))

    def test_unknown_id_returns_none(self):
        self.assertIsNone(self._detail("no-such-session"))


if __name__ == "__main__":
    unittest.main()
