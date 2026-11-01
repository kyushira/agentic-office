// Procedural 8-bit "space invader" sprites, stable per id (pure; unit-tested).
export function hash(s) {
  let h = 2166136261;
  for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rng(seed) {
  let x = seed || 1;
  return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 4294967296; };
}
const W = 11, H = 8, HALF = 6;   // mirrored about the centre column

/** Two animation frames of an 11×8 invader: arrays of [x, y] lit pixels. */
export function invader(id) {
  const r = rng(hash(id));
  const body = [];
  for (let y = 0; y < H; y++) {
    const row = [];
    for (let x = 0; x < HALF; x++) {
      // denser in the middle rows and towards the centre, sparser at the top
      const p = (y === 0 ? 0.25 : y < 3 ? 0.5 : y < 6 ? 0.72 : 0.4) + (x >= 3 ? 0.15 : 0);
      row.push(r() < p);
    }
    body.push(row);
  }
  for (let y = 2; y < 6; y++) body[y][5] = true;                   // solid spine
  const ey = 2 + Math.floor(r() * 2), ex = 2 + Math.floor(r() * 2); // eyes: holes
  body[ey][ex] = false;
  const legsA = body[H - 1].slice(), legsB = legsA.map((v, i) => (i % 2 ? !v : v));
  const frame = legs => {
    const px = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < HALF; x++) {
      const on = y === H - 1 ? legs[x] : body[y][x];
      if (on) { px.push([x, y]); if (x !== HALF - 1) px.push([W - 1 - x, y]); }
    }
    return px;
  };
  return { w: W, h: H, a: frame(legsA), b: frame(legsB) };
}

/** Bright, readable-on-black colour per id. */
export function tint(id) {
  const h = hash(id + '#');
  const hues = [8, 22, 45, 58, 95, 140, 172, 192, 210, 232, 262, 290, 320, 345];
  const hue = hues[h % hues.length], light = 62 + (h >>> 8) % 12;
  return `hsl(${hue} 85% ${light}%)`;
}
