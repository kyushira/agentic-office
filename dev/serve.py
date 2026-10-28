"""Local test server (temporary, for development and screenshots only).

Serves the dev harness, the built plugin files and the plugin's real API router,
the same paths the Hermes dashboard uses. Binds to 127.0.0.1 only.

    /opt/hermes/.venv/bin/python -I dev/serve.py [port] [--demo]

--demo (harness only, never shipped): adds sample helpers, toasts and Brain trips on top of the
real snapshot so the v2 animations can be checked when no agent happens to be delegating.
"""
import copy
import importlib.util
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
        return s

app.include_router(api.router, prefix="/api/plugins/agent-office")
app.mount("/dashboard-plugins/agent-office", StaticFiles(directory=PLUGIN), name="plugin")
app.mount("/", StaticFiles(directory=ROOT / "dev/dist", html=True), name="harness")

if __name__ == "__main__":
    port = next((int(a) for a in sys.argv[1:] if a.isdigit()), 8790)
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
