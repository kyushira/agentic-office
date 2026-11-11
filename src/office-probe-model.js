// Pure mapping from the proxy probe (HEAD on /api/plugins/agent-office/office/) to what OfficeHome shows.
// No DOM, no fetch here. Unit-tested in test/office-probe.test.js.

export const OFFICE_URL = '/api/plugins/agent-office/office/';

/**
 * status: the HTTP status of the probe response, or null when there was no response (network error).
 * redirectType: response.type for a manual redirect ('opaqueredirect'), else undefined.
 * Returns 'ready' | 'login' | 'offline'.
 *   2xx                      -> 'ready' (mount the iframe)
 *   401 / 403, or a redirect -> 'login' (the dashboard session is missing: the proxy 403s without auth)
 *   anything else, no reply  -> 'offline' (502/503/504 from the proxy, 404, network error)
 */
export function probeOutcome(status, redirectType) {
  if (redirectType === 'opaqueredirect') return 'login';
  const s = Number(status);
  if (!Number.isFinite(s) || s === 0) return 'offline';
  if (s >= 200 && s < 300) return 'ready';
  if (s === 401 || s === 403) return 'login';
  return 'offline';
}
