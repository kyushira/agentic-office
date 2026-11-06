// Pure logic for the desktop left icon rail (unit-tested in test/rail-model.test.js).
// No DOM access here: Rail.jsx measures the page and passes plain numbers in.

/**
 * Rail buttons, top to bottom. Each one scrolls to and focuses an existing element on the same page
 * (never switches a view). `target` is the element id; `fallback` is used when the target is not
 * rendered (Needs you only exists while something needs the user).
 */
export const RAIL_SECTIONS = [
  { id: 'office', label: 'Office', target: 'dk-pane-office' },
  { id: 'needs', label: 'Needs you', target: 'dk-needs', fallback: 'dk-roster' },
  { id: 'live', label: 'Live and Comms', target: 'dk-pane-comms' },
  { id: 'usage', label: 'Usage (5h reset)', target: 'dk-sec-usage' },
];

/** Reference line as a fraction of the scroll area's height: a section whose top has passed it is "current". */
export const RAIL_LINE = 0.3;

/** Tops within this many px count as the same row (side-by-side sections share a top). */
const TIE_PX = 2;

/** True when the scroll area is at (or within `slack` px of) its end. */
export function isAtBottom(scrollTop, clientHeight, scrollHeight, slack = 4) {
  return scrollTop + clientHeight >= scrollHeight - slack;
}

/**
 * Picks the active rail id from measured sections.
 *   items:    [{ id, top, visible }] in rail order. top is px from the top of the scroll area (null when the
 *             section is not rendered); visible is whether it overlaps the scroll area.
 *   line:     reference line in px (RAIL_LINE of the scroll area height).
 *   atBottom: the scroll area is at its end, so the last visible section wins (a short page can never
 *             scroll its last section up to the line).
 *   current:  the id active now. It is kept while it still ties for the best position, so a click on a
 *             side-by-side section is not undone by its neighbour.
 * Returns the chosen id, or `current` when nothing is measurable.
 */
export function pickActive({ items, line, atBottom = false, current = null }) {
  const live = (items || []).filter(i => i && i.visible && typeof i.top === 'number');
  if (!live.length) return current;
  let pool;
  if (atBottom) {
    pool = live;
  } else {
    const above = live.filter(i => i.top <= line);
    if (above.length) {
      pool = above;
    } else {   // all below the line: the topmost row (ties included) is the pool
      const topmost = Math.min(...live.map(i => i.top));
      pool = live.filter(i => i.top - topmost <= TIE_PX);
    }
  }
  const best = Math.max(...pool.map(i => i.top));
  const tied = pool.filter(i => best - i.top <= TIE_PX);
  if (current && tied.some(i => i.id === current)) return current;
  return tied[tied.length - 1].id;
}
