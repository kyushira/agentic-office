import { ASSET_BASE } from './assetBase'
/**
 * incidentAssets.ts — asset slots for incident mode.
 *
 * v1 ships with EXISTING art only. Each slot names the PNG the real incident
 * art should land at (see the design spec, section 2.2) and the existing
 * sprite to use until it exists. Drop the real PNG at `intended` and the
 * office picks it up on the next load — no code change needed. A slot with
 * `fallback: null` renders nothing until its PNG is drawn.
 *
 * Detection is a runtime image probe (one HEAD-equivalent <img> load per slot
 * per page load) rather than a build-time glob, because files in public/
 * cannot be imported from JavaScript and the Electron build serves them as
 * plain files. Missing intended files show up as a handful of 404s in the
 * devtools network tab on load; that is expected until the art is drawn.
 */

export interface IncidentAssetSlot {
  /** Where the real art should go. */
  intended: string
  /** Existing art used until `intended` exists; null = render nothing. */
  fallback: string | null
  /** What the slot is for. */
  note: string
}

export const INCIDENT_ASSETS = {
  beacon: {
    intended: ASSET_BASE + 'sprites/incident/beacon-0.webp',
    fallback: ASSET_BASE + 'sprites/effects/fire.webp',
    note: 'Rotating red beacon, frame A (lens dark). Mounted on the wall above the door.',
  },
  beaconLit: {
    intended: ASSET_BASE + 'sprites/incident/beacon-1.webp',
    fallback: ASSET_BASE + 'sprites/effects/fire.webp',
    note: 'Beacon frame B (lens lit). Alternates with frame A at ~1.2 Hz.',
  },
  statusScreen: {
    intended: ASSET_BASE + 'sprites/incident/status-screen.webp',
    fallback: ASSET_BASE + 'sprites/culture/deploying-screen.webp',
    note: 'Wall TV during an incident — reads as the ROLLBACK status page.',
  },
  daysSign: {
    intended: ASSET_BASE + 'sprites/culture/days-last-incident.webp',
    fallback: ASSET_BASE + 'sprites/culture/days-last-incident.webp',
    note: '"Days since last incident" sign on the left wall; the digit is drawn live over the art.',
  },
  failedBubble: {
    intended: ASSET_BASE + 'sprites/effects/build-failed.webp',
    fallback: ASSET_BASE + 'sprites/effects/build-failed.webp',
    note: 'Bubble above an agent whose last tool call failed (incident mode only).',
  },
  incidentBoard: {
    intended: ASSET_BASE + 'sprites/incident/incident-board.webp',
    fallback: null,
    note: 'Incident timeline whiteboard over the kanban board hotspot (80%, 42%). Hidden until drawn.',
  },
  pizzaTower0: {
    intended: ASSET_BASE + 'sprites/incident/pizza-tower-0.webp',
    fallback: null,
    note: 'One pizza box on the coffee counter (first 10 min of an incident). Hidden until drawn.',
  },
  pizzaTower1: {
    intended: ASSET_BASE + 'sprites/incident/pizza-tower-1.webp',
    fallback: null,
    note: 'Three pizza boxes (10-30 min). Hidden until drawn.',
  },
  pizzaTower2: {
    intended: ASSET_BASE + 'sprites/incident/pizza-tower-2.webp',
    fallback: null,
    note: 'Six leaning pizza boxes (30 min+). Hidden until drawn.',
  },
} as const satisfies Record<string, IncidentAssetSlot>

export type IncidentAssetName = keyof typeof INCIDENT_ASSETS

// ---------------------------------------------------------------------------
// Per-role props: what each kind of agent grabs when prod goes down
// ---------------------------------------------------------------------------

/** The hand-held props, one PNG each (generated together, so they share a style). */
export const INCIDENT_PROPS = {
  pager: ASSET_BASE + 'sprites/incident/props/pager.webp',
  megaphone: ASSET_BASE + 'sprites/incident/props/megaphone.webp',
  extinguisher: ASSET_BASE + 'sprites/incident/props/extinguisher.webp',
  magnifier: ASSET_BASE + 'sprites/incident/props/magnifier.webp',
  canary: ASSET_BASE + 'sprites/incident/props/canary.webp',
  stopwatch: ASSET_BASE + 'sprites/incident/props/stopwatch.webp',
} as const

// Why these pairings: the on-call engineer's pager goes off, the boss shouts
// through a megaphone, whoever debugs puts the fire out, reviewers and security
// hunt for the cause, the tester's canary is the first to notice, and
// performance times the outage. Roles not listed (frontend, fullstack, the
// session's own Claude) carry nothing.
const ROLE_PROP: Record<string, keyof typeof INCIDENT_PROPS> = {
  'devops-engineer': 'pager',
  boss: 'megaphone',
  debugger: 'extinguisher',
  'general-purpose': 'extinguisher',
  'code-reviewer': 'magnifier',
  'architect-reviewer': 'magnifier',
  'security-auditor': 'magnifier',
  'test-engineer': 'canary',
  'performance-engineer': 'stopwatch',
}

/**
 * The prop an agent of `role` holds during an incident.
 * @param role the agent's role key (src/config.ts ROLE_TO_CHAR keys, or 'boss')
 * @returns the PNG path, or null for a role that carries nothing
 */
export function incidentPropFor(role: string): string | null {
  const prop = ROLE_PROP[role]
  return prop ? INCIDENT_PROPS[prop] : null
}

// ---------------------------------------------------------------------------
// Runtime probe: does the intended file exist?
// ---------------------------------------------------------------------------

const probeResults = new Map<string, boolean>()
const probesInFlight = new Map<string, Promise<boolean>>()
const probeListeners = new Set<() => void>()

/** Resolve true when `url` loads as an image. Cached per URL. */
export function probeImage(url: string): Promise<boolean> {
  const known = probeResults.get(url)
  if (known !== undefined) return Promise.resolve(known)
  const inFlight = probesInFlight.get(url)
  if (inFlight) return inFlight

  const p = new Promise<boolean>(resolve => {
    if (typeof Image === 'undefined') { resolve(false); return }
    const img = new Image()
    img.onload = () => resolve(img.naturalWidth > 0)
    img.onerror = () => resolve(false)
    img.src = url
  }).then(ok => {
    probeResults.set(url, ok)
    probesInFlight.delete(url)
    probeListeners.forEach(l => l())
    return ok
  })
  probesInFlight.set(url, p)
  return p
}

/** Kick off probes for every slot whose intended file differs from its fallback. */
export function probeIncidentAssets(): Promise<void> {
  const urls = Object.values(INCIDENT_ASSETS)
    .filter(slot => slot.intended !== slot.fallback)
    .map(slot => slot.intended)
  return Promise.all(urls.map(probeImage)).then(() => undefined)
}

/**
 * Synchronous lookup: the intended URL once a probe has confirmed it,
 * otherwise the fallback (which may be null = draw nothing). Slots whose
 * intended file IS the fallback need no probe.
 */
export function incidentAssetUrl(name: IncidentAssetName): string | null {
  const slot: IncidentAssetSlot = INCIDENT_ASSETS[name]
  if (slot.intended === slot.fallback) return slot.intended
  return probeResults.get(slot.intended) === true ? slot.intended : slot.fallback
}

export function subscribeIncidentAssets(fn: () => void): () => void {
  probeListeners.add(fn)
  return () => probeListeners.delete(fn)
}

/** Test hook. */
export function _setProbeResultForTests(url: string, ok: boolean) {
  probeResults.set(url, ok)
}
