"""Tests for plugin/agent-office/dashboard/office_team.py: the Hermes team as Claude Office characters.

Pure state derivation and event planning use fake timestamps. The poller tests use temp state.db files
and an injected post function, so nothing reaches a real office server. The HTTP test talks only to a
localhost server it starts itself. Run via unittest discover (see package.json).
"""
import http.server
import importlib.util
import json
import os
import sqlite3
import tempfile
import threading
import time
import unittest
from pathlib import Path

_DASH = Path(__file__).resolve().parent.parent / "plugin" / "agent-office" / "dashboard"
_spec = importlib.util.spec_from_file_location("office_team_under_test", _DASH / "office_team.py")
ot = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ot)

NOW = 1_800_000_000.0
TOKEN = "test-token-not-real"
DEV = next(m for m in ot.TEAM if m["profile"] == "dev")
ASH = next(m for m in ot.TEAM if m["profile"] == "default")


def _kinds(events):
    return [e["type"] for e in events]


def _of(events, agent_id):
    """Only one member's events (the whole team is always posted now)."""
    return [e for e in events if (e.get("agentId") or e.get("agent", {}).get("id")) == agent_id]


class ClassifyTests(unittest.TestCase):
    def test_no_database_row_is_gone(self):
        self.assertEqual(ot.classify(None, NOW), (ot.GONE, None, None))

    def test_fresh_assistant_text_is_working_thinking(self):
        self.assertEqual(ot.classify((NOW - 5, "assistant", None, False), NOW), (ot.WORKING, "thinking", None))

    def test_fresh_tool_result_is_working_with_verb_and_tool_name(self):
        self.assertEqual(ot.classify((NOW - 5, "tool", "terminal", False), NOW),
                         (ot.WORKING, "running commands", "terminal"))

    def test_unknown_tool_gets_a_generic_phrase(self):
        self.assertEqual(ot.status_text("tool", "frob_widget"), "using frob widget")

    def test_working_boundary_is_inclusive_at_90_seconds(self):
        self.assertEqual(ot.classify((NOW - 90, "assistant", None, False), NOW)[0], ot.WORKING)

    def test_idle_just_past_working_window(self):
        self.assertEqual(ot.classify((NOW - 91, "assistant", None, False), NOW), (ot.IDLE, None, None))

    def test_pending_tool_call_keeps_working_up_to_15_minutes(self):
        self.assertEqual(ot.classify((NOW - 600, "assistant", None, True), NOW)[0], ot.WORKING)
        self.assertEqual(ot.classify((NOW - 901, "assistant", None, True), NOW)[0], ot.GONE)

    def test_gone_after_15_minutes_without_activity(self):
        self.assertEqual(ot.classify((NOW - 899, "assistant", None, False), NOW)[0], ot.IDLE)
        self.assertEqual(ot.classify((NOW - 901, "assistant", None, False), NOW), (ot.GONE, None, None))

    def test_future_timestamp_counts_as_working(self):
        # clock skew between a profile's writes and this process should not read as gone
        self.assertEqual(ot.classify((NOW + 3, "user", None, False), NOW)[0], ot.WORKING)


class StartupTests(unittest.TestCase):
    def test_idle_or_gone_agent_at_startup_is_not_posted(self):
        self.assertEqual(ot.plan(DEV, {}, ot.IDLE, None, None, NOW), [])
        self.assertEqual(ot.plan(DEV, {}, ot.GONE, None, None, NOW), [])

    def test_working_agent_at_startup_is_spawned_then_marked_working(self):
        events = ot.plan(DEV, {}, ot.WORKING, "thinking", None, NOW)
        self.assertEqual(_kinds(events), ["agent_spawned", "agent_working"])


class PlanTests(unittest.TestCase):
    def test_spawn_carries_name_role_and_stable_id(self):
        spawn = ot.spawn_event(DEV)["agent"]
        self.assertEqual(spawn["id"], "hermes-dev")
        self.assertEqual(spawn["name"], "Dev")
        self.assertEqual(spawn["role"], "debugger")

    def test_team_roles_are_claude_office_sprite_keys(self):
        # role picks the sprite (Claude-Office src/config.ts ROLE_TO_CHAR), so each member looks different
        titles = {m["name"]: m["role"] for m in ot.TEAM}
        self.assertEqual(titles["Ash"], "Chief of Staff")
        self.assertEqual(titles["Dev"], "debugger")
        self.assertEqual(titles["Red"], "Explore")
        self.assertEqual(titles["Nova"], "architect-reviewer")
        self.assertEqual(titles["Pixel"], "test-engineer")
        self.assertEqual(titles["Prism"], "frontend-developer")
        self.assertEqual(titles["Sentinel"], "security-auditor")
        self.assertEqual(len(set(titles.values())), 7)
        self.assertEqual(len(ot.TEAM), 7)
        self.assertEqual(len({m["id"] for m in ot.TEAM}), 7)

    def test_working_event_names_the_agent_and_tool(self):
        ev = ot.working_event(DEV, "running commands", "terminal")
        self.assertEqual(ev, {"type": "agent_working", "agentId": "hermes-dev", "status": "running commands",
                              "tool": "terminal"})

    def test_idle_present_agent_clocks_out_with_state_in_result(self):
        meta = {"present": True, "status": "thinking", "last_post": NOW}
        self.assertEqual(ot.plan(DEV, meta, ot.IDLE, None, None, NOW + 100),
                         [{"type": "agent_completed", "agentId": "hermes-dev", "result": "clocked out (idle)"}])

    def test_no_events_while_status_is_unchanged_and_fresh(self):
        meta = {"present": True, "status": "thinking", "last_post": NOW}
        self.assertEqual(ot.plan(DEV, meta, ot.WORKING, "thinking", None, NOW + 30), [])

    def test_status_change_posts_working_only_after_the_min_gap(self):
        meta = {"present": True, "status": "thinking", "last_post": NOW}
        self.assertEqual(ot.plan(DEV, meta, ot.WORKING, "running commands", "terminal", NOW + 5), [])
        self.assertEqual(_kinds(ot.plan(DEV, meta, ot.WORKING, "running commands", "terminal", NOW + 10)),
                         ["agent_working"])

    def test_keepalive_after_60_seconds_replays_spawn_then_working(self):
        meta = {"present": True, "status": "thinking", "last_post": NOW}
        events = ot.plan(DEV, meta, ot.WORKING, "thinking", None, NOW + 60)
        self.assertEqual(_kinds(events), ["agent_spawned", "agent_working"])

    def test_no_respawn_within_hold_after_clock_out(self):
        meta = {"present": False, "left_at": NOW}
        self.assertEqual(ot.plan(DEV, meta, ot.WORKING, "thinking", None, NOW + 5), [])
        self.assertEqual(_kinds(ot.plan(DEV, meta, ot.WORKING, "thinking", None, NOW + 16)),
                         ["agent_spawned", "agent_working"])

    def test_gone_and_absent_is_quiet(self):
        self.assertEqual(ot.plan(DEV, {"present": False}, ot.GONE, None, None, NOW), [])


class ApplyAckTests(unittest.TestCase):
    def test_acks_move_meta_and_do_not_mutate_input(self):
        meta = {}
        m1 = ot.apply_ack(meta, ot.spawn_event(DEV), NOW)
        m2 = ot.apply_ack(m1, ot.working_event(DEV, "thinking"), NOW + 1)
        m3 = ot.apply_ack(m2, ot.completed_event(DEV, ot.IDLE), NOW + 200)
        self.assertEqual(meta, {})
        self.assertTrue(m1["present"])
        self.assertEqual((m2["status"], m2["last_post"]), ("thinking", NOW + 1))
        self.assertFalse(m3["present"])
        self.assertEqual(m3["left_at"], NOW + 200)
        self.assertNotIn("status", m3)


class SigningTests(unittest.TestCase):
    def test_hmac_matches_rfc4231_test_case_2(self):
        # Pins the HMAC primitive itself: key "Jefe", data "what do ya want for nothing?"
        self.assertEqual(ot.hmac.new(b"Jefe", b"what do ya want for nothing?", ot.hashlib.sha256).hexdigest(),
                         "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843")

    def test_signature_matches_agent_tracker_sign_post(self):
        # Literal from hooks/agent-tracker.py's own manual HMAC (its _hmac_sha256_hex), same inputs
        body = b'{"type":"agent_completed","agentId":"hermes-dev","result":"clocked out (idle)"}'
        self.assertEqual(ot.sign(b"test-token".decode(), "/event", "1794358671000", body),
                         "d783dcd285792f2de9a6514eb6df644e7c469e8859f40d5b62e94a01e602bcfb")

    def test_build_request_signs_the_exact_body_and_keeps_token_out(self):
        url, headers, body = ot.build_request(ot.completed_event(DEV, ot.IDLE), TOKEN, 3334, 1794358671000)
        self.assertEqual(url, "http://127.0.0.1:3334/event")
        self.assertEqual(headers["x-office-timestamp"], "1794358671000")
        self.assertEqual(headers["x-office-signature"], ot.sign(TOKEN, "/event", "1794358671000", body))
        self.assertNotIn(TOKEN, json.dumps(headers))
        self.assertNotIn(TOKEN.encode(), body)
        self.assertEqual(json.loads(body)["type"], "agent_completed")


class ReadOnlyTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.db = self.root / "state.db"
        conn = sqlite3.connect(self.db)
        conn.execute("create table messages (id integer primary key autoincrement, role text, "
                     "tool_name text, tool_calls text, timestamp real)")
        conn.execute("insert into messages (role, timestamp) values ('assistant', ?)", (NOW - 10,))
        conn.commit()
        conn.close()

    def tearDown(self):
        self._tmp.cleanup()

    def test_opens_with_mode_ro_and_cannot_write(self):
        seen = []
        real_connect = ot.sqlite3.connect

        def spy(target, *a, **kw):
            seen.append((target, kw.get("uri")))
            return real_connect(target, *a, **kw)

        ot.sqlite3.connect = spy
        try:
            row = ot.read_row(self.root, NOW - 900)
        finally:
            ot.sqlite3.connect = real_connect
        self.assertEqual(row, (NOW - 10, "assistant", None, False))
        self.assertEqual(len(seen), 1)
        self.assertIn("mode=ro", seen[0][0])
        self.assertTrue(seen[0][1])
        # the same URI form refuses writes in this sqlite build
        ro = real_connect(f"file:{self.db}?mode=ro", uri=True)
        with self.assertRaises(sqlite3.OperationalError):
            ro.execute("insert into messages (role, timestamp) values ('user', 1)")
        ro.close()

    def test_assistant_with_tool_calls_is_pending_and_empty_list_is_not(self):
        conn = sqlite3.connect(self.db)
        conn.execute("insert into messages (role, tool_name, tool_calls, timestamp) values "
                     "('assistant', null, '[{\"id\":\"c1\"}]', ?)", (NOW - 5,))
        conn.commit()
        conn.close()
        self.assertEqual(ot.read_row(self.root, 0)[3], True)
        conn = sqlite3.connect(self.db)
        conn.execute("insert into messages (role, tool_name, tool_calls, timestamp) values "
                     "('assistant', null, '[]', ?)", (NOW - 1,))
        conn.commit()
        conn.close()
        self.assertEqual(ot.read_row(self.root, 0)[3], False)

    def test_missing_database_is_none_and_not_created(self):
        missing = self.root / "nope"
        self.assertIsNone(ot.read_row(missing, 0))
        self.assertFalse((missing / "state.db").exists())


class PollerTests(unittest.TestCase):
    """Real temp state.db files, an injected post, a fixed clock."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.token = self.root / "auth-token"
        self.token.write_text(TOKEN + "\n", encoding="utf-8")
        self.sent = []
        self.accept = True

    def tearDown(self):
        self._tmp.cleanup()

    def _post(self, event, token, now):
        self.sent.append(event)
        return self.accept

    def _db(self, home, rows):
        home.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(home / "state.db")
        conn.execute("create table if not exists messages (id integer primary key autoincrement, role text, "
                     "tool_name text, tool_calls text, timestamp real)")
        for role, tool, ts in rows:
            conn.execute("insert into messages (role, tool_name, timestamp) values (?, ?, ?)", (role, tool, ts))
        conn.commit()
        conn.close()

    def _poller(self):
        return ot.Poller(self.root, self.token, 3334, post=self._post)

    def test_startup_with_quiet_profiles_puts_whole_team_at_their_desks(self):
        # Sir 2026-11-13: the whole team is always in the office, idle or gone included
        self._db(self.root, [("assistant", None, NOW - 3000)])
        self._db(self.root / "profiles" / "dev", [("assistant", None, NOW - 600)])
        p = self._poller()
        p.tick(NOW)
        spawned = [e["agent"]["id"] for e in self.sent if e["type"] == "agent_spawned"]
        self.assertEqual(spawned, [m["id"] for m in ot.TEAM])
        working = [e for e in self.sent if e["type"] == "agent_working"]
        self.assertEqual(len(working), len(ot.TEAM))
        self.assertTrue(all(e["status"] == "at their desk" and e.get("tool") is None for e in working))
        self.assertNotIn("agent_completed", _kinds(self.sent))

    def test_quiet_team_never_clocks_out(self):
        self._db(self.root / "profiles" / "dev", [("assistant", None, NOW - 600)])
        p = self._poller()
        for t in (NOW, NOW + 61, NOW + 2000, NOW + 5000):
            p.tick(t)
        self.assertNotIn("agent_completed", _kinds(self.sent))

    def test_fresh_activity_spawns_that_agent_then_keepalive_then_at_desk(self):
        self._db(self.root, [("assistant", None, NOW - 3000)])
        self._db(self.root / "profiles" / "dev", [("tool", "terminal", NOW - 4)])
        p = self._poller()
        p.tick(NOW)
        dev = _of(self.sent, "hermes-dev")
        self.assertEqual(_kinds(dev), ["agent_spawned", "agent_working"])
        self.assertEqual(dev[1]["status"], "running commands")
        self.assertEqual(dev[1]["tool"], "terminal")
        ash = _of(self.sent, "hermes-ash")  # quiet for 50 min, still placed at the desk
        self.assertEqual([(e["type"], e.get("status")) for e in ash],
                         [("agent_spawned", None), ("agent_working", "at their desk")])

        self.sent.clear()
        p.tick(NOW + 5)  # nothing changed, inside the keepalive window
        self.assertEqual(self.sent, [])

        self.sent.clear()
        p.tick(NOW + 61)  # 65 s since dev's last row: still working, and 60 s since the last post, so keepalive
        self.assertEqual(_kinds(_of(self.sent, "hermes-dev")), ["agent_spawned", "agent_working"])

        self.sent.clear()
        p.tick(NOW + 95)  # 99 s since the last row: past the working window, so dev stays at the desk
        dev = _of(self.sent, "hermes-dev")
        self.assertEqual([(e["type"], e["status"]) for e in dev], [("agent_working", "at their desk")])
        self.assertNotIn("agent_completed", _kinds(self.sent))

    def test_keepalive_resends_while_working(self):
        self._db(self.root / "profiles" / "dev", [("assistant", None, NOW)])
        p = self._poller()
        p.tick(NOW)
        self.sent.clear()
        # a tool call lands right before each tick, so dev stays working across the minute
        self._db(self.root / "profiles" / "dev", [("assistant", None, NOW), ("tool", "patch", NOW + 60)])
        p.tick(NOW + 60)
        kinds = [e["type"] for e in self.sent if e.get("agentId") == "hermes-dev" or
                 e.get("agent", {}).get("id") == "hermes-dev"]
        self.assertIn("agent_working", kinds)

    def test_failed_post_is_retried_on_next_tick(self):
        self._db(self.root / "profiles" / "dev", [("tool", "terminal", NOW)])
        p = self._poller()
        self.accept = False
        p.tick(NOW)
        # each member's first post failed, so the rest of that member's events were not tried
        self.assertEqual(_kinds(self.sent), ["agent_spawned"] * len(ot.TEAM))
        self.sent.clear()
        self.accept = True
        p.tick(NOW + 10)
        self.assertEqual(_kinds(_of(self.sent, "hermes-dev")), ["agent_spawned", "agent_working"])
        self.assertEqual(_kinds(self.sent), ["agent_spawned", "agent_working"] * len(ot.TEAM))

    def test_missing_token_posts_nothing(self):
        self.token.unlink()
        self._db(self.root / "profiles" / "dev", [("tool", "terminal", NOW)])
        self._poller().tick(NOW)
        self.assertEqual(self.sent, [])

    def test_unreadable_database_keeps_last_state(self):
        self._db(self.root / "profiles" / "dev", [("tool", "terminal", NOW)])
        p = self._poller()
        p.tick(NOW)
        self.sent.clear()
        real = ot.read_row

        def broken(home, since):
            if Path(home).name == "dev":
                raise sqlite3.OperationalError("database is locked")
            return real(home, since)

        ot.read_row = broken
        try:
            p.tick(NOW + 600)  # dev's read failed: nothing posted for dev (the others get keepalives)
        finally:
            ot.read_row = real
        self.assertEqual(_of(self.sent, "hermes-dev"), [])
        self.assertNotIn("agent_completed", _kinds(self.sent))


class HttpRoundTripTests(unittest.TestCase):
    """The real request, checked by a localhost server that verifies the signature the way the office does."""

    def setUp(self):
        self.accepted = []
        outer = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get("Content-Length", "0"))
                body = self.rfile.read(length)
                ts = self.headers.get("x-office-timestamp", "")
                expected = ot.sign(TOKEN_IN_SERVER[0], "/event", ts, body)
                ok = self.headers.get("x-office-signature") == expected
                outer.accepted.append((ok, body))
                self.send_response(200 if ok else 401)
                self.end_headers()

            def log_message(self, *args):
                pass

        TOKEN_IN_SERVER[0] = TOKEN
        self.httpd = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.port = self.httpd.server_address[1]

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()

    def test_signed_post_is_accepted_and_wrong_token_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = ot.Poller(tmp, Path(tmp) / "t", self.port)
            self.assertTrue(p._http_post(ot.spawn_event(DEV), TOKEN, NOW))
            self.assertFalse(p._http_post(ot.spawn_event(DEV), "wrong-token", NOW))
        ok_flags = [ok for ok, _ in self.accepted]
        self.assertEqual(ok_flags, [True, False])
        self.assertEqual(json.loads(self.accepted[0][1])["agent"]["name"], "Dev")

    def test_unreachable_office_returns_false_without_raising(self):
        # a port nothing listens on: bind, learn the number, close again
        probe = http.server.HTTPServer(("127.0.0.1", 0), http.server.BaseHTTPRequestHandler)
        dead_port = probe.server_address[1]
        probe.server_close()
        with tempfile.TemporaryDirectory() as tmp:
            p = ot.Poller(tmp, Path(tmp) / "t", dead_port)
            self.assertFalse(p._http_post(ot.spawn_event(DEV), TOKEN, NOW))


TOKEN_IN_SERVER = [None]


class StartTests(unittest.TestCase):
    def test_disabled_by_env(self):
        old = os.environ.get("AGENT_OFFICE_TEAM_POLL")
        os.environ["AGENT_OFFICE_TEAM_POLL"] = "0"
        try:
            self.assertIsNone(ot.start(Path("/nonexistent"), Path("/nonexistent/token"), 3334))
        finally:
            if old is None:
                os.environ.pop("AGENT_OFFICE_TEAM_POLL", None)
            else:
                os.environ["AGENT_OFFICE_TEAM_POLL"] = old

    def test_starts_one_daemon_thread_and_refuses_a_second(self):
        if any(t.name == ot.THREAD_NAME and t.is_alive() for t in threading.enumerate()):
            self.skipTest("a team poller is already running in this process (plugin_api imported it)")
        old = os.environ.pop("AGENT_OFFICE_TEAM_POLL", None)
        poller = None
        try:
            with tempfile.TemporaryDirectory() as tmp:
                # no token file: the thread runs its loop but posts nothing
                poller = ot.start(Path(tmp), Path(tmp) / "no-token", 3334)
                self.assertIsNotNone(poller)
                self.assertIsNone(ot.start(Path(tmp), Path(tmp) / "no-token", 3334))
                threads = [t for t in threading.enumerate() if t.name == ot.THREAD_NAME]
                self.assertEqual(len(threads), 1)
                self.assertTrue(threads[0].daemon)
        finally:
            if poller is not None:
                poller.stop()
            if old is not None:
                os.environ["AGENT_OFFICE_TEAM_POLL"] = old


class _EnvPatch:
    """Set (or unset, with None) one env var for the duration of a test."""

    def __init__(self, name, value):
        self.name, self.value = name, value

    def __enter__(self):
        self.old = os.environ.get(self.name)
        if self.value is None:
            os.environ.pop(self.name, None)
        else:
            os.environ[self.name] = self.value

    def __exit__(self, *exc):
        if self.old is None:
            os.environ.pop(self.name, None)
        else:
            os.environ[self.name] = self.old


class ViewerCadenceTests(unittest.TestCase):
    def setUp(self):
        # leave the process-wide counter where it was found
        self._saved = ot.viewer_count()
        self.addCleanup(self._restore)
        ot._wake.clear()

    def _restore(self):
        while ot.viewer_count() > self._saved:
            ot.viewer_disconnected()
        for _ in range(self._saved - ot.viewer_count()):
            ot.viewer_connected()
        ot._wake.clear()

    def test_interval_is_fast_with_a_viewer_and_idle_without(self):
        with _EnvPatch("AGENT_OFFICE_TEAM_IDLE_SECS", None):
            self.assertEqual(ot.tick_interval(1), ot.TICK_SECS)
            self.assertEqual(ot.tick_interval(3), ot.TICK_SECS)
            self.assertEqual(ot.tick_interval(0), 60)
            self.assertEqual(ot.IDLE_TICK_SECS, 60)
        self.assertEqual(ot.TICK_SECS, 10)

    def test_idle_interval_env_override_and_bad_values_fall_back(self):
        with _EnvPatch("AGENT_OFFICE_TEAM_IDLE_SECS", "300"):
            self.assertEqual(ot.tick_interval(0), 300)
            self.assertEqual(ot.tick_interval(1), ot.TICK_SECS)
        for bad in ("abc", "0", "-5", ""):
            with self.subTest(value=bad), _EnvPatch("AGENT_OFFICE_TEAM_IDLE_SECS", bad):
                self.assertEqual(ot.tick_interval(0), 60)

    def test_counter_counts_viewers_and_never_goes_negative(self):
        start = ot.viewer_count()
        ot.viewer_connected()
        ot.viewer_connected()
        self.assertEqual(ot.viewer_count(), start + 2)
        ot.viewer_disconnected()
        self.assertEqual(ot.viewer_count(), start + 1)
        ot.viewer_disconnected()
        ot.viewer_disconnected()
        ot.viewer_disconnected()
        self.assertEqual(ot.viewer_count(), 0)

    def test_disconnect_with_no_viewers_stays_at_zero(self):
        while ot.viewer_count() > 0:
            ot.viewer_disconnected()
        ot.viewer_disconnected()
        self.assertEqual(ot.viewer_count(), 0)

    def test_connect_sets_the_wake_event(self):
        ot._wake.clear()
        ot.viewer_connected()
        self.assertTrue(ot._wake.is_set())

    def test_disconnect_does_not_wake(self):
        ot.viewer_connected()
        ot._wake.clear()
        ot.viewer_disconnected()
        self.assertFalse(ot._wake.is_set())

    def test_connect_wakes_a_sleeping_poller_immediately(self):
        ticks = []
        poller = ot.Poller(Path(tempfile.mkdtemp()), Path("/nonexistent/token"), 3334, post=lambda *a: True)
        poller.tick = lambda now=None: ticks.append(time.time())
        with _EnvPatch("AGENT_OFFICE_TEAM_IDLE_SECS", "3600"):
            thread = threading.Thread(target=poller.run_forever, daemon=True)
            thread.start()
            try:
                deadline = time.time() + 2
                while not ticks and time.time() < deadline:
                    time.sleep(0.01)
                self.assertEqual(len(ticks), 1)  # first pass ran; now it sleeps the hour
                started = time.time()
                ot.viewer_connected()  # a viewer opens the office
                deadline = time.time() + 2
                while len(ticks) < 2 and time.time() < deadline:
                    time.sleep(0.01)
                self.assertEqual(len(ticks), 2)
                self.assertLess(time.time() - started, 2)
            finally:
                poller.stop()
                thread.join(timeout=2)
                self.assertFalse(thread.is_alive())

    def test_stop_ends_the_loop_without_waiting_out_the_interval(self):
        poller = ot.Poller(Path(tempfile.mkdtemp()), Path("/nonexistent/token"), 3334, post=lambda *a: True)
        poller.tick = lambda now=None: None
        with _EnvPatch("AGENT_OFFICE_TEAM_IDLE_SECS", "3600"):
            thread = threading.Thread(target=poller.run_forever, daemon=True)
            thread.start()
            time.sleep(0.05)
            poller.stop()
            thread.join(timeout=2)
            self.assertFalse(thread.is_alive())


if __name__ == "__main__":
    unittest.main()
