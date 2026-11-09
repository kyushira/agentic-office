"""Tests for the Agent Deck brain editor: brain_edit.py (save, versions, restore) and the PUT /brain, GET /brain/versions,
GET /brain/version and POST /brain/restore routes in plugin_api.py. Every test runs in a temp dir: the office root and
the backup root are passed in (or patched on the route module), so nothing under /opt/data is touched."""
import importlib.util
import json
import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest import mock

_DASH = Path(__file__).resolve().parent.parent / "plugin" / "agent-office" / "dashboard"
_NOSCAN = lambda text: []  # the threat scanner is injected in every test, so the real one is never imported


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


brain = _load("brain_under_test_edit", _DASH / "brain.py")
brain_edit = _load("brain_edit_under_test", _DASH / "brain_edit.py")
HDR = {"X-Requested-With": "agent-deck"}
MARKER = "MARKER-7f3a9c-do-not-log"


def _prose(n: int) -> str:
    """Exactly n characters of spaced words. A long run of letters and digits would trip redact's base64 rule (and
    redact's regexes are slow on such runs), so fixtures for size tests use this instead."""
    return (("lorem ipsum dolor sit amet " * (n // 27 + 1))[:n])


def _sha(data: bytes) -> str:
    import hashlib
    return hashlib.sha256(data).hexdigest()


class _Temp(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.root = self.tmp / "office"
        self.bk = self.tmp / "bk"
        self.root.mkdir()

    def tearDown(self):
        self._tmp.cleanup()

    def target(self, agent: str, key: str) -> Path:
        return brain.paths(brain.resolve(agent), self.root)[key]

    def make(self, agent: str, key: str, data: bytes, mode: int = 0o600) -> Path:
        p = self.target(agent, key)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
        os.chmod(p, mode)
        return p

    def current_sha(self, agent, key) -> str:
        if brain.resolve(agent) is None or key not in brain_edit.FILES:
            return ""  # a bad name: the editor refuses it, the helper just needs a value
        p = self.target(agent, key)
        return _sha(p.read_bytes()) if p.is_file() else ""

    def save(self, agent="dev", file="memory", text="hello", base=None, confirm=None, scanner=_NOSCAN, mkparent=True):
        if mkparent and brain.resolve(agent) is not None and file in brain_edit.FILES:
            self.target(agent, file).parent.mkdir(parents=True, exist_ok=True)  # a missing file needs its folder
        payload = {"agent": agent, "file": file, "text": text,
                   "base_sha": self.current_sha(agent, file) if base is None else base}
        if confirm is not None:
            payload["confirm"] = confirm
        return brain_edit.save(payload, root=self.root, backup_root=self.bk, scanner=scanner)

    def refused(self, status: int, fn, *args, **kwargs):
        with self.assertRaises(brain_edit.EditError) as cm:
            fn(*args, **kwargs)
        self.assertEqual(cm.exception.status, status, cm.exception.body)
        return cm.exception.body

    def snapshot(self, base: Path):
        """Every name under base and the bytes of every regular file. Used to prove a refused request wrote nothing."""
        out = {}
        if not base.exists():
            return out
        for dp, dns, fns in os.walk(base):
            for n in dns + fns:
                p = Path(dp, n)
                rel = str(p.relative_to(base))
                if rel.endswith(".lock"):
                    continue  # lock files are empty 0600 files made before any check; they carry no content
                out[rel] = p.read_bytes() if p.is_file() and not p.is_symlink() else ("link" if p.is_symlink() else "dir")
        return out

    def backups(self, agent: str, key: str):
        d = self.bk / brain.resolve(agent) / key
        if not d.is_dir():
            return []
        return sorted(p.name for p in d.iterdir() if p.name != ".lock")


class WhitelistAndPathTests(_Temp):
    def test_all_seven_agents_and_ash_alias_are_accepted(self):
        for agent in brain.AGENTS + ("ash",):
            r = self.save(agent=agent, file="memory", text=f"entry for {agent}", confirm=True)
            self.assertTrue(r["saved"], agent)
            self.assertEqual(self.target(brain.resolve(agent), "memory").read_text(), f"entry for {agent}")

    def test_unknown_agent_is_404(self):
        self.refused(404, self.save, agent="ghost", file="memory", text="x")

    def test_file_names_outside_the_three_are_404(self):
        for bad in ("MEMORY.md", "../soul", "soul/..", "Soul", "", None, 7):
            self.refused(404, self.save, agent="dev", file=bad, text="x")

    def test_traversal_strings_in_agent_write_nothing(self):
        before = self.snapshot(self.tmp)
        for bad in ("../default", "dev/../nova", "/etc", "dev%2f..", "dev\x00", "", None, 3):
            self.refused(404, self.save, agent=bad, file="memory", text="x", confirm=True)
        self.assertEqual(self.snapshot(self.tmp), before)

    def test_version_routes_also_refuse_unknown_names(self):
        self.refused(404, brain_edit.list_versions, "../default", "memory", root=self.root, backup_root=self.bk)
        self.refused(404, brain_edit.list_versions, "dev", "MEMORY.md", root=self.root, backup_root=self.bk)


class LimitTests(_Temp):
    def test_memory_exactly_at_limit_is_saved_and_one_over_is_422(self):
        limit = brain.EDIT_LIMITS["memory"]
        self.assertTrue(self.save(text=_prose(limit))["saved"])
        body = self.refused(422, self.save, text=_prose(limit + 1), base=self.current_sha("dev", "memory"))
        self.assertEqual(body, {"error": "over limit", "chars": limit + 1, "limit": limit})

    def test_soul_limit_is_20000_and_soul_needs_confirm(self):
        self.assertEqual(brain.EDIT_LIMITS["soul"], 20000)
        self.assertTrue(self.save(agent="nova", file="soul", text=_prose(20000), confirm=True)["saved"])
        self.refused(422, self.save, agent="nova", file="soul", text=_prose(20001), confirm=True)

    def test_user_limit(self):
        self.refused(422, self.save, file="user", text="u" * 1376, confirm=None)

    def test_crlf_is_counted_after_normalisation(self):
        # 2199 characters + one CRLF: 2200 after CRLF->LF, so it fits the memory limit exactly
        self.assertTrue(self.save(text=_prose(2199) + "\r\n")["saved"])
        self.assertEqual(self.target("dev", "memory").read_bytes(), _prose(2199).encode() + b"\n")
        # 2200 characters + one CRLF is 2201 after normalisation: refused
        self.refused(422, self.save, text=_prose(2200) + "\r\n", base=self.current_sha("dev", "memory"))


class SecretAndScannerTests(_Temp):
    def test_secret_looking_text_is_422_and_nothing_is_written(self):
        self.make("dev", "memory", b"keep\n")
        body = self.refused(422, self.save, text="token sk-" + "a" * 24, base=self.current_sha("dev", "memory"))
        self.assertEqual(body["error"], "text looks like it contains a secret")
        self.assertEqual(self.target("dev", "memory").read_bytes(), b"keep\n")

    def test_scanner_findings_are_422(self):
        body = self.refused(422, self.save, text="innocent", scanner=lambda t: ["fake-rule-a", "fake-rule-b"])
        self.assertEqual(body, {"error": "blocked pattern", "findings": ["fake-rule-a", "fake-rule-b"]})
        self.assertFalse(self.target("dev", "memory").exists())

    def test_scanner_gets_the_normalised_text(self):
        seen = []
        self.save(text="a\r\nb", scanner=lambda t: seen.append(t) or [])
        self.assertEqual(seen, ["a\nb"])


class ConfirmTests(_Temp):
    def test_soul_without_confirm_is_428_and_with_confirm_is_ok(self):
        self.refused(428, self.save, agent="nova", file="soul", text="x")
        self.refused(428, self.save, agent="nova", file="soul", text="x", confirm="yes")
        self.assertTrue(self.save(agent="nova", file="soul", text="x", confirm=True)["saved"])

    def test_default_agent_needs_confirm_for_any_file(self):
        self.refused(428, self.save, agent="ash", file="memory", text="x")
        self.refused(428, self.save, agent="default", file="user", text="x", confirm=False)
        self.assertTrue(self.save(agent="default", file="user", text="x", confirm=True)["saved"])

    def test_other_agents_memory_needs_no_confirm(self):
        self.assertTrue(self.save(agent="red", file="memory", text="x")["saved"])


class SaveTests(_Temp):
    def test_stale_base_sha_is_409_with_no_write_and_no_backup(self):
        self.make("dev", "memory", b"current\n")
        before = self.snapshot(self.tmp)
        body = self.refused(409, self.save, text="new", base="0" * 64)
        self.assertEqual(body, {"error": "changed since loaded", "sha": _sha(b"current\n")})
        self.assertEqual(self.snapshot(self.tmp), before)
        self.assertFalse(self.bk.exists())

    def test_backup_holds_the_old_bytes_and_is_written_before_the_save(self):
        old = b"old entry\n\xc2\xa7 not a separator\n"
        self.make("dev", "memory", old)
        r = self.save(text="new entry")
        self.assertTrue(r["saved"])
        self.assertEqual(r["backup"] + ".md", self.backups("dev", "memory")[-1])
        backup = self.bk / "dev" / "memory" / (r["backup"] + ".md")
        self.assertEqual(backup.read_bytes(), old)
        self.assertEqual(stat.S_IMODE(os.stat(backup).st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(os.stat(self.bk / "dev" / "memory").st_mode), 0o700)
        self.assertEqual(self.target("dev", "memory").read_bytes(), b"new entry")

    def test_unchanged_text_is_200_and_writes_no_backup(self):
        self.make("dev", "memory", b"same\n")
        r = self.save(text="same\n")
        self.assertEqual((r["saved"], r["unchanged"]), (False, True))
        self.assertEqual(self.backups("dev", "memory"), [])

    def test_rotation_keeps_the_newest_ten_backups(self):
        states = [f"state {i}\n" for i in range(13)]
        self.make("dev", "memory", states[0].encode())
        for s in states[1:]:
            self.assertTrue(self.save(text=s)["saved"])
        names = self.backups("dev", "memory")
        self.assertEqual(len(names), brain_edit.BACKUP_KEEP)
        kept = [(self.bk / "dev" / "memory" / n).read_bytes().decode() for n in names]
        self.assertEqual(kept, states[2:12])  # backups hold states 0..11; the 10 newest are 2..11
        self.assertEqual(kept[-1], states[11])

    def test_versions_are_listed_newest_first_and_junk_is_ignored(self):
        self.make("dev", "memory", b"v0\n")
        for i in range(1, 4):
            self.save(text=f"v{i}\n")
        d = self.bk / "dev" / "memory"
        (d / "notes.md").write_bytes(b"junk")
        (d / "20260101T000000_000000Z.md.tmp").write_bytes(b"junk")
        os.symlink(self.tmp / "outside", d / "20260102T000000_000000Z.md")
        listing = brain_edit.list_versions("dev", "memory", root=self.root, backup_root=self.bk)["versions"]
        ids = [v["id"] for v in listing]
        self.assertEqual(ids, sorted(ids, reverse=True))
        self.assertEqual(len(ids), 3)
        self.assertNotIn("20260102T000000_000000Z", ids)
        self.assertEqual([v["chars"] for v in listing], [3, 3, 3])
        self.assertTrue(all(v["sha"] and v["ts"] > 0 for v in listing))

    def test_no_backup_folder_lists_empty(self):
        self.assertEqual(brain_edit.list_versions("dev", "memory", root=self.root, backup_root=self.bk),
                         {"versions": []})

    def test_memory_separator_round_trips_byte_exact(self):
        text = "first entry\n§\nsecond entry\n§\nthird"
        self.make("dev", "memory", b"seed\n")
        self.assertTrue(self.save(text=text)["saved"])
        self.assertEqual(self.target("dev", "memory").read_bytes(), text.encode("utf-8"))
        view = brain.read_file(self.target("dev", "memory"), brain.LIMITS["memory"])
        self.assertEqual(view["text"], text)

    def test_file_mode_is_preserved_and_new_file_is_0600(self):
        self.make("dev", "memory", b"a\n", mode=0o640)
        self.save(text="b\n")
        self.assertEqual(stat.S_IMODE(os.stat(self.target("dev", "memory")).st_mode), 0o640)
        self.save(agent="red", file="memory", text="new\n")
        self.assertEqual(stat.S_IMODE(os.stat(self.target("red", "memory")).st_mode), 0o600)

    def test_new_file_needs_missing_base_and_parent_must_exist(self):
        self.refused(409, self.save, agent="red", file="memory", text="x", base="", mkparent=False)  # parent missing
        self.target("red", "memory").parent.mkdir(parents=True)
        self.assertTrue(self.save(agent="red", file="memory", text="x", base="", mkparent=False)["saved"])

    def test_no_temp_files_left_after_success(self):
        self.make("dev", "memory", b"a\n")
        self.save(text="b\n")
        leftovers = [n for n in os.listdir(self.target("dev", "memory").parent) if n.endswith(".tmp")]
        self.assertEqual(leftovers, [])

    def test_failed_replace_removes_temp_and_keeps_file(self):
        self.make("dev", "memory", b"keep\n")
        with mock.patch.object(brain_edit.os, "replace", side_effect=OSError("disk gone")):
            with self.assertRaises(OSError):
                self.save(text="new\n")
        self.assertEqual(self.target("dev", "memory").read_bytes(), b"keep\n")
        self.assertEqual([n for n in os.listdir(self.target("dev", "memory").parent) if n.endswith(".tmp")], [])

    def test_symlink_target_is_409_and_link_target_is_unchanged(self):
        outside = self.tmp / "outside.md"
        outside.write_bytes(b"outside\n")
        p = self.target("dev", "memory")
        p.parent.mkdir(parents=True)
        os.symlink(outside, p)
        self.refused(409, self.save, text="pwned", base=_sha(b"outside\n"))
        self.assertEqual(outside.read_bytes(), b"outside\n")
        self.assertTrue(p.is_symlink())

    def test_symlinked_backup_folder_is_refused(self):
        self.make("dev", "memory", b"old\n")
        elsewhere = self.tmp / "elsewhere"
        elsewhere.mkdir()
        self.bk.mkdir()
        os.symlink(elsewhere, self.bk / "dev")
        self.refused(409, self.save, text="new", base=_sha(b"old\n"))
        self.assertEqual(list(elsewhere.iterdir()), [])
        self.assertEqual(self.target("dev", "memory").read_bytes(), b"old\n")

    def test_audit_lines_have_no_contents(self):
        self.make("dev", "memory", f"{MARKER} old\n".encode())
        self.save(text=f"{MARKER} new\n")
        audit = self.bk / "audit.log"
        self.assertEqual(stat.S_IMODE(os.stat(audit).st_mode), 0o600)
        raw = audit.read_bytes()
        self.assertNotIn(MARKER.encode(), raw)
        rec = json.loads(raw.splitlines()[-1])
        self.assertEqual(rec["action"], "save")
        self.assertEqual(set(rec), {"ts", "action", "agent", "file", "chars_before", "chars_after",
                                    "sha_before", "sha_after", "backup"})
        self.assertEqual(rec["sha_before"], _sha(f"{MARKER} old\n".encode()))

    def test_over_limit_body_has_no_contents(self):
        body = self.refused(422, self.save, text=MARKER + "x" * 2300)
        self.assertNotIn(MARKER, json.dumps(body))


class VersionAndRestoreTests(_Temp):
    def test_version_fetch_rejects_bad_and_traversal_ids(self):
        self.make("dev", "memory", b"a\n")
        self.save(text="b\n")
        for bad in ("../x", "..%2Fx", "a/../../x", "20260101T000000_000000Z", "nonexistent", "", None,
                    "20260101T000000_000000Z.md", "20260101T000000_000000Z\x00"):
            self.refused(404, brain_edit.get_version, "dev", "memory", bad, root=self.root, backup_root=self.bk)

    def test_version_fetch_returns_redacted_text_and_restorable_flag(self):
        self.make("dev", "memory", b"a\n")
        self.save(text="b\n")
        vid = brain_edit.list_versions("dev", "memory", root=self.root, backup_root=self.bk)["versions"][0]["id"]
        v = brain_edit.get_version("dev", "memory", vid, root=self.root, backup_root=self.bk)
        self.assertEqual(v["id"], vid)
        self.assertEqual(v["text"], "a\n")
        self.assertTrue(v["restorable"])
        self.assertEqual(v["chars"], 2)

    def test_restore_round_trip_and_pre_restore_backup(self):
        original = "original line\n§\nsecond\n".encode()
        self.make("dev", "memory", original)
        saved = self.save(text="changed line\n")
        self.assertTrue(saved["saved"])
        self.assertEqual(self.target("dev", "memory").read_bytes(), b"changed line\n")
        before = len(self.backups("dev", "memory"))
        r = brain_edit.restore({"agent": "dev", "file": "memory", "id": saved["backup"],
                                "base_sha": self.current_sha("dev", "memory"), "confirm": None},
                               root=self.root, backup_root=self.bk)
        self.assertEqual(r["restored"], saved["backup"])
        self.assertEqual(self.target("dev", "memory").read_bytes(), original)
        self.assertEqual(len(self.backups("dev", "memory")), before + 1)
        newest = self.bk / "dev" / "memory" / (r["backup"] + ".md")
        self.assertEqual(newest.read_bytes(), b"changed line\n")

    def test_restore_is_not_redacted_or_threat_checked(self):
        # A version that holds a secret-looking token. Saving that text would be refused, but restoring the bytes
        # the file already had is allowed: restore does not redact or scan.
        secretish = "token sk-" + "b" * 24 + "\n"
        d = self.bk / "dev" / "memory"
        d.mkdir(parents=True)
        (d / "20260101T000000_000000Z.md").write_bytes(secretish.encode())
        self.make("dev", "memory", b"clean\n")
        bid = "20260101T000000_000000Z"
        r = brain_edit.restore({"agent": "dev", "file": "memory", "id": bid, "base_sha": self.current_sha("dev", "memory")},
                               root=self.root, backup_root=self.bk)
        self.assertTrue(r["saved"])
        self.assertEqual(self.target("dev", "memory").read_bytes(), secretish.encode())

    def test_restore_checks_sha_and_confirm(self):
        self.make("dev", "memory", b"a\n")
        self.save(text="b\n")
        bid = self.backups("dev", "memory")[-1][:-3]
        self.refused(409, brain_edit.restore, {"agent": "dev", "file": "memory", "id": bid, "base_sha": "0" * 64},
                     root=self.root, backup_root=self.bk)
        self.refused(428, brain_edit.restore, {"agent": "ash", "file": "memory", "id": bid,
                                               "base_sha": self.current_sha("ash", "memory")},
                     root=self.root, backup_root=self.bk)

    def test_restore_of_oversize_version_is_422(self):
        self.make("dev", "memory", b"a\n")
        self.save(text="b\n")
        bid = self.backups("dev", "memory")[-1][:-3]
        p = self.bk / "dev" / "memory" / (bid + ".md")
        p.write_bytes(b"x" * (brain.EDIT_LIMITS["memory"] + 1))
        self.refused(422, brain_edit.restore, {"agent": "dev", "file": "memory", "id": bid,
                                               "base_sha": self.current_sha("dev", "memory")},
                     root=self.root, backup_root=self.bk)


class GetViewEditFieldsTests(_Temp):
    def test_file_view_carries_sha_limit_and_block_state(self):
        self.make("dev", "memory", b"plain\n")
        v = brain.agent("dev", self.root)["memory"]
        self.assertEqual(v["sha"], _sha(b"plain\n"))
        self.assertEqual(v["edit_limit"], 2200)
        self.assertTrue(v["editable"])
        self.assertIsNone(v["edit_block"])

    def test_missing_file_is_editable_only_with_a_parent(self):
        v = brain.agent("red", self.root)["memory"]
        self.assertEqual((v["sha"], v["editable"], v["edit_block"]), ("", False, "unreadable"))
        self.target("red", "memory").parent.mkdir(parents=True)
        v = brain.agent("red", self.root)["memory"]
        self.assertEqual((v["sha"], v["editable"], v["edit_block"]), ("", True, None))

    def test_redacted_file_is_not_editable(self):
        self.make("dev", "memory", b"api sk-" + b"c" * 24 + b"\n")
        v = brain.agent("dev", self.root)["memory"]
        self.assertFalse(v["editable"])
        self.assertEqual(v["edit_block"], "redacted")

    def test_too_large_file_is_not_editable(self):
        self.make("dev", "memory", _prose(brain.READ_CAP + 1).encode())
        v = brain.agent("dev", self.root)["memory"]
        self.assertEqual(v["edit_block"], "too_large")
        self.assertFalse(v["editable"])

    def test_symlink_and_bad_utf8_are_not_editable(self):
        p = self.target("dev", "memory")
        p.parent.mkdir(parents=True)
        os.symlink(self.tmp / "nowhere", p)
        v = brain.agent("dev", self.root)["memory"]
        self.assertFalse(v["editable"])
        p.unlink()
        p.write_bytes(b"\xff\xfe bad")
        v = brain.agent("dev", self.root)["memory"]
        self.assertEqual(v["edit_block"], "unreadable")

    def test_soul_up_to_the_edit_cap_is_returned_whole(self):
        self.make("nova", "soul", (_prose(19999) + "\n").encode())
        v = brain.agent("nova", self.root)["soul"]
        self.assertEqual(len(v["text"]), 20000)
        self.assertTrue(v["editable"])


class RouteTests(_Temp):
    """PUT /brain, POST /brain/restore, GET /brain, GET /brain/versions and /brain/version through the real router."""

    def setUp(self):
        super().setUp()
        try:
            from fastapi import FastAPI
            from fastapi.testclient import TestClient
        except ImportError:
            self.skipTest("fastapi / httpx not installed")
        self._env = os.environ.get("AGENT_OFFICE_ROOT")
        os.environ["AGENT_OFFICE_ROOT"] = str(self.tmp / "office-root")
        api = _load("plugin_api_brain_edit_test", _DASH / "plugin_api.py")
        api.brain.DEFAULT_ROOT = self.root
        api.brain_edit.DEFAULT_BACKUP_ROOT = self.bk
        self.api = api
        app = FastAPI()
        app.include_router(api.router, prefix="/api/plugins/agent-office")
        self.client = TestClient(app)
        self.base = "/api/plugins/agent-office"

    def tearDown(self):
        if self._env is None:
            os.environ.pop("AGENT_OFFICE_ROOT", None)
        else:
            os.environ["AGENT_OFFICE_ROOT"] = self._env
        super().tearDown()

    def put(self, body, headers=HDR, raw=None):
        kwargs = {"content": raw} if raw is not None else {"json": body}
        return self.client.put(f"{self.base}/brain", headers=headers, **kwargs)

    def test_put_without_header_is_403_and_file_unchanged(self):
        self.make("dev", "memory", b"keep\n")
        r = self.put({"agent": "dev", "file": "memory", "text": "pwned", "base_sha": _sha(b"keep\n")}, headers={})
        self.assertEqual(r.status_code, 403, r.text)
        self.assertEqual(self.target("dev", "memory").read_bytes(), b"keep\n")

    def test_put_with_cross_origin_is_403(self):
        self.make("dev", "memory", b"keep\n")
        r = self.put({"agent": "dev", "file": "memory", "text": "pwned", "base_sha": _sha(b"keep\n")},
                     headers={**HDR, "Origin": "http://evil.example"})
        self.assertEqual(r.status_code, 403, r.text)
        self.assertEqual(self.target("dev", "memory").read_bytes(), b"keep\n")

    def test_put_with_header_saves_and_returns_the_new_view(self):
        self.make("dev", "memory", b"old\n")
        r = self.put({"agent": "dev", "file": "memory", "text": "new\n\u00a7\nentry\n", "base_sha": _sha(b"old\n")})
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertTrue(body["saved"])
        self.assertEqual(body["file"]["sha"], _sha("new\n\u00a7\nentry\n".encode()))
        self.assertEqual(r.headers.get("cache-control"), "no-store")
        self.assertEqual(self.target("dev", "memory").read_bytes(), "new\n\u00a7\nentry\n".encode())

    def test_put_oversize_body_is_413(self):
        self.make("dev", "memory", b"keep\n")
        r = self.put(None, raw=b"x" * (brain_edit.MAX_BODY_BYTES + 1))
        self.assertEqual(r.status_code, 413, r.text)
        self.assertEqual(self.target("dev", "memory").read_bytes(), b"keep\n")

    def test_put_non_object_and_non_json_are_422(self):
        self.assertEqual(self.put(None, raw=b"[1,2]").status_code, 422)
        self.assertEqual(self.put(None, raw=b"{nope").status_code, 422)

    def test_put_confirm_and_unknown_agent_map_to_status(self):
        r = self.put({"agent": "nova", "file": "soul", "text": "x", "base_sha": ""})
        self.assertEqual(r.status_code, 428, r.text)
        r = self.put({"agent": "ghost", "file": "memory", "text": "x", "base_sha": ""})
        self.assertEqual(r.status_code, 404, r.text)

    def test_restore_without_header_is_403(self):
        self.make("dev", "memory", b"a\n")
        self.save(text="b\n")
        bid = self.backups("dev", "memory")[-1][:-3]
        r = self.client.post(f"{self.base}/brain/restore", json={
            "agent": "dev", "file": "memory", "id": bid, "base_sha": self.current_sha("dev", "memory")})
        self.assertEqual(r.status_code, 403, r.text)
        self.assertEqual(self.target("dev", "memory").read_bytes(), b"b\n")

    def test_restore_route_round_trip(self):
        self.make("dev", "memory", b"orig\n")
        r = self.put({"agent": "dev", "file": "memory", "text": "edited\n", "base_sha": _sha(b"orig\n")})
        bid = r.json()["backup"]
        r = self.client.post(f"{self.base}/brain/restore", headers=HDR, json={
            "agent": "dev", "file": "memory", "id": bid, "base_sha": self.current_sha("dev", "memory")})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["restored"], bid)
        self.assertEqual(self.target("dev", "memory").read_bytes(), b"orig\n")

    def test_versions_and_version_routes(self):
        self.make("dev", "memory", b"first\n")
        self.put({"agent": "dev", "file": "memory", "text": "second\n", "base_sha": _sha(b"first\n")})
        r = self.client.get(f"{self.base}/brain/versions", params={"agent": "dev", "file": "memory"})
        self.assertEqual(r.status_code, 200, r.text)
        versions = r.json()["versions"]
        self.assertEqual(len(versions), 1)
        vid = versions[0]["id"]
        r = self.client.get(f"{self.base}/brain/version", params={"agent": "dev", "file": "memory", "id": vid})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["text"], "first\n")
        self.assertTrue(r.json()["restorable"])
        for bad in ("../x", "..%2Fx", "nope"):
            r = self.client.get(f"{self.base}/brain/version", params={"agent": "dev", "file": "memory", "id": bad})
            self.assertEqual(r.status_code, 404, bad)
        r = self.client.get(f"{self.base}/brain/versions", params={"agent": "dev", "file": "MEMORY.md"})
        self.assertEqual(r.status_code, 404)

    def test_get_brain_every_file_carries_edit_fields(self):
        self.make("dev", "memory", b"a\n")
        r = self.client.get(f"{self.base}/brain")
        self.assertEqual(r.status_code, 200, r.text)
        found = []

        def walk(node):
            if isinstance(node, dict):
                if "edit_block" in node:
                    found.append(node)
                for v in node.values():
                    walk(v)
            elif isinstance(node, list):
                for v in node:
                    walk(v)

        walk(r.json())
        self.assertTrue(found)
        for f in found:
            self.assertIn("sha", f)
            self.assertIn("editable", f)
            self.assertIn("edit_limit", f)


if __name__ == "__main__":
    unittest.main()
