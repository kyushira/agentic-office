"""Tests for usage.token_breakdown / breakdown_usage / parse_days (GET /usage/breakdown).

Every state.db is a temp file built with the real session_model_usage column names. Nothing touches the
real Hermes home: the default root is patched to a temp directory where it is needed.
"""
import importlib.util
import sqlite3
import tempfile
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

_SRC = Path(__file__).resolve().parent.parent / "plugin" / "agent-office" / "dashboard" / "usage.py"
_spec = importlib.util.spec_from_file_location("usage_breakdown_under_test", _SRC)
usage = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(usage)

NOW = 1_800_000_000.0
DAY = 86400
CLAUDE = "claude-subscription-directsdk-experimental"

SCHEMA = (
    "CREATE TABLE session_model_usage ("
    " session_id TEXT, model TEXT, billing_provider TEXT,"
    " input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,"
    " reasoning_tokens INTEGER, api_call_count INTEGER, estimated_cost_usd REAL, actual_cost_usd REAL,"
    " cost_status TEXT, cost_source TEXT, first_seen REAL, last_seen REAL)"
)


def _day(ts):
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d")


def _make_db(path: Path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        path.unlink()
    conn = sqlite3.connect(path)
    conn.execute(SCHEMA)
    for r in rows:
        conn.execute(
            "INSERT INTO session_model_usage (session_id, model, billing_provider, input_tokens, output_tokens,"
            " cache_read_tokens, cache_write_tokens, reasoning_tokens, api_call_count, estimated_cost_usd,"
            " actual_cost_usd, cost_status, cost_source, first_seen, last_seen)"
            " VALUES (?, 'm', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'x', 'y', 0, ?)",
            (r["sid"], r.get("provider", CLAUDE), r.get("inp", 0), r.get("out", 0), r.get("cr", 0),
             r.get("cw", 0), r.get("rsn", 0), r.get("calls", 1), r.get("est"), r.get("act"), r["seen"]))
    conn.commit()
    conn.close()


class BreakdownFixture(unittest.TestCase):
    """Root (= ash) plus three profiles: dev, red, pixel. Costs and windows are chosen per test expectation."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self._build(NOW)

    def _build(self, base):
        """The fixture with every row placed relative to `base` (the "now" the test will use)."""
        _make_db(self.root / "state.db", [
            # ash: one actual + estimated row, one estimated-only row, one row outside the 7-day window
            {"sid": "a1", "inp": 100, "out": 50, "cr": 1000, "cw": 10, "rsn": 5, "calls": 2,
             "act": 0.10, "est": 0.12, "seen": base - 100},
            {"sid": "a1", "inp": 10, "out": 5, "calls": 1, "est": 0.02, "seen": base - 200},
            {"sid": "a2", "inp": 999, "out": 999, "act": 9.0, "seen": base - 8 * DAY},
        ])
        _make_db(self.root / "profiles" / "dev" / "state.db", [
            {"sid": "d1", "provider": "deepseek", "inp": 40, "out": 10, "calls": 3, "seen": base - DAY},
            {"sid": "d2", "inp": 7, "out": 3, "calls": 1, "act": 0.5, "est": 0.4, "seen": base - 2 * DAY},
        ])
        _make_db(self.root / "profiles" / "red" / "state.db", [
            {"sid": "r1", "inp": 20, "out": 10, "calls": 1, "seen": base - 3 * DAY},
        ])
        _make_db(self.root / "profiles" / "pixel" / "state.db", [
            {"sid": "p1", "inp": 15, "out": 5, "calls": 1, "est": 0.03, "seen": base - 6 * DAY},
        ])

    def tearDown(self):
        self._tmp.cleanup()

    def breakdown(self, **kw):
        return usage.token_breakdown(self.root, now=NOW, **kw)

    def by_name(self, result):
        return {a["agent"]: a for a in result["agents"]}


class WindowAndSumsTests(BreakdownFixture):
    def test_row_older_than_window_is_excluded(self):
        ash = self.by_name(self.breakdown())["ash"]
        self.assertEqual(ash["tokens"], 165)  # the 999+999 row at 8 days is outside the 7-day window

    def test_window_start_is_inclusive(self):
        _make_db(self.root / "profiles" / "edge" / "state.db", [
            {"sid": "e1", "inp": 1, "out": 1, "seen": NOW - 7 * DAY},
            {"sid": "e2", "inp": 1, "out": 1, "seen": NOW - 7 * DAY - 1},
        ])
        edge = self.by_name(self.breakdown())["edge"]
        self.assertEqual(edge["tokens"], 2)
        self.assertEqual(edge["sessions"], 1)

    def test_per_agent_sums_and_distinct_sessions(self):
        ash = self.by_name(self.breakdown())["ash"]
        self.assertEqual((ash["input"], ash["output"]), (110, 55))
        self.assertEqual(ash["tokens"], 165)
        self.assertEqual((ash["cache_read"], ash["cache_write"], ash["reasoning"]), (1000, 10, 5))
        self.assertEqual(ash["api_calls"], 3)
        self.assertEqual(ash["sessions"], 1)  # two rows, one session

    def test_cache_tokens_are_reported_but_not_in_tokens(self):
        ash = self.by_name(self.breakdown())["ash"]
        self.assertEqual(ash["tokens"], ash["input"] + ash["output"])

    def test_agents_sorted_by_tokens_desc_and_named_by_folder(self):
        result = self.breakdown()
        self.assertEqual([a["agent"] for a in result["agents"]], ["ash", "dev", "red", "pixel"])
        self.assertEqual([a["tokens"] for a in result["agents"]], [165, 60, 30, 20])

    def test_by_provider_sums_tokens_per_billing_provider(self):
        dev = self.by_name(self.breakdown())["dev"]
        self.assertEqual(dev["by_provider"], {"deepseek": 50, CLAUDE: 10})
        self.assertEqual(sum(dev["by_provider"].values()), dev["tokens"])

    def test_totals_match_agent_sums(self):
        result = self.breakdown()
        self.assertEqual(result["totals"]["tokens"], 275)
        self.assertEqual(result["totals"]["api_calls"], 3 + 4 + 1 + 1)

    def test_response_envelope(self):
        result = self.breakdown(days=7)
        self.assertEqual(result["days"], 7)
        self.assertEqual(result["since"], NOW - 7 * DAY)
        self.assertEqual(result["fetched_at"], NOW)
        self.assertEqual(result["source"], "state.db")
        self.assertEqual(result["errors"], [])


class CostKindTests(BreakdownFixture):
    def test_actual_beats_estimated_and_mixed_is_reported(self):
        ash = self.by_name(self.breakdown())["ash"]
        # row 1 uses actual 0.10, row 2 has only an estimate 0.02
        self.assertEqual(ash["cost_usd"], 0.12)
        self.assertEqual(ash["cost_kind"], "mixed")

    def test_actual_only(self):
        dev = self.by_name(self.breakdown())["dev"]
        self.assertEqual(dev["cost_usd"], 0.5)  # actual 0.5 wins over estimated 0.4 on the same row
        self.assertEqual(dev["cost_kind"], "actual")

    def test_estimated_only(self):
        pixel = self.by_name(self.breakdown())["pixel"]
        self.assertEqual(pixel["cost_usd"], 0.03)
        self.assertEqual(pixel["cost_kind"], "estimated")

    def test_all_null_costs_give_null_and_none(self):
        _make_db(self.root / "profiles" / "nullcost" / "state.db", [
            {"sid": "n1", "inp": 4, "out": 1, "seen": NOW - DAY},
        ])
        nullcost = self.by_name(self.breakdown())["nullcost"]
        self.assertIsNone(nullcost["cost_usd"])
        self.assertEqual(nullcost["cost_kind"], "none")
        self.assertEqual(nullcost["tokens"], 5)

    def test_null_row_does_not_erase_other_rows_cost(self):
        red = self.by_name(self.breakdown())["red"]  # its only row has no cost at all
        self.assertIsNone(red["cost_usd"])
        self.assertEqual(red["cost_kind"], "none")

    def test_total_cost_skips_null_agents_and_is_null_when_all_are_null(self):
        result = self.breakdown()
        self.assertEqual(result["totals"]["cost_usd"], 0.65)  # ash 0.12 + dev 0.5 + pixel 0.03 (red is null)
        _make_db(self.root / "state.db", [])  # wipe ash's rows
        _make_db(self.root / "profiles" / "dev" / "state.db", [])
        _make_db(self.root / "profiles" / "pixel" / "state.db", [])
        empty_costs = self.breakdown()
        self.assertIsNone(empty_costs["totals"]["cost_usd"])


class TrendTests(BreakdownFixture):
    def test_every_day_in_window_is_present_oldest_first_with_zero_fill(self):
        trend = self.breakdown()["trend"]
        days = [t["day"] for t in trend]
        expected = sorted({_day(NOW - k * DAY) for k in range(0, 8)})
        self.assertEqual(days, expected)
        self.assertEqual(len(days), 8)  # 7 days back from a mid-day "now" touches 8 UTC dates
        zero = [t for t in trend if t["tokens"] == 0]
        self.assertEqual(len(zero), 3)  # Jan 8, Jan 10, Jan 11 in the fixture
        for t in zero:
            self.assertIsNone(t["cost_usd"])
            self.assertEqual(t["by_agent"], {})

    def test_bucket_values_and_by_agent(self):
        by_day = {t["day"]: t for t in self.breakdown()["trend"]}
        today = by_day[_day(NOW - 100)]
        self.assertEqual(today["tokens"], 165)
        self.assertEqual(today["by_agent"], {"ash": 165})
        self.assertEqual(today["cost_usd"], 0.12)
        yesterday = by_day[_day(NOW - DAY)]
        self.assertEqual(yesterday["by_agent"], {"dev": 50})
        self.assertIsNone(yesterday["cost_usd"])  # dev's day-old row has no cost

    def test_trend_tokens_sum_to_totals(self):
        result = self.breakdown()
        self.assertEqual(sum(t["tokens"] for t in result["trend"]), result["totals"]["tokens"])


class SkippedDatabaseTests(BreakdownFixture):
    def test_missing_table_and_unreadable_file_are_skipped_and_named(self):
        _make_db(self.root / "profiles" / "oldschema" / "state.db", [])
        conn = sqlite3.connect(self.root / "profiles" / "oldschema" / "state.db")
        conn.execute("DROP TABLE session_model_usage")
        conn.commit()
        conn.close()
        (self.root / "profiles" / "garbage").mkdir(parents=True)
        (self.root / "profiles" / "garbage" / "state.db").write_bytes(b"this is not sqlite" * 50)

        result = self.breakdown()
        self.assertCountEqual(result["errors"], [
            {"agent": "oldschema", "error": "OperationalError"},
            {"agent": "garbage", "error": "DatabaseError"},
        ])
        names = [a["agent"] for a in result["agents"]]
        self.assertNotIn("oldschema", names)
        self.assertNotIn("garbage", names)
        self.assertIn("ash", names)  # the good databases still count

    def test_error_entries_carry_no_message_text(self):
        (self.root / "profiles" / "garbage").mkdir(parents=True)
        (self.root / "profiles" / "garbage" / "state.db").write_bytes(b"secret-looking text" * 50)
        for err in self.breakdown()["errors"]:
            self.assertEqual(set(err), {"agent", "error"})
            self.assertNotIn("secret", str(err))


class ReadOnlyTests(BreakdownFixture):
    def test_connection_refuses_writes(self):
        seen = []
        real_open = usage._open_ro

        def spy(path):
            conn = real_open(path)
            try:
                conn.execute("INSERT INTO session_model_usage (session_id, last_seen) VALUES ('x', 1)")
                seen.append("wrote")
            except sqlite3.Error as exc:
                seen.append(type(exc).__name__)
            return conn

        with patch.object(usage, "_open_ro", side_effect=spy):
            self.breakdown()
        self.assertEqual(len(seen), 4)  # one per database
        self.assertEqual(set(seen), {"OperationalError"})

    def test_failed_write_leaves_rows_untouched(self):
        before = self.breakdown()["totals"]
        real_open = usage._open_ro
        with patch.object(usage, "_open_ro", side_effect=lambda p: _write_attempt(real_open, p)):
            self.breakdown()
        self.assertEqual(self.breakdown()["totals"], before)

    def test_open_uses_mode_ro_uri(self):
        seen = []
        real = sqlite3.connect

        def spy(target, *a, **kw):
            seen.append((target, kw.get("uri")))
            return real(target, *a, **kw)

        with patch.object(usage.sqlite3, "connect", side_effect=spy):
            self.breakdown()
        self.assertEqual(len(seen), 4)
        for target, uri in seen:
            self.assertTrue(uri)
            self.assertIn("mode=ro", target)


def _write_attempt(real, path):
    conn = real(path)
    try:
        conn.execute("INSERT INTO session_model_usage (session_id, last_seen) VALUES ('x', 1)")
    except sqlite3.Error:
        pass
    return conn


class DaysClampTests(BreakdownFixture):
    def test_parse_days_defaults_and_clamps(self):
        self.assertEqual(usage.parse_days(None), 7)
        self.assertEqual(usage.parse_days("1"), 1)
        self.assertEqual(usage.parse_days("0"), 1)
        self.assertEqual(usage.parse_days("-5"), 1)
        self.assertEqual(usage.parse_days("30"), 30)
        self.assertEqual(usage.parse_days("999"), 30)
        self.assertEqual(usage.parse_days(" 14 "), 14)

    def test_parse_days_rejects_non_integers(self):
        for bad in ("abc", "", "1.5", "7d", "1e3"):
            with self.subTest(value=bad), self.assertRaises(ValueError):
                usage.parse_days(bad)

    def test_token_breakdown_clamps_days_in_the_response(self):
        self.assertEqual(self.breakdown(days=99)["days"], 30)
        self.assertEqual(self.breakdown(days=0)["days"], 1)
        self.assertEqual(self.breakdown(days=99)["since"], NOW - 30 * DAY)


class CacheTests(BreakdownFixture):
    def setUp(self):
        super().setUp()
        usage._reset_breakdown_cache()
        patcher = patch.object(usage, "_default_root", return_value=self.root)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(usage._reset_breakdown_cache)

    def test_cached_for_60_seconds_per_days_value(self):
        first = usage.breakdown_usage(7, now=NOW)
        again = usage.breakdown_usage(7, now=NOW + 59)
        self.assertEqual(first["fetched_at"], again["fetched_at"])
        fresh = usage.breakdown_usage(7, now=NOW + 61)
        self.assertEqual(fresh["fetched_at"], NOW + 61)

    def test_other_days_value_has_its_own_entry(self):
        seven = usage.breakdown_usage(7, now=NOW)
        three = usage.breakdown_usage(3, now=NOW + 1)
        self.assertEqual(seven["days"], 7)
        self.assertEqual(three["days"], 3)
        self.assertEqual(three["fetched_at"], NOW + 1)

    def test_returned_copy_is_not_the_cached_object(self):
        out = usage.breakdown_usage(7, now=NOW)
        out["agents"].clear()
        self.assertTrue(usage.breakdown_usage(7, now=NOW + 1)["agents"])


class RouteTests(BreakdownFixture):
    """GET /usage/breakdown through FastAPI's TestClient, against the temp fixture (team poller kept off)."""

    def setUp(self):
        super().setUp()
        try:
            from fastapi import FastAPI
            from fastapi.testclient import TestClient
        except ImportError as e:  # pragma: no cover - fastapi is a dashboard dependency
            self.skipTest(f"fastapi/httpx not available: {e}")
        import os
        old = os.environ.get("AGENT_OFFICE_TEAM_POLL")
        os.environ["AGENT_OFFICE_TEAM_POLL"] = "0"
        self.addCleanup(lambda: os.environ.pop("AGENT_OFFICE_TEAM_POLL", None) if old is None
                        else os.environ.__setitem__("AGENT_OFFICE_TEAM_POLL", old))
        plugin = Path(__file__).resolve().parent.parent / "plugin" / "agent-office" / "dashboard" / "plugin_api.py"
        spec = importlib.util.spec_from_file_location("plugin_api_breakdown_test", plugin)
        api = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(api)
        # The route reads the wall clock, so the fixture is rebuilt around real "now".
        # plugin_api loads its own usage module instance: patch the one the route calls, never the real home.
        self._build(time.time())
        api.usage._reset_breakdown_cache()
        self.addCleanup(api.usage._reset_breakdown_cache)
        patcher = patch.object(api.usage, "_default_root", return_value=self.root)
        patcher.start()
        self.addCleanup(patcher.stop)
        app = FastAPI()
        app.include_router(api.router, prefix="/api/plugins/agent-office")
        self.client = TestClient(app)
        self.url = "/api/plugins/agent-office/usage/breakdown"

    def test_default_window_is_seven_days_with_no_store(self):
        r = self.client.get(self.url)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers["cache-control"], "no-store")
        body = r.json()
        self.assertEqual(body["days"], 7)
        self.assertEqual(body["totals"]["tokens"], 275)
        self.assertEqual(set(body), {"days", "since", "fetched_at", "source", "agents", "trend", "totals", "errors"})

    def test_non_integer_days_is_400(self):
        for bad in ("abc", "1.5", ""):
            with self.subTest(days=bad):
                r = self.client.get(self.url, params={"days": bad})
                self.assertEqual(r.status_code, 400)
                self.assertEqual(r.json(), {"error": "days must be an integer"})

    def test_out_of_range_days_is_clamped_not_rejected(self):
        self.assertEqual(self.client.get(self.url, params={"days": "999"}).json()["days"], 30)
        self.assertEqual(self.client.get(self.url, params={"days": "0"}).json()["days"], 1)
        self.assertEqual(self.client.get(self.url, params={"days": "14"}).json()["days"], 14)


if __name__ == "__main__":
    unittest.main()
