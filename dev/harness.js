// Mimics what the Hermes dashboard gives a plugin: window.__HERMES_PLUGIN_SDK__ and
// window.__HERMES_PLUGINS__.register(), then loads the built plugin bundle and CSS.
import React from 'react';
import { createRoot } from 'react-dom/client';

window.__HERMES_PLUGIN_SDK__ = {
  React,
  hooks: { useState: React.useState, useEffect: React.useEffect, useRef: React.useRef, useMemo: React.useMemo, useCallback: React.useCallback },
  fetchJSON: url => fetch(url).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }),
};
const root = createRoot(document.getElementById('root'));
window.__HERMES_PLUGINS__ = { register: (name, Comp) => root.render(React.createElement(Comp)), registerSlot() {} };

const css = document.createElement('link');
css.rel = 'stylesheet'; css.href = '/dashboard-plugins/agent-office/dist/style.css';
document.head.appendChild(css);
const s = document.createElement('script');
s.src = '/dashboard-plugins/agent-office/dist/index.js';
document.body.appendChild(s);
