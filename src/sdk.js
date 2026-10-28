// The dashboard provides React and an authenticated fetch on window.__HERMES_PLUGIN_SDK__.
// The plugin never bundles React (see the Hermes "Extending the Dashboard" docs).
const SDK = window.__HERMES_PLUGIN_SDK__;
export const React = SDK.React;
export const { useState, useEffect, useRef, useCallback, useMemo } = React;
export const fetchJSON = SDK.fetchJSON || (url => fetch(url, { credentials: 'same-origin' }).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }));
export const API = '/api/plugins/agent-office/state';
