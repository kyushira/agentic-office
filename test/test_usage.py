"""Unit tests for plugin/agent-office/dashboard/usage.py (run via unittest discover)."""
import importlib.util
import json
import sqlite3
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

_SRC = Path(__file__).resolve().parent.parent / "plugin" / "agent-office" / "dashboard" / "usage.py"
_spec = importlib.util.spec_from_file_location("usage", _SRC)
usage = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(usage)

RESET_5H = datetime(2026, 11, 4, 15, 0, tzinfo=timezone.utc)
RESET_7D = datetime(2026, 11, 9, 0, 0, tzinfo=timezone.utc)


def _snapshot():
    return SimpleNamespace(windows=(
        SimpleNamespace(label="Current session", used_percent=42.5, reset_at=RESET_5H, scope="account"),
        SimpleNamespace(label="Current week", used_percent=77.0, reset_at=RESET_7D, scope="account"),
        SimpleNamespace(label="Opus week", used_percent=90.0, reset_at=None, scope="model"),
    ), identity="secret-principal-123")


FAKE_TOKENS = {
    "claude": {"five_hour": 1, "seven_day": 2, "prev_seven_day": 3, "sessions_7d": 4},
    "deepseek": {"five_hour": 0, "seven_day": 0, "prev_seven_day": 0, "sessions_7d": 0},
    "source": "state.db", "fetched_at": 1000.0,
}


class PlanUsageTests(unittest.TestCase):
    def setUp(self):
        usage._reset_cache()
        # plan_usage reads state.db through token_usage(); keep these tests off the real DBs.
        patcher = patch.object(usage, "token_usage", return_value=FAKE_TOKENS)
        patcher.start()
        self.addCleanup(patcher.stop)

    def tearDown(self):
        usage._reset_cache()

    def test_maps_windows_to_pct_and_resets(self):
        result = usage.plan_usage(now=1000.0, fetch=_snapshot)
        self.assertEqual(result, {
            "available": True,
            "five_hour": {"pct": 42.5, "resets_at": RESET_5H.isoformat()},
            "seven_day": {"pct": 77.0, "resets_at": RESET_7D.isoformat()},
            "fetched_at": 1000.0,
            "reason": None,
            "tokens": FAKE_TOKENS,
        })

    def test_raising_fetch_is_unavailable(self):
        def boom():
            raise RuntimeError("network down")
        result = usage.plan_usage(now=1000.0, fetch=boom)
        self.assertFalse(result["available"])
        self.assertIsNone(result["five_hour"]["pct"])
        self.assertIsNone(result["seven_day"]["resets_at"])

    def test_none_snapshot_is_unavailable(self):
        self.assertFalse(usage.plan_usage(now=1000.0, fetch=lambda: None)["available"])

    def test_unavailable_reason_is_surfaced(self):
        snap = SimpleNamespace(windows=(), unavailable_reason="no Claude subscription login found (run `claude` and log in)")
        result = usage.plan_usage(now=1000.0, fetch=lambda: snap)
        self.assertFalse(result["available"])
        self.assertEqual(result["reason"], "no Claude subscription login found (run `claude` and log in)")

    def test_long_reason_is_truncated(self):
        snap = SimpleNamespace(windows=(), unavailable_reason="x" * 500)
        self.assertEqual(len(usage.plan_usage(now=1000.0, fetch=lambda: snap)["reason"]), 200)

    def test_raising_fetch_reason_is_class_name_only(self):
        def boom():
            raise RuntimeError("token=abc123 at /home/user/.claude")
        result = usage.plan_usage(now=1000.0, fetch=boom)
        self.assertEqual(result["reason"], "usage lookup failed: RuntimeError")
        self.assertNotIn("abc123", json.dumps(result))

    def test_default_fetch_maps_plugin_limits(self):
        limits = {"limits": [
            {"kind": "session", "percent": 12.5, "resets_at": "2026-11-04T15:00:00Z"},
            {"kind": "weekly_all", "percent": 80, "resets_at": None},
            {"kind": "model_x", "percent": 5},
        ]}
        fake = SimpleNamespace(fetch_usage=lambda command=None, timeout=None: (limits, None))
        with patch.object(usage, "_plugin_dir", return_value="/nowhere"), \
                patch.object(usage, "_load_setup", return_value=fake):
            result = usage.plan_usage(now=1000.0)
        self.assertTrue(result["available"])
        self.assertEqual(result["five_hour"]["pct"], 12.5)
        self.assertEqual(result["five_hour"]["resets_at"], "2026-11-04T15:00:00+00:00")
        self.assertEqual(result["seven_day"]["pct"], 80.0)
        self.assertIsNone(result["reason"])

    def test_default_fetch_legacy_fraction_scale(self):
        limits = {"five_hour": {"utilization": 0.42}, "seven_day": {"utilization": 0.9, "resets_at": "2026-11-09T00:00:00Z"}}
        fake = SimpleNamespace(fetch_usage=lambda command=None, timeout=None: (limits, None))
        with patch.object(usage, "_plugin_dir", return_value="/nowhere"), \
                patch.object(usage, "_load_setup", return_value=fake):
            result = usage.plan_usage(now=1000.0)
        self.assertAlmostEqual(result["five_hour"]["pct"], 42.0)
        self.assertAlmostEqual(result["seven_day"]["pct"], 90.0)

    def test_default_fetch_surfaces_plugin_reason(self):
        fake = SimpleNamespace(fetch_usage=lambda command=None, timeout=None: (None, "no Claude subscription login found (run `claude` and log in)"))
        with patch.object(usage, "_plugin_dir", return_value="/nowhere"), \
                patch.object(usage, "_load_setup", return_value=fake):
            result = usage.plan_usage(now=1000.0)
        self.assertFalse(result["available"])
        self.assertIn("login", result["reason"])

    def test_default_fetch_without_plugin_says_so(self):
        with patch.object(usage, "_plugin_dir", return_value=None):
            result = usage.plan_usage(now=1000.0)
        self.assertFalse(result["available"])
        self.assertEqual(result["reason"], "Claude Subscription DirectSDK plugin not found")

    def test_pct_is_clamped_to_0_100(self):
        snap = SimpleNamespace(windows=(
            SimpleNamespace(label="Current session", used_percent=130.0, reset_at=None),
            SimpleNamespace(label="Current week", used_percent=-5.0, reset_at=None),
        ))
        result = usage.plan_usage(now=1000.0, fetch=lambda: snap)
        self.assertEqual(result["five_hour"]["pct"], 100.0)
        self.assertEqual(result["seven_day"]["pct"], 0.0)

    def test_cache_hit_within_60s_then_refetch_after_61s(self):
        calls = []

        def fake():
            calls.append(1)
            return _snapshot()

        usage.plan_usage(now=1000.0, fetch=fake)
        usage.plan_usage(now=1030.0, fetch=fake)
        self.assertEqual(len(calls), 1)
        usage.plan_usage(now=1061.0, fetch=fake)
        self.assertEqual(len(calls), 2)

    def test_tokens_are_attached_even_when_plan_lookup_fails(self):
        def boom():
            raise RuntimeError("nope")
        result = usage.plan_usage(now=1000.0, fetch=boom)
        self.assertFalse(result["available"])
        self.assertEqual(result["tokens"], FAKE_TOKENS)

    def test_token_failure_gives_null_tokens_not_an_error(self):
        with patch.object(usage, "token_usage", side_effect=RuntimeError("disk")):
            result = usage.plan_usage(now=1000.0, fetch=_snapshot)
        self.assertTrue(result["available"])
        self.assertIsNone(result["tokens"])

    def test_failure_is_cached_too(self):
        calls = []

        def boom():
            calls.append(1)
            raise RuntimeError("nope")

        usage.plan_usage(now=1000.0, fetch=boom)
        result = usage.plan_usage(now=1010.0, fetch=boom)
        self.assertEqual(len(calls), 1)
        self.assertFalse(result["available"])

    def test_output_is_whitelisted(self):
        dumped = json.dumps(usage.plan_usage(now=1000.0, fetch=_snapshot))
        self.assertNotIn("key", dumped.lower())
        self.assertNotIn("secret-principal", dumped)
        self.assertNotIn("identity", dumped)
        self.assertIn("reason", json.loads(dumped))


STATE_SCHEMA = """CREATE TABLE session_model_usage (
    session_id TEXT, model TEXT, billing_provider TEXT, api_call_count INTEGER,
    input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
    reasoning_tokens INTEGER, estimated_cost_usd REAL, actual_cost_usd REAL, first_seen REAL, last_seen REAL)"""
CLAUDE = usage.CLAUDE_PROVIDER
NOW = 2_000_000_000.0
HOUR, DAY = 3600.0, 86400.0


def _make_db(path, rows, schema=STATE_SCHEMA):
    conn = sqlite3.connect(str(path))
    if schema:
        conn.execute(schema)
    for sid, provider, last_seen, tin, tout, cache in rows:
        conn.execute("INSERT INTO session_model_usage (session_id, model, billing_provider, api_call_count, "
                     "input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, first_seen, last_seen) "
                     "VALUES (?, 'm', ?, 1, ?, ?, ?, 0, ?, ?)",
                     (sid, provider, tin, tout, cache, last_seen - 1, last_seen))
    conn.commit()
    conn.close()


class TokenUsageTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def test_windows_sum_input_and_output_only_and_split_providers(self):
        db = self.root / "state.db"
        _make_db(db, [
            ("a", CLAUDE, NOW - 1 * HOUR, 100, 50, 999_999),   # 5h, 7d: cache excluded
            ("b", CLAUDE, NOW - 3 * DAY, 200, 10, 0),          # 7d only
            ("c", CLAUDE, NOW - 10 * DAY, 400, 40, 0),         # previous week only
            ("d", CLAUDE, NOW - 20 * DAY, 800, 80, 0),         # outside every window
            ("e", "deepseek", NOW - 1 * HOUR, 7, 3, 0),        # other provider
        ])
        out = usage.token_usage(now=NOW, db_paths=[db])
        self.assertEqual(out["claude"], {"five_hour": 150, "seven_day": 360, "prev_seven_day": 440, "sessions_7d": 2})
        self.assertEqual(out["deepseek"], {"five_hour": 10, "seven_day": 10, "prev_seven_day": 0, "sessions_7d": 1})

    def test_five_hour_window_starts_exactly_five_hours_back(self):
        db = self.root / "state.db"
        _make_db(db, [("in", CLAUDE, NOW - 5 * HOUR, 1, 0, 0), ("out", CLAUDE, NOW - 5 * HOUR - 1, 100, 0, 0)])
        self.assertEqual(usage.token_usage(now=NOW, db_paths=[db])["claude"]["five_hour"], 1)

    def test_sums_across_every_db(self):
        root = self.root / "state.db"
        prof = self.root / "profiles" / "dev" / "state.db"
        prof.parent.mkdir(parents=True)
        _make_db(root, [("a", CLAUDE, NOW - HOUR, 10, 0, 0)])
        _make_db(prof, [("a", CLAUDE, NOW - HOUR, 20, 0, 0)])  # same session id in another DB is a different session
        out = usage.token_usage(now=NOW, db_paths=[root, prof])
        self.assertEqual(out["claude"]["five_hour"], 30)
        self.assertEqual(out["claude"]["sessions_7d"], 2)

    def test_missing_table_is_skipped(self):
        bad = self.root / "bad.db"
        _make_db(bad, [], schema="CREATE TABLE other (x INTEGER)")
        good = self.root / "good.db"
        _make_db(good, [("a", CLAUDE, NOW - HOUR, 5, 5, 0)])
        out = usage.token_usage(now=NOW, db_paths=[bad, good])
        self.assertEqual(out["claude"]["five_hour"], 10)

    def test_broken_file_is_skipped(self):
        broken = self.root / "broken.db"
        broken.write_bytes(b"this is not a sqlite database at all" * 100)
        good = self.root / "good.db"
        _make_db(good, [("a", CLAUDE, NOW - HOUR, 5, 5, 0)])
        out = usage.token_usage(now=NOW, db_paths=[broken, good])
        self.assertEqual(out["claude"]["five_hour"], 10)

    def test_missing_file_is_skipped_and_not_created(self):
        ghost = self.root / "nope" / "state.db"
        out = usage.token_usage(now=NOW, db_paths=[ghost])
        self.assertEqual(out["claude"], {"five_hour": 0, "seven_day": 0, "prev_seven_day": 0, "sessions_7d": 0})
        self.assertFalse(ghost.exists())

    def test_readonly_connection_cannot_write(self):
        db = self.root / "state.db"
        _make_db(db, [("a", CLAUDE, NOW - HOUR, 5, 5, 0)])
        conn = sqlite3.connect(f"{db.resolve().as_uri()}?mode=ro", uri=True)
        conn.execute("PRAGMA query_only = ON")
        with self.assertRaises(sqlite3.Error):
            conn.execute("UPDATE session_model_usage SET input_tokens = 0")
        conn.close()

    def test_output_is_integers_and_source_only(self):
        db = self.root / "state.db"
        _make_db(db, [("a", CLAUDE, NOW - HOUR, 5, 5, 0)])
        out = usage.token_usage(now=NOW, db_paths=[db])
        self.assertEqual(out["source"], "state.db")
        self.assertEqual(out["fetched_at"], NOW)
        for prov in ("claude", "deepseek"):
            for k, v in out[prov].items():
                self.assertIs(type(v), int, k)
        dumped = json.dumps(out)
        self.assertNotIn("session_id", dumped)
        self.assertNotIn(str(self.root), dumped)

    def test_default_discovery_finds_root_and_profiles(self):
        _make_db(self.root / "state.db", [])
        (self.root / "profiles" / "red").mkdir(parents=True)
        _make_db(self.root / "profiles" / "red" / "state.db", [])
        (self.root / "profiles" / "empty").mkdir()
        found = usage._state_dbs(self.root)
        self.assertEqual(found, [self.root / "state.db", self.root / "profiles" / "red" / "state.db"])


class ClaudeCommandTests(unittest.TestCase):
    def setUp(self):
        import tempfile
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def _exe(self, rel, mode=0o755):
        p = self.root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("#!/bin/sh\n")
        p.chmod(mode)
        return str(p)

    def test_first_executable_candidate_wins(self):
        a = self._exe("a/claude")
        b = self._exe("b/claude")
        self.assertEqual(usage._claude_command(candidates=[a, b]), [a])

    def test_non_executable_is_skipped(self):
        bad = self._exe("bad/claude", mode=0o644)
        good = self._exe("good/claude")
        self.assertEqual(usage._claude_command(candidates=[bad, good]), [good])

    def test_none_found_returns_none(self):
        missing = str(self.root / "nope" / "claude")
        self.assertIsNone(usage._claude_command(candidates=[missing]))
        self.assertIsNone(usage._claude_command(candidates=[]))

    def test_sibling_tools_dir_walk_finds_binary(self):
        target = self._exe("tools/node-1/bin/claude")
        exe = str(self.root / ".venv" / "bin" / "python")
        with patch.object(usage, "_BUNDLED_CLAUDE", str(self.root / "missing" / "claude")), \
                patch.object(usage, "_TOOLS_ROOT", str(self.root / "no-tools")):
            self.assertEqual(usage._claude_command(exe=exe), [target])

    def test_default_candidates_start_with_pinned_bundle(self):
        with patch.object(usage, "_TOOLS_ROOT", str(self.root / "no-tools")):
            cands = usage._candidates(exe=str(self.root / ".venv" / "bin" / "python"))
        self.assertEqual(cands[0], usage._BUNDLED_CLAUDE)

    def test_default_fetch_passes_command_through(self):
        seen = {}

        def fake_fetch(command=None, timeout=None):
            seen["command"] = command
            seen["timeout"] = timeout
            return (None, "no Claude subscription login found")

        fake = SimpleNamespace(fetch_usage=fake_fetch)
        with patch.object(usage, "_plugin_dir", return_value="/nowhere"), \
                patch.object(usage, "_load_setup", return_value=fake), \
                patch.object(usage, "_claude_command", return_value=["/x/claude"]):
            usage.plan_usage(now=1000.0)
        self.assertEqual(seen, {"command": ["/x/claude"], "timeout": 8})


if __name__ == "__main__":
    unittest.main()
