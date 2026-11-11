// Phase 1a: production build of the stripped Claude-Office scene (office-src/)
// into the Deck's dashboard plugin. The output runs from an opaque-origin iframe
// (sandbox without same-origin, no CORS headers from the static server), so it
// must be a CLASSIC script: no type="module", no crossorigin, no modulepreload.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { defineConfig } from 'vite'

const OUT = '../plugin/agent-office/dashboard/office/app'

/** Rewrites the emitted index.html so every script/style loads without CORS. */
function classicHtml() {
  let outDir = ''
  return {
    name: 'office-classic-html',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
    },
    closeBundle() {
      const file = join(outDir, 'index.html')
      if (!existsSync(file)) throw new Error('office build: index.html not emitted at ' + file)
      const before = readFileSync(file, 'utf8')
      const after = before
        .replace(/<link rel="modulepreload"[^>]*>\s*/g, '')
        .replace(/ type="module"/g, '')
        .replace(/ crossorigin(="[^"]*")?/g, '')
        // The bundle must run after the DOM exists (it mounts into #root in <body>).
        .replace(/<script src=/g, '<script defer src=')
      if (/type="module"|crossorigin|modulepreload/.test(after)) {
        throw new Error('office build: module/CORS attributes survived in index.html')
      }
      writeFileSync(file, after)
    },
  }
}

export default defineConfig({
  root: 'office-src',
  base: './',
  mode: 'production',
  publicDir: 'public',
  // Automatic JSX runtime: React 19 from the Deck's node_modules.
  oxc: { jsx: { runtime: 'automatic' } },
  plugins: [classicHtml()],
  build: {
    outDir: OUT,
    // Only this app directory is emptied; the sibling dashboard/office assets stay.
    emptyOutDir: true,
    sourcemap: false,
    modulePreload: false,
    cssCodeSplit: false,
    rolldownOptions: {
      output: {
        format: 'iife',
        entryFileNames: 'assets/office.js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
})
