# Agent Office

A Hermes dashboard plugin ("Office" tab) that shows the agent team as a live 3D isometric office.
It's read-only, and its data endpoint sits behind the dashboard login.

- Frontend: three.js scene (`src/scene.js`) + React UI (React comes from the dashboard SDK), built to `plugin/agent-office/dashboard/dist/`.
- Backend: `plugin/agent-office/dashboard/plugin_api.py` → `GET /api/plugins/agent-office/state`. It reads each profile's `state.db` read-only (`mode=ro`), polls every 5s and caches for 4s. It never reads message text, tool arguments, config secrets or `.env`.

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
