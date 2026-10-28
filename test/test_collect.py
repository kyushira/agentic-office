"""Unit tests for plugin/agent-office/dashboard/collect.py (run via unittest discover)."""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

_SRC = Path(__file__).resolve().parent.parent / "plugin" / "agent-office" / "dashboard" / "collect.py"
_spec = importlib.util.spec_from_file_location("collect", _SRC)
collect = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(collect)

REAL_HOME = "/opt/data"
FORBIDDEN = ("api_key", "sk-", "password", "BEGIN OPENSSH")


class ShortTests(unittest.TestCase):
    def test_collapses_whitespace(self):
        self.assertEqual(collect._short("  hello \n\t  world   foo "), "hello world foo")

    def test_strips_trailing_dots_and_ellipsis(self):
        self.assertEqual(collect._short("Done..."), "Done")
        self.assertEqual(collect._short("Working…"), "Working")
        self.assertEqual(collect._short("wait . . ."), "wait")

    def test_keeps_inner_punctuation(self):
        self.assertEqual(collect._short("v1.2 release"), "v1.2 release")

    def test_none_and_empty(self):
        self.assertEqual(collect._short(None), "")
        self.assertEqual(collect._short(""), "")

    def test_within_limit_unchanged(self):
        self.assertEqual(collect._short("exact", 5), "exact")

    def test_truncates_to_n_with_ellipsis(self):
        out = collect._short("a" * 60, 48)
        self.assertEqual(len(out), 48)
        self.assertTrue(out.endswith("…"))

    def test_truncation_drops_trailing_space_before_ellipsis(self):
        # text[:9] == "abcdefgh " -> rstrip -> "abcdefgh" + "…"
        self.assertEqual(collect._short("abcdefgh ijk", 10), "abcdefgh…")


class ChipTests(unittest.TestCase):
    def test_known_families(self):
        cases = {
            "claude-opus-4": "Opus",
            "anthropic/claude-sonnet-4.5": "Sonnet",
            "claude-haiku-5-5": "Haiku",
            "gemini-2.5-flash": "Gemini Flash",
            "gemini-2.5-pro": "Gemini",
            "gpt-4o": "GPT",
            "llama-3-70b": "Llama",
            "qwen2.5-coder": "Qwen",
            "deepseek-chat": "DeepSeek",
        }
        for model, expected in cases.items():
            with self.subTest(model=model):
                self.assertEqual(collect.chip(model), expected)

    def test_case_insensitive(self):
        self.assertEqual(collect.chip("CLAUDE-OPUS-4"), "Opus")

    def test_unknown_model_returns_short_name(self):
        self.assertEqual(collect.chip("mistral-7b"), "mistral-7b")

    def test_unknown_long_model_is_truncated(self):
        out = collect.chip("mistral-large-latest-experimental")
        self.assertLessEqual(len(out), 16)
        self.assertTrue(out.endswith("…"))

    def test_empty_and_none(self):
        self.assertEqual(collect.chip(""), "")
        self.assertEqual(collect.chip(None), "")


class ActivityTextTests(unittest.TestCase):
    def test_running_tool_with_title(self):
        self.assertEqual(
            collect.activity_text("tool running: terminal", "PokeSurvivor"),
            "running commands · PokeSurvivor",
        )

    def test_started_tool_uses_verb_table(self):
        self.assertEqual(collect.activity_text("tool started: web_search", None), "researching")

    def test_completed_tool_reads_as_thinking(self):
        self.assertEqual(collect.activity_text("tool completed: read_file", None), "thinking")

    def test_unknown_tool_name_is_humanised(self):
        self.assertEqual(collect.activity_text("tool running: my_custom_tool", None), "using my custom tool")

    def test_streaming_and_thinking(self):
        self.assertEqual(collect.activity_text("streaming response", None), "thinking")
        self.assertEqual(collect.activity_text("model thinking", None), "thinking")

    def test_approval_and_waiting(self):
        self.assertEqual(collect.activity_text("waiting for approval", None), "waiting for approval")

    def test_default_is_working(self):
        self.assertEqual(collect.activity_text(None, None), "working")
        self.assertEqual(collect.activity_text("", ""), "working")

    def test_subagent_prefix_stripped_from_title(self):
        self.assertEqual(collect.activity_text("", "Subagent: Research X"), "working · Research X")

    def test_title_truncated_to_40(self):
        out = collect.activity_text("", "t" * 80)
        self.assertEqual(out, "working · " + "t" * 39 + "…")


class DiscoverTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def _touch(self, rel):
        p = self.root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b"")
        return p

    def test_empty_root(self):
        self.assertEqual(collect.discover(self.root), [])

    def test_root_state_db_is_default_profile(self):
        self._touch("state.db")
        self.assertEqual(collect.discover(self.root), [{"id": "default", "home": self.root}])

    def test_profiles_with_state_db_only(self):
        self._touch("state.db")
        self._touch("profiles/alpha/state.db")
        (self.root / "profiles" / "beta").mkdir(parents=True)  # no state.db -> skipped
        self._touch("profiles/file.txt")  # not a directory -> skipped
        self._touch("profiles/gamma/state.db")
        found = collect.discover(self.root)
        self.assertEqual([p["id"] for p in found], ["default", "alpha", "gamma"])
        self.assertEqual(found[1]["home"], self.root / "profiles" / "alpha")

    def test_profiles_without_root_state_db(self):
        self._touch("profiles/only/state.db")
        self.assertEqual([p["id"] for p in collect.discover(self.root)], ["only"])

    def test_root_home_from_profile_path(self):
        profile = self.root / "profiles" / "dev"
        self.assertEqual(collect.root_home(str(profile)), self.root)
        self.assertEqual(collect.root_home(str(self.root)), self.root)


class SnapshotTests(unittest.TestCase):
    def test_real_home_snapshot_shape_and_no_secrets(self):
        snap = collect.snapshot(home=REAL_HOME)
        self.assertIsInstance(snap, dict)
        for key in ("ts", "agents", "brain", "runsOn", "counts"):
            self.assertIn(key, snap)
        self.assertIsInstance(snap["agents"], list)
        self.assertEqual(snap["counts"]["agents"], len(snap["agents"]))
        for agent in snap["agents"]:
            blob = json.dumps(agent, ensure_ascii=False)
            for bad in FORBIDDEN:
                with self.subTest(agent=agent.get("id"), forbidden=bad):
                    self.assertNotIn(bad, blob)


if __name__ == "__main__":
    unittest.main()
