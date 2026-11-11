"""Local test server (temporary, for development and screenshots only).

Serves the dev harness, the built plugin files and the plugin's real API router,
the same paths the Hermes dashboard uses. Binds to 127.0.0.1 only.

    /opt/hermes/.venv/bin/python -I dev/serve.py [port] [--demo] [--brain-root <dir>]

--demo (harness only, never shipped): adds sample helpers, toasts and Brain trips on top of the
real snapshot so the v2 animations can be checked when no agent happens to be delegating.

--brain-root <dir> (ALWAYS pass it when testing the Brain editor): the Brain read and write routes use <dir>
instead of /opt/data, and backups go to <dir>/deck-backups. <dir> must hold a copy of the agent files in the
same layout (SOUL.md, memories/MEMORY.md, memories/USER.md, profiles/<agent>/...). Without it the harness
would write to the real agent files, so the server warns loudly. It refuses <dir> = /opt/data.
"""
import copy
import importlib.util
import json
import sys
import time
from pathlib import Path

import uvicorn
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent.parent
PLUGIN = ROOT / "plugin/agent-office/dashboard"
spec = importlib.util.spec_from_file_location("plugin_api", PLUGIN / "plugin_api.py")
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)
DEMO = "--demo" in sys.argv
T0 = time.time()


def _brain_root_arg(argv):
    """The directory after --brain-root, or None. Exits with a message if the flag has no directory."""
    if "--brain-root" not in argv:
        return None
    i = argv.index("--brain-root")
    if i + 1 >= len(argv) or argv[i + 1].startswith("--"):
        sys.exit("serve.py: --brain-root needs a directory")
    return Path(argv[i + 1])


BRAIN_ROOT = _brain_root_arg(sys.argv)
if BRAIN_ROOT is not None:
    root = BRAIN_ROOT.resolve()
    if root == Path("/opt/data").resolve():
        sys.exit("serve.py: refusing --brain-root /opt/data (that is the real agent data)")
    api.brain.DEFAULT_ROOT = root
    api.brain_edit.DEFAULT_BACKUP_ROOT = root / "deck-backups"
    print(f"serve.py: Brain root = {root}, backups = {root / 'deck-backups'}", file=sys.stderr)
else:
    print("!!! serve.py: NO --brain-root. Brain write routes (PUT /brain, restore) act on REAL agent files "
          "under /opt/data. Pass --brain-root <temp copy> for any test. !!!", file=sys.stderr)

app = FastAPI()
if DEMO:
    @app.get("/api/plugins/agent-office/state")
    def demo_state():
        s = copy.deepcopy(api.collect.snapshot())
        now, k = time.time(), int((time.time() - T0) // 20)       # a new "batch" every 20s
        for a in s["agents"]:
            if a["id"] == "dev":
                tasks = ["Run test suite and report", "Phone screenshots", "Review diff for bugs"][: 2 + k % 2]
                a["helpers"] = [{"id": f"demo{k}-{i}", "task": t, "model": "Haiku", "activity": "running commands", "since": now}
                                for i, t in enumerate(tasks)]
                a["activity"], a["status"] = f"delegating · {len(a['helpers'])} helpers", "working"
            a["brainTrips"] = [{"id": f"demo-{a['id']}-{k}", "at": now - 1, "kind": "write"}]
        s["events"] = [{"id": f"demo-ev{k}", "at": now - 1, "kind": "helpers", "agent": "dev", "text": f"{2 + k % 2} helpers started"},
                       {"id": f"demo-ev{k}b", "at": now - 2, "kind": "session", "agent": "default", "text": "session started · telegram"}]
        s["counts"]["helpers"] = sum(len(a["helpers"]) for a in s["agents"])
        s["walks"] = [{"id": f"demo-w{k}", "at": now - 1, "from": "default", "to": "dev", "kind": "brief", "subject": "Agent Office v2.1"},
                      {"id": f"demo-w{k}r", "at": now - 1, "from": "red", "to": "default", "kind": "reply", "subject": "Jev research notes"}]
        s["events"] += [{"id": f"demo-ev{k}w", "at": now - 1, "kind": "walk", "agent": "default", "text": "→ Dev · new brief"}]
        return s

FAKE_STATE = None
if "--fake-state" in sys.argv:
    # Harness only: GET /state returns the JSON file at this path, re-read on every request, so a test can
    # script agents (working, waiting, error, offline) by rewriting the file. The real collector is not called.
    i = sys.argv.index("--fake-state")
    if i + 1 >= len(sys.argv) or sys.argv[i + 1].startswith("--"):
        sys.exit("serve.py: --fake-state needs a file path")
    FAKE_STATE = Path(sys.argv[i + 1])

    @app.get("/api/plugins/agent-office/state")
    def fake_state():
        return json.loads(FAKE_STATE.read_text(encoding="utf-8"))

app.include_router(api.router, prefix="/api/plugins/agent-office")
app.mount("/dashboard-plugins/agent-office", StaticFiles(directory=PLUGIN), name="plugin")
app.mount("/", StaticFiles(directory=ROOT / "dev/dist", html=True), name="harness")

if __name__ == "__main__":
    port = next((int(a) for a in sys.argv[1:] if a.isdigit()), 8790)
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
