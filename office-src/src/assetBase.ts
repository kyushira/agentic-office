/**
 * assetBase.ts — the one place asset URLs are rooted.
 *
 * The scene runs in an iframe with an opaque origin (sandbox without
 * same-origin), so a root-relative path would point at the Deck's own origin.
 * './' resolves against the iframe document's URL, which
 * is the packaged app/ directory where sprites/ and rooms/ sit beside index.html.
 */
export const ASSET_BASE = './'
