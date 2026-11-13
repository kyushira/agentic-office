// agent-sprites.mjs - per-agent recoloured walking sprites for the Claude-Office scene.
//
// Each Hermes team member gets its own copy of an upstream character sheet (a base role sheet from
// Claude-Office public/sprites/characters), with the base's skin, hair, top, inner and accent colours
// mapped onto the agent's palette from src/portrait.js. Everything else (outline, shading steps, alpha,
// width and height of every frame) is kept.
//
//   node agent-sprites.mjs [--src <characters dir>] [--out <dir>]
//
// Defaults: --src $CLAUDE_OFFICE_DIR/public/sprites/characters (CLAUDE_OFFICE_DIR defaults to the
// upstream checkout), --out ./agent-sprites next to this file. Output is committed; the build copies it
// into the dist (build-office.mjs). Generation is deterministic: the same input gives the same bytes
// (ffmpeg libwebp, fixed settings; each output is decoded again and checked against its source).
//
// Output per agent: four standing poses as lossy WebP (q92) and, for front-left/front-right/rear-left,
// four lossless walk frames (src/walk.ts). Walk frames are optional at runtime, so a missing one glides.
//
// Upstream art is Claude-Office, MIT, Copyright (c) 2026 W17ANT (see NOTICE.md).

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync, inflateSync } from 'node:zlib'

const HERE = dirname(fileURLToPath(import.meta.url))

/** The seven Hermes team ids (src/portrait.js PEOPLE, office_team.py TEAM) and their upstream base sheet. */
export const SHEET_IDS = Object.freeze({
  'hermes-ash': 'ash',
  'hermes-dev': 'dev',
  'hermes-red': 'red',
  'hermes-nova': 'nova',
  'hermes-pixel': 'pixel',
  'hermes-sentinel': 'sentinel',
  'hermes-prism': 'prism',
})

/** Standing poses shipped per agent, and the subset that has a four-frame walk cycle upstream. */
export const POSES = Object.freeze(['front-left', 'front-right', 'rear-left', 'rear-right'])
export const WALK_POSES = Object.freeze(['front-left', 'front-right', 'rear-left'])
export const WALK_FRAMES = 4

// Palette per agent: the five colours of the Deck bust in src/portrait.js. accent = its eye/glow colour.
// test/agent-sprites.test.js asserts these equal the PEOPLE entries in src/portrait.js.
export const PALETTES = Object.freeze({
  ash: { skin: '#f1c3a1', hair: '#2b1f33', top: '#1f2f63', inner: '#4f86e8', accent: '#9fd4ff' },
  dev: { skin: '#e9b48e', hair: '#231a1c', top: '#2f9e5c', inner: '#2f9e5c', accent: '#b6ffcf' },
  red: { skin: '#f3cfb0', hair: '#5a2a22', top: '#e0582e', inner: '#f2e6d0', accent: '#ffd2a8' },
  nova: { skin: '#f1c3a1', hair: '#2e1a4f', top: '#6d3fd6', inner: '#8b5cf6', accent: '#d6c2ff' },
  pixel: { skin: '#f6d0b5', hair: '#5b2a48', top: '#be2f73', inner: '#ec4899', accent: '#ffc2e0' },
  sentinel: { skin: '#e7b58f', hair: '#1e2b2e', top: '#0f766e', inner: '#14b8a6', accent: '#9ff5ea' },
  prism: { skin: '#dfae86', hair: '#3a2a1e', top: '#7c5c12', inner: '#facc15', accent: '#fff3b0' },
})

/**
 * Base sheet per palette, and the upstream colours each region has on that sheet (sampled from the
 * front-right pose with a quantised colour histogram per region). A region is one colour or a list of
 * shades of it; a pixel within REF_TOL of any shade is part of that region. Anything else keeps its colour.
 * `accent` and `inner` are null when the base has no distinct trim or second garment.
 * Dev uses dev-2, not dev-1: dev-1 is shaved-headed, so it has no hair to recolour.
 */
export const BASES = Object.freeze({
  ash: { base: 'Claude-1', refs: {
    skin: '#fabe93', hair: '#45291d', top: ['#f2dabb', '#f6e2c4', '#edd5b6', '#e5caaa'],
    inner: ['#b6977a', '#c7a88a', '#d4b698'], accent: '#e0701e' } },
  dev: { base: 'dev-2', refs: {
    skin: '#f1b596', hair: ['#05ab99', '#3a8c84', '#038788', '#04b2a1', '#05b19e'],
    top: ['#facc03', '#fed002', '#e59706', '#d98a06', '#e9a705'], inner: null, accent: null } },
  red: { base: 'employee-2', refs: {
    skin: '#f5bc97', hair: ['#372b38', '#493a47', '#2d222d'], top: ['#3b6599', '#3a69a2', '#365889'],
    inner: ['#2e4676', '#314779'], accent: '#5ee0f0' } },
  nova: { base: 'explore-1', refs: {
    skin: '#f4b699', hair: ['#553223', '#4b2d22', '#48291d'], top: ['#781a19', '#861a19', '#691818', '#581515'],
    inner: ['#ba1d1d'], accent: '#9fd3e6' } },
  pixel: { base: 'Frontend-dev-1', refs: {
    skin: '#f4bc9b', hair: ['#a53c27', '#9a3726', '#b6462b'], top: ['#528345', '#4d7d43', '#375a36', '#3c6338'],
    inner: ['#f5f5f5', '#e5e6e7'], accent: '#8fa0b0' } },
  sentinel: { base: 'security-audit-1', refs: {
    skin: '#f3b798', hair: '#050405', top: ['#18171a', '#211e22', '#1f1d21'], inner: null, accent: '#b8903a' } },
  prism: { base: 'employee-3', refs: {
    skin: '#f1b794', hair: ['#171519', '#232228'], top: ['#2d365b', '#2e3861', '#1d2345'], inner: ['#fcfcfc'], accent: null } },
})

/** How far (RGB Euclidean) a pixel may be from a reference colour and still count as that region. */
export const REF_TOL = 40

// ---------------------------------------------------------------------------------------------
// colour helpers (pure)

function parseHex(hex) {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** Luma of an RGB triple, 0..255. Used only for shading steps, so the exact weights do not matter. */
export function luma([r, g, b]) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

const clamp255 = v => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v))

/**
 * Recolour one RGB triple. `classes` is [{ ref: [r,g,b], to: [r,g,b] }, ...]; the nearest class within
 * REF_TOL wins. The pixel keeps its luma step from the reference: out = to + (luma(p) - luma(ref)).
 * Pixels that match no class are returned unchanged.
 * @returns {[number, number, number]}
 */
export function recolourRGB(rgb, classes, tol = REF_TOL) {
  let best = null
  let bestD = tol * tol
  for (const c of classes) {
    const d = (rgb[0] - c.ref[0]) ** 2 + (rgb[1] - c.ref[1]) ** 2 + (rgb[2] - c.ref[2]) ** 2
    if (d <= bestD) { bestD = d; best = c }
  }
  if (!best) return [rgb[0], rgb[1], rgb[2]]
  const shift = luma(rgb) - luma(best.ref)
  return [clamp255(best.to[0] + shift), clamp255(best.to[1] + shift), clamp255(best.to[2] + shift)]
}

/**
 * The region classes for one agent: base reference colours mapped to the agent palette.
 * @returns {{ ref: number[], to: number[] }[]}
 */
export function classesFor(id) {
  const palKey = SHEET_IDS[id]
  if (!palKey) throw new Error(`agent-sprites: no sheet for ${id}`)
  const pal = PALETTES[palKey]
  const refs = BASES[palKey].refs
  const out = []
  for (const region of ['skin', 'hair', 'top', 'inner', 'accent']) {
    const shades = [].concat(refs[region] ?? [])
    for (const hex of shades) out.push({ ref: parseHex(hex), to: parseHex(pal[region]) })
  }
  return out
}

/**
 * Recolour a whole RGBA frame. Returns a new Buffer of the same length; the input is not modified.
 * Alpha, width and height are unchanged by construction (only the RGB bytes of opaque pixels move).
 */
export function recolourRGBA(rgba, classes) {
  const out = Buffer.from(rgba)
  for (let i = 0; i < out.length; i += 4) {
    if (out[i + 3] === 0) continue
    const [r, g, b] = recolourRGB([out[i], out[i + 1], out[i + 2]], classes)
    out[i] = r; out[i + 1] = g; out[i + 2] = b
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// PNG (8-bit RGBA or RGB, non-interlaced) - node:zlib only

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

/** @returns {{ width: number, height: number, rgba: Buffer }} */
export function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error('agent-sprites: not a PNG')
  let p = 8, width = 0, height = 0, colorType = -1
  const idat = []
  while (p < buf.length) {
    const len = buf.readUInt32BE(p)
    const type = buf.toString('latin1', p + 4, p + 8)
    const data = buf.subarray(p + 8, p + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4)
      if (data[8] !== 8) throw new Error(`agent-sprites: bit depth ${data[8]} unsupported`)
      colorType = data[9]
      if (data[12] !== 0) throw new Error('agent-sprites: interlaced PNG unsupported')
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    p += 12 + len
  }
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 0
  if (!bpp) throw new Error(`agent-sprites: colour type ${colorType} unsupported (need RGB or RGBA)`)
  const stride = width * bpp
  const raw = inflateSync(Buffer.concat(idat))
  if (raw.length !== (stride + 1) * height) throw new Error('agent-sprites: PNG data length mismatch')
  const px = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)]
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const row = px.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? px.subarray((y - 1) * stride, y * stride) : null
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? row[x - bpp] : 0
      const b = prev ? prev[x] : 0
      const c = prev && x >= bpp ? prev[x - bpp] : 0
      let v = src[x]
      if (ft === 1) v += a
      else if (ft === 2) v += b
      else if (ft === 3) v += (a + b) >> 1
      else if (ft === 4) {
        const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      } else if (ft !== 0) throw new Error(`agent-sprites: filter ${ft} unsupported`)
      row[x] = v & 255
    }
  }
  const rgba = Buffer.alloc(width * height * 4)
  for (let i = 0, j = 0; i < px.length; i += bpp, j += 4) {
    rgba[j] = px[i]; rgba[j + 1] = px[i + 1]; rgba[j + 2] = px[i + 2]
    rgba[j + 3] = bpp === 4 ? px[i + 3] : 255
  }
  return { width, height, rgba }
}

/** Encodes RGBA as an 8-bit RGBA PNG. Same input, same bytes. */
export function encodePng(width, height, rgba) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const chunk = (type, data) => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(data.length, 0)
    head.write(type, 4, 'latin1')
    const body = Buffer.concat([head.subarray(4), data])
    const out = Buffer.alloc(12 + data.length)
    out.writeUInt32BE(data.length, 0)
    body.copy(out, 4)
    out.writeUInt32BE(crc32(body), 8 + data.length)
    return out
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

// ---------------------------------------------------------------------------------------------
// WebP walk frames: decoded and encoded by ffmpeg (libwebp). Used by the CLI only.

function ffprobeSize(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]).toString().trim()
  const [w, h] = out.split(',').map(Number)
  return { width: w, height: h }
}

function webpToRgba(file) {
  const { width, height } = ffprobeSize(file)
  const rgba = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 1 << 28 })
  if (rgba.length !== width * height * 4) throw new Error(`agent-sprites: ${file} decoded to ${rgba.length} bytes, expected ${width * height * 4}`)
  return { width, height, rgba }
}

/**
 * Standing poses: lossy WebP at quality 92 (yuva420p), about a third of the lossless size. Walk frames are
 * small (98x200), so their edge error is too large for lossy: they are lossless, and their visible pixels
 * must come back exactly.
 */
export const WEBP_QUALITY = 92

function rgbaToWebp(width, height, rgba, file, { lossless }) {
  const codec = lossless
    ? ['-lossless', '1', '-pix_fmt', 'rgba']
    : ['-q:v', String(WEBP_QUALITY), '-pix_fmt', 'yuva420p']
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-i', '-',
    '-frames:v', '1', '-c:v', 'libwebp', ...codec, file], { input: rgba, maxBuffer: 1 << 28 })
  if (r.status !== 0) throw new Error(`agent-sprites: ffmpeg webp encode failed: ${r.stderr}`)
  const back = webpToRgba(file).rgba
  const ok = lossless ? sameVisible(back, rgba) : withinLossy(back, rgba)
  if (!ok) throw new Error(`agent-sprites: ${file} is off the recoloured source (${lossless ? 'lossless' : 'lossy'} check)`)
}

/**
 * libwebp rewrites the RGB of fully transparent pixels (invisible). Alpha must match everywhere and RGB
 * wherever alpha is above zero.
 */
export function sameVisible(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 4) {
    if (a[i + 3] !== b[i + 3]) return false
    if (a[i + 3] === 0) continue
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) return false
  }
  return true
}

/**
 * Lossy WebP is close, not exact. WebP is always 4:2:0, so the error sits on hard colour edges: mean RGB
 * error over visible pixels measured 2.05 on the upstream art and 4.83 on a recoloured frame (max ~150 on
 * an edge pixel), and quality 97 does not get it lower. Budget: mean <= 6, alpha within 2. Anything further
 * off means the encoder or the source changed.
 */
export const LOSSY_MEAN_BUDGET = 6

export function withinLossy(decoded, want) {
  if (decoded.length !== want.length) return false
  let sum = 0, n = 0
  for (let i = 0; i < want.length; i += 4) {
    if (Math.abs(decoded[i + 3] - want[i + 3]) > 2) return false
    if (want[i + 3] === 0) continue
    for (let c = 0; c < 3; c++) sum += Math.abs(decoded[i + c] - want[i + c])
    n += 3
  }
  return n === 0 || sum / n <= LOSSY_MEAN_BUDGET
}

// ---------------------------------------------------------------------------------------------
// file names: the upstream convention `<base>-<pose>.<ext>` and `<base>-<pose>-walk<N>.webp`, base = agent id

export const sheetName = (id, pose) => `${id}-${pose}.webp`
export const walkName = (id, pose, n) => `${id}-${pose}-walk${n}.webp`

/**
 * CLI: regenerate every agent sheet from the upstream characters folder.
 * @param {{ src: string, out: string }} opts
 * @returns {{ files: number, bytes: number }}
 */
export function generate({ src, out }) {
  mkdirSync(out, { recursive: true })
  let files = 0, bytes = 0
  const write = (name, data) => { writeFileSync(join(out, name), data); files++; bytes += data.length }
  for (const id of Object.keys(SHEET_IDS)) {
    const classes = classesFor(id)
    const base = BASES[SHEET_IDS[id]].base
    for (const pose of POSES) {
      const { width, height, rgba } = decodePng(readFileSync(join(src, `${base}-${pose}.png`)))
      const target = join(out, sheetName(id, pose))
      rgbaToWebp(width, height, recolourRGBA(rgba, classes), target, { lossless: false })
      files++
      bytes += readFileSync(target).length
    }
    for (const pose of WALK_POSES) {
      for (let n = 1; n <= WALK_FRAMES; n++) {
        const webp = join(src, `${base}-${pose}-walk${n}.webp`)
        const { width, height, rgba } = webpToRgba(webp)
        const target = join(out, walkName(id, pose, n))
        rgbaToWebp(width, height, recolourRGBA(rgba, classes), target, { lossless: true })
        files++
        bytes += readFileSync(target).length
      }
    }
  }
  return { files, bytes }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined }
  const src = resolve(arg('--src') || join(process.env.CLAUDE_OFFICE_DIR || '/opt/data/projects/Claude-Office', 'public', 'sprites', 'characters'))
  const out = resolve(arg('--out') || join(HERE, 'agent-sprites'))
  if (!existsSync(src)) throw new Error(`agent-sprites: no upstream characters folder at ${src}`)
  const { files, bytes } = generate({ src, out })
  console.log(`agent sprites ok: ${files} files, ${(bytes / 1024).toFixed(1)} KB in ${out}`)
}
