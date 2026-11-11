// Pure fit/zoom model for OfficeHome (the Home iframe). No DOM, no React, no messaging.
// Taken from feat/office-exact (src/office-frame-model.js, Phase 2) and cut down to the zoom part only:
// the postMessage protocol, pick and gesture helpers are not here (the sandboxed adapter is dropped).
// Unit-tested in test/office-zoom.test.js. Kept apart from the old office-frame-model.js, which OfficeFrame
// still imports until the removal commit.
//
// Size: the office page is 1056x682 = a 756px room + a 300px right column. Embed mode (plugin
// office-build/embed.css, under 900px) hides that column and the status strip, so the frame is the room plus the
// 28px title bar: 756 x 613 (the room art 756 / (4800/3584) = 565, plus the title bar and the strip's slack).
// Measured from Claude-Office src/styles/office.css (.app-wrapper 1056x682, .title-bar 28) and src/App.tsx
// (aspectRatio '4800/3584').
export const ROOM_W = 756;
export const ROOM_H = 613;

/** Zoom levels: fit the whole room in the pane (never upscaled), or 1.0x with the pane scrolling. */
export const ZOOM_FIT = 'fit';
export const ZOOM_ONE = 'one';

/** Fit-to-width scale for a box of the given CSS width. Never upscales (pixel art). Unknown width -> 1. */
export function frameScale(width, mode = ZOOM_FIT, roomW = ROOM_W) {
  if (mode === ZOOM_ONE) return 1;
  const w = Number(width);
  if (!Number.isFinite(w) || w <= 0 || !(roomW > 0)) return 1;
  return Math.min(1, w / roomW);
}

/**
 * The zoom after a button press: 'toggle' flips, 'in' means 1.0x, 'out' means fit.
 * A missing or bogus op leaves the mode alone (and an unknown mode falls back to fit).
 */
export function zoomNext(mode, op) {
  const now = mode === ZOOM_ONE ? ZOOM_ONE : ZOOM_FIT;
  if (op === 'toggle') return now === ZOOM_ONE ? ZOOM_FIT : ZOOM_ONE;
  if (op === 'in') return ZOOM_ONE;
  if (op === 'out') return ZOOM_FIT;
  return now;
}

/**
 * The zoom a freshly shown Home starts in: 1.0x on a coarse-pointer landscape screen (the room is wider than
 * tall, so fit-to-width leaves the floor tiny and half the screen empty), fit everywhere else.
 */
export function defaultZoomMode({ coarseLandscape = false } = {}) {
  return coarseLandscape ? ZOOM_ONE : ZOOM_FIT;
}
