// Hand-authored 32×32 pixel-art busts (no image assets): each character is drawn from a few
// shapes on a grid, then outlined and rim-shaded the same way so they share one style.
// Pure; unit-tested in test/portrait.test.js.
export const SIZE = 32;
const OUTLINE = '#14122a';

// kind picks the hair shape and the accessory: ash headset, dev headphones + </>, red round glasses,
// nova neat crop + star badge, pixel bob + beret + pencil, sentinel visor + shield badge,
// prism swept spikes + gold goggles + rainbow bars. Colours follow each agent's accent.
const PEOPLE = {
  ash: { skin: '#f1c3a1', hair: '#2b1f33', top: '#1f2f63', inner: '#4f86e8', eye: '#9fd4ff', kind: 'ash' },
  dev: { skin: '#e9b48e', hair: '#231a1c', top: '#2f9e5c', inner: '#2f9e5c', eye: '#b6ffcf', kind: 'dev' },
  red: { skin: '#f3cfb0', hair: '#5a2a22', top: '#e0582e', inner: '#f2e6d0', eye: '#ffd2a8', kind: 'red' },
  nova: { skin: '#f1c3a1', hair: '#2e1a4f', top: '#6d3fd6', inner: '#8b5cf6', eye: '#d6c2ff', kind: 'nova' },
  pixel: { skin: '#f6d0b5', hair: '#5b2a48', top: '#be2f73', inner: '#ec4899', eye: '#ffc2e0', kind: 'pixel' },
  sentinel: { skin: '#e7b58f', hair: '#1e2b2e', top: '#0f766e', inner: '#14b8a6', eye: '#9ff5ea', kind: 'sentinel' },
  prism: { skin: '#dfae86', hair: '#3a2a1e', top: '#7c5c12', inner: '#facc15', eye: '#fff3b0', kind: 'prism' },
};
// Unknown ids get a variant picked by hash of the id: one of these kinds and palettes.
const KINDS = ['ash', 'dev', 'red', 'nova', 'pixel', 'sentinel', 'prism'];   // every kind bust() draws
const SKINS = ['#f1c3a1', '#e9b48e', '#f3cfb0', '#c98f6b', '#ffd8bd', '#8d5e42'];
const HAIRS = ['#2b1f33', '#6b3d1e', '#c9a13b', '#3a3f4b', '#7a2e6b', '#1d1d1d'];
const TOPS = ['#2f6f9e', '#8a4b2a', '#4c7a2f', '#7b5ea7', '#b5472f', '#3c5a66'];
const HELPER_TINT = { haiku: '#ff9a3c', gemini: '#4f8bff', deepseek: '#4fd1c5' };
const VISOR = '#0d2a2d';                 // Sentinel's visor glass; eyes glow on it, blink = a dim line
const PENCIL = '#fbbf24';                // Pixel's pencil; left flat (unshaded) so it reads as a stick

/** FNV-1a 32-bit: a stable hash of a string (same result in every browser and every load). */
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

function variant(key) {
  const h = hash(key);
  const top = TOPS[(h >>> 4) % TOPS.length];
  return { skin: SKINS[(h >>> 8) % SKINS.length], hair: HAIRS[(h >>> 12) % HAIRS.length], top,
    inner: mix(top, 0.3), eye: mix(top, 0.7), kind: KINDS[h % KINDS.length] };
}

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
  if (p.kind === 'pixel') { rect(8, 9, 10, 18, p.hair); rect(21, 9, 23, 18, p.hair); }      // bob, shoulder-length
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
  } else if (p.kind === 'sentinel') {                                       // short crop
    ellipse(15.5, 9.4, 7, 4.4, p.hair, (x, y) => y <= 10);
    rect(9, 9, 9, 11, p.hair); rect(22, 9, 22, 11, p.hair);
  } else if (p.kind === 'nova') {                                           // neat short crop, flat top, sheen
    ellipse(15.5, 9.2, 7.2, 4.6, p.hair, (x, y) => y <= 10);
    rect(9, 9, 9, 11, p.hair); rect(22, 9, 22, 11, p.hair);
    rect(12, 5, 18, 5, mix(p.hair, 0.25)); set(13, 6, mix(p.hair, 0.25));
  } else if (p.kind === 'pixel') {                                          // bob with bangs (beret goes on top)
    ellipse(15.5, 9.4, 7.4, 5, p.hair, (x, y) => y <= 10);
    rect(9, 9, 10, 11, p.hair); rect(21, 9, 22, 11, p.hair);
  } else if (p.kind === 'prism') {                                          // swept-up spiky tufts
    ellipse(15.5, 9.4, 7.2, 4.8, p.hair, (x, y) => y <= 10);
    rect(9, 9, 10, 11, p.hair); rect(21, 9, 22, 11, p.hair);
    rect(10, 4, 11, 6, p.hair); rect(13, 2, 14, 5, p.hair); rect(16, 1, 17, 4, p.hair);   // solid tufts off the crown
    rect(19, 2, 20, 5, p.hair); rect(21, 4, 22, 6, p.hair);
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
  } else if (p.kind === 'nova') {                                           // star badge on the chest
    for (const [x, y] of [[15, 26], [14, 27], [15, 27], [16, 27], [15, 28]]) set(x, y, '#ffd84d');
  } else if (p.kind === 'pixel') {                                          // beret with a stem, pencil behind the ear
    ellipse(15.5, 4.6, 7.2, 2.8, p.inner);
    rect(9, 6, 22, 6, mix(p.inner, -0.25)); set(15, 1, p.inner); set(16, 1, p.inner);
    for (const [x, y] of [[23, 11], [24, 10], [25, 9], [26, 8]]) set(x, y, PENCIL);
    set(27, 7, p.inner);                                                    // eraser
  } else if (p.kind === 'sentinel') {                                       // visor across the eyes, shield badge, high collar
    rect(10, 12, 21, 14, VISOR); rect(10, 12, 21, 12, p.inner);
    rect(12, 19, 13, 21, mix(p.top, -0.15)); rect(18, 19, 19, 21, mix(p.top, -0.15));
    rect(10, 24, 12, 25, p.inner); rect(10, 26, 12, 26, p.inner); rect(11, 27, 11, 27, p.inner);
    set(11, 24, '#e6fffb');
  } else if (p.kind === 'prism') {                                          // gold goggles pushed up on the forehead, rainbow bars on the right chest
    rect(9, 8, 12, 9, p.inner); rect(19, 8, 22, 9, p.inner);
    rect(13, 8, 18, 8, '#2a2a2a');
    rect(16, 24, 20, 24, '#f472b6'); rect(16, 25, 20, 25, '#facc15'); rect(16, 26, 20, 26, '#4fd1c5');
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
  if (kind === 'sentinel') {                       // glowing eyes behind the visor; closed = the visor's dim line
    for (const ex of [13, 17]) {
      open.push([ex, 13, iris], [ex + 1, 13, iris], [ex, 14, iris], [ex + 1, 14, '#ffffff']);
      closed.push([ex, 14, p.inner], [ex + 1, 14, p.inner], [ex, 13, VISOR], [ex + 1, 13, VISOR]);
    }
    return { open, closed };
  }
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
    const id = String(key || ''), alias = id === 'default' || id === 'hermes' ? 'ash' : id;
    const p = Object.prototype.hasOwnProperty.call(PEOPLE, alias) ? PEOPLE[alias] : variant(id);
    grid = finish(bust(p), new Set([PENCIL]));
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
