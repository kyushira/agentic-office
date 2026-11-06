import { React, useState, useEffect } from './sdk.js';
import { Sprite } from './Sprite.jsx';
import { statusWord, rosterDuration, clockText } from './deck-model.js';

/** Live state of a media query (phone vs desktop layout). */
export function useMedia(query) {
  const get = () => !!(window.matchMedia && window.matchMedia(query).matches);
  const [m, setM] = useState(get);
  useEffect(() => {
    if (!window.matchMedia) return undefined;
    const mq = window.matchMedia(query);
    const on = () => setM(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return m;
}

/** 'Updated 4s ago' from the last good poll. Ticks itself each second so the whole deck does not re-render. */
export function UpdatedAgo({ at, error }) {
  const [, tick] = useState(0);
  useEffect(() => { const id = setInterval(() => tick(x => x + 1), 1000); return () => clearInterval(id); }, []);
  if (error) return <span className="dk-pill is-err">Connection lost · retrying</span>;
  if (!at) return <span className="dk-pill">Updating…</span>;
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  return <span className="dk-pill" title="Time since the last successful refresh">Updated {s}s ago</span>;
}

/** Local clock, HH:MM, refreshed every 15 seconds. */
export function LiveClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const id = setInterval(() => setNow(new Date()), 15000); return () => clearInterval(id); }, []);
  return <time className="dk-pill dk-clock" dateTime={now.toISOString()}>{clockText(now)}</time>;
}

const BELL = (
  <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">
    <path d="M6 9a6 6 0 1 1 12 0c0 5.5 2 7 2 7H4s2-1.5 2-7M10 20a2 2 0 0 0 4 0" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Bell in the header: badge = number needing the user. Tapping opens the first one's panel. */
export function Bell({ count, onPick }) {
  const label = count ? `${count} agent${count === 1 ? '' : 's'} need${count === 1 ? 's' : ''} you` : 'Nothing needs you';
  return (
    <button type="button" className={'dk-pill dk-bell' + (count ? ' has-badge' : '')} aria-label={label} title={label}
      onClick={onPick} disabled={!count}>
      {BELL}
      {count > 0 && <b className="dk-bell-n" aria-hidden="true">{count}</b>}
    </button>
  );
}

/** Needs-you lane: red chip for a pending question, amber for an approval. Shown only when non-empty. */
export function NeedsYou({ items, onPick }) {
  if (!items.length) return null;
  return (
    <section className="dk-needs" aria-labelledby="dk-needs-h">
      <h2 id="dk-needs-h" className="dk-needs-h">Needs you <span className="dk-needs-n">{items.length}</span></h2>
      <ul className="dk-needs-list">
        {items.map(n => (
          <li key={n.id}>
            <button type="button" className={'dk-chip is-' + n.kind} onClick={() => onPick(n.id)}
              aria-label={`${n.name}: ${n.label}. Open ${n.name}`}>
              <span className="dk-chip-who">{n.name}</span>
              <span className="dk-chip-what">{n.label}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

const STATUS_CLS = { working: 'is-working', waiting: 'is-waiting', idle: 'is-idle', offline: 'is-offline' };

/** One card per agent: sprite, status dot, duration tag, name, status word. Tap opens the agent sheet. */
export function Roster({ agents, sessions, now, sel, onPick }) {
  if (!agents.length) return null;
  return (
    <section className="dk-roster-wrap" aria-label="Agent roster">
      <ul className="dk-roster">
        {agents.map(a => {
          const word = statusWord(a.status);
          const dur = rosterDuration(a, (sessions || {})[a.id], now);
          const cls = STATUS_CLS[a.status] || 'is-idle';
          return (
            <li key={a.id} className="dk-rcard-li">
              <button type="button" className={'dk-rcard ' + cls + (sel === 'a:' + a.id ? ' is-pressed' : '')}
                style={{ '--dk-c': a.color || '#8a8a8a' }} onClick={() => onPick(a.id)}
                aria-label={`${a.name}, ${word}${dur ? `, ${dur}` : ''}. Open panel`}>
                <span className="dk-rcard-art"><Sprite who={a.id} small working={a.status === 'working'} /></span>
                <span className="dk-rcard-txt">
                  <span className="dk-rcard-name">{a.name}{dur && <span className="dk-rtag" title={`${word} for ${dur}`}>{dur}</span>}</span>
                  <span className="dk-rstat"><i className="dk-rdot" aria-hidden="true" />{word}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Phone-only segmented control: Office | Comms, one page, one pane visible at a time. */
export function PaneTabs({ pane, setPane }) {
  const tabs = [['office', 'Office'], ['comms', 'Comms']];
  const onKey = (e, i) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next = (i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
    setPane(tabs[next][0]);
    e.currentTarget.parentElement.querySelectorAll('[role="tab"]')[next].focus();
  };
  return (
    <div className="dk-seg" role="tablist" aria-label="Office or Comms">
      {tabs.map(([id, label], i) => {
        const on = pane === id;
        return (
          <button key={id} id={'dk-pane-tab-' + id} type="button" role="tab" aria-selected={on}
            aria-controls={'dk-pane-' + id} tabIndex={on ? 0 : -1} className={'dk-seg-btn' + (on ? ' is-on' : '')}
            onClick={() => setPane(id)} onKeyDown={e => onKey(e, i)}>{label}</button>
        );
      })}
    </div>
  );
}
