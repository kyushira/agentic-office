// Mimics what the Hermes dashboard gives a plugin: window.__HERMES_PLUGIN_SDK__ and
// window.__HERMES_PLUGINS__.register(), then loads the built plugin bundle and CSS.
import React from 'react';
import { createRoot } from 'react-dom/client';

window.__HERMES_PLUGIN_SDK__ = {
  React,
  hooks: { useState: React.useState, useEffect: React.useEffect, useRef: React.useRef, useMemo: React.useMemo, useCallback: React.useCallback },
  // Same error shape as the host's ApiError: numeric .status (0 = no response), raw response text in .body.
  fetchJSON: async (url, init) => {
    let r;
    try { r = await fetch(url, { credentials: 'same-origin', ...init }); }
    catch (e) { throw Object.assign(new Error('Could not reach the server'), { status: 0, body: '' }); }
    const text = await r.text();
    if (!r.ok) throw Object.assign(new Error('HTTP ' + r.status), { status: r.status, body: text });
    return JSON.parse(text);
  },
};
const root = createRoot(document.getElementById('root'));
window.__HERMES_PLUGINS__ = { register: (name, Comp) => root.render(React.createElement(Comp)), registerSlot() {} };

const css = document.createElement('link');
css.rel = 'stylesheet'; css.href = '/dashboard-plugins/agent-office/dist/style.css';
document.head.appendChild(css);
const s = document.createElement('script');
s.src = '/dashboard-plugins/agent-office/dist/index.js';
document.body.appendChild(s);
