"""Brain editor hardening: the feature flag (env, then the config file), the one-time confirm token (expiry on an
injected clock, wrong sha / agent / file, single use, 409 and 422 do not spend it, reuse while unexpired), get_version
findings and scan_unavailable, restore refused on findings and allowed with override_findings (audit records the
override), scanner unavailable -> 503, author in the audit line (session user_id, or addr + UA hash without the raw UA),
and audit.log rotation at AUDIT_MAX_BYTES keeping exactly .1 .2 .3. Temp dirs only; DECK_CONFIG and the default
scanner are always replaced, and DECK_BRAIN_EDIT is cleared or set per test."""
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

_DASH = Path(__file__).resolve().parent.parent / "plugin" / "agent-office" / "dashboard"
_NOSCAN = lambda text: []  # injected so the real Hermes scanner is never imported by these tests
HDR = {"X-Requested-With": "agent-deck"}


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class _Clock:
    def __init__(self, t: float = 1000.0):
        self.t = t

    def __call__(self) -> float:
        return self.t


class _Base(unittest.TestCase):
    """A fresh brain_edit module per test (its token store and clock are module state), temp root and backup root,
    DECK_BRAIN_EDIT cleared, and DECK_CONFIG pointed at a temp file that does not exist."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.root = self.tmp / "office"
        self.bk = self.tmp / "bk"
        self.root.mkdir()
        self.brain = _load("brain_gate_test", _DASH / "brain.py")
        self.be = _load("brain_edit_gate_test", _DASH / "brain_edit.py")
        self.clock = _Clock()
        self.be._clock = self.clock
        self.be._tokens.clear()
        self.cfg = self.tmp / "deck-config.json"
        self.be.DECK_CONFIG = self.cfg
        self._env = mock.patch.dict(os.environ, {}, clear=False)
        self._env.start()
        os.environ.pop("DECK_BRAIN_EDIT", None)

    def tearDown(self):
        self._env.stop()
        self._tmp.cleanup()

    def target(self, agent, key):
        return self.brain.paths(self.brain.resolve(agent), self.root)[key]

    def make(self, agent, key, data: bytes):
        p = self.target(agent, key)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
        os.chmod(p, 0o600)
        return p

    def sha(self, data: bytes) -> str:
        import hashlib
        return hashlib.sha256(data).hexdigest()

    def current_sha(self, agent, key):
        p = self.target(agent, key)
        return self.sha(p.read_bytes()) if p.is_file() else ""

    def save_payload(self, agent, key, text, base=None, token=None):
        payload = {"agent": agent, "file": key, "text": text,
                   "base_sha": self.current_sha(agent, key) if base is None else base}
        if token is not None:
            payload["confirm_token"] = token
        return payload

    def audit_lines(self):
        p = self.bk / self.be.AUDIT_NAME
        return [json.loads(x) for x in p.read_text().splitlines()] if p.exists() else []

    def refused(self, status, fn, *args, **kwargs):
        with self.assertRaises(self.be.EditError) as cm:
            fn(*args, **kwargs)
        self.assertEqual(cm.exception.status, status, cm.exception.body)
        return cm.exception.body


class FlagEnvTests(_Base):
    """DECK_BRAIN_EDIT decides alone when it is set and non-empty."""

    def _cfg(self, text):
        self.cfg.write_text(text)

    def test_env_on_values_win_over_a_false_file(self):
        self._cfg('{"brain_edit": false}')
        for v in ("1", "true", "TRUE", "yes", "On"):
            os.environ["DECK_BRAIN_EDIT"] = v
            self.assertTrue(self.be.edit_enabled(self.cfg), v)

    def test_env_off_values_win_over_a_true_file(self):
        self._cfg('{"brain_edit": true}')
        for v in ("0", "false", "no", "off", "garbage", " 1"):
            os.environ["DECK_BRAIN_EDIT"] = v
            self.assertFalse(self.be.edit_enabled(self.cfg), v)

    def test_empty_env_is_unset_and_the_file_decides(self):
        os.environ["DECK_BRAIN_EDIT"] = ""
        self._cfg('{"brain_edit": true}')
        self.assertTrue(self.be.edit_enabled(self.cfg))
        self._cfg('{"brain_edit": false}')
        self.assertFalse(self.be.edit_enabled(self.cfg))


class FlagFileTests(_Base):
    """With the env unset, the config file must be a regular, non-symlink UTF-8 JSON object of at most CONFIG_CAP
    bytes whose brain_edit is the literal true. Everything else is off."""

    def test_true_is_on(self):
        self.cfg.write_text('{"brain_edit": true, "other": 1}')
        self.assertTrue(self.be.edit_enabled(self.cfg))

    def test_false_is_off(self):
        self.cfg.write_text('{"brain_edit": false}')
        self.assertFalse(self.be.edit_enabled(self.cfg))

    def test_missing_is_off(self):
        self.assertFalse(self.be.edit_enabled(self.cfg))

    def test_invalid_json_is_off(self):
        self.cfg.write_text('{"brain_edit": true')
        self.assertFalse(self.be.edit_enabled(self.cfg))

    def test_non_utf8_is_off(self):
        self.cfg.write_bytes(b'{"brain_edit": true, "x": "\xff"}')
        self.assertFalse(self.be.edit_enabled(self.cfg))

    def test_string_true_and_non_object_are_off(self):
        for body in ('{"brain_edit": "true"}', '{"brain_edit": 1}', "[true]", "true"):
            self.cfg.write_text(body)
            self.assertFalse(self.be.edit_enabled(self.cfg), body)

    def test_oversize_is_off_even_when_the_true_is_inside_the_cap(self):
        pad = "x" * self.be.CONFIG_CAP
        self.cfg.write_text(json.dumps({"brain_edit": True, "pad": pad}))
        self.assertGreater(self.cfg.stat().st_size, self.be.CONFIG_CAP)
        self.assertFalse(self.be.edit_enabled(self.cfg))

    def test_exactly_at_the_cap_is_read(self):
        head = '{"brain_edit": true, "pad": "'
        body = head + "x" * (self.be.CONFIG_CAP - len(head) - 2) + '"}'
        self.cfg.write_text(body)
        self.assertEqual(self.cfg.stat().st_size, self.be.CONFIG_CAP)
        self.assertTrue(self.be.edit_enabled(self.cfg))

    def test_symlink_to_a_true_file_is_off(self):
        real = self.tmp / "real.json"
        real.write_text('{"brain_edit": true}')
        os.symlink(real, self.cfg)
        self.assertFalse(self.be.edit_enabled(self.cfg))

    def test_directory_in_place_of_the_file_is_off(self):
        self.cfg.mkdir()
        self.assertFalse(self.be.edit_enabled(self.cfg))

    def test_default_path_is_read_per_call(self):
        self.cfg.write_text('{"brain_edit": false}')
        self.assertFalse(self.be.edit_enabled())
        self.cfg.write_text('{"brain_edit": true}')
        self.assertTrue(self.be.edit_enabled())


class TokenTests(_Base):
    def tok(self, agent="nova", key="soul", sha=""):
        return self.be.issue_token(agent, key, sha)

    def test_token_required_for_soul_and_default_only(self):
        self.make("nova", "soul", b"s\n")
        self.refused(428, self.be.save, self.save_payload("nova", "soul", "x\n"), root=self.root,
                     backup_root=self.bk, scanner=_NOSCAN)
        self.make("red", "memory", b"m\n")  # 'ash' is an alias of default, so it would need a token too
        self.assertTrue(self.be.save(self.save_payload("red", "memory", "y\n"), root=self.root,
                                     backup_root=self.bk, scanner=_NOSCAN)["saved"])

    def test_missing_token_body_is_the_required_message(self):
        self.make("nova", "soul", b"s\n")
        body = self.refused(428, self.be.save, self.save_payload("nova", "soul", "x\n"), root=self.root,
                            backup_root=self.bk, scanner=_NOSCAN)
        self.assertEqual(body, {"error": "confirm token required"})

    def test_invalid_token_is_428_and_writes_nothing(self):
        self.make("nova", "soul", b"s\n")
        body = self.refused(428, self.be.save, self.save_payload("nova", "soul", "x\n", token="bogus"),
                            root=self.root, backup_root=self.bk, scanner=_NOSCAN)
        self.assertEqual(body, {"error": "confirm token invalid or expired"})
        self.assertEqual(self.target("nova", "soul").read_bytes(), b"s\n")

    def test_wrong_sha_is_refused(self):
        self.make("nova", "soul", b"s\n")
        tok = self.tok(sha="0" * 64)
        self.refused(428, self.be.save, self.save_payload("nova", "soul", "x\n", token=tok), root=self.root,
                     backup_root=self.bk, scanner=_NOSCAN)
        self.assertEqual(self.target("nova", "soul").read_bytes(), b"s\n")

    def test_token_for_another_agent_or_file_is_refused(self):
        # both files missing, so the sha binding is "" for every one of them: only agent and file differ
        self.target("default", "user").parent.mkdir(parents=True)
        self.target("nova", "soul").parent.mkdir(parents=True, exist_ok=True)
        tok_other_agent = self.tok(agent="nova", key="soul", sha="")
        self.refused(428, self.be.save, self.save_payload("default", "user", "x\n", token=tok_other_agent),
                     root=self.root, backup_root=self.bk, scanner=_NOSCAN)
        tok_other_file = self.tok(agent="default", key="memory", sha="")
        self.refused(428, self.be.save, self.save_payload("default", "user", "x\n", token=tok_other_file),
                     root=self.root, backup_root=self.bk, scanner=_NOSCAN)
        self.assertFalse(self.target("default", "user").exists())

    def test_expired_token_is_refused_on_an_injected_clock(self):
        self.make("nova", "soul", b"s\n")
        tok = self.tok(sha=self.current_sha("nova", "soul"))
        self.clock.t += self.be.TOKEN_TTL_S - 1
        self.assertTrue(self.be.save(self.save_payload("nova", "soul", "a\n", token=tok), root=self.root,
                                     backup_root=self.bk, scanner=_NOSCAN)["saved"])  # still live just before expiry
        self.make("nova", "soul", b"s\n")
        tok2 = self.tok(sha=self.current_sha("nova", "soul"))
        self.clock.t += self.be.TOKEN_TTL_S
        self.refused(428, self.be.save, self.save_payload("nova", "soul", "b\n", token=tok2), root=self.root,
                     backup_root=self.bk, scanner=_NOSCAN)
        self.assertEqual(self.target("nova", "soul").read_bytes(), b"s\n")

    def test_single_use_second_write_with_same_token_is_428(self):
        self.make("nova", "soul", b"s\n")
        tok = self.tok(sha=self.sha(b"s\n"))
        self.assertTrue(self.be.save(self.save_payload("nova", "soul", "a\n", token=tok), root=self.root,
                                     backup_root=self.bk, scanner=_NOSCAN)["saved"])
        self.make("nova", "soul", b"s\n")  # put the bytes back to the sha the token is bound to
        self.refused(428, self.be.save, self.save_payload("nova", "soul", "b\n", token=tok), root=self.root,
                     backup_root=self.bk, scanner=_NOSCAN)
        self.assertEqual(self.target("nova", "soul").read_bytes(), b"s\n")

    def test_a_409_does_not_spend_the_token(self):
        self.make("nova", "soul", b"s\n")
        tok = self.tok(sha=self.sha(b"s\n"))
        with mock.patch.object(self.be, "_read_locked", return_value=("f" * 64, b"other")):
            self.refused(409, self.be.save, self.save_payload("nova", "soul", "a\n", token=tok), root=self.root,
                         backup_root=self.bk, scanner=_NOSCAN)
        self.assertTrue(self.be._check_token(tok, "nova", "soul", self.sha(b"s\n")))
        self.assertTrue(self.be.save(self.save_payload("nova", "soul", "a\n", token=tok), root=self.root,
                                     backup_root=self.bk, scanner=_NOSCAN)["saved"])

    def test_a_422_does_not_spend_the_token(self):
        self.make("nova", "soul", b"s\n")
        tok = self.tok(sha=self.sha(b"s\n"))
        self.refused(422, self.be.save, self.save_payload("nova", "soul", "x" * 20001, token=tok), root=self.root,
                     backup_root=self.bk, scanner=_NOSCAN)
        self.assertTrue(self.be.save(self.save_payload("nova", "soul", "a\n", token=tok), root=self.root,
                                     backup_root=self.bk, scanner=_NOSCAN)["saved"])

    def test_a_failed_write_gives_the_token_back(self):
        self.make("nova", "soul", b"s\n")
        tok = self.tok(sha=self.sha(b"s\n"))
        with mock.patch.object(self.be, "_atomic_write", side_effect=OSError("disk gone")):
            with self.assertRaises(OSError):
                self.be.save(self.save_payload("nova", "soul", "a\n", token=tok), root=self.root,
                             backup_root=self.bk, scanner=_NOSCAN)
        self.assertEqual(self.target("nova", "soul").read_bytes(), b"s\n")
        self.assertTrue(self.be.save(self.save_payload("nova", "soul", "a\n", token=tok), root=self.root,
                                     backup_root=self.bk, scanner=_NOSCAN)["saved"])

    def test_reuse_while_unexpired_returns_the_same_token(self):
        t1 = self.tok(sha="abc")
        self.clock.t += self.be.TOKEN_TTL_S / 2
        self.assertEqual(self.tok(sha="abc"), t1)
        self.assertNotEqual(self.tok(sha="other"), t1)
        self.clock.t += self.be.TOKEN_TTL_S  # past the first token's expiry: a fresh one is issued
        self.assertNotEqual(self.tok(sha="abc"), t1)

    def test_get_snapshot_issues_tokens_only_for_soul_and_default(self):
        self.make("dev", "memory", b"d\n")  # a missing file in a missing folder is 'blocked', not editable
        snap = self.be.mark_snapshot(self.brain.snapshot(None, self.root), True)
        by_id = {a["id"]: a for a in snap["agents"]}
        self.assertTrue(snap["edit_enabled"])
        self.assertIn("confirm_token", by_id["nova"]["soul"])
        self.assertIn("confirm_token", by_id["default"]["memory"])
        self.assertNotIn("confirm_token", by_id["dev"]["memory"])
        self.assertTrue(by_id["dev"]["memory"]["editable"])

    def test_snapshot_with_edit_off_has_no_tokens_and_blocks_every_file(self):
        snap = self.be.mark_snapshot(self.brain.snapshot(None, self.root), False)
        self.assertFalse(snap["edit_enabled"])
        for ag in snap["agents"]:
            for key in ("soul", "memory", "user"):
                self.assertFalse(ag[key]["editable"])
                self.assertEqual(ag[key]["edit_block"], "disabled")
                self.assertNotIn("confirm_token", ag[key])
        self.assertEqual(self.be._tokens, {})


class VersionAndRestoreTests(_Base):
    def make_version(self, agent="dev", key="memory", old=b"old line\n", new=b"new line\n"):
        """Saves `new` over `old` with the clean scanner, so the backup of `old` exists. Returns its id."""
        self.make(agent, key, old)
        saved = self.be.save(self.save_payload(agent, key, new.decode()), root=self.root, backup_root=self.bk,
                             scanner=_NOSCAN)
        return saved["backup"]

    def test_get_version_reports_findings(self):
        vid = self.make_version()
        out = self.be.get_version("dev", "memory", vid, root=self.root, backup_root=self.bk,
                                  scanner=lambda t: ["pattern-x"])
        self.assertEqual(out["findings"], ["pattern-x"])
        self.assertFalse(out["scan_unavailable"])
        self.assertTrue(out["restorable"])

    def test_get_version_with_no_scanner_is_scan_unavailable_not_an_error(self):
        vid = self.make_version()
        with mock.patch.dict(sys.modules, {"tools.threat_patterns": None}):
            out = self.be.get_version("dev", "memory", vid, root=self.root, backup_root=self.bk)
        self.assertIsNone(out["findings"])
        self.assertTrue(out["scan_unavailable"])
        self.assertEqual(out["text"], "old line\n")

    def test_restore_is_refused_on_findings_and_writes_nothing(self):
        vid = self.make_version()
        before = self.target("dev", "memory").read_bytes()
        body = self.refused(422, self.be.restore,
                            {"agent": "dev", "file": "memory", "id": vid,
                             "base_sha": self.current_sha("dev", "memory")},
                            root=self.root, backup_root=self.bk, scanner=lambda t: ["pattern-x"])
        self.assertEqual(body["findings"], ["pattern-x"])
        self.assertTrue(body["overridable"])
        self.assertEqual(self.target("dev", "memory").read_bytes(), before)

    def test_restore_with_override_is_allowed_and_audit_records_it(self):
        vid = self.make_version()
        r = self.be.restore({"agent": "dev", "file": "memory", "id": vid,
                             "base_sha": self.current_sha("dev", "memory"), "override_findings": True},
                            root=self.root, backup_root=self.bk, scanner=lambda t: ["p1", "p2"], author="user:ops")
        self.assertTrue(r["saved"])
        self.assertEqual(self.target("dev", "memory").read_bytes(), b"old line\n")
        rec = self.audit_lines()[-1]
        self.assertEqual(rec["action"], "restore")
        self.assertIs(rec["override"], True)
        self.assertEqual(rec["findings"], 2)
        self.assertEqual(rec["author"], "user:ops")

    def test_override_must_be_exactly_true(self):
        vid = self.make_version()
        self.refused(422, self.be.restore,
                     {"agent": "dev", "file": "memory", "id": vid, "base_sha": self.current_sha("dev", "memory"),
                      "override_findings": "true"},
                     root=self.root, backup_root=self.bk, scanner=lambda t: ["p"])
        self.assertEqual(self.target("dev", "memory").read_bytes(), b"new line\n")

    def test_restore_with_no_findings_has_no_override_key_in_audit(self):
        vid = self.make_version()
        self.be.restore({"agent": "dev", "file": "memory", "id": vid, "base_sha": self.current_sha("dev", "memory")},
                        root=self.root, backup_root=self.bk, scanner=_NOSCAN)
        self.assertNotIn("override", self.audit_lines()[-1])

    def test_scanner_unavailable_is_503_even_with_override(self):
        vid = self.make_version()
        before = self.target("dev", "memory").read_bytes()
        with mock.patch.dict(sys.modules, {"tools.threat_patterns": None}):
            for extra in ({}, {"override_findings": True}):
                body = self.refused(503, self.be.restore,
                                    {"agent": "dev", "file": "memory", "id": vid,
                                     "base_sha": self.current_sha("dev", "memory"), **extra},
                                    root=self.root, backup_root=self.bk)
                self.assertEqual(body, {"error": "safety scanner unavailable"})
        self.assertEqual(self.target("dev", "memory").read_bytes(), before)

    def test_restore_of_soul_needs_a_token_bound_to_the_base_sha(self):
        self.make("nova", "soul", b"s1\n")
        saved = self.be.save(self.save_payload("nova", "soul", "s2\n",
                                               token=self.be.issue_token("nova", "soul", self.sha(b"s1\n"))),
                             root=self.root, backup_root=self.bk, scanner=_NOSCAN)
        vid = saved["backup"]
        self.refused(428, self.be.restore,
                     {"agent": "nova", "file": "soul", "id": vid, "base_sha": self.sha(b"s2\n")},
                     root=self.root, backup_root=self.bk, scanner=_NOSCAN)
        tok = self.be.issue_token("nova", "soul", self.sha(b"s2\n"))
        r = self.be.restore({"agent": "nova", "file": "soul", "id": vid, "base_sha": self.sha(b"s2\n"),
                             "confirm_token": tok}, root=self.root, backup_root=self.bk, scanner=_NOSCAN)
        self.assertTrue(r["saved"])
        self.assertEqual(self.target("nova", "soul").read_bytes(), b"s1\n")

    def test_live_state_carries_a_token_only_while_editing_is_on(self):
        self.make("nova", "soul", b"s\n")
        on = self.be.live_state("nova", "soul", root=self.root, enabled=True)
        self.assertEqual(on["base_sha"], self.sha(b"s\n"))
        self.assertIn("confirm_token", on)
        off = self.be.live_state("nova", "soul", root=self.root, enabled=False)
        self.assertNotIn("confirm_token", off)
        dev = self.be.live_state("dev", "memory", root=self.root, enabled=True)
        self.assertNotIn("confirm_token", dev)


class AuthorAndAuditTests(_Base):
    def test_author_is_cleaned_and_capped(self):
        self.make("dev", "memory", b"a\n")
        self.be.save(self.save_payload("dev", "memory", "b\n"), root=self.root, backup_root=self.bk,
                     scanner=_NOSCAN, author="user:alice\u200b\x00\n")
        self.assertEqual(self.audit_lines()[-1]["author"], "user:alice")
        self.be.save(self.save_payload("dev", "memory", "c\n"), root=self.root, backup_root=self.bk,
                     scanner=_NOSCAN, author="x" * 300)
        self.assertEqual(len(self.audit_lines()[-1]["author"]), self.be.AUTHOR_MAX)
        self.be.save(self.save_payload("dev", "memory", "d\n"), root=self.root, backup_root=self.bk,
                     scanner=_NOSCAN, author="\u200b\x00")
        self.assertIsNone(self.audit_lines()[-1]["author"])


class RouteTests(_Base):
    """The real router through fastapi TestClient, with the flag set per test and the default scanner replaced."""

    def setUp(self):
        super().setUp()
        try:
            from fastapi import FastAPI
            from fastapi.testclient import TestClient
        except ImportError:
            self.skipTest("fastapi / httpx not installed")
        self._pa = mock.patch.dict(os.environ, {"AGENT_OFFICE_ROOT": str(self.tmp / "office-root")})
        self._pa.start()
        self.api = _load("plugin_api_gate_test", _DASH / "plugin_api.py")
        self.api.brain.DEFAULT_ROOT = self.root
        self.api.brain_edit.DEFAULT_BACKUP_ROOT = self.bk
        self.api.brain_edit._clock = self.clock
        self.api.brain_edit.DECK_CONFIG = self.cfg
        self.real_scanner = self.api.brain_edit._default_scanner
        self._scan = mock.patch.object(self.api.brain_edit, "_default_scanner", lambda text: [])
        self._scan.start()
        app = FastAPI()

        @app.middleware("http")
        async def fake_session(request, call_next):  # stands in for the dashboard auth middleware
            user = request.headers.get("x-test-user")
            if user:
                request.state.session = SimpleNamespace(user_id=user)
            return await call_next(request)

        app.include_router(self.api.router, prefix="/api/plugins/agent-office")
        self.client = TestClient(app)
        self.url = "/api/plugins/agent-office/brain"
        self.base = "/api/plugins/agent-office"

    def tearDown(self):
        self._scan.stop()
        self._pa.stop()
        super().tearDown()

    def flag_on(self):
        os.environ["DECK_BRAIN_EDIT"] = "1"

    def flag_off(self):
        os.environ["DECK_BRAIN_EDIT"] = "0"

    def put(self, body, headers=HDR):
        return self.client.put(self.url, headers=headers, json=body)

    def test_flag_off_by_env_blocks_both_write_routes_with_403(self):
        self.flag_off()
        self.make("dev", "memory", b"keep\n")
        r = self.put({"agent": "dev", "file": "memory", "text": "pwned\n", "base_sha": self.current_sha("dev", "memory")})
        self.assertEqual(r.status_code, 403, r.text)
        self.assertEqual(r.json(), {"error": "brain edit disabled"})
        r = self.client.post(f"{self.base}/brain/restore", headers=HDR,
                             json={"agent": "dev", "file": "memory", "id": "20260101T000000_000000Z",
                                   "base_sha": self.current_sha("dev", "memory")})
        self.assertEqual(r.status_code, 403, r.text)
        self.assertEqual(self.target("dev", "memory").read_bytes(), b"keep\n")

    def test_flag_off_from_the_config_file_blocks_writes(self):
        os.environ.pop("DECK_BRAIN_EDIT", None)
        self.cfg.write_text('{"brain_edit": false}')
        self.make("dev", "memory", b"keep\n")
        r = self.put({"agent": "dev", "file": "memory", "text": "x\n", "base_sha": self.current_sha("dev", "memory")})
        self.assertEqual(r.status_code, 403, r.text)

    def test_flag_on_from_the_config_file_allows_writes(self):
        os.environ.pop("DECK_BRAIN_EDIT", None)
        self.cfg.write_text('{"brain_edit": true}')
        self.make("dev", "memory", b"keep\n")
        r = self.put({"agent": "dev", "file": "memory", "text": "x\n", "base_sha": self.current_sha("dev", "memory")})
        self.assertEqual(r.status_code, 200, r.text)

    def test_get_brain_marks_editable_false_with_block_when_off(self):
        self.flag_off()
        body = self.client.get(self.url, params={"agent": "nova"}).json()
        self.assertFalse(body["edit_enabled"])
        for key in ("soul", "memory", "user"):
            self.assertFalse(body["agents"][0][key]["editable"])
            self.assertEqual(body["agents"][0][key]["edit_block"], "disabled")
            self.assertNotIn("confirm_token", body["agents"][0][key])

    def test_get_brain_issues_a_token_that_the_put_accepts_once(self):
        self.flag_on()
        self.make("nova", "soul", b"s\n")
        body = self.client.get(self.url, params={"agent": "nova"}).json()
        soul = body["agents"][0]["soul"]
        tok = soul["confirm_token"]
        r = self.put({"agent": "nova", "file": "soul", "text": "new\n", "base_sha": soul["sha"],
                      "confirm_token": tok})
        self.assertEqual(r.status_code, 200, r.text)
        r = self.put({"agent": "nova", "file": "soul", "text": "again\n", "base_sha": r.json()["file"]["sha"],
                      "confirm_token": tok})
        self.assertEqual(r.status_code, 428, r.text)

    def test_put_without_token_for_soul_is_428_with_the_new_message(self):
        self.flag_on()
        self.make("nova", "soul", b"s\n")
        r = self.put({"agent": "nova", "file": "soul", "text": "x\n", "base_sha": self.current_sha("nova", "soul")})
        self.assertEqual(r.status_code, 428)
        self.assertEqual(r.json(), {"error": "confirm token required"})

    def test_version_route_has_findings_base_sha_and_token(self):
        self.flag_on()
        self.make("dev", "memory", b"old line\n")
        saved = self.be_save("dev", "memory", "new line\n")
        with mock.patch.object(self.api.brain_edit, "_default_scanner", lambda t: ["pat"]):
            r = self.client.get(f"{self.base}/brain/version",
                                params={"agent": "dev", "file": "memory", "id": saved["backup"]})
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(body["findings"], ["pat"])
        self.assertFalse(body["scan_unavailable"])
        self.assertEqual(body["base_sha"], self.current_sha("dev", "memory"))
        self.assertNotIn("confirm_token", body)  # dev memory needs no token
        self.assertEqual(r.headers.get("cache-control"), "no-store")

    def test_version_route_scan_unavailable_is_200_with_flag(self):
        self.flag_on()
        self.make("default", "memory", b"old\n")
        saved = self.be_save("default", "memory", "new\n", scanner=_NOSCAN)
        with mock.patch.object(self.api.brain_edit, "_default_scanner", self.real_scanner), \
                mock.patch.dict(sys.modules, {"tools.threat_patterns": None}):
            r = self.client.get(f"{self.base}/brain/version",
                                params={"agent": "ash", "file": "memory", "id": saved["backup"]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIsNone(r.json()["findings"])
        self.assertTrue(r.json()["scan_unavailable"])
        self.assertIn("confirm_token", r.json())  # default's memory needs a token

    def test_restore_route_on_findings_is_422_and_override_is_200_with_audit(self):
        self.flag_on()
        self.make("dev", "memory", b"old line\n")
        saved = self.be_save("dev", "memory", "new line\n")
        restore_body = {"agent": "dev", "file": "memory", "id": saved["backup"],
                        "base_sha": self.current_sha("dev", "memory")}
        with mock.patch.object(self.api.brain_edit, "_default_scanner", lambda t: ["pat"]):
            r = self.client.post(f"{self.base}/brain/restore", headers=HDR, json=restore_body)
            self.assertEqual(r.status_code, 422, r.text)
            self.assertTrue(r.json()["overridable"])
            r = self.client.post(f"{self.base}/brain/restore", headers=HDR,
                                 json={**restore_body, "override_findings": True}, )
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.target("dev", "memory").read_bytes(), b"old line\n")
        self.assertIs(self.audit_rows()[-1]["override"], True)

    def test_restore_route_scanner_unavailable_is_503(self):
        self.flag_on()
        self.make("dev", "memory", b"old line\n")
        saved = self.be_save("dev", "memory", "new line\n")
        with mock.patch.object(self.api.brain_edit, "_default_scanner", self.real_scanner), \
                mock.patch.dict(sys.modules, {"tools.threat_patterns": None}):
            r = self.client.post(f"{self.base}/brain/restore", headers=HDR,
                                 json={"agent": "dev", "file": "memory", "id": saved["backup"],
                                       "base_sha": self.current_sha("dev", "memory"),
                                       "override_findings": True})
        self.assertEqual(r.status_code, 503, r.text)
        self.assertEqual(r.json(), {"error": "safety scanner unavailable"})
        self.assertEqual(self.target("dev", "memory").read_bytes(), b"new line\n")

    def test_author_is_the_session_user_when_there_is_one(self):
        self.flag_on()
        self.make("dev", "memory", b"a\n")
        r = self.client.put(self.url, headers={**HDR, "X-Test-User": "user-42"},
                            json={"agent": "dev", "file": "memory", "text": "b\n",
                                  "base_sha": self.current_sha("dev", "memory")})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.audit_rows()[-1]["author"], "user:user-42")

    def test_author_without_session_is_addr_and_ua_hash_never_the_raw_ua(self):
        self.flag_on()
        self.make("dev", "memory", b"a\n")
        ua = "Hermes-Probe/9.9 RAW-UA-MARKER-5511"
        r = self.client.put(self.url, headers={**HDR, "User-Agent": ua},
                            json={"agent": "dev", "file": "memory", "text": "b\n",
                                  "base_sha": self.current_sha("dev", "memory")})
        self.assertEqual(r.status_code, 200, r.text)
        author = self.audit_rows()[-1]["author"]
        self.assertTrue(author.startswith("addr:"), author)
        self.assertRegex(author, r" ua:[0-9a-f]{16}$")
        raw = (self.bk / self.be_audit_name()).read_text()
        self.assertNotIn("RAW-UA-MARKER", raw)

    def be_save(self, agent, key, text, scanner=_NOSCAN):
        aid = self.brain.resolve(agent)
        token = self.be.issue_token(aid, key, self.current_sha(agent, key)) if (key == "soul" or aid == "default") \
            else None
        return self.be.save(self.save_payload(agent, key, text, token=token), root=self.root, backup_root=self.bk,
                            scanner=scanner)

    def be_audit_name(self):
        return self.be.AUDIT_NAME

    def audit_rows(self):
        return self.audit_lines()


class AuditRotationTests(_Base):
    def name(self, n=""):
        return self.bk / (self.be.AUDIT_NAME + n)

    def test_rotation_at_the_threshold_keeps_exactly_three_old_files(self):
        self.bk.mkdir(parents=True)
        self.name().write_bytes(b"x" * self.be.AUDIT_MAX_BYTES)
        self.name(".1").write_bytes(b"one")
        self.name(".2").write_bytes(b"two")
        self.name(".3").write_bytes(b"three")
        self.be._audit(self.bk, {"action": "probe"})
        self.assertEqual(self.name(".1").stat().st_size, self.be.AUDIT_MAX_BYTES)
        self.assertEqual(self.name(".2").read_bytes(), b"one")
        self.assertEqual(self.name(".3").read_bytes(), b"two")
        self.assertFalse(self.name(".4").exists())
        self.assertEqual(json.loads(self.name().read_text().splitlines()[0])["action"], "probe")

    def test_one_byte_under_the_threshold_does_not_rotate(self):
        self.bk.mkdir(parents=True)
        self.name().write_bytes(b"x" * (self.be.AUDIT_MAX_BYTES - 1))
        self.name(".1").write_bytes(b"one")
        self.be._audit(self.bk, {"action": "probe"})
        self.assertEqual(self.name(".1").read_bytes(), b"one")
        self.assertGreater(self.name().stat().st_size, self.be.AUDIT_MAX_BYTES - 1)

    def test_repeated_rotation_never_grows_past_three(self):
        self.bk.mkdir(parents=True)
        for i in range(6):
            self.name().write_bytes(b"x" * self.be.AUDIT_MAX_BYTES)
            self.be._audit(self.bk, {"round": i})
        names = sorted(p.name for p in self.bk.iterdir() if p.name.startswith(self.be.AUDIT_NAME))
        self.assertEqual(names, [self.be.AUDIT_NAME, self.be.AUDIT_NAME + ".1", self.be.AUDIT_NAME + ".2",
                                 self.be.AUDIT_NAME + ".3"])


if __name__ == "__main__":
    unittest.main()
