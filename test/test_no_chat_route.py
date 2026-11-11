"""Ash chat has no route: the Agent Deck plugin API exposes no chat endpoint, and the wiki chat flag is not on by default.

Checked against plugin_api.py source with ast (no import, so no fastapi needed). Route paths come from the
@router.<method>("...") decorators. Every route path must avoid 'chat', and no route string or WIKI_CHAT_ENABLED
default may turn chat on.
"""
import ast
import re
import unittest
from pathlib import Path

_API = Path(__file__).resolve().parent.parent / "plugin" / "agent-office" / "dashboard" / "plugin_api.py"
_SRC = _API.read_text(encoding="utf-8")
_TREE = ast.parse(_SRC)


def _route_paths():
    paths = []
    for node in ast.walk(_TREE):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            for dec in node.decorator_list:
                if (isinstance(dec, ast.Call) and isinstance(dec.func, ast.Attribute)
                        and isinstance(dec.func.value, ast.Name) and dec.func.value.id == "router"
                        and dec.args and isinstance(dec.args[0], ast.Constant) and isinstance(dec.args[0].value, str)):
                    paths.append(dec.args[0].value)
    return paths


class NoChatRouteTest(unittest.TestCase):
    def test_routes_exist(self):
        # Guard: if the decorator scan finds nothing, the other assertions would pass vacuously.
        self.assertIn("/state", _route_paths())

    def test_no_router_route_path_contains_chat(self):
        bad = [p for p in _route_paths() if "chat" in p.lower()]
        self.assertEqual(bad, [], f"chat routes found: {bad}")

    def test_no_chat_route_string_in_source(self):
        # Any string literal in the module that names a chat route (e.g. "/chat", "chat/") is a red flag.
        strings = [n.value for n in ast.walk(_TREE) if isinstance(n, ast.Constant) and isinstance(n.value, str)]
        # The office UI's own chat route is proxied on purpose (office_route_allowed allows POST /chat, and
        # /chat is the office page's chat). Only that exact value is exempt; the Agent Deck API still gets no
        # chat route, which the decorator check above enforces.
        office_proxy_literals = {"chat"}
        bad = [s for s in strings
               if re.search(r"(^|/)chat(/|$|\?)", s, re.IGNORECASE) and s not in office_proxy_literals]
        self.assertEqual(bad, [], f"chat route strings found: {bad}")

    def test_wiki_chat_flag_not_on_by_default(self):
        # If the flag is read at all, its default must not be 'true' / '1' / 'yes' / 'on'.
        for line in _SRC.splitlines():
            if "WIKI_CHAT_ENABLED" not in line:
                continue
            self.assertIsNone(
                re.search(r"WIKI_CHAT_ENABLED[^\n]*(['\"])(true|1|yes|on)\1", line, re.IGNORECASE),
                f"WIKI_CHAT_ENABLED defaults on: {line.strip()}",
            )


if __name__ == "__main__":
    unittest.main()
