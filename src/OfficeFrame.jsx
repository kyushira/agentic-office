// The exact Claude-Office scene on Deck Home (Phase 1c, behind the office=exact flag; Deck.jsx picks it).
// The scene runs in a sandboxed iframe with an opaque origin: allow-scripts only, no network (its own CSP
// says connect-src 'none'). It cannot read the Deck's storage or cookies. The Deck pushes envelopes built by
// office-adapter.js into it, and takes click picks back. No polling here: state arrives from the Deck's
// existing /state poll (the `state` prop).
import { React, useEffect, useRef, useState } from './sdk.js';
import { OFFICE_BASE } from './office-model.js';
import { diffState, connectionEvent, envelope } from './office-adapter.js';
import { parseFrameMessage, frameScale, isKnownAgent, firstSyncEvents, ROOM_W, ROOM_H } from './office-frame-model.js';

const SRC = OFFICE_BASE + '/app/index.html';

/**
 * state: the Deck's /state object (or null before the first good poll). error: the Deck's poll error ('' when ok).
 * onPick(profileId): a character was clicked. Mounted by the Deck only while Home is visible.
 */
export function OfficeFrame({ state, error, onPick }) {
  const boxRef = useRef(null);
  const frameRef = useRef(null);
  const latest = useRef(state);
  latest.current = state;
  const pickRef = useRef(onPick);
  pickRef.current = onPick;
  const ready = useRef(false);   // the frame posted hermes-office-ready, so its listener is up
  const sent = useRef(null);     // the last state whose diff was posted to the frame
  const [scale, setScale] = useState(1);

  // Only the envelope from office-adapter.js leaves the Deck. targetOrigin is '*' because the frame's origin
  // is opaque ('null') and cannot be named; the payload is plain event data, with no secrets.
  const post = events => {
    const w = frameRef.current && frameRef.current.contentWindow;
    if (!w || !ready.current || events.length === 0) return;
    w.postMessage(envelope(events), '*');
  };
  // Post what changed since the last post. sent null (first sync, or a fresh frame) gives a full snapshot.
  const sync = () => {
    const s = latest.current;
    if (!ready.current || !s) return;
    const events = [...(sent.current ? diffState(sent.current, s) : firstSyncEvents(s)), connectionEvent(true)];
    sent.current = s;
    post(events);
  };

  // Every good poll: the new state, as a diff.
  useEffect(() => { sync(); }, [state]);
  // A failed poll: the connection strip shows closed (the scene keeps its last agents).
  useEffect(() => { if (error) post([connectionEvent(false)]); }, [error]);

  useEffect(() => {
    const onMessage = ev => {
      const frame = frameRef.current;
      if (!frame || !frame.contentWindow || ev.source !== frame.contentWindow) return;
      const msg = parseFrameMessage(ev.data);
      if (!msg) return;
      if (msg.type === 'ready') { ready.current = true; sent.current = null; sync(); return; }
      if (msg.type === 'pick' && isKnownAgent(latest.current, msg.id) && pickRef.current) pickRef.current(msg.id);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // Fit-to-width: the 1056x682 room is scaled by the pane's width. ResizeObserver, no timers.
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return undefined;
    const measure = () => setScale(frameScale(box.clientWidth));
    measure();
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(measure);
      ro.observe(box);
      return () => ro.disconnect();
    }
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  return (
    <div className="dk-ofr" ref={boxRef} style={{ height: ROOM_H * scale + 'px' }}>
      {/* allow-scripts only: no allow-same-origin (opaque origin), no top navigation, forms, popups or modals. */}
      <iframe ref={frameRef} className="dk-ofr-frame" title="Office" src={SRC}
        sandbox="allow-scripts" referrerPolicy="no-referrer" allow="" loading="lazy"
        style={{ width: ROOM_W + 'px', height: ROOM_H + 'px', transform: `scale(${scale})` }} />
    </div>
  );
}
