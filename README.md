# Agent Office

A Hermes dashboard plugin ("Office" tab) that shows the agent team as a live 3D isometric office.
It's read-only, and its data endpoint sits behind the dashboard login.

- Frontend: three.js scene (`src/scene.js`) + React UI (React comes from the dashboard SDK), built to `plugin/agent-office/dashboard/dist/`.
- Backend: `plugin/agent-office/dashboard/plugin_api.py` → `GET /api/plugins/agent-office/state`. It reads each profile's `state.db` read-only (`mode=ro`), polls every 5s and caches for 4s. The state payload never includes message text or tool arguments, and it never reads config secrets or `.env`.
- Feed and comms: `GET /api/plugins/agent-office/feed?agent=&since=&limit=` returns newest-first assistant text, tool-call names with a short argument, and tool results (only assistant and tool rows; user messages are never read out). `GET /api/plugins/agent-office/comms?since=&limit=` returns `message_agent` and `delegate_task` calls from each sender's own db. Both are read-only and pass every string through `dashboard/redact.py` on the server before it leaves the API: provider keys (sk-, ghp_, AIza, xox, AKIA), bearer tokens, `key/token/secret/password` values, PEM private keys, `.env`-style blocks and 33+ character hex/base64 runs become `[redacted]`; a `.env` file reference (in arguments or in the result of that call) becomes `[redacted: .env file]`. Config secrets and `.env` contents are never read.

## Develop

    export PATH=/opt/hermes/tools/node-26.12.1-linux-x64/bin:$PATH
    npm install && npm run build && npm test
    /opt/hermes/.venv/bin/python -I dev/serve.py 8790          # local harness on 127.0.0.1 only
    /opt/hermes/.venv/bin/python -I dev/serve.py 8790 --demo   # + sample helpers/toasts/Brain trips (harness only)

## What it shows (all from real data)

- Rooms: one per profile (default + profiles/*), status from state.db activity and the latest tool *name*.
- Helpers: running delegate_task children from `cache/delegation/live/*/manifest.json` beam in at spare desks, tagged
  "Sub N · short goal · model". They fade out when their task log ends.
- Brain trips: `memory` / `session_search` calls and vault reads/writes make a character carry a tablet to the Brain.
- Toasts: sessions started/finished, helpers started/finished, pushes (remote-ref reflogs under /opt/data/projects).

## Install (default profile)

    mkdir -p /opt/data/plugins/agent-office
    tar -C plugin/agent-office --exclude=__pycache__ -cf - dashboard | tar -C /opt/data/plugins/agent-office -xf -
    # add "agent-office" under plugins.enabled in /opt/data/config.yaml (needed for the API route),
    # then restart the dashboard (or hit /api/dashboard/plugins/rescan while logged in)

## Disable

    mv /opt/data/plugins/agent-office /opt/data/agent-office.disabled

The dashboard notices the folder is gone and drops the tab. Optionally remove `agent-office` from `plugins.enabled` too.
