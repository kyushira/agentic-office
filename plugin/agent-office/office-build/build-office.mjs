// build-office.mjs - builds the Claude-Office UI for the dashboard proxy at /api/plugins/agent-office/office/.
//
//   node build-office.mjs [--out <dir>]
//
// The checkout's own vite.config.ts is loaded unchanged; this script only overrides base and outDir
// and adds office-patch.mjs as a transform. Nothing under the Claude-Office checkout is written.
// Env: CLAUDE_OFFICE_DIR (default /opt/data/projects/Claude-Office).
// Run it with the Node that ships with Hermes (see the README note in office-build/start-office-server.sh).

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { OFFICE_PREFIX, PATCHES, patchSource } from './office-patch.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(process.env.CLAUDE_OFFICE_DIR || '/opt/data/projects/Claude-Office')

// The Vite the checkout pins (this worktree has no node_modules of its own).
const VITE_ENTRY = join(ROOT, 'node_modules', 'vite', 'dist', 'node', 'index.js')
if (!existsSync(VITE_ENTRY)) throw new Error(`no vite under ${ROOT}/node_modules; run npm install there first`)
const { build } = await import(pathToFileURL(VITE_ENTRY).href)

function argValue(name) {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}
const OUT = resolve(argValue('--out') || join(HERE, '..', 'dashboard', 'office-dist'))

if (!existsSync(join(ROOT, 'vite.config.ts'))) throw new Error(`no vite.config.ts under ${ROOT}`)

/** Applies office-patch.mjs to every src/*.ts(x) file, and fails if a patched file never showed up. */
function officePatch() {
  const seen = new Set()
  return {
    name: 'agent-office:claude-office-patch',
    enforce: 'pre',
    transform(code, id) {
      const file = id.split('?')[0]
      if (!file.startsWith(join(ROOT, 'src') + sep)) return null
      const rel = relative(ROOT, file).split(sep).join('/')
      if (!/\.tsx?$/.test(rel)) return null
      if (PATCHES[rel]) seen.add(rel)
      const { code: out } = patchSource(rel, code)
      return out === code ? null : { code: out, map: null }
    },
    buildEnd() {
      for (const rel of Object.keys(PATCHES)) {
        if (!seen.has(rel)) throw new Error(`office-patch: ${rel} was never transformed (file moved upstream?)`)
      }
    },
  }
}

/** Walks the build output and fails on any root-absolute sprite/room reference left in the bundle. */
function verifyOutput(dir) {
  const bad = []
  let prefixed = 0
  const walk = d => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) {
        walk(p)
        continue
      }
      if (!/\.(js|css|html)$/.test(name)) continue
      const text = readFileSync(p, 'utf8')
      const m = text.match(/(["'`]|url\()\/(sprites|rooms)\//g)
      if (m) bad.push(`${relative(dir, p)}: ${m.length}`)
      prefixed += text.split(`${OFFICE_PREFIX}/`).length - 1
    }
  }
  walk(dir)
  if (bad.length) throw new Error(`root-absolute asset URLs left in the build:\n  ${bad.join('\n  ')}`)
  if (prefixed === 0) throw new Error('no prefixed URLs in the build: the base or patch did not apply')
  if (!existsSync(join(dir, 'index.html'))) throw new Error('index.html missing from the build')
  return { prefixed }
}

await build({
  root: ROOT,
  configFile: join(ROOT, 'vite.config.ts'),
  base: `${OFFICE_PREFIX}/`,
  plugins: [officePatch()],
  logLevel: 'warn',
  build: { outDir: OUT, emptyOutDir: true },
})

const { prefixed } = verifyOutput(OUT)
console.log(`office build ok: ${OUT} (${prefixed} prefixed references)`)
