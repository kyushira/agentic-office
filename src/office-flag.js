// Flag for the exact Claude-Office scene on Deck Home (Phase 1c). Pure: no DOM, no React.
// Default stays OfficeScene. The exact scene (OfficeFrame) shows when either is set:
//   - the URL hash contains 'office=exact'   (e.g. #office=exact)
//   - localStorage 'agent-office.officeScene' === 'exact'

export const OFFICE_FLAG_HASH = 'office=exact';
export const OFFICE_FLAG_KEY = 'agent-office.officeScene';
export const OFFICE_FLAG_VALUE = 'exact';

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
