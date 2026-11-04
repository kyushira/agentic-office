// Pure fullscreen / standalone helpers. No DOM globals: everything is injected.

// True when the page runs as an installed app or in fullscreen display mode.
export function isStandalone(win) {
  if (!win) return false;
  try {
    if (typeof win.matchMedia === 'function') {
      const mq = win.matchMedia('(display-mode: standalone)');
      const mf = win.matchMedia('(display-mode: fullscreen)');
      if ((mq && mq.matches) || (mf && mf.matches)) return true;
    }
  } catch {
    // fall through to the iOS flag
  }
  return win.navigator?.standalone === true;
}

// Full-view mode is on when standalone, or when ?full=1 is present.
export function wantsFull(search, standalone) {
  if (standalone) return true;
  return new URLSearchParams(search).get('full') === '1';
}

// Return a relative URL (pathname+search+hash) with ?full=1 set or removed.
export function withFullParam(href, on) {
  const url = new URL(href);
  if (on) url.searchParams.set('full', '1');
  else url.searchParams.delete('full');
  return url.pathname + url.search + url.hash;
}

// Ask the element to enter native fullscreen. Resolves true on success.
export async function requestNativeFullscreen(el) {
  const fn = el && (el.requestFullscreen || el.webkitRequestFullscreen);
  if (typeof fn !== 'function') return false;
  try {
    await fn.call(el);
    return true;
  } catch {
    return false;
  }
}

// Leave native fullscreen if the document is currently in it. Errors are swallowed.
export async function exitNativeFullscreen(doc) {
  if (!doc) return;
  if (!(doc.fullscreenElement || doc.webkitFullscreenElement)) return;
  const fn = doc.exitFullscreen || doc.webkitExitFullscreen;
  if (typeof fn !== 'function') return;
  try {
    await fn.call(doc);
  } catch {
    // ignore
  }
}

// Attribute marking every ancestor of a fullscreen overlay (up to <html>), so CSS can hide
// their non-ancestor siblings and drop transforms/filters that would trap position:fixed.
export const FULL_PATH_ATTR = 'data-ao-full-path';

// Marks el's ancestors (not el itself, not <html>). Returns a cleanup that removes exactly those marks.
export function markFullPath(el) {
  if (!el) return () => {};
  const marked = [];
  let node = el.parentElement;
  while (node && node.tagName !== 'HTML') {
    node.setAttribute(FULL_PATH_ATTR, '');
    marked.push(node);
    node = node.parentElement;
  }
  return () => {
    for (const n of marked) n.removeAttribute(FULL_PATH_ATTR);
  };
}
