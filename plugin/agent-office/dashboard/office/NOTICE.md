# Notices: Deck office sprites

The pixel-art sprites in this folder are adapted from **Claude-Office** by W17ANT.

- Source: https://github.com/W17ant/Claude-Office
- Licence: MIT (full text in `LICENSE` next to this file, copied unchanged)
- Copyright (c) 2026 W17ANT

## Shipped files

Source paths are relative to `public/sprites/` in the Claude-Office repository.
Every file was converted from PNG to lossless WebP with ffmpeg (`libwebp -lossless 1`).
Files marked "scaled" were also downscaled with nearest-neighbour (`flags=neighbor`), so pixel edges stay hard.

| Output file | Source | Conversion | Output px (w x h) |
|---|---|---|---|
| char-claude.webp | characters/Claude-1-front-left.png | WebP, scaled 1/8 | 54 x 110 |
| char-frontend.webp | characters/Frontend-dev-1-front-left.png | WebP, scaled 1/8 | 50 x 105 |
| char-me.webp | characters/Me-1-front-left.png | WebP, scaled 1/8 | 56 x 128 |
| char-dev.webp | characters/dev-1-front-left.png | WebP, scaled 1/8 | 38 x 107 |
| char-employee.webp | characters/employee-1-front-left.png | WebP, scaled 1/8 | 54 x 110 |
| char-explore.webp | characters/explore-1-front-left.png | WebP, scaled 1/8 | 46 x 128 |
| char-security.webp | characters/security-audit-1-front-left.png | WebP, scaled 1/8 | 46 x 127 |
| desk.webp | furniture/standing-desk-left-front.png | WebP, scaled 1/4 | 145 x 182 |
| coffee-off.webp | appliances/coffee-off.png | WebP, scaled 1/4 | 74 x 94 |
| whiteboard.webp | decoration/white-board.png | WebP, scaled 1/4 | 187 x 249 |
| plant.webp | decoration/monstera-plant.png | WebP, scaled 1/4 | 98 x 140 |

Only static front-left poses are shipped. Walk frames, rear views, right-hand views and `*-xmas*` variants are not included.

## Excluded on purpose

- `public/sprites/office/**` (Dunder Mifflin characters and props). Its licence is not MIT, so it is not used.
- `public/sprites/cats/**`, `docs/images/**`, and all `*xmas*` files.
- `src/theme.ts` (quotes and copy from the source app).
- Any code from the Claude-Office repository. Only the art is used.

## Changes made to the art

The sprites above were converted to WebP and scaled down, and nothing else was changed. No recolouring, no retouching. Tinting, glows and name tags are applied in CSS at render time.

## Derived per-agent sheets (recoloured)

The seven Hermes agent sheets in `plugin/agent-office/office-build/agent-sprites/` (`hermes-<id>-<pose>.webp` and `hermes-<id>-<pose>-walk<N>.webp`, 112 files) are **derivatives of Claude-Office art** (MIT, Copyright (c) 2026 W17ANT, as above). Each is a copy of one upstream character sheet with its skin, hair, top, inner and accent colours mapped onto the agent's palette from `src/portrait.js`. Outlines, shading steps, alpha and frame sizes are unchanged. The generator is `plugin/agent-office/office-build/agent-sprites.mjs`, and it is deterministic.

| Agent id | Upstream base sheet (`public/sprites/characters/`) |
|---|---|
| hermes-ash | Claude-1 |
| hermes-dev | dev-2 |
| hermes-red | employee-2 |
| hermes-nova | explore-1 |
| hermes-pixel | Frontend-dev-1 |
| hermes-sentinel | security-audit-1 |
| hermes-prism | employee-3 |

Standing poses are lossy WebP (quality 92); walk frames are lossless WebP. Walk frames exist for front-left, front-right and rear-left only.
