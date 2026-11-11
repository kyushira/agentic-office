/**
 * useAgentSocket — Phase 1a stub (Hermes Deck port).
 *
 * The upstream hook opened a socket to the Claude-Office server and fetched
 * /roster. Both are removed: the iframe runs with an opaque origin and has no
 * network access (CSP connect-src 'none'). It keeps the same return shape so
 * App.tsx compiles unchanged.
 *
 * Phase 1b replaces this body: the Deck posts real Hermes state into the
 * iframe via window.postMessage, and the bridge below turns it into events.
 */
import type { OfficeEvent, SessionInfo } from '../types'

export interface AgentSocketOptions {
  /** Called for every incoming event. Stable reference recommended (useCallback). */
  onEvent?: (event: OfficeEvent) => void
  /** Ignored in the stub (kept for call-site compatibility). */
  url?: string
  /** Disable connection entirely (mock mode). */
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

// HERMES-BRIDGE: Phase 1b wires window 'message' events from the Deck parent here
// (origin-checked, schema-validated) and dispatches them through the same onEvent path.
// Until then nothing is delivered.
const STUB_RESULT: AgentSocketResult = {
  connected: false,
  mcpServers: [],
  events: [],
  offline: true,
  sessions: [],
  trusted: false,
}

export function useAgentSocket(_options: AgentSocketOptions = {}): AgentSocketResult {
  return STUB_RESULT
}
