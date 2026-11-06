import { React, useState, useEffect, useRef } from './sdk.js';
import { RAIL_SECTIONS, RAIL_LINE, isAtBottom, pickActive } from './rail-model.js';

/**
 * Desktop left icon rail (>= 900px, rendered by Deck only on desktop). One page: its buttons never switch
 * views, they scroll to and focus an existing section, and the active button follows the scroll position.
 * Fullscreen and Lite reuse the Deck's own state and handlers (passed in), not a copy.
 */

const reducedMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

const svg = children => (
  <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false" fill="none"
    stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{children}</svg>
);

const ICONS = {
  office: svg(<><rect x="3.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.5" /></>),
  needs: svg(<><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5v5.5M12 16v.5" /></>),
  live: svg(<path d="M4 5h16v10.5H9.5L5 19.5V15H4z" />),
  activity: svg(<path d="M3 12h4l2.5-6 4 12 2.5-6H21" />),
  projects: svg(<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />),
  usage: svg(<><path d="M4.5 16a7.5 7.5 0 1 1 15 0" /><path d="M12 16l3.5-4" /></>),
  full: svg(<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />),
  lite: svg(<path d="M13 3L5.5 13.5H12L11 21l7.5-10.5H12z" />),
};

const LOGO = (
  <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true" focusable="false">
    <rect x="2.5" y="2.5" width="19" height="19" rx="6" fill="none" stroke="var(--dk-hot)" strokeWidth="1.6" />
    <circle cx="12" cy="12" r="3.2" fill="var(--dk-hot)" />
  </svg>
);

/** Only elements that can take focus themselves get tabindex -1; a button keeps its place in the Tab order. */
const NATIVE_FOCUS = 'button, a[href], input, select, textarea, [tabindex]';

export default function Rail({ rootRef, needsCount, full, standalone, lite, onToggleFull, onToggleLite }) {
  const [active, setActive] = useState(RAIL_SECTIONS[0].id);
  const activeRef = useRef(active);
  const chooseActive = id => { activeRef.current = id; setActive(id); };

  // Follow the scroll position. The scroll area is the Deck's .dk-scroll; IntersectionObserver reports
  // visibility and each change triggers a re-measure, and a scroll listener keeps the positions current.
  // Without IntersectionObserver the scroll listener alone still works.
  const hasNeeds = needsCount > 0;
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const scroller = root.querySelector('.dk-scroll');
    if (!scroller) return undefined;
    let raf = 0, alive = true;
    const measure = () => {
      raf = 0;
      if (!alive) return;
      const sr = scroller.getBoundingClientRect();
      const items = RAIL_SECTIONS.map(s => {
        const el = root.querySelector('#' + s.target);
        if (!el) return { id: s.id, top: null, visible: false };
        const r = el.getBoundingClientRect();
        return { id: s.id, top: r.top - sr.top, visible: r.bottom > sr.top && r.top < sr.bottom };
      });
      const next = pickActive({
        items, line: sr.height * RAIL_LINE, atBottom: isAtBottom(scroller.scrollTop, scroller.clientHeight, scroller.scrollHeight),
        current: activeRef.current,
      });
      if (next && next !== activeRef.current) chooseActive(next);
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(measure); };
    scroller.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    let io = null;
    if (typeof IntersectionObserver === 'function') {
      io = new IntersectionObserver(schedule, { root: scroller, threshold: [0, 0.25, 0.5, 0.75, 1] });
      for (const s of RAIL_SECTIONS) {
        const el = root.querySelector('#' + s.target);
        if (el) io.observe(el);
      }
    }
    schedule();
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      scroller.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      if (io) io.disconnect();
    };
    // Re-observe when the Needs section appears or goes (it is the only target that comes and goes).
  }, [hasNeeds, rootRef]);

  const go = s => {
    const root = rootRef.current;
    if (!root) return;
    const el = root.querySelector('#' + s.target) || (s.fallback ? root.querySelector('#' + s.fallback) : null);
    if (!el) return;
    if (!el.matches(NATIVE_FOCUS)) el.setAttribute('tabindex', '-1');
    el.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
    el.focus({ preventScroll: true });
    chooseActive(s.id);
  };

  return (
    <nav className="dk-rail" aria-label="Sections">
      <div className="dk-rail-top">
        <span className="dk-rail-logo" aria-hidden="true">{LOGO}</span>
        <ul className="dk-rail-list">
          {RAIL_SECTIONS.map(s => {
            const on = active === s.id;
            const label = s.id === 'needs' && needsCount ? `${s.label}, ${needsCount} waiting` : s.label;
            return (
              <li key={s.id}>
                <button type="button" className="dk-rail-btn" aria-label={label}
                  aria-current={on ? 'true' : undefined} onClick={() => go(s)}>
                  {ICONS[s.id]}
                  <span className="dk-rail-tip" aria-hidden="true">{s.label}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      <div className="dk-rail-bottom">
        <ul className="dk-rail-list">
          {!standalone && (
            <li>
              <button type="button" className="dk-rail-btn" aria-label="Fullscreen deck" aria-pressed={full}
                onClick={onToggleFull}>
                {ICONS.full}
                <span className="dk-rail-tip" aria-hidden="true">{full ? 'Exit fullscreen' : 'Fullscreen'}</span>
              </button>
            </li>
          )}
          <li>
            <button type="button" className="dk-rail-btn" aria-label="Lite mode" aria-pressed={lite} onClick={onToggleLite}>
              {ICONS.lite}
              <span className="dk-rail-tip" aria-hidden="true">Lite</span>
            </button>
          </li>
        </ul>
        <span className="dk-rail-me" role="img" aria-label="Signed in as CEO">D</span>
      </div>
    </nav>
  );
}
