import { React, useState, useEffect, useRef, fetchJSON, API, USAGE_API, SESSION_API } from './sdk.js';
import { ago, compact, resetCountdown } from './format.js';
import { buildItems, headerCounts, durationText, modelText, modelParts, usageText, meterLevel, activeTokens, currentSessionId, eventLabel, detailRows, traceModel, newToolCalls, countStep, todayParts, COUNT_MS, newWalks, walkLabel, toolRing, newBrainTrips, brainCounts, brainText, brainNotes, helperChanges, swarmTip, needsYou, greeting, resetSoon, RIGHT_PANE_DEFAULT, livePolls, commsPolls, speechText, paneTabNext } from './deck-model.js';
import { isStandalone, wantsFull, withFullParam, requestNativeFullscreen, exitNativeFullscreen, markFullPath } from './fullscreen.js';
import { Live } from './Mission.jsx';
import MissionComms from './MissionComms.jsx';
import { useDialogFocus } from './dialog-focus.js';
import { Sprite } from './Sprite.jsx';
import { useMedia, UpdatedAgo, LiveClock, Bell } from './DeckRevamp.jsx';
import { WikiPane } from './Wiki.jsx';
import { BrainDetail } from './BrainDetail.jsx';
import { ProjectsList } from './ProjectsList.jsx';
import { visibleInterval } from './visible-timer.js';
import { parseHash, hashFor, ASH_ID, agentsViewOf, hashForAgentsView } from './tabs-model.js';
import BottomNav from './BottomNav.jsx';
import { AshCard } from './AshCard.jsx';
import MenuTab from './MenuTab.jsx';
import { AgentsTab } from './AgentsTab.jsx';
import { OfficeScene } from './OfficeScene.jsx';
import { OfficeFrame } from './OfficeFrame.jsx';
import { officeExactRequested, OFFICE_FLAG_KEY } from './office-flag.js';
import { InboxTab } from './InboxTab.jsx';


const POLL_MS = 15000, POLL_LITE_MS = 15000, DETAIL_MS = 5000;   // spec 5: 15s visible, Lite no slower; hidden is paused elsewhere

const pctStr = p => (p == null ? 'n/a' : Math.round(p) + '%');

const PHONE_TABS = [['office', 'Office'], ['live', 'Live'], ['comms', 'Comms']];

/**
 * Phone pane tabs on Home: Office | Live | Comms. Same markup and keys as DeckRevamp's PaneTabs, which still
 * lists the retired Memory tab, so Deck uses this one. Wiki has its own tab now.
 */
function PhoneTabs({ pane, setPane }) {
  const onKey = (e, i) => {
    const next = paneTabNext(i, e.key, PHONE_TABS.length);
    if (next < 0) return;
    e.preventDefault();
    setPane(PHONE_TABS[next][0]);
    e.currentTarget.parentElement.querySelectorAll('[role="tab"]')[next].focus();
  };
  return (
    <div className="dk-seg" role="tablist" aria-label="Deck pane">
      {PHONE_TABS.map(([id, label], i) => {
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

/** The office desk's hit button for an agent (focus returns here when its sheet closes); null if none is on screen. */
const officeHitFor = id => Array.from(document.querySelectorAll('.dk-off-hit')).find(el => el.dataset.agentId === String(id)) || null;

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
  const [tab, setTab] = useState(() => parseHash(location.hash));       // home | agents | inbox | wiki | menu, synced to #hash
  const goTab = id => { if (location.hash !== hashFor(id)) location.hash = hashFor(id); setTab(id); };
  const [hash, setHash] = useState(location.hash);                      // kept so the Agents Grid / Office view re-renders on #agents/office
  useEffect(() => {
    const onHash = () => { setTab(parseHash(location.hash)); setHash(location.hash); };  // browser Back / Forward moves between tabs
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const [pane, setPane] = useState('office');                          // phone only, on Home: Office | Live | Comms
  const [rightPane, setRightPane] = useState(RIGHT_PANE_DEFAULT);      // desktop only: right pane is Live (default) or Comms
  const desktop = useMedia('(min-width: 900px)');                      // desktop: left rail nav, Office and Live/Comms side by side
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
      <header className="dk-top dk-topbar">
        <div className="dk-brand">
          <h1 className="dk-title">Agent Deck</h1>
          <span className="dk-pill dk-local" title="Served from this machine">local</span>
        </div>
        <div className="dk-acts">
          <UpdatedAgo at={updatedAt} error={!!error} />
          <button className="dk-btn dk-tb-refresh" onClick={load} aria-label="Refresh">↻</button>
        </div>
      </header>
      {error && <div className="dk-err">Can't reach the deck data ({error}). Retrying…</div>}
      <BottomNav tab={tab} onTab={goTab} needsCount={needs.length} desktop={desktop} />
      <div id="dk-tabpanel" className={'dk-scroll dk-tabbody dk-tab-' + tab} role="tabpanel" aria-labelledby={'dk-tab-' + tab}>
      {tab === 'home' && <>
      <div className="dk-home-hd">
        <p className="dk-sub">{greeting(new Date().getHours())} Sir · your AI team, live</p>
        <div className="dk-sum">
          <span className="dk-pill dk-working-pill" title="Agents working now, of all agents">{counts ? `${counts.working} of ${counts.working + counts.idle} working` : 'loading…'}</span>
          <button id="dk-sec-usage" type="button" className={'dk-pill dk-usage dk-usage-btn is-' + ut.level} title={ut.title} aria-label={ut.aria}
            onClick={() => goTab('menu')}>
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
      </div>
      <AshCard agents={state && state.agents} sessions={state && state.sessions} error={error} loaded={!!state}
        onOpen={() => setSel('a:' + ASH_ID)} />
      {needs.length > 0 && <button type="button" className="dk-needs-chip" onClick={() => goTab('inbox')}>Needs you · {needs.length}</button>}
      {!desktop && <PhoneTabs pane={pane} setPane={setPane} />}
      <div className="dk-panes">
      <section id="dk-pane-office" role="tabpanel" aria-labelledby="dk-pane-tab-office" className="dk-pane dk-pane-office"
        hidden={!desktop && pane !== 'office'}>
      <h2 className="dk-pane-h">Office</h2>
      {(desktop || pane === 'office') && <>
          {/* Agents are desks in the scene. Helper sessions have no desk, so they keep a tile row under it. */}
          {/* Phase 1c: the exact Claude-Office frame only behind office=exact / localStorage flag; default is OfficeScene.
              The frame is mounted only while the page is visible (hidden unmounts it, which stops its rAF loop). */}
          {officeExactRequested(location.hash, () => localStorage.getItem(OFFICE_FLAG_KEY))
            ? (!hidden && <OfficeFrame state={state} error={error} onPick={id => setSel('a:' + id)} />)
            : <OfficeScene agents={(state && state.agents) || []} onPick={id => setSel('a:' + id)} />}
          {items.some(it => it.type !== 'agent') && <div className="dk-grid dk-helper-row">
            {items.filter(it => it.type !== 'agent').map(it => <HelperTile key={it.key} it={it} pressed={it.key === sel} onPick={() => setSel(it.key)} />)}
          </div>}
        </>}
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
      </>}
      {tab === 'agents' && <AgentsTab agents={(state && state.agents) || []} sessions={state && state.sessions} now={now}
        loading={!state && !error} error={error} onRetry={load} onPick={id => setSel('a:' + id)}
        view={agentsViewOf(hash)} onView={v => { const h = hashForAgentsView(v); if (location.hash !== h) location.hash = h; setHash(h); }} />}
      {tab === 'inbox' && <InboxTab items={needs} loading={!state && !error} error={error} onRetry={load} onPick={id => setSel('a:' + id)} />}
      {/* Wiki mounts only while its tab is shown; it fetches on first show */}
      {tab === 'wiki' && <WikiPane hidden={false} />}
      {tab === 'menu' && <MenuTab usage={usage} now={Date.now()} full={full} standalone={standalone} lite={lite}
        onEnterFull={enterFull} onExitFull={exitFull} onToggleLite={() => setLite(!lite)} />}
      </div>
      {picked && <Sheet onClose={closeSheet} getReturn={sel && sel.startsWith('a:') ? () => officeHitFor(sel.slice(2)) : null}>
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
