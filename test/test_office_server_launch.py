"""Sentinel fixes 1 and 4: start-office-server.sh runs node with a scrubbed environment and a checked server.pid,
and the s6 service definition exists and is executable.

The launcher is run for real, against a temp checkout and a stub `node` (AGENT_OFFICE_NODE_BIN). The stub records
its own pid and environment, then sleeps; the test kills its process group in tearDown. The real Claude-Office
checkout and the real node are never used. guard-upstream.sh runs on a synthetic scripts/start-office.sh in the temp
checkout only.
"""
import os
import signal
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
BUILD = REPO / "plugin" / "agent-office" / "office-build"
SERVER = BUILD / "start-office-server.sh"
INSTALL = BUILD / "install-office-service.sh"
S6 = BUILD / "s6" / "agent-office-server"

UPSTREAM_START = "\n".join([
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'PROJECT_DIR="/x"; CHAT_AI_LOG="/y"',
    'spawn bash "$PROJECT_DIR/scripts/chat-ai-watcher.sh" >> "$CHAT_AI_LOG" 2>&1',
    "",
])

SECRETS = {
    "ADMIN_PASSWORD": "hunter2-admin",
    "DASHBOARD_AUTH_SECRET": "dash-secret-value",
    "HERMES_FOO": "hermes-foo-value",
}


class LaunchTestBase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR"))
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        self.checkout = self.root / "Claude-Office"
        (self.checkout / "scripts").mkdir(parents=True)
        (self.checkout / "server").mkdir()
        (self.checkout / "server" / "index.js").write_text("// stub server\n")
        (self.checkout / "scripts" / "start-office.sh").write_text(UPSTREAM_START)
        self.runtime = self.root / "runtime"
        self.stub_env = self.root / "stub.env"
        self.stub_pid = self.root / "stub.pid"
        self.stub = self.root / "bin" / "node"
        self.stub.parent.mkdir()
        self.stub.write_text(
            "#!/bin/sh\n"
            f"echo $$ > '{self.stub_pid}'\n"
            f"env > '{self.stub_env}'\n"
            "sleep 30\n"
        )
        self.stub.chmod(0o755)
        self.port = "34987"
        self.started = []
        self.addCleanup(self._kill_started)

    def _kill_started(self):
        for pid in self.started:
            try:
                os.killpg(pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass

    def _env(self, **extra):
        env = dict(os.environ)
        env.update(SECRETS)
        env.update({
            "CLAUDE_OFFICE_DIR": str(self.checkout),
            "AGENT_OFFICE_HOME": str(self.runtime),
            "AGENT_OFFICE_NODE_BIN": str(self.stub),
            "AGENT_OFFICE_PORT": self.port,
            "AGENT_OFFICE_START_TRIES": "4",
            "AGENT_OFFICE_TEAM_POLL": "0",
            "AGENT_OFFICE_TEST_MARK": "1",
        })
        env.pop("AGENT_OFFICE_FOREGROUND", None)
        env.pop("AGENT_OFFICE_CHAT_AI", None)
        env.update(extra)
        return env

    def _run_server(self, args=(), **extra):
        proc = subprocess.run(["bash", str(SERVER), *args], env=self._env(**extra),
                              capture_output=True, text=True, timeout=90)
        return proc

    def _wait_for(self, path: Path, timeout=10.0):
        end = time.time() + timeout
        while time.time() < end:
            if path.exists() and path.read_text().strip():
                return path.read_text()
            time.sleep(0.1)
        self.fail(f"{path} never appeared")

    def _alive(self, pid: int) -> bool:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
        try:
            state = Path(f"/proc/{pid}/stat").read_text().split(")")[-1].split()[0]
            return state != "Z"  # a zombie is not running
        except OSError:
            return False

    def _remember(self, pid: int):
        self.started.append(pid)


class EnvScrubTest(LaunchTestBase):
    def _child_env(self):
        text = self._wait_for(self.stub_env)
        env = {}
        for line in text.splitlines():
            if "=" in line:
                key, _, value = line.partition("=")
                env[key] = value
        return env

    def test_secrets_not_inherited_and_allowed_vars_passed(self):
        proc = self._run_server()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        pid = int(self._wait_for(self.stub_pid))
        self._remember(pid)
        child = self._child_env()
        for name, value in SECRETS.items():
            self.assertNotIn(name, child, f"{name} reached the server")
            self.assertNotIn(value, child.values(), f"{name}'s value reached the server")
        self.assertIn("PATH", child)
        self.assertIn("HOME", child)
        self.assertEqual(child.get("AGENT_OFFICE_HOME"), str(self.runtime))
        self.assertEqual(child.get("AGENT_OFFICE_TEST_MARK"), "1")
        self.assertEqual(child.get("AGENT_OFFICE_PORT"), self.port)
        self.assertIn("AGENT_OFFICE_ALLOWED_HOSTS", child)
        # Nothing outside the allowed set: only PATH, HOME, LANG, AGENT_OFFICE_* and the shell's own bookkeeping.
        allowed_plain = {"PATH", "HOME", "LANG", "PWD", "SHLVL", "OLDPWD", "_"}
        extra = [k for k in child if k not in allowed_plain and not k.startswith("AGENT_OFFICE_")]
        self.assertEqual(extra, [], f"unexpected environment variables in the server: {extra}")

    def test_server_pid_file_is_the_child_pid(self):
        proc = self._run_server()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        child_pid = int(self._wait_for(self.stub_pid))
        self._remember(child_pid)
        self.assertEqual(int((self.runtime / "server.pid").read_text().strip()), child_pid)
        self.assertTrue(self._alive(child_pid))

    def test_restart_stops_the_old_server_and_records_the_new_pid(self):
        self.assertEqual(self._run_server().returncode, 0)
        first = int(self._wait_for(self.stub_pid))
        self._remember(first)
        self.stub_pid.unlink()
        self.assertEqual(self._run_server().returncode, 0)
        second = int(self._wait_for(self.stub_pid))
        self._remember(second)
        self.assertNotEqual(first, second)
        self.assertFalse(self._alive(first), "the old office server was not stopped")
        self.assertEqual(int((self.runtime / "server.pid").read_text().strip()), second)

    def test_unrelated_pid_in_pid_file_is_never_signalled(self):
        bystander = subprocess.Popen(["sleep", "60"])
        self.addCleanup(bystander.kill)
        self.runtime.mkdir(parents=True)
        (self.runtime / "server.pid").write_text(str(bystander.pid) + "\n")
        proc = self._run_server()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self._remember(int(self._wait_for(self.stub_pid)))
        self.assertIsNone(bystander.poll(), "a process that is not the office server was signalled")
        self.assertIn("not an office server", proc.stderr)

    def test_foreground_mode_execs_node_with_the_same_scrub(self):
        proc = subprocess.Popen(["bash", str(SERVER), "--foreground"], env=self._env(),
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                start_new_session=True)
        self._remember(proc.pid)
        try:
            child_pid = int(self._wait_for(self.stub_pid))
            self.assertEqual(child_pid, proc.pid, "foreground mode must exec node, not fork it")
            self.assertEqual(int((self.runtime / "server.pid").read_text().strip()), proc.pid)
            child = self._child_env()
            for name in SECRETS:
                self.assertNotIn(name, child)
            self.assertEqual(child.get("AGENT_OFFICE_TEST_MARK"), "1")
        finally:
            proc.kill()
            proc.wait(timeout=10)

    def test_foreground_env_var_matches_flag(self):
        proc = subprocess.Popen(["bash", str(SERVER)], env=self._env(AGENT_OFFICE_FOREGROUND="1"),
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                start_new_session=True)
        self._remember(proc.pid)
        try:
            self.assertEqual(int(self._wait_for(self.stub_pid)), proc.pid)
        finally:
            proc.kill()
            proc.wait(timeout=10)

    def test_guard_failure_starts_nothing(self):
        (self.checkout / "scripts" / "start-office.sh").write_text("#!/bin/bash\necho unrelated\n")
        proc = self._run_server()
        self.assertNotEqual(proc.returncode, 0)
        self.assertFalse(self.stub_pid.exists())
        self.assertFalse((self.runtime / "server.pid").exists())


class S6ServiceTest(unittest.TestCase):
    def test_run_script_exists_is_executable_and_uses_foreground(self):
        run = S6 / "run"
        self.assertTrue(run.is_file())
        self.assertTrue(os.access(run, os.X_OK), "s6 run script is not executable")
        text = run.read_text()
        exec_lines = [line for line in text.splitlines() if line.lstrip().startswith("exec ")]
        self.assertTrue(any("start-office-server.sh" in line and "--foreground" in line for line in exec_lines),
                        "run script must exec start-office-server.sh --foreground")
        self.assertIn("s6-setuidgid hermes", text)
        self.assertIn("exec", text)

    def test_finish_and_type_present(self):
        self.assertTrue(os.access(S6 / "finish", os.X_OK))
        self.assertEqual((S6 / "type").read_text().strip(), "longrun")

    def test_run_script_mode_in_git_index(self):
        try:
            out = subprocess.run(["git", "-C", str(REPO), "ls-files", "-s", "--", str(S6 / "run")],
                                 capture_output=True, text=True, timeout=30)
        except (OSError, subprocess.SubprocessError):
            self.skipTest("git not available")
        if out.returncode != 0 or not out.stdout.strip():
            self.skipTest("not a git checkout")
        self.assertTrue(out.stdout.startswith("100755 "), out.stdout)

    def test_install_script_is_valid_bash(self):
        proc = subprocess.run(["bash", "-n", str(INSTALL)], capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("s6-svscanctl -a", INSTALL.read_text())
        self.assertIn("@OFFICE_BUILD_DIR@", (S6 / "run").read_text())


if __name__ == "__main__":
    unittest.main()
