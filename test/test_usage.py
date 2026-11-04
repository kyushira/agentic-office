"""Unit tests for plugin/agent-office/dashboard/usage.py (run via unittest discover)."""
import importlib.util
import json
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
            "reason": None,
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
        fake = SimpleNamespace(fetch_usage=lambda timeout=None: (limits, None))
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
        fake = SimpleNamespace(fetch_usage=lambda timeout=None: (limits, None))
        with patch.object(usage, "_plugin_dir", return_value="/nowhere"), \
                patch.object(usage, "_load_setup", return_value=fake):
            result = usage.plan_usage(now=1000.0)
        self.assertAlmostEqual(result["five_hour"]["pct"], 42.0)
        self.assertAlmostEqual(result["seven_day"]["pct"], 90.0)

    def test_default_fetch_surfaces_plugin_reason(self):
        fake = SimpleNamespace(fetch_usage=lambda timeout=None: (None, "no Claude subscription login found (run `claude` and log in)"))
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
        self.assertIn("reason", json.loads(dumped))


if __name__ == "__main__":
    unittest.main()
