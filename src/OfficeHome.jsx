// Home's office: the live Claude Office in a same-origin proxy iframe, fitted to the pane width.
//
// Lazy: nothing is fetched or mounted unless `active` (Deck passes it: Home tab shown, page visible, and on
// phone the Office pane selected). When `active` goes false the iframe unmounts, which closes its WebSocket
// (the server's viewer count drops). Before the iframe mounts, a GET probe of the proxy's /health decides the state:
// 2xx -> iframe, 401/403/login redirect -> "needs dashboard login", anything else -> "Office server offline".
import { React, useState, useEffect, useRef } from './sdk.js';
import { ROOM_W, ROOM_H, ZOOM_ONE, frameScale, zoomNext, defaultZoomMode } from './office-zoom-model.js';
import { OFFICE_PROBE_URL, DESKTOP_QUERY, officeFrameUrl, probeOutcome } from './office-probe-model.js';

/** GET on the upstream-backed /health route with the dashboard session cookie (same-origin). Redirects are not followed: a login redirect is 'login'. */
async function probeOffice() {
  try {
    const r = await fetch(OFFICE_PROBE_URL, { method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'manual' });
    return probeOutcome(r.status, r.type);
  } catch (e) {
    return probeOutcome(null);
  }
}

const coarseLandscape = () =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  && window.matchMedia('(pointer: coarse) and (orientation: landscape)').matches;

// Desktop-width viewport (the Deck's own 900px split). Read once per mount: changing the src would reload the office.
const desktopViewport = () =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(DESKTOP_QUERY).matches;

export default function OfficeHome({ active }) {
  const [phase, setPhase] = useState('idle');        // idle | checking | ready | offline | login
  const [attempt, setAttempt] = useState(0);         // bumped by Retry to probe again
  const [mode, setMode] = useState(() => defaultZoomMode({ coarseLandscape: coarseLandscape() }));
  const [width, setWidth] = useState(0);             // pane width in CSS px (0 until measured)
  const [frameUrl] = useState(() => officeFrameUrl({ desktop: desktopViewport() }));
  const boxRef = useRef(null);

  // Probe only while active; leaving Home (or hiding the page) drops back to idle and unmounts the iframe.
  useEffect(() => {
    if (!active) { setPhase('idle'); return undefined; }
    let live = true;
    setPhase('checking');
    probeOffice().then(outcome => { if (live) setPhase(outcome); });
    return () => { live = false; };
  }, [active, attempt]);

  // Fit-to-width: measure the pane with a ResizeObserver (no timers). Only needed while the frame is shown.
  useEffect(() => {
    const el = boxRef.current;
    if (!active || phase !== 'ready' || !el) return undefined;
    const measure = () => setWidth(el.clientWidth);
    measure();
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      return () => ro.disconnect();
    }
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [active, phase]);

  if (!active) return null;

  const one = mode === ZOOM_ONE;
  const scale = frameScale(width, mode);
  const retry = () => setAttempt(n => n + 1);
  const toggleZoom = () => setMode(m => zoomNext(m, 'toggle'));

  let body;
  if (phase === 'ready') {
    // 1x: the pane scrolls (and the user pans it). Fit: the box is the scaled room's height, nothing scrolls.
    const boxStyle = one
      ? { height: 'min(70vh, ' + ROOM_H + 'px)', overflow: 'auto', touchAction: 'pan-x pan-y pinch-zoom' }
      : { height: Math.round(ROOM_H * scale) + 'px', overflow: 'hidden' };
    body = (
      <>
        <div className="dk-oh-bar">
          <button type="button" className="dk-oh-zoom" aria-pressed={one} onClick={toggleZoom}
            aria-label={one ? 'Office zoom: actual size. Switch to fit' : 'Office zoom: fitted to the pane. Switch to actual size'}
            title={one ? 'Actual size: tap to fit the whole room' : 'Fitted to the pane: tap for actual size'}>
            {one ? 'Fit' : '1x'}
          </button>
        </div>
        <div ref={boxRef} className="dk-oh-box" style={boxStyle}>
          <iframe className="dk-oh-frame" title="Claude Office: live office scene" src={frameUrl}
            style={{ width: ROOM_W + 'px', height: ROOM_H + 'px', transform: `scale(${scale})`, visibility: width ? 'visible' : 'hidden' }} />
        </div>
      </>
    );
  } else if (phase === 'login') {
    body = (
      <div className="dk-oh-card" role="status">
        <h3 className="dk-oh-card-h">Office needs dashboard login</h3>
        <p className="dk-oh-card-p">Sign in to the dashboard, then retry. The other tabs still work.</p>
        <button type="button" className="dk-oh-retry" onClick={retry} aria-label="Retry the office connection">Retry</button>
      </div>
    );
  } else if (phase === 'offline') {
    body = (
      <div className="dk-oh-card" role="status">
        <h3 className="dk-oh-card-h">Office server offline</h3>
        <p className="dk-oh-card-p">The office scene is not reachable right now. The other tabs still work.</p>
        <button type="button" className="dk-oh-retry" onClick={retry} aria-label="Retry connecting to the office server">Retry</button>
      </div>
    );
  } else {
    body = <div className="dk-oh-skel" aria-busy="true" aria-label="Checking the office" />;
  }

  return (
    <section className="dk-oh" aria-label="Office">
      {body}
    </section>
  );
}
