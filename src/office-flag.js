// Flag for the exact Claude-Office scene on Deck Home (Phase 1c). Pure: no DOM, no React.
// Default stays OfficeScene. The exact scene (OfficeFrame) shows when either is set:
//   - the URL hash contains 'office=exact'   (e.g. #office=exact)
//   - localStorage 'agent-office.officeScene' === 'exact'

export const OFFICE_FLAG_HASH = 'office=exact';
export const OFFICE_FLAG_KEY = 'agent-office.officeScene';
export const OFFICE_FLAG_VALUE = 'exact';

// Phase 1d: while the exact office is the Home scene on screen, the Deck's existing /state poll runs at this
// interval (the scene must reflect a change within 8 s). Otherwise the Deck's normal interval applies.
export const OFFICE_POLL_MS = 4000;

/** The poll interval for the next /state read: OFFICE_POLL_MS when the exact office is shown, else baseMs. */
export function pollMsFor(officeShown, baseMs) {
  return officeShown === true ? OFFICE_POLL_MS : baseMs;
}

/**
 * True when the exact office should render. hash: location.hash. readStored: a function returning the
 * stored flag value. It may throw (private windows and blocked site data do); a throw means "not set".
 */
export function officeExactRequested(hash, readStored) {
  if (typeof hash === 'string' && hash.includes(OFFICE_FLAG_HASH)) return true;
  try {
    return typeof readStored === 'function' && readStored() === OFFICE_FLAG_VALUE;
  } catch (e) {
    return false;
  }
}
