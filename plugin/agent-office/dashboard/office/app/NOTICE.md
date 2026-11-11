# NOTICE — Claude-Office scene (office/app)

This directory is a port of the **Claude-Office** scene.

- Upstream project: Claude-Office by W17ANT — https://github.com/W17ant/Claude-Office
- Upstream version: v1.1.2
- Upstream commit: b2354706a3495fe245aec27392c2458c148800ca
- Upstream license: MIT. Full text in `LICENSE` beside this file (Copyright (c) 2026 W17ANT).

## What changed in this port (Phase 1a)

- Built from the upstream `src/` and `public/` with a Vite production build
  (classic IIFE script, no module scripts, no CORS-dependent requests).
- Removed: Dunder Mifflin assets and theme (Office sprites, `*-dm*` rooms,
  Dunder logos, Office chatter pools), seasonal (`*-xmas*`) art, the Slack chat
  panel, permission cards, the advent calendar, viewer / auth / server-settings
  modules, and every network request.
- Fonts are inlined as `data:` URIs (see below). The Google Fonts `@import` is removed.
- Random events and sound are OFF by default.

## Third-party fonts (SIL Open Font License 1.1)

- JetBrains Mono — Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)
- Press Start 2P — Copyright 2012 The Press Start 2P Project Authors (cody@zone38.net)

The OFL texts are in `fonts-OFL.txt` beside this file.

## Not included

The Dunder Mifflin assets and theme from the upstream project are excluded from
this build and are not redistributed here.
