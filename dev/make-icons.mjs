// Renders the Agent Deck pixel portrait (src/portrait.js) into PNG app icons for the PWA.
// Node built-ins only: a minimal RGBA PNG encoder (zlib + CRC-32), nearest-neighbour scaling.
// Run: npm run icons
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { portrait } from '../src/portrait.js';

const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(here, '..', 'plugin', 'agent-office', 'dashboard', 'pwa');
const BG = [0x0f, 0x11, 0x15];           // solid, opaque background: iOS would blacken transparency
const AGENT = 'hermes';                  // resolves to the Ash portrait

// --- CRC-32 (PNG chunk checksums) ---
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** rgba: Uint8Array of w*h*4 bytes. Returns a PNG file as a Buffer (8-bit RGBA, no interlace). */
function encodePng(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;                       // filter type 0 (None) per scanline
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;                                      // bit depth
  ihdr[9] = 6;                                      // colour type: RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;         // compression, filter, interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const hex = c => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));

/** Flatten the portrait into a 32x32 grid of [r,g,b] | null (transparent), eyes included. */
function portraitGrid(key) {
  const p = portrait(key);
  const g = Array.from({ length: p.size }, () => Array(p.size).fill(null));
  for (const [x, y, w, c] of p.base) for (let i = 0; i < w; i++) g[y][x + i] = hex(c);
  for (const [x, y, c] of p.open) g[y][x] = hex(c);
  return { size: p.size, g };
}

/**
 * Square icon of side `s`: solid background, portrait scaled by an integer factor (sharp pixels)
 * and centred. `pad` is the fraction of the side left empty on each edge (e.g. 0.2 → ~20% padding).
 */
function renderIcon(s, pad) {
  const { size, g } = portraitGrid(AGENT);
  const box = Math.floor((s * (1 - 2 * pad)) / size);   // integer pixel scale
  const px = box * size;
  const off = Math.floor((s - px) / 2);
  const rgba = new Uint8Array(s * s * 4);
  for (let i = 0; i < s * s; i++) { rgba[i * 4] = BG[0]; rgba[i * 4 + 1] = BG[1]; rgba[i * 4 + 2] = BG[2]; rgba[i * 4 + 3] = 255; }
  for (let y = 0; y < px; y++) for (let x = 0; x < px; x++) {
    const c = g[Math.floor(y / box)][Math.floor(x / box)];
    if (!c) continue;
    const o = ((off + y) * s + (off + x)) * 4;
    rgba[o] = c[0]; rgba[o + 1] = c[1]; rgba[o + 2] = c[2];
  }
  return { w: s, h: s, rgba, scale: box, box: px, offset: off };
}

const targets = [
  { file: 'icon-180.png', size: 180, pad: 0.2 },            // apple-touch-icon
  { file: 'icon-192.png', size: 192, pad: 0.2 },
  { file: 'icon-512.png', size: 512, pad: 0.2 },
  { file: 'icon-maskable-512.png', size: 512, pad: 0.3 },   // extra safe zone for Android maskable crop
];

mkdirSync(OUT_DIR, { recursive: true });
for (const t of targets) {
  const icon = renderIcon(t.size, t.pad);
  const png = encodePng(icon.w, icon.h, icon.rgba);
  const path = join(OUT_DIR, t.file);
  writeFileSync(path, png);
  console.log(`${t.file}: ${icon.w}x${icon.h}, portrait ${icon.box}px (scale ${icon.scale}, offset ${icon.offset}), ${png.length} bytes`);
}
