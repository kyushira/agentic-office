// Injects PWA manifest / apple / theme tags into document.head at load time.
// The Hermes dashboard index.html cannot be edited, so the plugin does it here.

export const PWA_BASE = '/dashboard-plugins/agent-office/pwa';

export function headTags() {
  return [
    { tag: 'link', attrs: { rel: 'manifest', href: `${PWA_BASE}/manifest.json` } },
    { tag: 'link', attrs: { rel: 'apple-touch-icon', sizes: '180x180', href: `${PWA_BASE}/icon-180.png` } },
    { tag: 'link', attrs: { rel: 'icon', type: 'image/png', sizes: '192x192', href: `${PWA_BASE}/icon-192.png` } },
    { tag: 'meta', attrs: { name: 'apple-mobile-web-app-capable', content: 'yes' } },
    { tag: 'meta', attrs: { name: 'mobile-web-app-capable', content: 'yes' } },
    { tag: 'meta', attrs: { name: 'apple-mobile-web-app-status-bar-style', content: 'black-translucent' } },
    { tag: 'meta', attrs: { name: 'apple-mobile-web-app-title', content: 'Deck' } },
    { tag: 'meta', attrs: { name: 'theme-color', content: '#0f1115' } },
  ];
}

// Returns a selector that identifies an existing equivalent element, or null.
function keySelector(entry) {
  if (entry.tag === 'link' && entry.attrs.rel) return `link[rel="${entry.attrs.rel}"]`;
  if (entry.tag === 'meta' && entry.attrs.name) return `meta[name="${entry.attrs.name}"]`;
  return null;
}

// Idempotently adds PWA head tags and viewport-fit=cover. Returns number of
// tags added (viewport edits do not count). No-op returning 0 without doc/head.
export function installPwaHead(doc) {
  if (!doc || !doc.head) return 0;

  let added = 0;
  for (const entry of headTags()) {
    const sel = keySelector(entry);
    if (sel && doc.head.querySelector(sel)) continue;
    const el = doc.createElement(entry.tag);
    for (const [k, v] of Object.entries(entry.attrs)) el.setAttribute(k, v);
    el.setAttribute('data-agent-office', 'pwa');
    doc.head.appendChild(el);
    added += 1;
  }

  const viewport = doc.head.querySelector('meta[name="viewport"]');
  if (viewport) {
    const content = viewport.getAttribute('content') || '';
    if (!content.includes('viewport-fit')) {
      viewport.setAttribute('content', `${content}, viewport-fit=cover`);
    }
  } else {
    const meta = doc.createElement('meta');
    meta.setAttribute('name', 'viewport');
    meta.setAttribute('content', 'width=device-width, initial-scale=1, viewport-fit=cover');
    doc.head.appendChild(meta);
  }

  return added;
}
