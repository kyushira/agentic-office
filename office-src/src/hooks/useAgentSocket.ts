/**
 * useAgentSocket — Hermes postMessage bridge (Phase 1b).
 *
 * The iframe runs sandboxed with an opaque origin and CSP connect-src 'none':
 * no sockets, no fetch. The Deck parent polls /state and posts Claude-Office
 * events into this frame. This hook is the only place that listens for them.
 *
 * Accepted message (from the parent only, event.source === window.parent):
 *   { type: 'hermes-office', v: 1, events: OfficeEvent[] }
 * Each event keeps only a whitelisted `type` plus primitive values (nested objects
 * and arrays are copied up to two levels deep, primitives only). Anything else is
 * dropped silently.
 *
 * Outbound (window.parent, targetOrigin '*'; the payload is ids and status only):
 *   { type: 'hermes-office-ready', v: 1 }      on mount
 *   { type: 'hermes-office-pick',  v: 1, id }  when a Hermes character is clicked
 *
 * Accepted events go through the same onEvent callback the old socket used, so
 * App.tsx's handleEvent and reduceOffice run unchanged.
 */
import { useEffect, useRef, useState } from 'react'
import type { OfficeEvent, SessionInfo } from '../types'

export interface AgentSocketOptions {
  /** Called for every accepted event. A stable reference is recommended; a ref is kept anyway. */
  onEvent?: (event: OfficeEvent) => void
  /** Ignored (kept for call-site compatibility). */
  url?: string
  /** Disable the listener entirely (mock mode). */
  disabled?: boolean
}

export interface AgentSocketResult {
  connected: boolean
  mcpServers: string[]
  events: OfficeEvent[]
  offline: boolean
  sessions: SessionInfo[]
  trusted: boolean | null
}

const PROTOCOL = 'hermes-office'
const PROTOCOL_V = 1
const MAX_EVENTS = 200
const MAX_DEPTH = 2
const MAX_ITEMS = 200
const MAX_STRING = 2000

/** Every `type` the iframe acts on: the OfficeEvent union in types.ts. */
export const ACCEPTED_TYPES: ReadonlySet<string> = new Set([
  'agent_spawned', 'agent_working', 'agent_completed', 'mcp_call', 'mcp_done', 'new_hire',
  'chat_message', 'chat_typing', 'chat_reaction', 'chat_seen', 'inbox_update', 'variant_change',
  'session_started', 'session_ended', 'session_status', 'agent_status', 'snapshot',
  'session_prompt', 'session_turn_end', 'session_needs_you', 'session_error', 'session_compact',
  'session_cwd', 'session_model', 'session_main', 'session_tool_done', 'session_registry',
  'permission_request', 'permission_extended', 'permission_resolved',
  'health', 'connection', 'task_board',
])

const isPlain = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

/** Primitives only; strings capped. Containers are copied up to MAX_DEPTH; anything else is dropped. */
function clean(v: unknown, depth: number): unknown {
  if (v === null || typeof v === 'boolean') return v
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v === 'string') return v.length > MAX_STRING ? v.slice(0, MAX_STRING) : v
  if (depth >= MAX_DEPTH) return undefined
  if (Array.isArray(v)) {
    const out: unknown[] = []
    for (const item of v.slice(0, MAX_ITEMS)) {
      const c = clean(item, depth + 1)
      if (c !== undefined) out.push(c)
    }
    return out
  }
  if (isPlain(v)) {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(v)) {
      const c = clean(v[key], depth + 1)
      if (c !== undefined) out[key] = c
    }
    return out
  }
  return undefined
}

/** One message item -> an OfficeEvent, or null when it is not an accepted event. */
export function toOfficeEvent(item: unknown): OfficeEvent | null {
  if (!isPlain(item)) return null
  const type = item.type
  if (typeof type !== 'string' || !ACCEPTED_TYPES.has(type)) return null
  const out = clean(item, 0)
  return isPlain(out) ? (out as unknown as OfficeEvent) : null
}

/** Full check on a MessageEvent: parent window only, schema v1, events array. */
export function parseEnvelope(ev: MessageEvent, parent: Window | null): OfficeEvent[] | null {
  if (!parent || ev.source !== parent) return null
  const data: unknown = ev.data
  if (!isPlain(data) || data.type !== PROTOCOL || data.v !== PROTOCOL_V) return null
  if (!Array.isArray(data.events)) return null
  const out: OfficeEvent[] = []
  for (const item of data.events.slice(0, MAX_EVENTS)) {
    const e = toOfficeEvent(item)
    if (e) out.push(e)
  }
  return out
}

/**
 * Outbound click bridge. Only the profile id leaves the frame. Non-Hermes ids
 * (the boss, the decorative Claude) are not sent.
 */
export function postPick(agentId: string | null | undefined): void {
  if (typeof window === 'undefined' || typeof agentId !== 'string' || !agentId.startsWith('hermes-')) return
  const profile = agentId.slice('hermes-'.length).split(':')[0]
  if (!profile || window.parent === window) return
  window.parent.postMessage({ type: 'hermes-office-pick', v: PROTOCOL_V, id: profile }, '*')
}

export function useAgentSocket(options: AgentSocketOptions = {}): AgentSocketResult {
  const { disabled = false } = options
  const onEventRef = useRef(options.onEvent)
  onEventRef.current = options.onEvent
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    if (disabled || typeof window === 'undefined') return
    const parent = window.parent === window ? null : window.parent
    const onMessage = (ev: MessageEvent) => {
      const events = parseEnvelope(ev, parent)
      if (!events) return
      setConnected(true)
      const cb = onEventRef.current
      if (!cb) return
      for (const e of events) cb(e)
    }
    window.addEventListener('message', onMessage)
    if (parent) parent.postMessage({ type: 'hermes-office-ready', v: PROTOCOL_V }, '*')
    return () => window.removeEventListener('message', onMessage)
  }, [disabled])

  return {
    connected,
    mcpServers: [],
    events: [],
    offline: !connected,
    sessions: [],
    // Stays false: the frame has no path that sends chat or commands back, so the Deck keeps the read-only view.
    trusted: false,
  }
}
