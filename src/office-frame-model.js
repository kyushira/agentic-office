// Pure helpers for OfficeFrame (Phase 1c). No DOM, no React; unit-tested in test/office-flag.test.js.
import { snapshotEvents, diffState } from './office-adapter.js';

// The app's fixed room (office-src/src/styles/office.css .app-wrapper). The iframe is this size, then scaled.
export const ROOM_W = 1056;
export const ROOM_H = 682;

/**
 * Events for the first sync into a fresh frame. The scene's `snapshot` handler refreshes agents it already
 * has but never seats new ones (officeReducer 'snapshot'), so the snapshot is followed by agent_spawned for
 * each present agent (the diff from an empty prev), which is what makes them walk in.
 */
export function firstSyncEvents(state) {
  return [...snapshotEvents(state), ...diffState({}, state)];
}

const MAX_ID = 64;

/**
 * Schema check for a message from the office iframe. Returns {type:'ready'}, {type:'pick', id} or null.
 * Anything else (wrong version, unknown type, non-string or empty id) is null. The caller also checks
 * event.source; this checks only the payload.
 */
export function parseFrameMessage(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
  if (data.v !== 1) return null;
  if (data.type === 'hermes-office-ready') return { type: 'ready' };
  if (data.type === 'hermes-office-pick' && typeof data.id === 'string' && data.id.length > 0 && data.id.length <= MAX_ID) {
    return { type: 'pick', id: data.id };
  }
  return null;
}

/** Fit-to-width scale for a box of the given CSS width. Never upscales (pixel art). Unknown width -> 1. */
export function frameScale(width, roomW = ROOM_W) {
  const w = Number(width);
  if (!Number.isFinite(w) || w <= 0 || !(roomW > 0)) return 1;
  return Math.min(1, w / roomW);
}

/** True when the /state object lists an agent with this profile id (a pick must name a real agent). */
export function isKnownAgent(state, id) {
  return !!state && Array.isArray(state.agents) && state.agents.some(a => !!a && a.id === id);
}
