import { React, useState, useEffect, useRef, fetchJSON, API, USAGE_API, SESSION_API } from './sdk.js';
import { ago, compact, resetCountdown } from './format.js';
import { buildItems, headerCounts, durationText, modelText, modelParts, usageText, meterLevel, activeTokens, currentSessionId, eventLabel, detailRows, traceModel, newToolCalls, countStep, todayParts, COUNT_MS, newWalks, walkLabel, toolRing, newBrainTrips, brainCounts, brainText, brainNotes, helperChanges, swarmTip, needsYou, greeting, resetSoon, RIGHT_PANE_DEFAULT, livePolls, commsPolls, speechText } from './deck-model.js';
import { isStandalone, wantsFull, withFullParam, requestNativeFullscreen, exitNativeFullscreen, markFullPath } from './fullscreen.js';
import { Live } from './Mission.jsx';
import MissionComms from './MissionComms.jsx';
import { useDialogFocus } from './dialog-focus.js';
import { Sprite } from './Sprite.jsx';
import { useMedia, UpdatedAgo, LiveClock, Bell, NeedsYou, PaneTabs } from './DeckRevamp.jsx';
import { MemoryPane } from './Memory.jsx';
import { BrainDetail } from './BrainDetail.jsx';
import { UsageRings } from './UsageRings.jsx';
import { ServerCard } from './ServerCard.jsx';
import { ProjectsList } from './ProjectsList.jsx';
import { visibleInterval } from './visible-timer.js';
import Rail from './Rail.jsx';


const POLL_MS = 15000, POLL_LITE_MS = 15000, DETAIL_MS = 5000;   // spec 5: 15s visible, Lite no slower; hidden is paused elsewhere

const pctStr = p => (p == null ? 'n/a' : Math.round(p) + '%');

/**
 * Thin percent bar (cyan ok, amber warn, red hot). No value means a bare track.
 * Inside a button the button's aria-label carries the number, so pass `decorative`.
 */
function Meter({ pct, label, decorative }) {
  const lvl = meterLevel(pct);
  const fill = lvl === 'na' ? null : <i style={{ transform: `scaleX(${Math.max(0, Math.min(100, +pct)) / 100})` }} />;
  if (decorative || lvl === 'na') return <span className={'dk-meter is-' + lvl} aria-hidden="true">{fill}</span>;
  return <span className={'dk-meter is-' + lvl} role="meter" aria-valuemin={0} aria-valuemax={100}
    aria-valuenow={Math.round(+pct)} aria-label={label}>{fill}</span>;
}

// Desktop reads "Opus 5.5 · helpers Haiku". On phone (style.css) the main model gets line 1 and the
// helpers line 2 as "+ Haiku"; the full text stays in the title attribute.
function ModelLines({ a }) {
  const { main, helpers } = modelParts(a);
  return (<>
    <span className="dk-m1">{main}</span>
    {helpers && <><span className="dk-sep"> · helpers </span><span className="dk-m2">{helpers}</span></>}
  </>);
}

/**
 * Hourly tool-call trace (last 12h) from spark.toolCalls. Scrolls only for a working agent with data;
 * `blip` is a counter that bumps when new tool calls land (the dot is remounted by key to replay).
 */
function ActivityStrip({ spark, working, blip }) {
  const t = traceModel(spark);
  if (!t) return <span className="dk-strip-none">no data</span>;
  const pts = t.points.map(p => p.join(',')).join(' ');
  return (
    <span className={'dk-strip' + (working ? ' is-scroll' : '')}>
      <svg viewBox={`0 0 ${t.width} ${t.height}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
        <g className="dk-trace-run"><polyline className="dk-trace" points={pts} vectorEffect="non-scaling-stroke" /></g>
      </svg>
      {blip > 0 && <i key={blip} className="dk-blip" />}
      <span className="dk-sr">tool calls per hour, last 12h</span>
    </span>
  );
}

/**
 * Tool-mix donut from toolRing(): one stroke circle per tool, sized with pathLength="100" so a
 * segment's share is a percentage. Segments start at 12 o'clock. Draw-in replays only when the set of
 * tools changes (the key on the wrapper). Only the running tool gets the pulse and the orbit marker.
 * Decorative beyond the role=img label; the sheet repeats the counts in a legend.
 */
const RING_R = 15.9155;   // circumference 100 with pathLength="100"
function ToolRing({ model, big }) {
  const { segments, aria } = model;
  const setKey = segments.map(s => s.name).join('|');
  const runs = segments.find(s => s.active);
  return (
    <svg className={'dk-ring' + (big ? ' is-big' : '')} viewBox="0 0 42 42" role="img" aria-label={aria} focusable="false">
      <circle className="dk-ring-track" cx="21" cy="21" r={RING_R} pathLength="100" />
      <g key={setKey} transform="rotate(-90 21 21)">
        {segments.map((s, i) => (
          <g key={s.name} className="dk-ring-seg" style={{ animationDelay: `${i * 90}ms` }}>
            <circle className={'dk-ring-arc' + (s.active ? ' is-active' : '')} cx="21" cy="21" r={RING_R} pathLength="100"
              strokeDasharray={`${s.frac * 100} ${100 - s.frac * 100}`} strokeDashoffset={-s.offset * 100} strokeOpacity={s.shade} />
          </g>
        ))}
      </g>
      {runs && <g className="dk-ring-orbit"><circle cx="21" cy="2.2" r="1.3" /></g>}
    </svg>
  );
}

/**
 * Brain node on a tile (bottom-right of the sprite box): a ring that is cyan when the agent had a memory
 * or vault read today, and a filled core when it had a write. Each new trip is a `pulses` entry that
 * flies in from the upper left and is absorbed; the parent drops it after BRAIN_MS. Read = outline dot,
 * write = filled dot. Nothing is drawn with no trips.
 */
function BrainNode({ trips, pulses }) {
  if (!Array.isArray(trips) || !trips.length) return null;
  const c = brainCounts(trips), text = brainText(trips);
  return (
    <span className="dk-brain" role="img" aria-label={`Memory and vault: ${text}`} title={`Memory and vault trips: ${text}`}>
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <circle className={'dk-brain-ring' + (c.reads ? ' has-read' : '')} cx="8" cy="8" r="6" />
        {c.writes > 0 && <circle className="dk-brain-core" cx="8" cy="8" r="2.4" />}
      </svg>
      {(pulses || []).map((p, i) => <i key={p.key} className={'dk-brain-pulse is-' + p.kind} style={{ animationDelay: `${i * 150}ms` }} />)}
    </span>
  );
}

/** Legend under the big ring in the sheet: swatch (rank shade), tool label, count. */
function ToolLegend({ segments }) {
  return (
    <ul className="dk-legend">
      {segments.map(s => (
        <li key={s.name} className={s.active ? 'is-active' : undefined}>
          <span className="dk-lsw" style={{ opacity: s.shade }} aria-hidden="true" />
          <span className="dk-wrap">{s.label}{s.active && <em> · running</em>}</span>
          <b>{s.count}</b>
        </li>
      ))}
    </ul>
  );
}

const reducedMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

/**
 * A number that rolls from the value on screen to a new one (COUNT_MS, ease-out, rAF). The first
 * render shows the value at once. `still` (Lite or tab hidden) and reduced motion jump instead.
 */
function CountUp({ value, format, still }) {
  const [shown, setShown] = useState(value);
  const shownRef = useRef(value);            // what is on screen now, so a new target rolls from there
  useEffect(() => {
    const from = shownRef.current;
    if (from === value || still || reducedMotion()) { shownRef.current = value; setShown(value); return; }
    let raf = 0, t0 = null;
    const tick = now => {
      if (t0 == null) t0 = now;
      const v = countStep(from, value, (now - t0) / COUNT_MS);
      shownRef.current = v;
      setShown(v);
      if (now - t0 < COUNT_MS) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, still]);
  return format(shown);
}

/** Today's totals under the strip: '{tokens} tok · {toolCalls} tools · {sessions} sess'. A field not reported shows a dash. */
function TodayLine({ a, still }) {
  const t = todayParts(a);
  if (!t) return null;
  const full = v => (v == null ? 'not reported' : String(v));
  const cell = (v, unit) => <>{v == null ? '—' : <CountUp value={v} format={compact} still={still} />} {unit}</>;
  return (
    <span className="dk-today" title={`Today: ${full(t.tokens)} tokens · ${full(t.toolCalls)} tool calls · ${full(t.sessions)} sessions`}>
      {cell(t.tokens, 'tok')} · {cell(t.toolCalls, 'tools')} · {cell(t.sessions, 'sess')}
    </span>
  );
}

const HELPER_DOTS = 6;   // most live helpers drawn around one tile

/**
 * Helper swarm: one dot per live helper (up to 6) on a slow orbit around the tile, plus dots that are drifting
 * away (fx kind 'out'). Each dot sits in a slot rotated by its share of the circle, so the orbit spins the
 * whole group and nothing moves by layout. `still` (Lite, reduced motion, tab hidden) draws the same dots at
 * fixed angles with no rotation or entrance/exit motion. Pointer-events none, aria-hidden: the tile says it.
 */
function Swarm({ live, fx, still }) {
  const ins = new Set(fx.filter(x => x.kind === 'in').map(x => x.id));
  const liveIds = new Set(live.map(h => h.id));
  const outs = fx.filter(x => x.kind === 'out' && !liveIds.has(x.id)).slice(0, HELPER_DOTS);
  const dots = [...live.slice(0, HELPER_DOTS).map(h => ({ key: 'l' + h.id, cls: ins.has(h.id) ? ' is-in' : '' })),
    ...outs.map(o => ({ key: 'o' + o.key, cls: ' is-out' }))];
  const n = dots.length;
  if (!n) return null;
  return (
    <span className={'dk-swarm' + (still ? ' is-still' : '')} aria-hidden="true">
      <span className="dk-swarm-orbit">
        {dots.map((d, i) => <span key={d.key} className="dk-hslot" style={{ transform: `rotate(${(i * 360) / n}deg)` }}><i className={'dk-hdot' + d.cls} /></span>)}
      </span>
    </span>
  );
}

function AgentTile({ it, pressed, onPick, blip, still, setRef, pulses, fx }) {
  const a = it.agent, working = it.working;
  const ring = toolRing(a.tools, a.activity, a.status);
  const hs = Array.isArray(a.helpers) ? a.helpers.filter(h => h && h.id != null) : [];
  return (
    <button ref={setRef} className={'dk-tile is-agent' + (working ? ' is-working' : ' is-rest') + (pressed ? ' is-pressed' : '') + (it.chip ? ' has-chip' : '') + (it.helperCount > 0 || it.ctxPct != null ? ' has-top' : '') + (working ? ' has-say' : '')} onClick={onPick}
      style={{ '--dk-c': it.color, gridColumnStart: it.rowStart ? 1 : undefined }}
      aria-label={`${a.name}, ${a.role}, ${it.status}` + (hs.length ? `, ${hs.length} helper${hs.length === 1 ? '' : 's'} running` : '')}
      title={swarmTip(hs) || undefined}>
      {(hs.length > 0 || (fx || []).some(x => x.kind === 'out')) && <Swarm live={hs} fx={fx || []} still={still} />}
      {working && <i className="dk-badge" />}
      {it.helperCount > 0 && <span className="dk-count-chip">{it.helperCount} helper{it.helperCount > 1 ? 's' : ''}</span>}
      {it.ctxPct != null && !it.helperCount && <span className="dk-ctx">{it.ctxPct}% ctx</span>}
      {working && a.activity && <span className="dk-say" aria-hidden="true">
        <span className="dk-say-t">{speechText(a.activity)}</span>
        {a.status === 'working' && <span className="dk-typing"><i /><i /><i /></span>}
      </span>}
      <span className="dk-art"><Sprite who={a.id} working={working} />{!working && <em className="dk-zz">zz</em>}
        {ring.segments.length > 0 && <span className="dk-ring-wrap"><ToolRing model={ring} /></span>}
        <BrainNode trips={a.brainTrips} pulses={still ? null : pulses} /></span>
      <b className="dk-name">{a.name}</b>
      <span className="dk-role">{a.role}</span>
      {a.remit && <span className="dk-remit" title={a.remit}>{a.remit}</span>}
      <span className="dk-status">{it.status}</span>
      <ActivityStrip spark={a.spark} working={working} blip={blip} />
      <TodayLine a={a} still={still} />
      {it.ctxPct != null && <Meter pct={it.ctxPct} decorative />}
      <span className="dk-models" title={modelText(a)}><ModelLines a={a} /></span>
      {it.chip && <span className="dk-handoff" style={{ '--dk-from': it.chip.color }}>← {it.chip.text}</span>}
    </button>
  );
}

function HelperTile({ it, pressed, onPick }) {
  const h = it.helper, done = it.done;
  return (
    <button className={'dk-tile is-helper' + (done ? ' is-done' : ' is-working') + (pressed ? ' is-pressed' : '')} onClick={onPick}
      style={{ '--dk-c': it.parentColor }} aria-label={`${it.name}, ${it.status}`}>
      <span className="dk-art"><Sprite who={'helper:' + (h.model || '')} working={!done} done={done} small />
        {done && <em className="dk-zz dk-check">✓</em>}</span>
      <b className="dk-name">{it.name}</b>
      <span className="dk-parent">↳ {it.parentName}</span>
      <span className="dk-status">{it.status}</span>
    </button>
  );
}

/**
 * One hand-off on the grid overlay: a line and arrowhead from the sender tile to the receiver, a dot
 * that travels along it (animated only), and the walk label at the midpoint. Coordinates are in grid
 * scroll-content space. `still` (Lite or reduced motion) shows the arrow and label with no animation.
 */
function FlightLayer({ f }) {
  const { x1, y1, x2, y2, color, label, lx, ly, still } = f;
  const pad = 14, left = Math.min(x1, x2) - pad, top = Math.min(y1, y2) - pad;
  const w = Math.abs(x2 - x1) + pad * 2, h = Math.abs(y2 - y1) + pad * 2;
  const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len, px = -uy, py = ux, head = 8;
  const tip = [x2 - left, y2 - top], b1 = [x2 - left - ux * head + px * 4, y2 - top - uy * head + py * 4];
  const b2 = [x2 - left - ux * head - px * 4, y2 - top - uy * head - py * 4];
  const anim = still ? '' : ' is-anim';
  return (<>
    <svg className={'dk-flight-line' + anim} style={{ left, top, width: w, height: h, color }} viewBox={`0 0 ${w} ${h}`} focusable="false">
      <line x1={x1 - left} y1={y1 - top} x2={x2 - left} y2={y2 - top} stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <polygon points={[tip, b1, b2].map(p => p.join(',')).join(' ')} fill="currentColor" />
    </svg>
    {!still && <i className="dk-flight-dot" style={{ left: x1, top: y1, '--dx': dx + 'px', '--dy': dy + 'px', '--dk-c': color }} />}
    <span className={'dk-flight-label' + anim} style={{ left: lx, top: ly }}>{label}</span>
  </>);
}

const FLIGHT_MS = 2600, FLIGHT_STILL_MS = 4000;
const BRAIN_MS = 1600;   // brain pulse lifetime: 1.2s flight plus the stagger for up to three trips
const HELPER_IN_MS = 1200, HELPER_OUT_MS = 1600;   // swarm dot entrance and drift-off lifetimes (match style.css)

const Pill = ({ status }) => <span className={'dk-pill is-' + status}>{status === 'done' ? '✓ done' : status}</span>;

function SessionDetail({ s, now, onBack }) {
  const rows = [
    ['Status', <Pill status={s.status} />], ['Where', s.source], ['Model', s.model || '—'],
    ['Now', s.status === 'working' ? s.step || 'working' : '—'],
    ['Context', s.ctx ? <>{`~${compact(s.ctx)} tokens${s.ctxPct != null ? ` (${s.ctxPct}%)` : ''}`}
      {s.ctxPct != null && <Meter pct={s.ctxPct} label={`Context window used, ${s.ctxPct}%`} />}</> : '—'],
    ['Tokens (session)', compact(s.tokens)], ['Helpers spawned', String(s.helpers || 0)], ['Last active', ago(s.at, now)],
  ];
  return (
    <>
      <button className="dk-back" onClick={onBack}>‹ Sessions</button>
      <h2 id="dk-sheet-title" className="dk-wrap">{s.title}</h2>
      <dl>{rows.map(([k, v]) => <React.Fragment key={k}><dt>{k}</dt><dd>{v}</dd></React.Fragment>)}</dl>
    </>
  );
}

/** Live 'Now' block: what the agent is doing, last tool, helpers and recent events. */
function NowBlock({ det, err, now }) {
  if (!det) return err ? <div className="dk-now"><p className="dk-note">detail unavailable</p></div> : null;
  const r = detailRows(det);
  const events = [...(det.events || [])].sort((x, y) => (y.at || 0) - (x.at || 0)).slice(0, 8);
  return (
    <div className="dk-now">
      <div className="dk-now-act">{r.activity}</div>
      {r.tool && <div className="dk-now-meta">Last tool: {r.tool}{det.last_tool.at ? <> · <span className="dk-mut">{ago(det.last_tool.at, now)}</span></> : null}</div>}
      <div className="dk-now-meta">Helpers: {r.helpers}</div>
      {events.length > 0 && <ul className="dk-events">
        {events.map((e, i) => <li key={i}><span>{ago(e.at, now)}</span> {eventLabel(e)}</li>)}
      </ul>}
    </div>
  );
}

const SHEET_TABS = [['live', 'Live'], ['comms', 'Comms'], ['details', 'Details'], ['brain', 'Brain']];

function AgentSheet({ it, sessions, now, det, detErr, notes, agents, lite, guard }) {
  const [open, setOpen] = useState(null);
  const [tab, setTab] = useState('details');
  const a = it.agent;
  const s = open && sessions.find(x => x.id === open);
  if (s) return <SessionDetail s={s} now={now} onBack={() => setOpen(null)} />;
  const ring = toolRing(a.tools, a.activity, a.status);
  // Leaving the Brain tab with unsaved edits asks first (the editor shows the prompt).
  const go = id => {
    const g = guard && guard.current;
    if (tab === 'brain' && id !== 'brain' && g && g.dirty) g.ask(() => setTab(id));
    else setTab(id);
  };
  const onTabKey = (e, i) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next = (i + (e.key === 'ArrowRight' ? 1 : SHEET_TABS.length - 1)) % SHEET_TABS.length;
    go(SHEET_TABS[next][0]);
    e.currentTarget.parentElement.querySelectorAll('[role="tab"]')[next].focus();
  };
  return (
    <>
      <header><span className="dk-sheet-art"><Sprite who={a.id} /></span>
        <div className="dk-grow"><h2 id="dk-sheet-title">{a.name}</h2><small>{a.role} · {it.status}</small></div></header>
      <div className="dk-mc-tabs dk-sheet-tabs" role="tablist" aria-label="Agent panels">
        {SHEET_TABS.map(([id, label], i) => {
          const on = tab === id;
          return (
            <button key={id} id={`dk-sh-tab-${id}`} role="tab" aria-selected={on} aria-controls="dk-sh-panel"
              tabIndex={on ? 0 : -1} className={'dk-mc-tab' + (on ? ' is-on' : '')}
              onClick={() => go(id)} onKeyDown={e => onTabKey(e, i)}>{label}</button>
          );
        })}
      </div>
      <div id="dk-sh-panel" role="tabpanel" aria-labelledby={`dk-sh-tab-${tab}`}>
        {tab === 'live' && <div className="dk-mc-body"><Live agentKey={a.id} agents={agents} lite={lite} /></div>}
        {tab === 'comms' && <div className="dk-mc-body"><MissionComms agents={agents} agentKey={a.id} lite={lite} /></div>}
        {tab === 'brain' && <BrainDetail agentId={a.id} guard={guard} />}
        {tab === 'details' && <>
          <NowBlock det={det} err={detErr} now={now} />
          {a.remit && <p className="dk-remit-full">{a.remit}</p>}
          <dl>
            <dt>Model</dt><dd>{a.model || '—'}</dd>
            <dt>Model id</dt><dd>{a.modelId || '—'}</dd>
            <dt>Helpers</dt><dd>{(a.helperModels || []).join(', ') || '—'}</dd>
          </dl>
          <section><h3>Tools today</h3>
            {ring.segments.length > 0
              ? <div className="dk-ring-row" style={{ '--dk-c': it.color }}><ToolRing model={ring} big /><ToolLegend segments={ring.segments} /></div>
              : <p className="dk-note">no data</p>}
          </section>
          <section><h3>Brain</h3>
            {notes != null && <div className="dk-row-mini"><span>Vault notes</span><small>{compact(notes)}</small></div>}
            {brainText(a.brainTrips)
              ? <div className="dk-row-mini"><span>Memory and vault, last 5 min</span><small>{brainText(a.brainTrips)}</small></div>
              : notes == null && <p className="dk-note">no data</p>}
          </section>
          {it.walks.length > 0 && <section><h3>Hand-offs</h3>
            {it.walks.map(w => <div key={w.id} className="dk-row-mini"><span>{w.label}</span><small>{ago(w.at, now)}</small></div>)}</section>}
          <section><h3>Sessions · {sessions.length}</h3>
            {sessions.map(x => (
              <button key={x.id} className={'dk-srow is-' + x.status} onClick={() => setOpen(x.id)}>
                <span className="dk-wrap dk-stitle">{x.title}</span>
                <span className="dk-smeta"><Pill status={x.status} />{x.ctxPct != null && <span>{x.ctxPct}% ctx</span>}
                  <span>{ago(x.at, now)}</span>{x.model && <span>{x.model}</span>}<span>{compact(x.tokens)} tok</span></span>
                {x.ctxPct != null && <Meter pct={x.ctxPct} decorative />}
              </button>
            ))}
            {!sessions.length && <p className="dk-note">No sessions in the last 14 days.</p>}
          </section>
        </>}
      </div>
    </>
  );
}

function HelperSheet({ it, now }) {
  const h = it.helper;
  const rows = [['Goal', h.task], ['Model', h.model || '—'], ['Parent', it.parentName],
    ['Status', it.done ? '✓ done' : 'running · ' + (h.activity || 'working')], ['Duration', durationText(h, now)]];
  return (
    <>
      <header><span className="dk-sheet-art"><Sprite who={'helper:' + (h.model || '')} done={it.done} small /></span>
        <div className="dk-grow"><h2 id="dk-sheet-title">{it.name}</h2><small>↳ {it.parentName}</small></div></header>
      <dl>{rows.map(([k, v]) => <React.Fragment key={k}><dt>{k}</dt><dd>{v}</dd></React.Fragment>)}</dl>
    </>
  );
}

function Sheet({ children, onClose, getReturn }) {
  const ref = useRef(null);
  useDialogFocus(ref, onClose, getReturn);
  return (
    <div className="dk-scrim" onClick={onClose}>
      <aside ref={ref} className="dk-sheet" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="dk-sheet-title" tabIndex={-1}>
        <button className="dk-x" onClick={onClose} aria-label="Close">✕</button>
        {children}
        <p className="dk-note">Live and Comms show message text; secrets are redacted on the server.</p>
      </aside>
    </div>
  );
}

const readLite = () => { try { return localStorage.getItem('agent-deck.lite') === '1'; } catch (e) { return false; } };

export default function Deck() {
  const rootRef = useRef(null);
  const fullRef = useRef(null);
  const [state, setState] = useState(null);
  const [error, setError] = useState('');
  const [sel, setSel] = useState(null);
  // Set by the Brain editor while it has unsaved changes: { dirty, ask(next) }. Close goes through ask().
  const brainGuard = useRef(null);
  const closeSheet = () => {
    const g = brainGuard.current;
    if (g && g.dirty) g.ask(() => setSel(null));
    else setSel(null);
  };
  const [lite, setLite] = useState(readLite);
  const [height, setHeight] = useState(600);
  const [, setTick] = useState(0);
  const [usage, setUsage] = useState(null);
  const usageRef = useRef(null);                                       // usage rings section; the header pill scrolls to it
  const [pane, setPane] = useState('office');                          // phone only: Office | Live | Comms | Memory
  const [rightPane, setRightPane] = useState(RIGHT_PANE_DEFAULT);      // desktop only: right pane is Live (default) or Comms
  const desktop = useMedia('(min-width: 900px)');                      // side by side from 900px
  const [updatedAt, setUpdatedAt] = useState(null);                    // ms of the last good /state poll
  const [standalone] = useState(() => isStandalone(window));
  const [full, setFull] = useState(() => wantsFull(location.search, standalone));
  const timer = useRef(0), alive = useRef(true), liteRef = useRef(lite);
  liteRef.current = lite;
  const prevState = useRef(null);                                       // last /state, for the tool-call diff
  const [blips, setBlips] = useState({});                               // agent id -> blip counter
  const [hidden, setHidden] = useState(() => document.visibilityState === 'hidden');
  const gridRef = useRef(null);                                         // scroll container; overlay lives inside it
  const tileRefs = useRef(new Map());                                   // agent id -> tile <button>
  const flightTimers = useRef(new Map());                               // flight key -> removal timeout
  const [flights, setFlights] = useState([]);                           // walks being drawn right now
  const setTileRef = (id, el) => { if (el) tileRefs.current.set(id, el); else tileRefs.current.delete(id); };
  useEffect(() => () => { for (const t of flightTimers.current.values()) clearTimeout(t); }, []);
  const fxTimers = useRef(new Map());                                    // swarm fx key -> removal timeout
  const [swarmFx, setSwarmFx] = useState({});                            // agent id -> [{key, kind, id, ...}] dots entering or leaving
  useEffect(() => () => { for (const t of fxTimers.current.values()) clearTimeout(t); }, []);
  const [brainPulses, setBrainPulses] = useState({});                   // agent id -> [{key, kind}] trips flying into the brain node
  const brainTimers = useRef(new Set());
  useEffect(() => () => { for (const t of brainTimers.current) clearTimeout(t); }, []);

  const load = () => {
    clearTimeout(timer.current);
    if (document.hidden) { timer.current = setTimeout(load, POLL_MS); return; }
    fetchJSON(API).then(s => { if (alive.current) { setState(s); setError(''); setUpdatedAt(Date.now()); } })
      .catch(e => alive.current && setError(String((e && e.message) || e)))
      .finally(() => { if (alive.current) timer.current = setTimeout(load, liteRef.current ? POLL_LITE_MS : POLL_MS); });
  };
  useEffect(() => { alive.current = true; load(); return () => { alive.current = false; clearTimeout(timer.current); }; }, []);
  useEffect(() => { try { localStorage.setItem('agent-deck.lite', lite ? '1' : '0'); } catch (e) { /* private mode */ } }, [lite]);
  useEffect(() => { try { localStorage.removeItem('agent-deck.view'); } catch (e) { /* private mode */ } }, []);
  useEffect(() => {
    const size = () => { const r = rootRef.current; if (r) setHeight(Math.max(360, window.innerHeight - Math.max(0, r.getBoundingClientRect().top) - 6)); };
    size(); window.addEventListener('resize', size);
    return () => window.removeEventListener('resize', size);
  }, []);
  useEffect(() => visibleInterval(() => setTick(x => x + 1), 15000), []);
  useEffect(() => {
    const onVis = () => setHidden(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);
  useEffect(() => {
    if (!state) return;
    const agents = state.agents || [];
    const fresh = newWalks(prevState.current, state, agents.map(a => a.id), Date.now() / 1000);
    const d = newToolCalls(prevState.current, state);
    const bt = newBrainTrips(prevState.current, state, Date.now() / 1000);
    const hc = helperChanges(prevState.current, state);                 // helper spawns and exits since the last poll
    prevState.current = state;                                          // walks are seen now, even if not drawn
    const fxStill = liteRef.current || reducedMotion() || hidden;       // no entrance or exit motion when still
    if (!fxStill) {
      const made = [];
      for (const aid of Object.keys(hc)) {
        for (const sid of hc[aid].spawned) made.push({ key: `in-${aid}-${sid}`, agent: aid, kind: 'in', id: sid, ms: HELPER_IN_MS });
        for (const e of hc[aid].exited) made.push({ key: `out-${aid}-${e.id}`, agent: aid, kind: 'out', id: e.id, task: e.task, model: e.model, ms: HELPER_OUT_MS });
      }
      if (made.length) {
        setSwarmFx(f => { const n = { ...f }; for (const m of made) n[m.agent] = [...(n[m.agent] || []).filter(x => x.key !== m.key), m]; return n; });
        for (const m of made) {
          const old = fxTimers.current.get(m.key);
          if (old) clearTimeout(old);
          fxTimers.current.set(m.key, setTimeout(() => {                 // one timeout per dot; removed after its motion
            fxTimers.current.delete(m.key);
            setSwarmFx(f => ({ ...f, [m.agent]: (f[m.agent] || []).filter(x => x.key !== m.key) }));
          }, m.ms));
        }
      }
    }
    const bIds = Object.keys(bt);
    if (bIds.length && !hidden && !liteRef.current && !reducedMotion()) {   // one-shot pulses; none when still
      const keys = bIds.flatMap(id => bt[id].map(t => [id, String(t.id)]));
      setBrainPulses(p => { const n = { ...p }; for (const id of bIds) n[id] = [...(n[id] || []), ...bt[id].map(t => ({ key: String(t.id), kind: t.kind === 'write' ? 'write' : 'read' }))]; return n; });
      const tid = setTimeout(() => {
        brainTimers.current.delete(tid);
        setBrainPulses(p => { const n = { ...p }; for (const [id, k] of keys) n[id] = (n[id] || []).filter(x => x.key !== k); return n; });
      }, BRAIN_MS);
      brainTimers.current.add(tid);
    }
    const ids = Object.keys(d);
    if (ids.length) setBlips(b => { const n = { ...b }; for (const id of ids) n[id] = (n[id] || 0) + 1; return n; });
    if (!fresh.length || hidden || !gridRef.current) return;            // nothing is queued while the tab is hidden
    const names = Object.fromEntries(agents.map(a => [a.id, a.name]));
    const colors = Object.fromEntries(agents.map(a => [a.id, a.color || '#8a8a8a']));
    const still = liteRef.current || reducedMotion();
    const gw = gridRef.current.clientWidth;
    const made = [];
    for (const w of fresh) {
      const a = tileRefs.current.get(w.from), b = tileRefs.current.get(w.to);
      if (!a || !b) continue;                                           // tile not in the DOM: skip this flight
      const x1 = a.offsetLeft + a.offsetWidth / 2, y1 = a.offsetTop + a.offsetHeight / 2;
      const x2 = b.offsetLeft + b.offsetWidth / 2, y2 = b.offsetTop + b.offsetHeight / 2;
      const mx = (x1 + x2) / 2, lx = Math.min(Math.max(mx, 96), Math.max(96, gw - 96));
      made.push({ key: String(w.id), x1, y1, x2, y2, lx, ly: (y1 + y2) / 2, color: colors[w.from] || '#8a8a8a',
        label: walkLabel(w, names), still });
    }
    if (!made.length) return;
    setFlights(f => [...f, ...made]);
    for (const m of made) {
      const old = flightTimers.current.get(m.key);
      if (old) clearTimeout(old);
      flightTimers.current.set(m.key, setTimeout(() => {
        flightTimers.current.delete(m.key);
        setFlights(f => f.filter(x => x.key !== m.key));
      }, still ? FLIGHT_STILL_MS : FLIGHT_MS));
    }
  }, [state]);
  useEffect(() => {
    let live = true;
    const pull = () => fetchJSON(USAGE_API).catch(() => ({ available: false })).then(u => { if (live) setUsage(u); });
    const stop = visibleInterval(pull, 60000);
    return () => { live = false; stop(); };
  }, []);

  const enterFull = () => {
    setFull(true);
    history.replaceState(history.state, '', withFullParam(location.href, true));
    requestNativeFullscreen(document.documentElement);
  };
  const exitFull = () => {
    exitNativeFullscreen(document);
    setFull(false);
    history.replaceState(history.state, '', withFullParam(location.href, false));
  };
  useEffect(() => {
    if (!full) return;
    return markFullPath(fullRef.current);
  }, [full]);
  useEffect(() => {
    if (!full) return;
    document.documentElement.classList.add('ao-full-active');
    return () => document.documentElement.classList.remove('ao-full-active');
  }, [full]);
  useEffect(() => {
    if (!full || standalone || sel) return;
    const k = e => { if (e.key === 'Escape' && !document.fullscreenElement) exitFull(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [full, standalone, sel]);

  const now = Date.now() / 1000;
  const items = state ? buildItems(state, now) : [];
  const counts = state ? headerCounts(items) : null;
  const needs = state ? needsYou(state.agents || []) : [];
  const picked = items.find(i => i.key === sel) || null;
  const ut = usageText(usage);
  const detailId = picked && picked.type === 'agent' ? currentSessionId((state.sessions || {})[picked.agent.id]) : null;
  const [detail, setDetail] = useState(null);   // {sid, data, err}
  useEffect(() => {
    setDetail(null);
    if (!detailId) return;
    let live = true;
    const pull = () => fetchJSON(`${SESSION_API}?id=${encodeURIComponent(detailId)}`)
      .then(d => { if (live) setDetail({ sid: detailId, data: d, err: false }); })
      .catch(() => { if (live) setDetail({ sid: detailId, data: null, err: true }); });
    pull();
    const stop = visibleInterval(pull, DETAIL_MS);
    return () => { live = false; stop(); };
  }, [detailId]);
  const detOk = detail && detail.sid === detailId ? detail : null;

  const fiveRaw = usage && usage.available && usage.five_hour ? usage.five_hour.resets_at : null;
  const fiveIn = resetCountdown(fiveRaw, Date.now());
  const resetLabel = fiveIn == null ? null : fiveIn === 'now' ? 'Session resetting now' : `Session resets in ${fiveIn}`;

  const root = (
    <div ref={rootRef} className={'dk-root' + (lite ? ' is-lite' : '') + (hidden ? ' is-hidden' : '') + (items.length && items.length <= 6 ? ' is-few' : '')} style={{ height: full ? '100%' : height }}>
      {desktop && <Rail rootRef={rootRef} needsCount={needs.length} full={full} standalone={standalone} lite={lite}
        onToggleFull={full ? exitFull : enterFull} onToggleLite={() => setLite(!lite)} />}
      <header className="dk-top">
        <div className="dk-brand">
          <h1 className="dk-title">Agent Deck</h1>
          <p className="dk-sub">{greeting(new Date().getHours())} Sir · your AI team, live</p>
        </div>
        <div className="dk-sum">
          <UpdatedAgo at={updatedAt} error={!!error} />
          <span className="dk-pill dk-working-pill" title="Agents working now, of all agents">{counts ? `${counts.working} of ${counts.working + counts.idle} working` : 'loading…'}</span>
          <button id="dk-sec-usage" type="button" className={'dk-pill dk-usage dk-usage-btn is-' + ut.level} title={ut.title} aria-label={ut.aria}
            onClick={() => { const el = usageRef.current; if (el) { el.scrollIntoView({ block: 'start' }); el.focus({ preventScroll: true }); } }}>
            {ut.level === 'na' && ut.reason ? <span className="dk-uw-na">usage n/a</span> : ut.windows.map(w => (
              <span key={w.key} className="dk-uw" aria-hidden="true">
                <span className="dk-uw-l">{w.short}</span><Meter pct={w.pct} decorative /><span className="dk-uw-v">{pctStr(w.pct)}</span>
              </span>))}
          </button>
          {resetLabel && <span className={'dk-pill dk-reset' + (resetSoon(fiveRaw, Date.now()) ? ' is-soon' : '')} role="timer" aria-live="off" title="Claude 5-hour session window">{resetLabel}</span>}
          <span className="dk-pill dk-tok" title="Tokens used by sessions that are working now, all agents">{compact(activeTokens(items))} tok <span className="dk-tok-lbl">active</span></span>
          <LiveClock />
          <Bell count={needs.length} onPick={() => needs.length && setSel('a:' + needs[0].id)} />
        </div>
        <div className="dk-acts">
          {!full && <button className="dk-btn" onClick={enterFull} aria-label="Open fullscreen deck">Fullscreen</button>}
          {full && !standalone && <button className="dk-btn ao-fs-exit" onClick={exitFull} aria-label="Exit fullscreen deck">Exit</button>}
          <button className={'dk-btn' + (lite ? ' on' : '')} aria-pressed={lite} onClick={() => setLite(!lite)} title="Low-power: no animation, refresh every 15s">Lite</button>
          <button className="dk-btn" onClick={load} aria-label="Refresh">↻</button>
        </div>
      </header>
      {error && <div className="dk-err">Can't reach the deck data ({error}). Retrying…</div>}
      <div className="dk-scroll">
      <ServerCard />
      {/* spec 2: the usage rings row comes first and is always on the page (n/a rings plus the backend reason when unavailable) */}
      <section id="dk-usage-rings" ref={usageRef} className="dk-uplan" tabIndex={-1} aria-label="Plan usage">
        <UsageRings usage={usage} now={Date.now()} />
      </section>
      <NeedsYou items={needs} onPick={id => setSel('a:' + id)} />
      {!desktop && <PaneTabs pane={pane} setPane={setPane} />}
      <div className="dk-panes">
      <section id="dk-pane-office" role="tabpanel" aria-labelledby="dk-pane-tab-office" className="dk-pane dk-pane-office"
        hidden={!desktop && pane !== 'office'}>
      <h2 className="dk-pane-h">Office</h2>
      {(desktop || pane === 'office') && <main ref={gridRef} className="dk-grid">
            {items.map(it => it.type === 'agent'
              ? <AgentTile key={it.key} it={it} pressed={it.key === sel} blip={blips[it.agent.id] || 0} still={lite || hidden} onPick={() => setSel(it.key)}
                  setRef={el => { setTileRef(it.agent.id, el); }} pulses={brainPulses[it.agent.id]} fx={swarmFx[it.agent.id]} />
              : <HelperTile key={it.key} it={it} pressed={it.key === sel} onPick={() => setSel(it.key)} />)}
            {!state && !error && Array.from({ length: 4 }, (_, i) => <div key={i} className="dk-tile is-ghost" />)}
            <div className="dk-flights" aria-hidden="true">
              {flights.map(f => <FlightLayer key={f.key} f={f} />)}
            </div>
          </main>}
      </section>
      {/* phone only (hidden on desktop, where Live is the right pane below): the same all-agents feed, mounted only while shown */}
      <section id="dk-pane-live" role="tabpanel" aria-labelledby="dk-pane-tab-live" className="dk-pane dk-pane-live"
        hidden={desktop || pane !== 'live'}>
        {!desktop && livePolls({ desktop, rightPane, pane }) && <Live agentKey="" agents={(state && state.agents) || []} lite={lite} />}
      </section>
      <section id="dk-pane-comms" role="tabpanel" aria-labelledby="dk-pane-tab-comms" className="dk-pane dk-pane-comms"
        hidden={!desktop && pane !== 'comms'}>
        <div className="dk-pane-hd">
          <h2 className="dk-pane-h">{desktop && rightPane === 'live' ? 'Live' : 'Comms'}</h2>
          {desktop && <div className="dk-rseg" role="group" aria-label="Right pane: Live or Comms">
            {[['live', 'Live'], ['comms', 'Comms']].map(([id, label]) => (
              <button key={id} type="button" className={'dk-rseg-btn' + (rightPane === id ? ' is-on' : '')}
                aria-pressed={rightPane === id} onClick={() => setRightPane(id)}>{label}</button>
            ))}
          </div>}
        </div>
        {/* Only the mounted feed polls: Live on desktop when selected (phone Live is the section above), Comms on desktop or phone when selected */}
        {desktop && livePolls({ desktop, rightPane, pane }) && <Live agentKey="" agents={(state && state.agents) || []} lite={lite} />}
        {commsPolls({ desktop, pane, rightPane }) && <MissionComms agents={(state && state.agents) || []} agentKey="" lite={lite} />}
      </section>
      </div>
      {/* Projects sit below Office and Live (Sir 2026-11-09) */}
      <ProjectsList now={now} />
      {/* Memory: phone tab (hidden unless selected), full width below Office and Live/Comms on desktop. Fetches only on search. */}
      <MemoryPane agents={(state && state.agents) || []} sessions={state && state.sessions} brain={state && state.brain}
        lite={lite} hidden={!desktop && pane !== 'memory'} />
      </div>
      {picked && <Sheet onClose={closeSheet} getReturn={sel && sel.startsWith('a:') ? () => tileRefs.current.get(sel.slice(2)) : null}>
        {picked.type === 'agent'
          ? <AgentSheet key={picked.key} it={picked} sessions={(state.sessions || {})[picked.agent.id] || []} now={now}
                      det={detOk && detOk.data} detErr={!!(detOk && detOk.err)} notes={brainNotes(state.brain)}
                      agents={state.agents || []} lite={lite} guard={brainGuard} />
          : <HelperSheet it={picked} now={now} />}
      </Sheet>}
    </div>
  );
  return full
    ? <div ref={fullRef} className="ao-full" role="region" aria-label="Agent Deck fullscreen"><i className="ao-edge ao-edge-top" aria-hidden="true" />{root}<i className="ao-edge ao-edge-bot" aria-hidden="true" /></div>
    : root;
}
