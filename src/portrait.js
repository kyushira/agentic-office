// Hand-authored 32×32 pixel-art busts (no image assets): each character is drawn from a few
// shapes on a grid, then outlined and rim-shaded the same way so they share one style.
// Pure; unit-tested in test/portrait.test.js.
export const SIZE = 32;
const OUTLINE = '#14122a';

const PEOPLE = {
  ash: { skin: '#f1c3a1', hair: '#2b1f33', top: '#1f2f63', inner: '#4f86e8', eye: '#9fd4ff', kind: 'ash' },
  dev: { skin: '#e9b48e', hair: '#231a1c', top: '#2f9e5c', inner: '#2f9e5c', eye: '#b6ffcf', kind: 'dev' },
  red: { skin: '#f3cfb0', hair: '#5a2a22', top: '#e0582e', inner: '#f2e6d0', eye: '#ffd2a8', kind: 'red' },
};
const HELPER_TINT = { haiku: '#ff9a3c', gemini: '#4f8bff' };

function mix(hex, k) {             // k < 0 darker, k > 0 lighter
  const n = parseInt(hex.slice(1), 16), c = [n >> 16, (n >> 8) & 255, n & 255];
  const t = k < 0 ? 0 : 255, a = Math.abs(k);
  return '#' + c.map(v => Math.round(v + (t - v) * a).toString(16).padStart(2, '0')).join('');
}

function canvas() {
  const g = Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
  const set = (x, y, c) => { if (x >= 0 && y >= 0 && x < SIZE && y < SIZE) g[y][x] = c; };
  return {
    g, set,
    rect(x0, y0, x1, y1, c) { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(x, y, c); },
    ellipse(cx, cy, rx, ry, c, clip = () => true) {
      for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++)
        for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++)
          if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1 && clip(x, y)) set(x, y, c);
    },
    trap(y0, y1, x0a, x1a, x0b, x1b, c) {              // rows y0..y1, edges interpolate a → b
      for (let y = y0; y <= y1; y++) {
        const t = (y - y0) / Math.max(1, y1 - y0);
        this.rect(Math.round(x0a + (x0b - x0a) * t), y, Math.round(x1a + (x1b - x1a) * t), y, c);
      }
    },
  };
}

/** Warm rim light on left edges, cool shadow on right edges and under the jaw, then a dark outline. */
function finish(g, noShade = new Set()) {
  const filled = (x, y) => y >= 0 && y < SIZE && x >= 0 && x < SIZE && g[y][x] !== null;
  const out = g.map(r => r.slice());
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const c = g[y][x];
    if (c === null || noShade.has(c)) continue;
    if (!filled(x + 1, y) || !filled(x + 2, y)) out[y][x] = mix(c, -0.28);
    else if (!filled(x - 1, y)) out[y][x] = mix(c, 0.22);
  }
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    if (g[y][x] !== null) continue;
    if (filled(x - 1, y) || filled(x + 1, y) || filled(x, y - 1) || filled(x, y + 1)) out[y][x] = OUTLINE;
  }
  for (let x = 0; x < SIZE; x++) if (g[SIZE - 1][x] !== null) out[SIZE - 1][x] = out[SIZE - 1][x];   // crop edge stays open
  return out;
}

function bust(p) {
  const C = canvas(), { rect, ellipse, set } = C;
  const shadowSkin = mix(p.skin, -0.18);
  // back hair (Red's shoulder-length sides sit behind the face)
  if (p.kind === 'red') { rect(8, 9, 10, 21, p.hair); rect(21, 9, 23, 21, p.hair); rect(9, 21, 11, 22, p.hair); rect(20, 21, 22, 22, p.hair); }
  // torso + hood collar
  C.trap(23, 31, 9, 22, 4, 27, p.top);
  rect(11, 20, 20, 23, mix(p.top, -0.15));
  if (p.kind === 'ash') C.trap(23, 31, 14, 17, 12, 19, p.inner);            // blue hoodie under the blazer
  if (p.kind === 'red') { C.trap(23, 31, 14, 17, 13, 18, p.inner); set(13, 27, '#7a2b17'); set(13, 30, '#7a2b17'); }
  // neck + head
  rect(14, 18, 17, 22, shadowSkin);
  ellipse(15.5, 12.5, 6, 7, p.skin);
  // hair on top
  if (p.kind === 'ash') {
    ellipse(15.5, 9.5, 7, 4.8, p.hair, (x, y) => y <= 10);
    rect(9, 9, 10, 14, p.hair); rect(21, 9, 22, 13, p.hair);
    ellipse(15.5, 3.6, 2.6, 2.2, p.hair);                                   // bun
  } else if (p.kind === 'dev') {
    ellipse(15.5, 9.2, 7.2, 5, p.hair, (x, y) => y <= 10);
    for (const [x, y] of [[10, 4], [12, 3], [14, 3], [17, 3], [19, 4], [21, 5], [9, 6], [22, 7], [15, 2]]) set(x, y, p.hair);
    for (const x of [11, 13, 16, 19]) set(x, 11, p.hair);                    // jagged fringe
    rect(9, 9, 10, 12, p.hair); rect(21, 9, 22, 12, p.hair);
  } else {
    ellipse(15.5, 9.4, 7.4, 5, p.hair, (x, y) => y <= 10);
    rect(9, 9, 11, 11, p.hair); rect(20, 9, 22, 11, p.hair);
  }
  // face details
  set(12, 15, '#f28b8b'); set(19, 15, '#f28b8b');                           // blush
  rect(15, 17, 16, 17, mix(p.skin, -0.35));                                 // mouth
  rect(13, 11, 14, 11, mix(p.hair, 0.1)); rect(17, 11, 18, 11, mix(p.hair, 0.1));   // brows
  // accessories
  if (p.kind === 'ash') {                                                   // headset band, ear cup, mic
    for (const [x, y] of [[9, 7], [10, 6], [11, 5], [12, 5], [19, 5], [20, 5], [21, 6], [22, 7]]) set(x, y, '#aab3d6');
    rect(8, 11, 9, 14, '#aab3d6'); set(10, 15, '#aab3d6'); set(11, 16, '#aab3d6'); set(12, 17, '#aab3d6'); set(13, 17, '#7fd0ff');
  } else if (p.kind === 'dev') {                                            // headphones round the neck + </> mark
    rect(11, 21, 20, 21, '#c9ccd8'); rect(8, 21, 11, 25, '#c9ccd8'); rect(20, 21, 23, 25, '#c9ccd8');
    rect(9, 22, 10, 24, '#ff7a59'); rect(21, 22, 22, 24, '#ff7a59');      // ear cups with a coral pad
    for (const [x, y] of [[13, 27], [12, 28], [11, 29], [12, 30], [13, 31], [17, 27], [16, 28], [16, 29], [15, 30], [15, 31],
                          [18, 27], [19, 28], [20, 29], [19, 30], [18, 31]]) set(x, y, '#ffffff');   // "</>" on the chest
  } else {                                                                  // round glasses
    for (const ox of [11, 17]) {
      rect(ox, 12, ox + 3, 12, '#c98a5a'); rect(ox, 15, ox + 3, 15, '#c98a5a');
      rect(ox - 1, 13, ox - 1, 14, '#c98a5a'); rect(ox + 4, 13, ox + 4, 14, '#c98a5a');
    }
    set(15, 13, '#c98a5a'); set(16, 13, '#c98a5a');
  }
  return C.g;
}

function robot(tint) {
  const C = canvas(), { rect, ellipse, set } = C;
  const metal = '#9aa3b5', dark = '#4a5166';
  C.trap(24, 31, 10, 21, 7, 24, metal);
  rect(13, 26, 18, 28, tint);                                               // chest light
  rect(14, 20, 17, 23, dark);                                               // neck
  ellipse(15.5, 13, 7, 6.5, metal);
  rect(9, 11, 22, 14, '#1b1d2e');                                           // visor
  rect(10, 12, 21, 13, tint);
  rect(15, 3, 16, 6, dark); ellipse(15.5, 2.5, 1.4, 1.4, tint);              // antenna
  rect(7, 12, 8, 15, dark); rect(23, 12, 24, 15, dark);                     // ear bolts
  return C.g;
}

/** Eye pixels for open / closed frames (drawn over the finished base). */
function eyes(kind, p) {
  if (kind === 'robot') return { open: [], closed: [] };
  const lid = '#2a1a22', iris = p.eye;
  const open = [], closed = [];
  for (const ex of [13, 17]) {
    open.push([ex, 13, lid], [ex + 1, 13, lid], [ex, 14, iris], [ex + 1, 14, '#ffffff']);
    closed.push([ex, 14, lid], [ex + 1, 14, lid], [ex, 13, p.skin], [ex + 1, 13, p.skin]);
  }
  return { open, closed };
}

const cache = new Map();
/** {size, base: [[x,y,w,color]] runs, open: [[x,y,c]], closed: [[x,y,c]]} for an agent id or a helper model. */
export function portrait(key) {
  if (cache.has(key)) return cache.get(key);
  let grid, ey;
  const m = /^helper:(.*)$/.exec(key);
  if (m) {
    const model = m[1].toLowerCase();
    const tint = Object.entries(HELPER_TINT).find(([k]) => model.includes(k))?.[1] || '#b8c0d0';
    grid = finish(robot(tint), new Set([tint]));
    ey = eyes('robot');
  } else {
    const p = PEOPLE[{ default: 'ash', hermes: 'ash' }[key] || key] || { ...PEOPLE.dev, top: '#6b7a99', inner: '#6b7a99' };
    grid = finish(bust(p));
    ey = eyes(p.kind, p);
  }
  const base = [];
  for (let y = 0; y < SIZE; y++) {
    let x = 0;
    while (x < SIZE) {
      const c = grid[y][x];
      if (c === null) { x++; continue; }
      let w = 1;
      while (x + w < SIZE && grid[y][x + w] === c) w++;
      base.push([x, y, w, c]);
      x += w;
    }
  }
  const out = { size: SIZE, base, open: ey.open, closed: ey.closed };
  cache.set(key, out);
  return out;
}
