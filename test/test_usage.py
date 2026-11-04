"""Unit tests for plugin/agent-office/dashboard/usage.py (run via unittest discover)."""
import importlib.util
import json
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

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


class PlanUsageTests(unittest.TestCase):
    def setUp(self):
        usage._reset_cache()

    def tearDown(self):
        usage._reset_cache()

    def test_maps_windows_to_pct_and_resets(self):
        result = usage.plan_usage(now=1000.0, fetch=_snapshot)
        self.assertEqual(result, {
            "available": True,
            "five_hour": {"pct": 42.5, "resets_at": RESET_5H.isoformat()},
            "seven_day": {"pct": 77.0, "resets_at": RESET_7D.isoformat()},
            "fetched_at": 1000.0,
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
        self.assertNotIn("token", dumped.lower())
        self.assertNotIn("key", dumped.lower())
        self.assertNotIn("secret-principal", dumped)
        self.assertNotIn("identity", dumped)


if __name__ == "__main__":
    unittest.main()
