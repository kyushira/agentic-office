"""Tests for the office-build shell scripts: guard-upstream.sh and start-office-server.sh.

guard-upstream.sh is only ever run against a temp copy of Claude-Office's scripts/start-office.sh (or a
synthetic one). CLAUDE_OFFICE_DIR is always pointed at the temp dir, so the real upstream checkout is never
written. start-office-server.sh is only syntax-checked: it starts and stops processes, so it is never run here.
"""
import hashlib
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

BUILD = Path(__file__).resolve().parent.parent / "plugin" / "agent-office" / "office-build"
GUARD = BUILD / "guard-upstream.sh"
SERVER = BUILD / "start-office-server.sh"
UPSTREAM = Path("/opt/data/projects/Claude-Office/scripts/start-office.sh")

ANCHOR = 'spawn bash "$PROJECT_DIR/scripts/chat-ai-watcher.sh" >> "$CHAT_AI_LOG" 2>&1'
MARKER = "# agent-office guard: chat AI watcher is opt-in"
SYNTHETIC = "\n".join([
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'PROJECT_DIR="/x"; CHAT_AI_LOG="/y"',
    "echo one",
    ANCHOR,
    "echo two",
    "",
]) + "\n"


def _tmp_dir():
    # mktemp -d under $TMPDIR, per the runtime rule (scratch lives under TMPDIR, not the system temp dir)
    base = os.environ.get("TMPDIR") or None
    return tempfile.mkdtemp(prefix="guard-test-", dir=base)


def _run(args, office_dir):
    env = dict(os.environ, CLAUDE_OFFICE_DIR=str(office_dir))
    return subprocess.run(["bash", str(GUARD), *args], env=env, capture_output=True, text=True, timeout=30)


def _sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


class GuardTestBase(unittest.TestCase):
    def setUp(self):
        self.root = Path(_tmp_dir())
        self.addCleanup(shutil.rmtree, self.root, True)
        self.office = self.root / "office"
        (self.office / "scripts").mkdir(parents=True)
        self.target = self.office / "scripts" / "start-office.sh"

    def write_target(self, text):
        self.target.write_text(text, encoding="utf-8")


class GuardSyntheticTests(GuardTestBase):
    def test_guard_applies_once_and_second_run_is_idempotent(self):
        self.write_target(SYNTHETIC)
        first = _run([], self.office)
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertIn("guarded:", first.stdout)
        guarded = self.target.read_text(encoding="utf-8")
        self.assertEqual(guarded.count(MARKER), 1)
        self.assertEqual(guarded.count(ANCHOR), 1)
        self.assertIn('if [ "${AGENT_OFFICE_CHAT_AI:-0}" = "1" ]; then\n' + ANCHOR + "\nfi\n", guarded)
        self.assertIn("echo one\n", guarded)
        self.assertIn("echo two\n", guarded)

        before = _sha(self.target)
        second = _run([], self.office)
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertIn("already guarded", second.stdout)
        self.assertEqual(_sha(self.target), before, "second run must not write")

    def test_check_before_and_after(self):
        self.write_target(SYNTHETIC)
        before = _sha(self.target)
        check = _run(["--check"], self.office)
        self.assertEqual(check.returncode, 1)
        self.assertIn("not guarded", check.stdout)
        self.assertEqual(_sha(self.target), before, "--check must not write")

        self.assertEqual(_run([], self.office).returncode, 0)
        after = _run(["--check"], self.office)
        self.assertEqual(after.returncode, 0)
        self.assertIn("guarded", after.stdout)

    def test_missing_anchor_fails_loudly_and_writes_nothing(self):
        text = SYNTHETIC.replace(ANCHOR, "echo the watcher was removed upstream")
        self.write_target(text)
        before = _sha(self.target)
        result = _run([], self.office)
        self.assertEqual(result.returncode, 2)
        self.assertIn("anchor line found 0 times", result.stderr)
        self.assertEqual(_sha(self.target), before)
        self.assertEqual(sorted(p.name for p in self.target.parent.iterdir()), ["start-office.sh"],
                         "no temp file left behind")

    def test_duplicated_anchor_fails_loudly_and_writes_nothing(self):
        self.write_target(SYNTHETIC + ANCHOR + "\n")
        before = _sha(self.target)
        result = _run([], self.office)
        self.assertEqual(result.returncode, 2)
        self.assertIn("anchor line found 2 times", result.stderr)
        self.assertEqual(_sha(self.target), before)

    def test_check_on_missing_file_exits_nonzero(self):
        result = _run(["--check"], self.root / "nowhere")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("not found", result.stderr)

    def test_unknown_argument_is_usage_error(self):
        self.write_target(SYNTHETIC)
        result = _run(["--bogus"], self.office)
        self.assertEqual(result.returncode, 64)
        self.assertNotIn(MARKER, self.target.read_text(encoding="utf-8"))

    def test_guard_keeps_file_mode(self):
        self.write_target(SYNTHETIC)
        os.chmod(self.target, 0o755)
        self.assertEqual(_run([], self.office).returncode, 0)
        self.assertEqual(self.target.stat().st_mode & 0o777, 0o755)


@unittest.skipUnless(UPSTREAM.exists(), "upstream Claude-Office checkout not present")
class GuardUpstreamCopyTests(GuardTestBase):
    """The real upstream file, copied into a temp dir. The checkout itself is never touched."""

    def setUp(self):
        super().setUp()
        shutil.copy2(UPSTREAM, self.target)
        self.upstream_before = _sha(UPSTREAM)

    def test_real_copy_is_guarded_once_and_still_parses(self):
        self.assertEqual(_run(["--check"], self.office).returncode, 1)
        self.assertEqual(_run([], self.office).returncode, 0)
        self.assertEqual(_run(["--check"], self.office).returncode, 0)
        before = _sha(self.target)
        self.assertEqual(_run([], self.office).returncode, 0)
        self.assertEqual(_sha(self.target), before)
        self.assertEqual(subprocess.run(["bash", "-n", str(self.target)], capture_output=True).returncode, 0)
        self.assertEqual(_sha(UPSTREAM), self.upstream_before, "the real checkout must not change")


class ScriptSyntaxTests(unittest.TestCase):
    def test_both_scripts_pass_bash_n(self):
        for script in (GUARD, SERVER):
            with self.subTest(script=script.name):
                result = subprocess.run(["bash", "-n", str(script)], capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_server_script_calls_the_guard_before_starting_anything(self):
        text = SERVER.read_text(encoding="utf-8")
        guard_at = text.index("guard-upstream.sh")
        server_at = text.index("setsid env -i")  # the server launch (env -i scrub, see Sentinel fix 1)
        self.assertLess(guard_at, server_at)
        self.assertIn("AGENT_OFFICE_CHAT_AI", text)
        self.assertIn('"paused"', text)


if __name__ == "__main__":
    unittest.main()
