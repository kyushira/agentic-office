// The dashboard provides React and an authenticated fetch on window.__HERMES_PLUGIN_SDK__.
// The plugin never bundles React (see the Hermes "Extending the Dashboard" docs).
const SDK = window.__HERMES_PLUGIN_SDK__;
export const React = SDK.React;
export const { useState, useEffect, useRef, useCallback, useMemo } = React;
// Fallback when the host SDK has no fetchJSON. Errors look like the host's: .status (0 = no response) and .body (raw text).
export const fetchJSON = SDK.fetchJSON || (async (url, init) => {
  let r;
  try { r = await fetch(url, { credentials: 'same-origin', ...init }); }
  catch (e) { throw Object.assign(new Error(String(e && e.message || e)), { status: 0, body: '' }); }
  const text = await r.text();
  if (!r.ok) throw Object.assign(new Error(`${r.status}: ${text}`), { status: r.status, body: text });
  return JSON.parse(text);
});
export const API = '/api/plugins/agent-office/state';
export const USAGE_API = '/api/plugins/agent-office/usage';
export const SERVER_API = '/api/plugins/agent-office/server';
export const SESSION_API = '/api/plugins/agent-office/session';
