// office-patch.mjs - source edits applied to the Claude-Office UI at build time, so that the same
// checkout can be served under /api/plugins/agent-office/office/ by the dashboard proxy
// (plugin/agent-office/dashboard/office_proxy.py) without touching its tracked files.
//
// Every edit states how many times its `find` text must occur. A miss throws, so an upstream
// change fails the build loudly instead of shipping a page that calls the wrong URLs.

export const OFFICE_PREFIX = '/api/plugins/agent-office/office'

// Root-absolute sprite and room URLs in string literals: '/sprites/x.png', "/rooms/y.webp",
// `/sprites/${name}`. Vite cannot rewrite them (they are runtime strings), so they are prefixed here.
const SPRITE_LITERAL = /(["'`])\/(sprites|rooms)\//g

const WS_FIND =
  "if (!isDevServerPage(loc, env)) return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/ws`"
const WS_REPLACE =
  "if (!isDevServerPage(loc, env)) return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}" +
  OFFICE_PREFIX +
  "/ws`"

// Exact-text edits per file. `count` defaults to 1.
export const PATCHES = {
  'src/serverUrl.ts': [
    {
      name: 'http base is the page origin plus the prefix',
      find: 'if (!isDevServerPage(loc, env)) return loc.origin\n',
      replace: "if (!isDevServerPage(loc, env)) return loc.origin + '" + OFFICE_PREFIX + "'\n",
    },
    { name: 'ws url carries the prefix', find: WS_FIND, replace: WS_REPLACE },
  ],
  'src/officeAuth.ts': [
    {
      // The dashboard gate reads any Authorization header as its own credential and answers 401
      // when it is not one, so a bearer from the page would lock the page out. The dashboard
      // proxy (plugin_api.py, /office/) adds the office token on the server side instead.
      name: 'proxied page sends no Authorization header (the dashboard proxy adds the token)',
      find: '  if (!isProxiedPage(loc)) return {}',
      replace:
        '  if (isProxiedPage(loc)) return {} // the agent-office dashboard proxy adds the token\n' +
        '  if (!isProxiedPage(loc)) return {}',
    },
  ],
}

/** Files whose sprite/room literals must be rewritten, and the minimum number expected in each. */
export const SPRITE_EXPECTED = { 'src/assets.ts': 40 }

/**
 * Apply every edit that applies to `rel` (a path relative to the Claude-Office root, '/' separated).
 * @returns {{ code: string, spriteHits: number }}
 * @throws {Error} when an exact edit does not occur the expected number of times, or a file that
 *   must contain sprite literals has fewer than expected.
 */
export function patchSource(rel, code) {
  let out = code
  for (const edit of PATCHES[rel] ?? []) {
    const want = edit.count ?? 1
    const have = out.split(edit.find).length - 1
    if (have !== want) {
      throw new Error(
        `office-patch: ${rel}: "${edit.name}" expected ${want} match(es), found ${have}. ` +
          'Claude-Office changed upstream; update plugin/agent-office/office-build/office-patch.mjs.',
      )
    }
    out = out.split(edit.find).join(edit.replace)
  }

  let spriteHits = 0
  if (/^src\/.+\.tsx?$/.test(rel)) {
    out = out.replace(SPRITE_LITERAL, (_m, quote, dir) => {
      spriteHits += 1
      return `${quote}${OFFICE_PREFIX}/${dir}/`
    })
  }
  const expected = SPRITE_EXPECTED[rel]
  if (expected !== undefined && spriteHits < expected) {
    throw new Error(
      `office-patch: ${rel}: expected at least ${expected} sprite/room literals, found ${spriteHits}. ` +
        'Claude-Office changed upstream; update SPRITE_EXPECTED or the literal pattern.',
    )
  }
  return { code: out, spriteHits }
}
