# Agent Office

A Hermes dashboard plugin ("Office" tab) that shows the agent team as a live 3D isometric office.
It's read-only, and its data endpoint sits behind the dashboard login.

- Frontend: three.js scene (`src/scene.js`) + React UI (React comes from the dashboard SDK), built to `plugin/agent-office/dashboard/dist/`.
- Backend: `plugin/agent-office/dashboard/plugin_api.py` → `GET /api/plugins/agent-office/state`. It reads each profile's `state.db` read-only (`mode=ro`), polls every 5s and caches for 4s. The state payload never includes message text or tool arguments, and it never reads config secrets or `.env`.
- Feed and comms: `GET /api/plugins/agent-office/feed?agent=&since=&limit=` returns newest-first assistant text, tool-call names with a short argument, and tool results (only assistant and tool rows; user messages are never read out). `GET /api/plugins/agent-office/comms?since=&limit=` returns `message_agent` and `delegate_task` calls from each sender's own db. Both are read-only and pass every string through `dashboard/redact.py` on the server before it leaves the API: provider keys (sk-, ghp_, AIza, xox, AKIA), bearer tokens, `key/token/secret/password` values, PEM private keys, `.env`-style blocks and 33+ character hex/base64 runs become `[redacted]`; a `.env` file reference (in arguments or in the result of that call) becomes `[redacted: .env file]`. Config secrets and `.env` contents are never read.

- Projects: `GET /api/plugins/agent-office/projects` (cached 30s) lists the folders under `/opt/data/projects`, one card each: last commit (read-only `git log`, 3s timeout), briefs, and a status (active under 3 days, quiet 3 to 7, stale over 7). Only `owner` and `next` come from the registry below. Read-only; `dashboard/projects.py`.

## Projects registry

`/opt/data/projects/projects.json` is optional and hand-written. It is the only source of owner and next step on the Projects tab:

    {"projects": {"<folder name>": {"owner": "dev", "next": "what is next", "note": "", "source": "_briefs/x.md"}}}

- Keys are project folder names. A folder with no entry shows "not set" for owner and next step.
- `owner` and `next` are strings (blank counts as not set); `note` and `source` are free text for people and are not shown.
- Every string is redacted server-side. A missing file gives "No projects.json registry" on the tab; a malformed file is reported as an error and never crashes the API.
- The file lives outside the repo and is not committed.

## Memory

`GET /api/plugins/agent-office/memory?q=&agent=&limit=` is a read-only full-text search over assistant and tool
messages in every Hermes `state.db`. It uses the existing `messages_fts` FTS5 index and falls back to a LIKE scan of
the last 5000 rows per DB when that index is missing (the response says which mode ran). User messages are never
searched or returned. Snippets are redacted: secrets, e-mail addresses, and absolute paths outside
`/opt/data/projects`. `limit` is clamped to 1-50 and `q` is capped at 200 characters. Code:
`plugin/agent-office/dashboard/memory.py`; tests: `test/test_memory.py`.

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
