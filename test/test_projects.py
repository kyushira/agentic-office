"""Unit tests for projects.projects (the /projects payload): temp project trees and a real temp git repo.
Run via unittest discover."""
import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

_SRC = Path(__file__).resolve().parent.parent / "plugin" / "agent-office" / "dashboard" / "projects.py"
_spec = importlib.util.spec_from_file_location("projects", _SRC)
projects = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(projects)

DAY = 86400.0
NOW = 1_800_000_000.0


def _dir(path: Path, mtime: float) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    os.utime(path, (mtime, mtime))
    return path


def _file(path: Path, mtime: float, text: str = "x") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    os.utime(path, (mtime, mtime))
    return path


def _git(cwd: Path, *args: str, date: str | None = None) -> None:
    env = dict(os.environ)
    if date:
        env["GIT_AUTHOR_DATE"] = env["GIT_COMMITTER_DATE"] = date
    subprocess.run(["git", "-c", "user.name=test", "-c", "user.email=test@example.invalid", *args],
                   cwd=cwd, check=True, capture_output=True, env=env)


class ProjectsTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name) / "projects"
        self.root.mkdir()

    def tearDown(self):
        self._tmp.cleanup()

    def by_name(self, res):
        return {p["name"]: p for p in res["projects"]}

    def test_status_thresholds(self):
        _dir(self.root / "fresh", NOW - 1 * DAY)
        _dir(self.root / "edge3", NOW - 3 * DAY)      # exactly 3 days: quiet (active is strictly under 3)
        _dir(self.root / "mid", NOW - 5 * DAY)
        _dir(self.root / "edge7", NOW - 7 * DAY)      # exactly 7 days: still quiet
        _dir(self.root / "old", NOW - 8 * DAY)
        got = self.by_name(projects.projects(self.root, now=NOW))
        self.assertEqual({n: p["status"] for n, p in got.items()},
                         {"fresh": "active", "edge3": "quiet", "mid": "quiet", "edge7": "quiet", "old": "stale"})
        self.assertEqual(got["old"]["last_source"], "dir")
        self.assertEqual(got["old"]["last_activity"], NOW - 8 * DAY)
        self.assertFalse(got["old"]["git"])
        self.assertIsNone(got["old"]["last_commit"])

    def test_skip_rules(self):
        _dir(self.root / "plain", NOW)
        for name in ("_briefs", "_research", ".cache", "worktrees", "agent-wt"):
            _dir(self.root / name, NOW)
        _file(self.root / "projects.json", NOW, json.dumps({"projects": {}}))
        _file(self.root / "loose.txt", NOW)
        res = projects.projects(self.root, now=NOW)
        self.assertEqual([p["name"] for p in res["projects"]], ["plain"])
        self.assertTrue(res["registry"])

    def test_missing_root_is_empty(self):
        res = projects.projects(self.root / "nope", now=NOW)
        self.assertEqual(res["projects"], [])
        self.assertFalse(res["registry"])
        self.assertIsNone(res["error"])
        self.assertEqual(res["now"], NOW)

    def test_brief_discovery_filters_suffixes_and_sorts_newest_first(self):
        proj = _dir(self.root / "alpha", NOW - 10 * DAY)
        briefs = self.root / "_briefs"
        _file(briefs / "alpha" / "a.md", NOW - 4 * DAY)
        _file(briefs / "alpha" / "b.txt", NOW - 2 * DAY)
        _file(briefs / "alpha" / "d.json", NOW - 3 * DAY)
        _file(briefs / "alpha" / "c.png", NOW - 1 * DAY)     # wrong suffix: ignored
        _file(briefs / "alpha-plan.md", NOW - 1 * DAY)        # top-level match: newest
        _file(briefs / "beta.md", NOW - 1 * DAY)              # other project: ignored
        got = self.by_name(projects.projects(self.root, now=NOW))["alpha"]
        self.assertEqual([b["name"] for b in got["briefs"]], ["alpha-plan.md", "b.txt", "d.json", "a.md"])
        self.assertEqual(got["last_source"], "brief")
        self.assertEqual(got["last_activity"], NOW - 1 * DAY)
        self.assertEqual(got["status"], "active")
        self.assertTrue(proj.is_dir())

    def test_brief_list_capped_at_eight(self):
        self.assertEqual(projects.BRIEF_CAP, 8)
        _dir(self.root / "gamma", NOW - 30 * DAY)
        for i in range(10):
            _file(self.root / "_briefs" / "gamma" / f"n{i:02d}.md", NOW - 2 * DAY - i * 60)
        briefs = self.by_name(projects.projects(self.root, now=NOW))["gamma"]["briefs"]
        self.assertEqual(len(briefs), 8)
        self.assertEqual(briefs[0]["name"], "n00.md")
        self.assertEqual(briefs[-1]["name"], "n07.md")

    def test_git_last_commit_branch_status_and_redaction(self):
        repo = _dir(self.root / "repo", NOW - 30 * DAY)
        subprocess.run(["git", "init", "-q", str(repo)], check=True, capture_output=True)
        _git(repo, "symbolic-ref", "HEAD", "refs/heads/main")
        _file(repo / "f.txt", NOW, "hi")
        _git(repo, "add", "f.txt")
        commit_dt = datetime(2026, 10, 1, 12, 0, tzinfo=timezone.utc)
        commit_ts = int(commit_dt.timestamp())
        # words, not one long run: a 33+ character run of letters is itself redacted as base64
        long_subject = "Add sk-ABCDEF1234567890ABCDEF1234 key " + " ".join(["word"] * 30)
        _git(repo, "commit", "-q", "-m", long_subject, date=commit_dt.strftime("%Y-%m-%dT%H:%M:%S+0000"))

        res = projects.projects(self.root, now=commit_ts + 10 * DAY)
        got = self.by_name(res)["repo"]
        self.assertTrue(got["git"])
        self.assertEqual(got["last_source"], "git")
        self.assertEqual(got["last_activity"], commit_ts)
        self.assertEqual(got["status"], "stale")
        lc = got["last_commit"]
        self.assertEqual(lc["ts"], commit_ts)
        self.assertEqual(lc["branch"], "main")
        self.assertLessEqual(len(lc["subject"]), 80)
        self.assertTrue(lc["subject"].endswith("…"))
        self.assertNotIn("sk-ABCDEF", lc["subject"])
        self.assertIn("[redacted]", lc["subject"])

    def test_non_git_dir_has_no_commit(self):
        _dir(self.root / "plain", NOW)
        got = self.by_name(projects.projects(self.root, now=NOW))["plain"]
        self.assertFalse(got["git"])
        self.assertIsNone(got["last_commit"])

    def test_git_timeout_is_not_a_crash(self):
        repo = _dir(self.root / "slow", NOW)
        (repo / ".git").mkdir()     # looks like a repo, so git runs
        calls = []

        def boom(args, **kwargs):
            calls.append((args, kwargs))
            raise subprocess.TimeoutExpired(args, kwargs.get("timeout"))

        with mock.patch.object(projects.subprocess, "run", side_effect=boom):
            got = self.by_name(projects.projects(self.root, now=NOW))["slow"]
        self.assertTrue(got["git"])
        self.assertIsNone(got["last_commit"])
        self.assertEqual(got["last_source"], "dir")
        args, kwargs = calls[0]
        self.assertIsInstance(args, list)
        self.assertEqual(args[0], "git")
        self.assertEqual(kwargs.get("timeout"), 3)
        self.assertFalse(kwargs.get("shell", False))

    def test_registry_present_sets_owner_and_next_only_for_listed_projects(self):
        _dir(self.root / "alpha", NOW)
        _dir(self.root / "beta", NOW)
        _file(self.root / "projects.json", NOW, json.dumps({"projects": {
            "alpha": {"owner": "dev", "next": "Ship the thing", "source": "_briefs/x.md"},
            "ghost": {"owner": "nobody", "next": "nothing"},
        }}))
        res = projects.projects(self.root, now=NOW)
        self.assertTrue(res["registry"])
        self.assertIsNone(res["error"])
        got = self.by_name(res)
        self.assertEqual((got["alpha"]["owner"], got["alpha"]["next"]), ("dev", "Ship the thing"))
        self.assertEqual((got["beta"]["owner"], got["beta"]["next"]), (None, None))
        self.assertNotIn("ghost", got)

    def test_registry_strings_are_redacted_and_blank_means_not_set(self):
        _dir(self.root / "alpha", NOW)
        _file(self.root / "projects.json", NOW, json.dumps({"projects": {
            "alpha": {"owner": "ghp_" + "a" * 36, "next": "   "},
        }}))
        got = self.by_name(projects.projects(self.root, now=NOW))["alpha"]
        self.assertIn("[redacted]", got["owner"])
        self.assertNotIn("ghp_", got["owner"])
        self.assertIsNone(got["next"])

    def test_registry_absent(self):
        _dir(self.root / "alpha", NOW)
        res = projects.projects(self.root, now=NOW)
        self.assertFalse(res["registry"])
        self.assertIsNone(res["error"])
        self.assertIsNone(res["projects"][0]["owner"])
        self.assertIsNone(res["projects"][0]["next"])

    def test_registry_malformed_never_crashes(self):
        _dir(self.root / "alpha", NOW)
        for bad in ("{not json", "[]", '{"projects": []}', '{"projects": "x"}'):
            _file(self.root / "projects.json", NOW, bad)
            res = projects.projects(self.root, now=NOW)
            self.assertFalse(res["registry"], bad)
            self.assertIsInstance(res["error"], str, bad)
            self.assertTrue(res["error"], bad)
            self.assertIsNone(res["projects"][0]["owner"], bad)
            self.assertIsNone(res["projects"][0]["next"], bad)


if __name__ == "__main__":
    unittest.main()
