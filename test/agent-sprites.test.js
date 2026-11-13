// agent-sprites.test.js - per-agent recoloured sheets (plugin/agent-office/office-build/agent-sprites.mjs).
// Pure-function checks run everywhere; the committed-asset checks need ffprobe and skip without it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BASES, PALETTES, POSES, SHEET_IDS, WALK_FRAMES, WALK_POSES,
  classesFor, decodePng, encodePng, luma, recolourRGB, recolourRGBA, sheetName, walkName, withinLossy, sameVisible,
} from '../plugin/agent-office/office-build/agent-sprites.mjs'
import { patchSource } from '../plugin/agent-office/office-build/office-patch.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ASSETS = join(ROOT, 'plugin', 'agent-office', 'office-build', 'agent-sprites')
const hex = ([r, g, b]) => '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')

function hasFfprobe() {
  try { execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); return true } catch { return false }
}

// --- the palette and the ids are read from the sources they must match ---------------------------

test('PALETTES equals the Deck bust palette in src/portrait.js (accent = eye)', () => {
  const src = readFileSync(join(ROOT, 'src', 'portrait.js'), 'utf8')
  for (const [id, pal] of Object.entries(PALETTES)) {
    const m = src.match(new RegExp(`\\b${id}: \\{ skin: '(#[0-9a-f]{6})', hair: '(#[0-9a-f]{6})', top: '(#[0-9a-f]{6})', inner: '(#[0-9a-f]{6})', eye: '(#[0-9a-f]{6})'`))
    assert.ok(m, `portrait.js has no palette line for ${id}`)
    assert.deepEqual(
      { skin: m[1], hair: m[2], top: m[3], inner: m[4], accent: m[5] },
      pal,
      `${id} palette drifted from portrait.js`,
    )
  }
})

test('SHEET_IDS covers exactly the seven hermes-* team ids in office_team.py', () => {
  const src = readFileSync(join(ROOT, 'plugin', 'agent-office', 'dashboard', 'office_team.py'), 'utf8')
  const ids = [...src.matchAll(/"id": "(hermes-[a-z]+)"/g)].map(m => m[1]).sort()
  assert.deepEqual(ids, Object.keys(SHEET_IDS).sort())
  assert.equal(ids.length, 7)
})

test('every palette has a base sheet and every base region is a shade list or null', () => {
  for (const key of Object.keys(PALETTES)) {
    assert.ok(BASES[key], `${key} has no base`)
    assert.match(BASES[key].base, /^[A-Za-z][A-Za-z-]*\d$/)
    for (const [region, v] of Object.entries(BASES[key].refs)) {
      if (v == null) continue
      for (const h of [].concat(v)) assert.match(h, /^#[0-9a-f]{6}$/, `${key}.${region}`)
    }
  }
})

// --- pure colour mapping --------------------------------------------------------------------------

test('recolourRGB maps a reference colour to the target colour exactly', () => {
  const classes = [{ ref: [10, 20, 30], to: [200, 100, 50] }]
  assert.deepEqual(recolourRGB([10, 20, 30], classes), [200, 100, 50])
})

test('recolourRGB keeps the luma step from the reference (shading survives)', () => {
  const classes = [{ ref: [100, 100, 100], to: [200, 0, 0] }]
  const darker = [90, 90, 90]
  const shift = luma(darker) - luma([100, 100, 100]) // negative
  const clamp = v => Math.max(0, Math.min(255, Math.round(v)))
  assert.deepEqual(recolourRGB(darker, classes), [clamp(200 + shift), clamp(shift), clamp(shift)])
})

test('recolourRGB leaves a colour outside the tolerance unchanged', () => {
  const classes = [{ ref: [10, 20, 30], to: [200, 100, 50] }]
  assert.deepEqual(recolourRGB([250, 250, 250], classes), [250, 250, 250])
})

test('recolourRGB picks the nearest class when several are within tolerance', () => {
  const classes = [
    { ref: [100, 100, 100], to: [255, 0, 0] },
    { ref: [110, 110, 110], to: [0, 255, 0] },
  ]
  // nearest is the 110 class; the one-step-darker source keeps its -1 luma step on the target (255 -> 254)
  assert.deepEqual(recolourRGB([109, 109, 109], classes), [0, 254, 0])
})

test('classesFor: every agent maps every base shade onto its own palette colour', () => {
  for (const id of Object.keys(SHEET_IDS)) {
    const classes = classesFor(id)
    const pal = PALETTES[SHEET_IDS[id]]
    assert.ok(classes.length > 0, `${id} has classes`)
    const targets = new Set(classes.map(c => hex(c.to)))
    assert.ok(targets.has(pal.skin) && targets.has(pal.hair) && targets.has(pal.top), `${id} targets its palette`)
  }
})

test('classesFor: unknown agent id throws loudly (no silent fallback here)', () => {
  assert.throws(() => classesFor('hermes-nobody'), /no sheet for hermes-nobody/)
})

test('recolourRGBA keeps alpha, length, and does not mutate its input', () => {
  const classes = classesFor('hermes-dev')
  const src = Buffer.from([
    0xfa, 0xbb, 0x96, 255,  // skin pixel, opaque
    0xfa, 0xbb, 0x96, 0,    // same colour, transparent: must stay untouched
    0x10, 0x10, 0x10, 255,  // outline, no class
    0x05, 0xab, 0x99, 128,  // hair pixel, semi-transparent
  ])
  const before = Buffer.from(src)
  const out = recolourRGBA(src, classes)
  assert.equal(out.length, src.length)
  assert.deepEqual(src, before, 'input not mutated')
  for (let i = 3; i < src.length; i += 4) assert.equal(out[i], src[i], `alpha at ${i}`)
  assert.deepEqual([...out.subarray(4, 8)], [...src.subarray(4, 8)], 'transparent pixel RGB untouched')
  assert.deepEqual([...out.subarray(8, 12)], [...src.subarray(8, 12)], 'unmatched outline untouched')
  assert.notDeepEqual([...out.subarray(0, 3)], [...src.subarray(0, 3)], 'opaque skin recoloured')
})

test('recolourRGBA is deterministic (same input, same bytes)', () => {
  const classes = classesFor('hermes-sentinel')
  const src = Buffer.from([0x18, 0x17, 0x1a, 255, 0xf3, 0xb7, 0x98, 255])
  assert.deepEqual(recolourRGBA(src, classes), recolourRGBA(src, classes))
})

// --- PNG codec and the lossy/lossless checks ----------------------------------------------------

test('PNG encode/decode round-trips width, height and RGBA exactly', () => {
  const w = 3, h = 2
  const rgba = Buffer.from(Array.from({ length: w * h * 4 }, (_, i) => (i * 37) & 255))
  const back = decodePng(encodePng(w, h, rgba))
  assert.equal(back.width, w)
  assert.equal(back.height, h)
  assert.deepEqual(back.rgba, rgba)
})

test('encodePng is byte-stable', () => {
  const rgba = Buffer.from([1, 2, 3, 255, 4, 5, 6, 0])
  assert.deepEqual(encodePng(2, 1, rgba), encodePng(2, 1, rgba))
})

test('sameVisible ignores RGB under transparent pixels but not visible ones', () => {
  const a = Buffer.from([1, 2, 3, 0, 9, 9, 9, 255])
  const b = Buffer.from([7, 7, 7, 0, 9, 9, 9, 255])
  assert.equal(sameVisible(a, b), true)
  const c = Buffer.from([1, 2, 3, 0, 9, 9, 8, 255])
  assert.equal(sameVisible(a, c), false)
})

test('withinLossy accepts small edge error and rejects a broken frame', () => {
  const want = Buffer.from([100, 100, 100, 255, 0, 0, 0, 0])
  assert.equal(withinLossy(Buffer.from([102, 99, 100, 255, 0, 0, 0, 0]), want), true)
  assert.equal(withinLossy(Buffer.from([250, 10, 10, 255, 0, 0, 0, 0]), want), false)
  assert.equal(withinLossy(Buffer.from([100, 100, 100, 200, 0, 0, 0, 0]), want), false)
})

// --- id -> sheet names, and the runtime wiring ------------------------------------------------------

test('sheet names follow the upstream <base>-<pose> convention keyed by agent id', () => {
  assert.equal(sheetName('hermes-ash', 'front-right'), 'hermes-ash-front-right.webp')
  assert.equal(walkName('hermes-ash', 'front-right', 3), 'hermes-ash-front-right-walk3.webp')
  assert.deepEqual(WALK_POSES.filter(p => POSES.includes(p)), [...WALK_POSES])
  assert.equal(WALK_FRAMES, 4)
})

test('office-patch: the theme.ts edit routes only the seven ids and four poses to sprites/agents/', () => {
  const upstream = [
    'export function getSpritePath(_agentId: string, role: string, defaultBase: string, direction: string): string {',
    '  const base = getCharacterBaseForRole(role, defaultBase)',
    '  return seasonalUrl(`${getSpriteDir()}/${base}-${direction}.png`)',
    '}',
    '',
  ].join('\n')
  const out = patchSource('src/theme.ts', upstream).code
  assert.match(out, /if \(\["hermes-ash",/)
  assert.match(out, /"hermes-prism"\]\.includes\(_agentId\)/)
  // the literal is prefixed by the same rewrite every other sprite URL gets
  assert.match(out, /\["front-left","front-right","rear-left","rear-right"\]\.includes\(direction\)\) return seasonalUrl\('\/api\/plugins\/agent-office\/office\/sprites\/agents\/' \+ _agentId \+ '-' \+ direction \+ '\.webp'\)/)
  // the upstream fallback is still there, after the agent branch
  assert.ok(out.indexOf('getCharacterBaseForRole') > out.indexOf('sprites/agents/'), 'fallback follows the branch')
  assert.match(out, /\$\{getSpriteDir\(\)\}\/\$\{base\}-\$\{direction\}\.png/)
})

test('office-patch: a changed upstream getSpritePath fails loudly', () => {
  assert.throws(
    () => patchSource('src/theme.ts', 'export function getSpritePath(id: string): string {\n  return ""\n}\n'),
    /expected 1 match\(es\), found 0/,
  )
})

test('office-patch: an unchanged file other than theme.ts is untouched by the agent edit', () => {
  const code = 'export const x = 1\n'
  assert.equal(patchSource('src/other.ts', code).code, code)
})

// --- committed assets (needs ffprobe; skipped without it) -----------------------------------------

test('committed sheets: 112 files, every name the build expects, and dims match the base sheet', { skip: !hasFfprobe() && 'ffprobe not installed' }, () => {
  const expected = []
  for (const id of Object.keys(SHEET_IDS)) {
    for (const p of POSES) expected.push(sheetName(id, p))
    for (const p of WALK_POSES) for (let n = 1; n <= WALK_FRAMES; n++) expected.push(walkName(id, p, n))
  }
  assert.equal(expected.length, 112)
  for (const name of expected) assert.ok(existsSync(join(ASSETS, name)), `missing ${name}`)
  const dims = f => execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', f]).toString().trim()
  const up = '/opt/data/projects/Claude-Office/public/sprites/characters'
  if (!existsSync(up)) return
  for (const id of Object.keys(SHEET_IDS)) {
    const base = BASES[SHEET_IDS[id]].base
    for (const p of POSES) {
      assert.equal(dims(join(ASSETS, sheetName(id, p))), dims(join(up, `${base}-${p}.png`)), `${id} ${p} dims`)
    }
  }
})
