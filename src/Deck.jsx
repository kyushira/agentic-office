import { React, useState, useEffect, useRef, fetchJSON, API, USAGE_API, SESSION_API } from './sdk.js';
import { ago, compact } from './format.js';
import { portrait } from './portrait.js';
import { buildItems, headerCounts, durationText, modelText, modelParts, usageText, meterLevel, activeTokens, currentSessionId, eventLabel, detailRows, traceModel, newToolCalls, countStep, todayParts, COUNT_MS, newWalks, walkLabel, toolRing } from './deck-model.js';
import { isStandalone, wantsFull, withFullParam, requestNativeFullscreen, exitNativeFullscreen, markFullPath } from './fullscreen.js';

const POLL_MS = 5000, POLL_LITE_MS = 15000, DETAIL_MS = 5000;

/** Pixel-art bust: base pixels + an eyes layer that blinks; a small bob while working. */
function Sprite({ who, working, small, done }) {
  const p = portrait(who);
  const px = list => list.map(([x, y, c]) => <rect key={x + '-' + y} x={x} y={y} width="1" height="1" fill={c} />);
  return (
    <svg className={'dk-sprite' + (working ? ' is-work' : '') + (small ? ' is-small' : '') + (done ? ' is-done' : '')}
      viewBox={`0 0 ${p.size} ${p.size}`} shapeRendering="crispEdges" aria-hidden="true">
      {p.base.map(([x, y, w, c]) => <rect key={x + '-' + y} x={x} y={y} width={w} height="1" fill={c} />)}
      <g className="dk-eyes-open">{px(p.open)}</g>
      <g className="dk-eyes-shut">{px(p.closed)}</g>
    </svg>
  );
}

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

function AgentTile({ it, pressed, onPick, blip, still, setRef }) {
  const a = it.agent, working = it.working;
  const ring = toolRing(a.tools, a.activity, a.status);
  return (
    <button ref={setRef} className={'dk-tile is-agent' + (working ? ' is-working' : ' is-rest') + (pressed ? ' is-pressed' : '') + (it.chip ? ' has-chip' : '') + (it.helperCount > 0 || it.ctxPct != null ? ' has-top' : '')} onClick={onPick}
      style={{ '--dk-c': it.color, gridColumnStart: it.rowStart ? 1 : undefined }} aria-label={`${a.name}, ${a.role}, ${it.status}`}>
      {working && <i className="dk-sweep" aria-hidden="true" />}
      {working && <i className="dk-badge" />}
      {it.helperCount > 0 && <span className="dk-count-chip">{it.helperCount} helper{it.helperCount > 1 ? 's' : ''}</span>}
      {it.ctxPct != null && !it.helperCount && <span className="dk-ctx">{it.ctxPct}% ctx</span>}
      <span className="dk-art"><Sprite who={a.id} working={working} />{!working && <em className="dk-zz">zz</em>}
        {ring.segments.length > 0 && <span className="dk-ring-wrap"><ToolRing model={ring} /></span>}</span>
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
      <h2 className="dk-wrap">{s.title}</h2>
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

function AgentSheet({ it, sessions, now, det, detErr }) {
  const [open, setOpen] = useState(null);
  const a = it.agent;
  const s = open && sessions.find(x => x.id === open);
  if (s) return <SessionDetail s={s} now={now} onBack={() => setOpen(null)} />;
  const ring = toolRing(a.tools, a.activity, a.status);
  return (
    <>
      <NowBlock det={det} err={detErr} now={now} />
      <header><span className="dk-sheet-art"><Sprite who={a.id} /></span>
        <div className="dk-grow"><h2>{a.name}</h2><small>{a.role} · {it.status}</small></div></header>
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
        <div className="dk-grow"><h2>{it.name}</h2><small>↳ {it.parentName}</small></div></header>
      <dl>{rows.map(([k, v]) => <React.Fragment key={k}><dt>{k}</dt><dd>{v}</dd></React.Fragment>)}</dl>
    </>
  );
}

function Sheet({ children, onClose }) {
  useEffect(() => {
    const k = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="dk-scrim" onClick={onClose}>
      <aside className="dk-sheet" onClick={e => e.stopPropagation()} role="dialog">
        <button className="dk-x" onClick={onClose} aria-label="Close">✕</button>
        {children}
        <p className="dk-note">Titles and step names only — message text is never shown.</p>
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
  const [lite, setLite] = useState(readLite);
  const [height, setHeight] = useState(600);
  const [, setTick] = useState(0);
  const [usage, setUsage] = useState(null);
  const [showReason, setShowReason] = useState(false);
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

  const load = () => {
    clearTimeout(timer.current);
    if (document.hidden) { timer.current = setTimeout(load, POLL_MS); return; }
    fetchJSON(API).then(s => { if (alive.current) { setState(s); setError(''); } })
      .catch(e => alive.current && setError(String((e && e.message) || e)))
      .finally(() => { if (alive.current) timer.current = setTimeout(load, liteRef.current ? POLL_LITE_MS : POLL_MS); });
  };
  useEffect(() => { alive.current = true; load(); return () => { alive.current = false; clearTimeout(timer.current); }; }, []);
  useEffect(() => { try { localStorage.setItem('agent-deck.lite', lite ? '1' : '0'); } catch (e) { /* private mode */ } }, [lite]);
  useEffect(() => {
    const size = () => { const r = rootRef.current; if (r) setHeight(Math.max(360, window.innerHeight - Math.max(0, r.getBoundingClientRect().top) - 6)); };
    size(); window.addEventListener('resize', size);
    return () => window.removeEventListener('resize', size);
  }, []);
  useEffect(() => { const id = setInterval(() => setTick(x => x + 1), 15000); return () => clearInterval(id); }, []);
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
    prevState.current = state;                                          // walks are seen now, even if not drawn
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
    pull();
    const id = setInterval(pull, 60000);
    return () => { live = false; clearInterval(id); };
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
    const id = setInterval(pull, DETAIL_MS);
    return () => { live = false; clearInterval(id); };
  }, [detailId]);
  const detOk = detail && detail.sid === detailId ? detail : null;

  const root = (
    <div ref={rootRef} className={'dk-root' + (lite ? ' is-lite' : '') + (hidden ? ' is-hidden' : '') + (items.length && items.length <= 6 ? ' is-few' : '')} style={{ height: full ? '100%' : height }}>
      <header className="dk-top">
        <div className="dk-sum">
          <span className="dk-count"><i className={'dk-dot' + (counts && counts.working ? ' on' : '')} />
            <span className="dk-count-txt">{counts ? `${counts.working} working · ${counts.idle} idle · ${counts.helpers} helper${counts.helpers === 1 ? '' : 's'}` : 'loading…'}</span></span>
          <button className={'dk-usage dk-usage-btn is-' + ut.level} title={ut.title} aria-label={ut.aria} aria-expanded={showReason}
            onClick={() => setShowReason(!showReason)}>
            {ut.level === 'na' && ut.reason ? <span className="dk-uw-na">usage n/a</span> : ut.windows.map(w => (
              <span key={w.key} className="dk-uw" aria-hidden="true">
                <span className="dk-uw-l">{w.short}</span><Meter pct={w.pct} decorative /><span className="dk-uw-v">{pctStr(w.pct)}</span>
              </span>))}
          </button>
          <span className="dk-usage dk-tok" title="Tokens used by sessions that are working now, all agents">{compact(activeTokens(items))} tok <span className="dk-tok-lbl">active</span></span>
        </div>
        <span className="dk-grow" />
        <div className="dk-acts">
          {!full && <button className="dk-btn" onClick={enterFull} aria-label="Open fullscreen deck">Fullscreen</button>}
          {full && !standalone && <button className="dk-btn ao-fs-exit" onClick={exitFull} aria-label="Exit fullscreen deck">Exit</button>}
          <button className={'dk-btn' + (lite ? ' on' : '')} onClick={() => setLite(!lite)} title="Low-power: no animation, refresh every 15s">Lite</button>
          <button className="dk-btn" onClick={load} aria-label="Refresh">↻</button>
        </div>
      </header>
      {showReason && (ut.reason
        ? <div className="dk-reason">Plan usage unavailable: {ut.reason}</div>
        : <div className="dk-uplan" role="group" aria-label="Claude plan usage">
            {ut.windows.map(w => (
              <div key={w.key} className="dk-urow">
                <span className="dk-ulabel">{w.label}</span>
                <Meter pct={w.pct} label={`${w.label}: ${pctStr(w.pct)}`} />
                <span className="dk-upct">{pctStr(w.pct)}</span>
                {w.resets === 'n/a' || w.resets === 'reset time not reported'
                  ? <span className="dk-ures">reset time not reported</span>
                  : <span className="dk-ures">resets {w.resets}</span>}
              </div>))}
            <p className="dk-note dk-uscope">Claude plan usage, account-wide (not per agent).</p>
          </div>)}
      {error && <div className="dk-err">Can't reach the deck data ({error}). Retrying…</div>}
      <main ref={gridRef} className="dk-grid">
        {items.map(it => it.type === 'agent'
          ? <AgentTile key={it.key} it={it} pressed={it.key === sel} blip={blips[it.agent.id] || 0} still={lite || hidden} onPick={() => setSel(it.key)}
              setRef={el => { setTileRef(it.agent.id, el); }} />
          : <HelperTile key={it.key} it={it} pressed={it.key === sel} onPick={() => setSel(it.key)} />)}
        {!state && !error && Array.from({ length: 4 }, (_, i) => <div key={i} className="dk-tile is-ghost" />)}
        <div className="dk-flights" aria-hidden="true">
          {flights.map(f => <FlightLayer key={f.key} f={f} />)}
        </div>
      </main>
      {picked && <Sheet onClose={() => setSel(null)}>
        {picked.type === 'agent'
          ? <AgentSheet key={picked.key} it={picked} sessions={(state.sessions || {})[picked.agent.id] || []} now={now}
                      det={detOk && detOk.data} detErr={!!(detOk && detOk.err)} />
          : <HelperSheet it={picked} now={now} />}
      </Sheet>}
    </div>
  );
  return full
    ? <div ref={fullRef} className="ao-full" role="region" aria-label="Agent Deck fullscreen"><i className="ao-edge ao-edge-top" aria-hidden="true" />{root}<i className="ao-edge ao-edge-bot" aria-hidden="true" /></div>
    : root;
}
