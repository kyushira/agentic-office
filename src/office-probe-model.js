// Pure mapping from the proxy probe (HEAD on /api/plugins/agent-office/office/) to what OfficeHome shows.
// No DOM, no fetch here. Unit-tested in test/office-probe.test.js.

export const OFFICE_URL = '/api/plugins/agent-office/office/';

// The iframe is always the 756px room inside, so the office page cannot tell a phone from a desktop with a media
// query. The parent says so in the URL instead; office-patch.mjs (src/main.tsx) turns ?ao-tags=desktop into the
// class ao-tags-desktop on <html>, and embed.css draws the team name tags smaller under it.
export const DESKTOP_TAGS_PARAM = 'ao-tags';
export const DESKTOP_QUERY = '(min-width: 900px)';

/** The iframe src: the office page, plus ?ao-tags=desktop on a desktop-width viewport. */
export function officeFrameUrl({ desktop = false } = {}) {
  return desktop ? OFFICE_URL + '?' + DESKTOP_TAGS_PARAM + '=desktop' : OFFICE_URL;
}

// The probe is GET on /health, not HEAD on OFFICE_URL: the plugin serves office/ index.html statically (from
// office-dist) without reaching the office server, so a probe there answers 200 even when the server is down.
// /health is not a built file, so it is proxied upstream and its status reflects the office server.
export const OFFICE_PROBE_URL = '/api/plugins/agent-office/office/health';

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
