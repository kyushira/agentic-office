"""Agent Deck wiki API: wiki.py (unit) and the five GET /api/plugins/agent-office/wiki/... routes through fastapi
TestClient. Every filesystem fixture lives in a temp dir; /opt/data/wiki is never read. Covers the path rules
(traversal, percent, NUL, symlinks, raw/ and _archive/ refusals), the caps (index 64 KB, body 256 KB, list 500,
search 20, q 2..100, tail 1..200), log parsing order, [[links]] and backlinks, redaction of a planted key, the
405 and no-store contract, and a source scan for subprocess, shell, eval and write calls.
"""
import ast
import importlib.util
import json
import os
import shutil
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

_DASH = Path(__file__).resolve().parent.parent / "plugin" / "agent-office" / "dashboard"
_SRC = _DASH / "wiki.py"
BASE = "/api/plugins/agent-office"

KEY = "sk-ant-api03-" + "Q9x" * 8  # a planted provider key, must never leave the server
EVIL = "EVILMARK-7f3a9c"  # outside the root, reachable only through a symlink
LEAK = "LEAKMARK-c0ffee"  # outside the root, inside a symlinked dir
RAW = "RAWMARK-41bc"  # raw/ is never servable
ARCH = "ARCHMARK-88de"  # _archive/ is never servable
MARKERS = (EVIL, LEAK, RAW, ARCH, KEY)

LOG = """# Log

## [2026-01-02] ingest | first source
Added ash.

## [2026-03-05] query | newest one
Asked about ash.

## [2026-02-01] lint | middle
checked all
"""

ASH = """---
title: Ash
type: entity
updated: 2026-04-01
---
# Ash
Ash is an agent. See [[sir]] and [[agent-team|team]] and [[nonexistent]] and [[sir|Sir]] again. Also [[evil]].
"""


def build_tree(root: Path, outside: Path) -> None:
    for d in ("entities", "concepts", "comparisons", "queries", "raw/articles", "_archive"):
        (root / d).mkdir(parents=True)
    outside.mkdir(parents=True, exist_ok=True)

    def w(p: Path, text: str) -> None:
        p.write_text(text, encoding="utf-8")

    w(root / "SCHEMA.md", "# Schema\nPage rules.\n")
    w(root / "index.md", "# Index\n- [[ash]]\n")
    w(root / "log.md", LOG)
    w(root / "entities" / "ash.md", ASH)
    w(root / "entities" / "sir.md", "# Sir\nBoss. Links [[ash]].\n")
    w(root / "entities" / "needle-title.md", "---\ntype: entity\n---\n# Needle title\nNothing here.\n")
    w(root / "entities" / "secret-page.md", "# Secret page\nPlanted needle in prose " + KEY + " end.\n")
    w(root / "concepts" / "agent-team.md",
      "---\ntitle: Agent team\ntype: concept\nupdated: 2026-02-02\n---\nTeam with [[ash|Ash]].\n")
    w(root / "queries" / "q1.md", "Query about needle_phrase here.\n")
    w(root / "raw" / "articles" / "x.md", "raw text " + RAW + "\n")
    w(root / "_archive" / "old.md", "archived " + ARCH + "\n")
    w(outside / "evil.md", "outside file " + EVIL + "\n")
    w(outside / "leak.md", "leaked dir file " + LEAK + "\n")
    os.symlink(outside / "evil.md", root / "entities" / "evil.md")
    ts = datetime(2026, 5, 6, 12, 0, tzinfo=timezone.utc).timestamp()
    os.utime(root / "entities" / "sir.md", (ts, ts))


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


wiki = _load("wiki_under_test", _SRC)


class _Tmp(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="wiki-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.root = self.tmp / "wiki"
        self.outside = self.tmp / "outside"
        build_tree(self.root, self.outside)
        self.r = str(self.root)


class UnitTests(_Tmp):
    def test_index_text(self):
        self.assertEqual(wiki.index(self.r), {"text": "# Index\n- [[ash]]\n"})

    def test_index_413_past_64kb_and_200_at_exactly_64kb(self):
        (self.root / "index.md").write_text("x " * 32768, encoding="utf-8")  # 65536 bytes
        self.assertEqual(len(wiki.index(self.r)["text"]), 65536)
        (self.root / "index.md").write_text("x " * 32768 + "y", encoding="utf-8")  # 65537 bytes
        with self.assertRaises(wiki.WikiError) as cm:
            wiki.index(self.r)
        self.assertEqual(cm.exception.status, 413)

    def test_index_redacts_planted_key(self):
        (self.root / "index.md").write_text("# Index\nkeep " + KEY + "\n", encoding="utf-8")
        text = wiki.index(self.r)["text"]
        self.assertNotIn(KEY, text)
        self.assertIn("[redacted]", text)

    def test_list_entities_shape_and_title_order(self):
        items = wiki.list_pages("entities", self.r)["items"]
        self.assertEqual([i["path"] for i in items],
                         ["entities/ash.md", "entities/needle-title.md", "entities/secret-page.md", "entities/sir.md"])
        ash = items[0]
        self.assertEqual(ash, {"path": "entities/ash.md", "title": "Ash", "type": "entity", "updated": "2026-04-01"})
        sir = items[3]
        self.assertEqual(sir["title"], "Sir")  # first '# ' heading
        self.assertIsNone(sir["type"])
        self.assertEqual(sir["updated"], "2026-05-06")  # mtime, UTC date
        self.assertEqual(items[1]["title"], "Needle title")

    def test_list_title_falls_back_to_stem(self):
        (self.root / "queries" / "plain-stem.md").write_text("no heading here\n", encoding="utf-8")
        items = wiki.list_pages("queries", self.r)["items"]
        titles = {i["path"]: i["title"] for i in items}
        self.assertEqual(titles["queries/plain-stem.md"], "plain-stem")
        self.assertEqual(titles["queries/q1.md"], "q1")

    def test_list_rejects_other_dirs(self):
        for bad in ("raw", "_archive", "", "Entities", "entities/..", "../entities", None):
            with self.subTest(dir=bad), self.assertRaises(wiki.WikiError) as cm:
                wiki.list_pages(bad, self.r)
            self.assertEqual(cm.exception.status, 400)

    def test_list_skips_symlinked_entries(self):
        paths = [i["path"] for i in wiki.list_pages("entities", self.r)["items"]]
        self.assertNotIn("entities/evil.md", paths)

    def test_list_capped_at_500(self):
        for i in range(510):
            (self.root / "entities" / f"n{i:03d}.md").write_text(f"# N{i:03d}\n", encoding="utf-8")
        self.assertEqual(len(wiki.list_pages("entities", self.r)["items"]), 500)

    def test_page_happy_path(self):
        out = wiki.page("entities/ash.md", self.r)
        self.assertEqual(out["path"], "entities/ash.md")
        self.assertEqual(out["title"], "Ash")
        self.assertEqual(out["frontmatter"], {"title": "Ash", "type": "entity", "updated": "2026-04-01"})
        self.assertTrue(out["body"].startswith("# Ash\n"))
        self.assertNotIn("title: Ash", out["body"])
        self.assertFalse(out["truncated"])
        self.assertEqual(out["links"], [
            {"slug": "sir", "path": "entities/sir.md"},
            {"slug": "agent-team", "path": "concepts/agent-team.md"},
            {"slug": "nonexistent", "path": None},
            {"slug": "evil", "path": None},  # the symlinked page is not servable, so it does not resolve
        ])
        self.assertEqual(out["backlinks"], [
            {"path": "concepts/agent-team.md", "title": "Agent team"},
            {"path": "entities/sir.md", "title": "Sir"},
            {"path": "index.md", "title": "Index"},
        ])

    def test_page_root_files_are_servable(self):
        self.assertEqual(wiki.page("SCHEMA.md", self.r)["title"], "Schema")
        self.assertEqual(wiki.page("log.md", self.r)["path"], "log.md")

    def test_page_body_capped_at_256kb(self):
        (self.root / "entities" / "big.md").write_text("hello world " * 30000, encoding="utf-8")
        out = wiki.page("entities/big.md", self.r)
        self.assertTrue(out["truncated"])
        self.assertLessEqual(len(out["body"].encode("utf-8")), 256 * 1024)
        self.assertGreater(len(out["body"].encode("utf-8")), 256 * 1024 - 16)

    def test_page_redacts_planted_key(self):
        out = wiki.page("entities/secret-page.md", self.r)
        self.assertNotIn(KEY, out["body"])
        self.assertIn("[redacted]", out["body"])

    def test_page_refusals_are_404_and_leak_nothing(self):
        bad = [
            "../x.md", "entities/../../etc/passwd", "entities/../SCHEMA.md", "/etc/passwd",
            "entities\\ash.md", "entities/ash.md\x00", "entities/ash.md\n", "entities/ash.txt",
            "raw/articles/x.md", "_archive/old.md", "entities/evil.md", "entities//ash.md",
            "", "entities/ash.md ", "entities/a b.md", "./index.md", "entities/%2e%2e",
            "%2e%2e%2fx.md", "entities/..%2fSCHEMA.md", "entities/ash.md%00", "entities/" + "a" * 200 + ".md",
            "concepts/nope.md", "SCHEMA.md/x", "ENTITIES/ash.md", "entities/ash.MD", "entities/.hidden.md",
        ]
        for p in bad:
            with self.subTest(path=p):
                with self.assertRaises(wiki.WikiError) as cm:
                    wiki.page(p, self.r)
                self.assertEqual(cm.exception.status, 404)
                self.assertEqual(cm.exception.message, "not found")

    def test_symlinked_dir_is_not_served(self):
        os.rmdir(self.root / "comparisons")
        (self.outside / "cdir").mkdir()
        (self.outside / "cdir" / "c.md").write_text("dir leak " + LEAK + "\n", encoding="utf-8")
        os.symlink(self.outside / "cdir", self.root / "comparisons")
        self.assertEqual(wiki.list_pages("comparisons", self.r), {"items": []})
        with self.assertRaises(wiki.WikiError):
            wiki.page("comparisons/c.md", self.r)
        self.assertEqual(wiki.search("LEAKMARK", self.r), {"results": []})

    def test_search_title_hits_first_then_body(self):
        res = wiki.search("needle", self.r)["results"]
        self.assertEqual([r["path"] for r in res],
                         ["entities/needle-title.md", "entities/secret-page.md", "queries/q1.md"])
        self.assertEqual(res[0]["title"], "Needle title")
        self.assertIn("needle", res[2]["snippet"].lower())
        self.assertLessEqual(len(res[2]["snippet"]), 160)

    def test_search_snippet_is_redacted(self):
        res = wiki.search("needle", self.r)["results"]
        secret = [r for r in res if r["path"] == "entities/secret-page.md"][0]
        self.assertNotIn(KEY, secret["snippet"])
        self.assertIn("[redacted]", secret["snippet"])

    def test_search_capped_at_20(self):
        for i in range(25):
            (self.root / "concepts" / f"s{i:02d}.md").write_text(f"# Needle {i}\n", encoding="utf-8")
        self.assertEqual(len(wiki.search("needle", self.r)["results"]), 20)

    def test_search_length_bounds(self):
        for q in ("a", " a ", "x" * 101, "   "):
            with self.subTest(q=q), self.assertRaises(wiki.WikiError) as cm:
                wiki.search(q, self.r)
            self.assertEqual(cm.exception.status, 400)
        self.assertEqual(wiki.search("x" * 100, self.r), {"results": []})
        self.assertEqual(wiki.search("  zzqq  ", self.r), {"results": []})

    def test_search_never_returns_raw_archive_or_symlink(self):
        for q in ("RAWMARK", "ARCHMARK", "EVILMARK", "MARK", "LEAKMARK", "outside file"):
            with self.subTest(q=q):
                self.assertEqual(wiki.search(q, self.r), {"results": []})

    def test_log_newest_first_and_tail(self):
        entries = wiki.log(None, self.r)["entries"]
        self.assertEqual([e["date"] for e in entries], ["2026-03-05", "2026-02-01", "2026-01-02"])
        self.assertEqual(entries[0], {"date": "2026-03-05", "action": "query", "subject": "newest one",
                                      "body": "Asked about ash."})
        self.assertEqual(entries[1]["body"], "checked all")
        self.assertEqual([e["subject"] for e in wiki.log("1", self.r)["entries"]], ["newest one"])

    def test_log_same_date_later_in_file_comes_first(self):
        (self.root / "log.md").write_text(
            "## [2026-01-01] a | first\n\n## [2026-01-01] b | second\n", encoding="utf-8")
        self.assertEqual([e["action"] for e in wiki.log(None, self.r)["entries"]], ["b", "a"])

    def test_log_tail_bounds(self):
        for t in ("0", "201", "abc", "-1", "", "1.5", " 5"):
            with self.subTest(tail=t), self.assertRaises(wiki.WikiError) as cm:
                wiki.log(t, self.r)
            self.assertEqual(cm.exception.status, 400)
        self.assertEqual(len(wiki.log("200", self.r)["entries"]), 3)

    def test_log_missing_is_empty(self):
        (self.root / "log.md").unlink()
        self.assertEqual(wiki.log(None, self.r), {"entries": []})

    def test_backlinks_include_labelled_links(self):
        out = wiki.page("entities/sir.md", self.r)
        self.assertEqual(out["backlinks"], [{"path": "entities/ash.md", "title": "Ash"}])

    def test_mtime_updated_is_utc_date(self):
        ts = datetime(2026, 1, 31, 23, 30, tzinfo=timezone.utc).timestamp()
        os.utime(self.root / "entities" / "sir.md", (ts, ts))
        items = {i["path"]: i for i in wiki.list_pages("entities", self.r)["items"]}
        self.assertEqual(items["entities/sir.md"]["updated"], "2026-01-31")


class EndpointTests(_Tmp):
    def setUp(self):
        super().setUp()
        self._env = {k: os.environ.get(k) for k in ("AGENT_DECK_WIKI_ROOT", "AGENT_OFFICE_ROOT")}
        os.environ["AGENT_DECK_WIKI_ROOT"] = str(self.root)
        os.environ["AGENT_OFFICE_ROOT"] = str(self.tmp / "office-root")
        self.addCleanup(self._restore_env)
        api = _load("plugin_api_wiki_test", _DASH / "plugin_api.py")
        app = FastAPI()
        app.include_router(api.router, prefix=BASE)
        self.c = TestClient(app)

    def _restore_env(self):
        for k, v in self._env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def _get(self, route, **params):
        r = self.c.get(BASE + "/wiki/" + route, params=params)
        self.assertEqual(r.headers.get("cache-control"), "no-store", route)
        return r

    def test_happy_routes(self):
        r = self._get("index")
        self.assertEqual(r.status_code, 200)
        self.assertIn("text", r.json())
        r = self._get("list", dir="entities")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(sorted(r.json()), ["items"])
        r = self._get("page", path="entities/ash.md")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(set(r.json()), {"path", "title", "frontmatter", "body", "links", "backlinks", "truncated"})
        r = self._get("search", q="needle")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(sorted(r.json()), ["results"])
        r = self._get("log")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(sorted(r.json()["entries"][0]), ["action", "body", "date", "subject"])

    def test_bad_params_are_400(self):
        cases = [
            ("list", {"dir": "raw"}), ("list", {}), ("search", {"q": "a"}), ("search", {"q": "x" * 101}),
            ("search", {}), ("log", {"tail": "0"}), ("log", {"tail": "201"}), ("log", {"tail": "abc"}),
        ]
        for route, params in cases:
            with self.subTest(route=route, params=params):
                r = self._get(route, **params)
                self.assertEqual(r.status_code, 400)
                self.assertEqual(r.json(), {"error": "bad parameter"})

    def test_page_without_path_is_400(self):
        self.assertEqual(self._get("page").status_code, 400)

    def test_index_413_through_route(self):
        (self.root / "index.md").write_text("x " * 32768 + "y", encoding="utf-8")
        r = self._get("index")
        self.assertEqual(r.status_code, 413)
        self.assertEqual(r.json(), {"error": "too large"})

    def test_refusals_share_one_body_and_status(self):
        bodies = set()
        for p in ("../x.md", "entities/../../etc/passwd", "%2e%2e%2fx.md", "entities/..%2fSCHEMA.md",
                  "/etc/passwd", "entities\\ash.md", "entities/ash.md%00", "entities/ash.txt",
                  "raw/articles/x.md", "_archive/old.md", "entities/evil.md", "entities/missing.md"):
            r = self._get("page", path=p)
            self.assertEqual(r.status_code, 404, p)
            bodies.add(r.text)
        self.assertEqual(bodies, {'{"error":"not found"}'})

    def test_raw_percent_forms_are_refused(self):
        # The decoded value still holds '%', so it is refused whatever it would have named.
        for raw in ("%2e%2e%2fx.md", "entities%2F..%2FSCHEMA.md"):
            with self.subTest(raw=raw):
                r = self.c.get(BASE + "/wiki/page?path=" + raw)
                self.assertEqual(r.status_code, 404)
                self.assertNotIn(EVIL, r.text)

    def test_wrong_methods_are_405(self):
        for route in ("index", "list", "page", "search", "log"):
            for method in ("post", "put", "delete"):
                with self.subTest(route=route, method=method):
                    r = getattr(self.c, method)(BASE + "/wiki/" + route, params={"dir": "entities",
                                                                                 "path": "index.md",
                                                                                 "q": "needle", "tail": "1"})
                    self.assertEqual(r.status_code, 405)

    def test_no_marker_or_key_in_any_response(self):
        texts = []
        texts.append(self._get("index").text)
        for d in ("entities", "concepts", "comparisons", "queries"):
            texts.append(self._get("list", dir=d).text)
        for rel in ("SCHEMA.md", "index.md", "log.md", "entities/ash.md", "entities/secret-page.md",
                    "entities/evil.md", "raw/articles/x.md", "_archive/old.md"):
            texts.append(self._get("page", path=rel).text)
        for q in ("needle", "ash", "MARK", "outside", "page", "file", "sk-ant"):
            texts.append(self._get("search", q=q).text)
        texts.append(self._get("log", tail="200").text)
        blob = "\n".join(texts)
        for m in MARKERS:
            self.assertNotIn(m, blob)

    def test_symlinked_dir_variant_through_routes(self):
        os.rmdir(self.root / "comparisons")
        (self.outside / "cdir").mkdir()
        (self.outside / "cdir" / "c.md").write_text("dir leak " + LEAK + "\n", encoding="utf-8")
        os.symlink(self.outside / "cdir", self.root / "comparisons")
        self.assertEqual(self._get("list", dir="comparisons").json(), {"items": []})
        self.assertEqual(self._get("page", path="comparisons/c.md").status_code, 404)
        self.assertEqual(self._get("search", q="LEAKMARK").json(), {"results": []})
        self.assertNotIn(LEAK, self._get("search", q="dir").text)


class SourceScanTests(unittest.TestCase):
    """wiki.py must not spawn processes, run code, write, or log."""

    IMPORTS = {"importlib", "os", "re", "stat", "datetime", "pathlib"}
    BAD_OS = {"system", "popen", "remove", "unlink", "rename", "replace", "mkdir", "makedirs", "rmdir",
              "removedirs", "chmod", "chown", "utime", "truncate", "symlink", "link", "fork", "kill",
              "execv", "execve", "spawnv", "spawnve", "startfile"}
    BAD_ATTR = {"O_WRONLY", "O_RDWR", "O_CREAT", "O_TRUNC", "O_APPEND", "O_EXCL"}
    BAD_NAME = {"eval", "exec", "compile", "__import__", "open", "input", "breakpoint"}

    def test_source_scan(self):
        tree = ast.parse(_SRC.read_text(encoding="utf-8"))
        problems = []
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for a in node.names:
                    if a.name.split(".")[0] not in self.IMPORTS:
                        problems.append(f"import {a.name}")
            elif isinstance(node, ast.ImportFrom):
                if (node.module or "").split(".")[0] not in self.IMPORTS:
                    problems.append(f"from {node.module} import ...")
            elif isinstance(node, ast.Name) and node.id in self.BAD_NAME | {"subprocess", "shutil", "logging",
                                                                             "socket", "ctypes", "pty"}:
                problems.append(f"name {node.id}")
            elif isinstance(node, ast.Attribute):
                if node.attr in self.BAD_ATTR:
                    problems.append(f"attr {node.attr}")
                if isinstance(node.value, ast.Name) and node.value.id == "os" and node.attr in self.BAD_OS:
                    problems.append(f"os.{node.attr}")
        self.assertEqual(problems, [])


if __name__ == "__main__":
    unittest.main()
