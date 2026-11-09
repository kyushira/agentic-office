"""Unit tests for brain.py (GET /brain): the agent whitelist and aliases, traversal refusal, symlinks, redaction,
limits and percentages, the size cap, missing and unreadable files, and the route through plugin_api.router.
Builds fake agent homes in a temp root; never reads the real /opt/data. Run via unittest discover."""
import asyncio
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

_DASH = Path(__file__).resolve().parent.parent / "plugin" / "agent-office" / "dashboard"
_spec = importlib.util.spec_from_file_location("brain", _DASH / "brain.py")
brain = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(brain)

SK_ANT = "sk-ant-" + "a1B2c3D4e5F6g7H8i9J0" * 2  # 40 characters after the prefix
API_KV = "api_key=abcd1234secret"


class _Temp(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name) / "opt-data"
        self.root.mkdir()

    def tearDown(self):
        self._tmp.cleanup()

    def write(self, rel, text):
        p = self.root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")
        return p

    def home(self, agent_id):
        """Relative paths of an agent's files, as brain.paths builds them."""
        if agent_id == "default":
            return "SOUL.md", "memories/MEMORY.md", "memories/USER.md"
        base = f"profiles/{agent_id}/"
        return base + "SOUL.md", base + "memories/MEMORY.md", base + "memories/USER.md"


class WhitelistTests(_Temp):
    def test_all_seven_agents_in_order_with_names(self):
        snap = brain.snapshot(root=self.root)
        self.assertFalse(snap["unknown_agent"])
        self.assertEqual([a["id"] for a in snap["agents"]], ["default", "dev", "nova", "pixel", "prism", "red", "sentinel"])
        self.assertEqual(snap["agents"][0]["name"], "Ash")
        self.assertEqual(snap["agents"][1]["name"], "Dev")
        self.assertEqual(snap["limits"], {"memory": 2200, "user": 1375})

    def test_ash_and_hermes_alias_resolve_to_default(self):
        self.assertEqual(brain.resolve("ash"), "default")
        self.assertEqual(brain.resolve("Hermes"), "default")
        snap = brain.snapshot("ash", root=self.root)
        self.assertEqual([a["id"] for a in snap["agents"]], ["default"])

    def test_case_and_whitespace_are_normalised(self):
        self.assertEqual(brain.resolve("DEV"), "dev")
        self.assertEqual(brain.resolve("  nova "), "nova")

    def test_unknown_agent_rejected(self):
        snap = brain.snapshot("bob", root=self.root)
        self.assertTrue(snap["unknown_agent"])
        self.assertEqual(snap["agents"], [])
        self.assertIsNone(brain.resolve("bob"))


class TraversalTests(_Temp):
    BAD = ["../default", "dev/../../etc", "/etc/passwd", "dev/../nova", "..", "", "dev\x00", "dev/", "~", None]

    def test_resolve_refuses_traversal_and_odd_ids(self):
        for bad in self.BAD:
            with self.subTest(agent=bad):
                self.assertIsNone(brain.resolve(bad))

    def test_snapshot_refuses_traversal_and_reads_nothing(self):
        for bad in self.BAD[:-1]:
            with self.subTest(agent=bad):
                snap = brain.snapshot(bad, root=self.root)
                self.assertTrue(snap["unknown_agent"])
                self.assertEqual(snap["agents"], [])

    def test_fixed_paths_never_leave_the_profile_home(self):
        for aid in brain.AGENTS:
            with self.subTest(agent=aid):
                for p in brain.paths(aid, self.root).values():
                    self.assertTrue(p.is_relative_to(self.root))


class SymlinkTests(_Temp):
    def test_symlinked_memory_pointing_outside_root_is_not_followed(self):
        secret_file = Path(self._tmp.name) / "outside.md"
        secret_file.write_text("outside secret text", encoding="utf-8")
        (self.root / "memories").mkdir()
        os.symlink(secret_file, self.root / "memories" / "MEMORY.md")
        mem = brain.snapshot("default", root=self.root)["agents"][0]["memory"]
        self.assertFalse(mem["exists"])
        self.assertEqual(mem["text"], "")
        self.assertIsNone(mem["mtime"])

    def test_directory_named_like_a_file_counts_as_missing(self):
        (self.root / "memories" / "MEMORY.md").mkdir(parents=True)
        mem = brain.read_file(self.root / "memories" / "MEMORY.md", 2200)
        self.assertFalse(mem["exists"])
        self.assertIsNone(mem["error"])

    def test_unreadable_file_reports_error(self):
        p = self.write("memories/MEMORY.md", "hi")
        with mock.patch.object(brain.os, "open", side_effect=PermissionError("denied")):
            mem = brain.read_file(p, 2200)
        self.assertFalse(mem["exists"])
        self.assertEqual(mem["error"], "unreadable")
        self.assertEqual(mem["text"], "")


class RedactionTests(_Temp):
    def test_secrets_never_leave_the_backend(self):
        self.write("memories/MEMORY.md", f"{API_KV}\nnote {SK_ANT} end\n")
        agent = brain.snapshot("default", root=self.root)["agents"][0]
        mem = agent["memory"]
        self.assertNotIn(SK_ANT, mem["text"])
        self.assertNotIn("abcd1234secret", mem["text"])
        self.assertNotIn("abcd1234secret", mem["first"])
        self.assertIn("[redacted", mem["text"])
        self.assertIn("[redacted", mem["first"])
        self.assertGreaterEqual(mem["redacted"], 2)
        dumped = json.dumps(agent)
        self.assertNotIn(SK_ANT, dumped)
        self.assertNotIn("abcd1234secret", dumped)

    def test_first_line_is_first_non_empty_line_capped_at_140(self):
        line = "word " * 60  # spaced words: an unbroken 300-char run would be (correctly) redacted as a secret
        self.write("memories/USER.md", "\n\n   " + line + "\nsecond\n")
        user = brain.read_file(self.root / "memories" / "USER.md", 1375)
        self.assertEqual(user["first"], line.strip()[:139] + "…")
        self.assertLessEqual(len(user["first"]), 140)
        self.assertEqual(brain.read_file(self.root / "nowhere.md", None)["first"], "")


class LimitTests(_Temp):
    @staticmethod
    def text_of(n):
        return ("lorem ipsum " * (n // 12 + 1))[:n]

    def test_memory_full_is_100_percent(self):
        self.write("memories/MEMORY.md", self.text_of(2200))
        mem = brain.read_file(self.root / "memories" / "MEMORY.md", 2200)
        self.assertEqual(mem["chars"], 2200)
        self.assertEqual(mem["pct"], 100.0)
        self.assertEqual(mem["limit"], 2200)

    def test_memory_half_is_50_percent(self):
        self.write("memories/MEMORY.md", self.text_of(1100))
        mem = brain.read_file(self.root / "memories" / "MEMORY.md", 2200)
        self.assertEqual(mem["pct"], 50.0)

    def test_user_limit_is_1375(self):
        self.write("memories/USER.md", self.text_of(1375))
        user = brain.read_file(self.root / "memories" / "USER.md", 1375)
        self.assertEqual(user["pct"], 100.0)
        self.assertEqual(user["limit"], 1375)

    def test_over_limit_pct_may_exceed_100(self):
        self.write("memories/MEMORY.md", self.text_of(2750))
        self.assertEqual(brain.read_file(self.root / "memories" / "MEMORY.md", 2200)["pct"], 125.0)

    def test_soul_has_no_limit(self):
        self.write("SOUL.md", self.text_of(500))
        soul = brain.read_file(self.root / "SOUL.md", None)
        self.assertIsNone(soul["limit"])
        self.assertIsNone(soul["pct"])
        self.assertEqual(soul["chars"], 500)


class SizeCapTests(_Temp):
    def test_200kb_soul_is_truncated_and_text_is_capped(self):
        self.write("SOUL.md", ("lorem ipsum " * 20000)[: 200 * 1024])
        soul = brain.read_file(self.root / "SOUL.md", None)
        self.assertTrue(soul["truncated"])
        self.assertEqual(soul["chars"], 200 * 1024)
        self.assertLessEqual(len(soul["text"]), brain.TEXT_CAP)
        self.assertGreater(len(soul["text"]), 0)

    def test_text_over_text_cap_is_truncated_without_byte_overflow(self):
        self.write("SOUL.md", "ab cd " * 4000)  # 24000 chars: over TEXT_CAP (20000), under READ_CAP
        soul = brain.read_file(self.root / "SOUL.md", None)
        self.assertTrue(soul["truncated"])
        self.assertLessEqual(len(soul["text"]), brain.TEXT_CAP)
        self.assertGreaterEqual(len(soul["text"]), brain.TEXT_CAP - 10)  # cap rstrips before the ellipsis

    def test_small_file_not_truncated(self):
        self.write("SOUL.md", "short soul")
        soul = brain.read_file(self.root / "SOUL.md", None)
        self.assertFalse(soul["truncated"])
        self.assertEqual(soul["text"], "short soul")


class MissingAndMtimeTests(_Temp):
    def test_missing_files_are_reported_not_raised(self):
        agent = brain.snapshot("nova", root=self.root)["agents"][0]
        for key, limit in (("soul", None), ("memory", 2200), ("user", 1375)):
            with self.subTest(file=key):
                f = agent[key]
                self.assertFalse(f["exists"])
                self.assertIsNone(f["mtime"])
                self.assertEqual(f["chars"], 0)
                self.assertEqual(f["text"], "")
                self.assertEqual(f["first"], "")
                self.assertEqual(f["pct"], 0.0 if limit else None)

    def test_existing_file_has_float_mtime(self):
        self.write("profiles/dev/SOUL.md", "dev soul")
        soul = brain.snapshot("dev", root=self.root)["agents"][0]["soul"]
        self.assertTrue(soul["exists"])
        self.assertIsInstance(soul["mtime"], float)
        self.assertGreater(soul["mtime"], 0)


class EndpointTests(_Temp):
    """GET /api/plugins/agent-office/brain through the real router, with brain.DEFAULT_ROOT pointed at the temp root."""

    def setUp(self):
        super().setUp()
        try:
            from fastapi import FastAPI
            from fastapi.testclient import TestClient
        except ImportError:
            self.skipTest("fastapi / httpx not installed")
        self._env = os.environ.get("AGENT_OFFICE_ROOT")
        os.environ["AGENT_OFFICE_ROOT"] = str(self.root / "office-root")  # plugin_api loads collect with this root
        spec = importlib.util.spec_from_file_location("plugin_api_brain_test", _DASH / "plugin_api.py")
        api = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(api)
        self._default_root = api.brain.DEFAULT_ROOT
        api.brain.DEFAULT_ROOT = self.root
        app = FastAPI()
        app.include_router(api.router, prefix="/api/plugins/agent-office")
        self.client = TestClient(app)
        self.api = api
        self.url = "/api/plugins/agent-office/brain"

    def tearDown(self):
        if hasattr(self, "api"):
            self.api.brain.DEFAULT_ROOT = self._default_root
        if self._env is None:
            os.environ.pop("AGENT_OFFICE_ROOT", None)
        else:
            os.environ["AGENT_OFFICE_ROOT"] = self._env
        super().tearDown()

    def test_traversal_agent_is_404_no_store(self):
        resp = self.client.get(self.url, params={"agent": "../default"})
        self.assertEqual(resp.status_code, 404)
        self.assertEqual(resp.json(), {"error": "unknown agent"})
        self.assertEqual(resp.headers["cache-control"], "no-store")

    def test_no_agent_returns_seven_agents_no_store(self):
        resp = self.client.get(self.url)
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(len(body["agents"]), 7)
        self.assertEqual(resp.headers["cache-control"], "no-store")

    def test_endpoint_is_get_only(self):
        self.assertEqual(self.client.post(self.url).status_code, 405)


if __name__ == "__main__":
    unittest.main()
