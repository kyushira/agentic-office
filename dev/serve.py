"""Local test server (temporary, for development and screenshots only).

Serves the dev harness, the built plugin files and the plugin's real API router,
the same paths the Hermes dashboard uses. Binds to 127.0.0.1 only.

    /opt/hermes/.venv/bin/python -I dev/serve.py [port]
"""
import importlib.util
import sys
from pathlib import Path

import uvicorn
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent.parent
PLUGIN = ROOT / "plugin/agent-office/dashboard"
spec = importlib.util.spec_from_file_location("plugin_api", PLUGIN / "plugin_api.py")
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)

app = FastAPI()
app.include_router(api.router, prefix="/api/plugins/agent-office")
app.mount("/dashboard-plugins/agent-office", StaticFiles(directory=PLUGIN), name="plugin")
app.mount("/", StaticFiles(directory=ROOT / "dev/dist", html=True), name="harness")

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=int(sys.argv[1]) if len(sys.argv) > 1 else 8790, log_level="warning")
