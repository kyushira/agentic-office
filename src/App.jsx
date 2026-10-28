import { React, useState, useEffect, useRef, fetchJSON, API } from './sdk.js';
import { createOffice, COLORS } from './scene.js';
import { ago, compact, sparkPath, statusLabel, headline } from './format.js';

const POLL_MS = 5000;
const hex = n => '#' + (n >>> 0).toString(16).padStart(6, '0');
const colorOf = a => hex(COLORS[a.color] ?? COLORS.blue);

// Small inline icons (no icon font / network).
const PATHS = {
  code: 'M8 7l-5 5 5 5M16 7l5 5-5 5',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  star: 'M12 3l2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.5 6.7 19.4l1.2-6L3.4 9.3l6-.7z',
  brain: 'M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 1V5a2 2 0 0 0-3-1zM15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 1',
  x: 'M6 6l12 12M18 6L6 18', plus: 'M12 5v14M5 12h14', minus: 'M5 12h14', fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  full: 'M3 8V3h5M21 8V3h-5M3 16v5h5M21 16v5h-5', bolt: 'M13 2L4 14h7l-1 8 9-12h-7z',
};
function Icon({ name, size = 16 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={PATHS[name] || PATHS.star} /></svg>;
}
const roomIcon = a => /dev|code|engineer/i.test(a.id + a.role) ? 'code' : /research|red/i.test(a.id + a.role) ? 'search' : 'star';
function Avatar({ name, color, size = 18 }) {
  return <span className="ao-avatar" style={{ background: color, width: size, height: size, fontSize: size * 0.5 }}>{(name || '?')[0].toUpperCase()}</span>;
}
function Dot({ status }) { return <span className={'ao-dot ao-' + status} />; }

function Spark({ series, color }) {
  return <svg className="ao-spark" viewBox="0 0 120 28" preserveAspectRatio="none"><path d={sparkPath(series)} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" /></svg>;
}

function LabelCard({ a, onClick, innerRef }) {
  const c = colorOf(a);
  return (
    <button ref={innerRef} className={'ao-label' + (a.status === 'working' ? ' is-live' : '')} onClick={onClick} style={{ '--ao-c': c }}>
      <span className="ao-label-ico" style={{ background: c }}><Icon name={roomIcon(a)} size={13} /></span>
      <span className="ao-label-txt">
        <b>{a.name}</b>
        <span className="ao-mono"><Dot status={a.status} /> {a.activity}</span>
      </span>
      <span className="ao-avatars">
        <Avatar name={a.name} color={c} />
        {a.helpers.slice(0, 3).map(h => <Avatar key={h.id} name="S" color="#4b5875" size={16} />)}
      </span>
    </button>
  );
}

function DetailPanel({ a, onClose }) {
  if (!a) return null;
  const c = colorOf(a);
  const maxSkill = Math.max(1, ...a.skills.map(s => s.count));
  return (
    <aside className="ao-panel ao-detail" style={{ '--ao-c': c }}>
      <header className="ao-detail-head">
        <span className="ao-detail-ico" style={{ background: c }}><Icon name={roomIcon(a)} size={22} /></span>
        <div className="ao-grow">
          <h2>{a.name}</h2>
          <div className="ao-sub"><Dot status={a.status} /> {statusLabel(a)} · {a.role}</div>
        </div>
        <button className="ao-icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
      </header>
      <div className="ao-now ao-mono"><span>NOW</span> {a.activity}</div>
      <div className="ao-stats">
        <div className="ao-stat"><small>Sessions today</small><b>{a.today.sessions}</b><Spark series={a.spark.sessions} color="#8b7bff" /></div>
        <div className="ao-stat"><small>Tool calls today</small><b>{compact(a.today.toolCalls)}</b><Spark series={a.spark.toolCalls} color="#46e08a" /></div>
        <div className="ao-stat"><small>Tokens today</small><b>{compact(a.today.tokens)}</b><Spark series={a.spark.tokens} color="#5fc8ff" /></div>
      </div>
      <section>
        <h3><span>TOOLS USED TODAY</span><em className="ao-mono">{a.tools.length} active</em></h3>
        <div className="ao-tools">
          {a.tools.length ? a.tools.map(t => (
            <div key={t.name} className="ao-tool"><span className="ao-tool-ico">{t.name[0].toUpperCase()}</span>
              <div><b>{t.label}</b><small><Dot status="working" /> {t.count} uses · {t.name}</small></div></div>
          )) : <p className="ao-muted">No tool calls yet today.</p>}
        </div>
      </section>
      {a.helpers.length > 0 && <section>
        <h3><span>HELPERS</span><em className="ao-mono">{a.helpers.length} running</em></h3>
        {a.helpers.map((h, i) => <div key={h.id} className="ao-row ao-mono"><Dot status="working" /> Sub {i + 1} · {h.task} <small>{h.model}</small></div>)}
      </section>}
      <section>
        <h3><span>SKILLS</span><em className="ao-mono">{a.skills.reduce((n, s) => n + s.count, 0)} installed</em></h3>
        {a.skills.map(s => (
          <div key={s.name} className="ao-skill ao-mono"><Dot status="working" /><span className="ao-grow">{s.name}</span>
            <span className="ao-bar"><i style={{ width: (s.count / maxSkill) * 100 + '%' }} /></span><small>{s.count}</small></div>
        ))}
      </section>
      <section>
        <h3><span>RECENT</span><em className="ao-mono">{a.model}{a.helperModels.length ? ' + ' + a.helperModels.join(', ') : ''}</em></h3>
        {a.recent.map((r, i) => <div key={i} className="ao-row"><span className="ao-grow">{r.title}</span><small className="ao-mono">{r.source} · {ago(r.at)}</small></div>)}
      </section>
    </aside>
  );
}

function ListPanel({ tab, state, onPick, onClose }) {
  if (tab === 'brain') return (
    <aside className="ao-panel ao-detail">
      <header className="ao-detail-head"><span className="ao-detail-ico ao-brain-ico"><Icon name="brain" size={22} /></span>
        <div className="ao-grow"><h2>The Brain</h2><div className="ao-sub">shared memory · Obsidian vault</div></div>
        <button className="ao-icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" /></button></header>
      <div className="ao-stats"><div className="ao-stat"><small>Notes</small><b>{state.brain.notes}</b></div>
        <div className="ao-stat"><small>Agents</small><b>{state.counts.agents}</b></div>
        <div className="ao-stat"><small>Helpers now</small><b>{state.counts.helpers}</b></div></div>
      <p className="ao-muted">Every agent reads and writes the same vault, so what one learns the others can use.</p>
    </aside>
  );
  const rows = [];
  for (const a of state.agents) {
    rows.push({ a, who: a.name, what: a.activity, status: a.status });
    a.helpers.forEach((h, i) => rows.push({ a, who: `${a.name} · Sub ${i + 1}`, what: h.task, status: 'working' }));
  }
  return (
    <aside className="ao-panel ao-detail">
      <header className="ao-detail-head"><div className="ao-grow"><h2>Tasks</h2><div className="ao-sub">what everyone is doing now</div></div>
        <button className="ao-icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" /></button></header>
      {rows.map((r, i) => (
        <button key={i} className="ao-task" onClick={() => onPick(r.a.id)} style={{ '--ao-c': colorOf(r.a) }}>
          <Avatar name={r.a.name} color={colorOf(r.a)} size={24} />
          <div className="ao-grow"><b>{r.who}</b><small className="ao-mono"><Dot status={r.status} /> {r.what}</small></div>
        </button>
      ))}
    </aside>
  );
}

/** Top-down minimap in screen-plane units: room diamonds in their colours, the Brain, the view box. */
function Minimap({ map, onPan, onPick }) {
  if (!map || !map.rooms.length) return <svg className="ao-map" viewBox="0 0 10 7" />;
  const d = map.size / Math.SQRT2 + 1;
  const xs = map.rooms.flatMap(r => [r.x - d, r.x + d]), ys = map.rooms.flatMap(r => [-r.y - d, -r.y + d]);
  const x0 = Math.min(...xs, -map.hub), x1 = Math.max(...xs, map.hub), y0 = Math.min(...ys, -map.hub), y1 = Math.max(...ys, map.hub);
  const pad = 2, vb = [x0 - pad, y0 - pad, x1 - x0 + pad * 2, y1 - y0 + pad * 2];
  const v = map.view;
  const click = e => {
    const svg = e.currentTarget, r = svg.getBoundingClientRect();
    const sx = vb[0] + ((e.clientX - r.left) / r.width) * vb[2], sy = vb[1] + ((e.clientY - r.top) / r.height) * vb[3];
    const hit = map.rooms.find(rm => Math.abs(sx - rm.x) + Math.abs(sy + rm.y) < d);
    if (hit) onPick(hit.id); else onPan(sx, -sy);
  };
  return (
    <svg className="ao-map" viewBox={vb.join(' ')} preserveAspectRatio="xMidYMid meet" onClick={click} role="img" aria-label="Minimap">
      {map.rooms.map(r => <line key={'l' + r.id} x1="0" y1="0" x2={r.x} y2={-r.y} stroke={hex(r.color)} strokeOpacity="0.55" strokeWidth="0.9" />)}
      <circle cx="0" cy="0" r={map.hub} fill="#0d1733" stroke="#7fe6ff" strokeWidth="0.5" />
      <circle cx="0" cy="0" r={map.hub * 0.35} fill="#7fe6ff" opacity="0.8" />
      {map.rooms.map(r => (
        <g key={r.id}>
          <polygon points={`${r.x},${-r.y - d + 1} ${r.x + d - 1},${-r.y} ${r.x},${-r.y + d - 1} ${r.x - d + 1},${-r.y}`} fill={hex(r.color)} fillOpacity="0.85" stroke="#fff" strokeOpacity="0.25" strokeWidth="0.4" />
          {r.status === 'working' && <circle cx={r.x} cy={-r.y} r="1.1" fill="#46e08a" />}
        </g>
      ))}
      <rect x={v.x - v.w} y={-v.y - v.h} width={v.w * 2} height={v.h * 2} fill="none" stroke="#fff" strokeOpacity="0.7" strokeWidth="0.5" rx="0.8" />
    </svg>
  );
}

const isLite = () => {
  try { const v = localStorage.getItem('agent-office.lite'); if (v != null) return v === '1'; } catch (e) { /* private mode */ }
  return matchMedia('(pointer: coarse)').matches || (navigator.hardwareConcurrency || 8) <= 4;
};

export default function App() {
  const rootRef = useRef(null), stageRef = useRef(null), officeRef = useRef(null), labelRefs = useRef({}), brainRef = useRef(null);
  const helperRefs = useRef({}), ctrlRef = useRef(null), runsRef = useRef(null), toastRef = useRef(null);
  const [state, setState] = useState(null);
  const [error, setError] = useState('');
  const [sel, setSel] = useState(null);
  const [tab, setTab] = useState('office');
  const [lite, setLite] = useState(isLite);
  const [height, setHeight] = useState(600);
  // Free area for the 3D fit: below the top bar + label headroom, above the bottom bars,
  // and right of the detail panel when it's docked on the left (desktop / phone landscape).
  const insetsRef = useRef({ top: 110, bottom: 52, left: 0, right: 0 });
  const panelOpen = !!sel || tab !== 'office';
  useEffect(() => {
    const el = rootRef.current, w = el ? el.clientWidth : 1000, h = el ? el.clientHeight : 600;
    const sheet = w <= 720 && h > 500;               // phone portrait: the panel is a bottom sheet
    insetsRef.current = {
      top: h < 500 ? 64 : 62 + (w <= 720 ? 30 : 56),
      bottom: panelOpen && sheet ? Math.round(h * 0.62) : (w <= 720 && h > 500 ? 118 : h < 500 ? 30 : 60),
      left: panelOpen && !sheet ? (h < 500 ? 340 : 380) : 0, right: 0,
      topBar: h < 500 ? 54 : w <= 720 ? 56 : 62, bottomBar: w <= 720 && h > 500 ? 112 : 56,
    };
    const o = officeRef.current;
    if (o) { if (sel) o.focus(sel); else o.fit(); }
  }, [panelOpen, height, sel]);

  // Fill the space below the dashboard's header (the plugin renders inside its main area).
  useEffect(() => {
    const size = () => { const r = rootRef.current; if (!r) return; setHeight(Math.max(360, window.innerHeight - Math.max(0, r.getBoundingClientRect().top) - 8)); };
    size(); window.addEventListener('resize', size);
    return () => window.removeEventListener('resize', size);
  }, []);

  useEffect(() => {
    const office = createOffice(stageRef.current, {
      lite: isLite(),
      onSelect: id => { setSel(id); setTab(id ? 'office' : 'office'); },
      onFrame: () => {           // keep the HTML label cards glued to their rooms
        const pos = office.project(), st = stageRef.current;
        const W = st ? st.clientWidth : 1e4, H = st ? st.clientHeight : 1e4;
        const top = insetsRef.current.topBar || 60, bottom = H - (insetsRef.current.bottomBar || 52);
        // Each card goes on the outer side of its room (from project()), as a top-left rect, clamped on screen.
        const place = (el, p) => {
          const w = el.offsetWidth, h = el.offsetHeight, g = 8;
          let x = p.x - w / 2, y = p.y - h - g;
          if (p.side === 'below') y = p.y + g;
          else if (p.side === 'right') { x = p.x + g; y = p.y - h / 2; }
          else if (p.side === 'left') { x = p.x - w - g; y = p.y - h / 2; }
          return { el, x: Math.min(Math.max(x, 6), W - w - 6), y: Math.min(Math.max(y, top), bottom - h), w, h };
        };
        const cards = [];
        // Room cards: try each side of the room; keep the one that covers the least of the other rooms
        // and the Brain (bounding boxes shrunk to roughly the visible diamond), sticky to avoid flicker.
        const ids = Object.keys(labelRefs.current).filter(id => labelRefs.current[id] && pos[id]);
        const shrink = b => { const sx = (b.x1 - b.x0) * 0.2, sy = (b.y1 - b.y0) * 0.2; return { x0: b.x0 + sx, x1: b.x1 - sx, y0: b.y0 + sy, y1: b.y1 - sy }; };
        const area = (r, b) => Math.max(0, Math.min(r.x + r.w, b.x1) - Math.max(r.x, b.x0)) * Math.max(0, Math.min(r.y + r.h, b.y1) - Math.max(r.y, b.y0));
        for (const id of ids) {
          const el = labelRefs.current[id], p = pos[id], b = p.box, cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
          const cands = { above: { x: cx, y: b.y0 }, below: { x: cx, y: b.y1 }, left: { x: b.x0, y: cy }, right: { x: b.x1, y: cy } };
          const order = [p.side, ...['above', 'below', 'left', 'right'].filter(s => s !== p.side)];
          const others = ids.filter(o => o !== id).map(o => shrink(pos[o].box)).concat(pos.__hubBox ? [pos.__hubBox] : []);
          let best = null;
          order.forEach((side, i) => {
            const r = place(el, { ...cands[side], side });
            const score = others.reduce((s, o) => s + area(r, o), 0) + area(r, shrink(b)) * 0.4 + i * 30 - (el.dataset.side === side ? 400 : 0);
            if (!best || score < best.score) best = { ...r, score, side };
          });
          el.dataset.side = best.side;
          cards.push(best);
        }
        if (brainRef.current && pos.__brain && pos.__hubBox) {   // the Brain card picks a free side of the platform too
          const el = brainRef.current, b = pos.__hubBox, cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
          const rooms = ids.map(o => shrink(pos[o].box));
          let best = null;
          [['below', pos.__brain.x, pos.__brain.y], ['right', b.x1 - 10, cy], ['left', b.x0 + 10, cy], ['above', cx, b.y0]].forEach(([side, x, y], i) => {
            const r = place(el, { x, y, side });
            const score = rooms.reduce((s, o) => s + area(r, o), 0) + i * 30 - (el.dataset.side === side ? 400 : 0);
            if (!best || score < best.score) best = { ...r, score, side };
          });
          el.dataset.side = best.side;
          cards.push(best);
        }
        // helper tags above their desks (they give way to the room cards)
        for (const [hid, el] of Object.entries(helperRefs.current)) {
          if (!el) continue;
          const p = pos.__helpers[hid];
          el.style.opacity = p ? '1' : '0';
          if (p) cards.push(Object.assign(place(el, { ...p, side: 'above' }), { tag: true }));
        }
        // The bottom panels (minimap, RUNS ON) are fixed obstacles: a card over one is lifted above it first.
        const rr = st ? st.getBoundingClientRect() : { left: 0, top: 0 };
        const obst = [ctrlRef.current, runsRef.current, toastRef.current && toastRef.current.childElementCount ? toastRef.current : null].filter(Boolean).map(o => { const b = o.getBoundingClientRect(); return { x: b.left - rr.left, y: b.top - rr.top, w: b.width, h: b.height, fixed: true }; });
        for (const c of cards) for (const o of obst) {
          if (!(c.x < o.x + o.w && c.x + c.w > o.x && c.y < o.y + o.h && c.y + c.h > o.y - 4)) continue;
          if (o.y > H / 2) c.y = o.y - c.h - 6; else c.y = o.y + o.h + 6;     // bottom panels lift, top ones push down
        }
        // Push overlapping cards apart vertically (a few passes); obstacles never move, tags give way to cards.
        const all = cards.concat(obst).sort((a, b) => a.y - b.y);
        for (let pass = 0; pass < 5; pass++) for (let i = 1; i < all.length; i++) for (let j = 0; j < i; j++) {
          const a = all[j], b = all[i];
          if (a.fixed && b.fixed) continue;
          const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
          if (!(ox > 0 && oy > -3)) continue;
          const d = oy + 3, up = a.y <= b.y ? a : b, down = up === a ? b : a;
          const ku = up.fixed ? 0 : down.fixed ? 1 : up.tag && !down.tag ? 1 : !up.tag && down.tag ? 0 : 0.5;
          up.y -= d * ku; down.y += d * (1 - ku);
        }
        for (const c of cards) {
          c.y = Math.max(c.y, top);
          c.el.style.transform = `translate(${c.x.toFixed(1)}px, ${c.y.toFixed(1)}px)`;
        }
      },
      insets: () => insetsRef.current,
    });
    officeRef.current = office;
    return () => office.dispose();
  }, []);

  useEffect(() => {
    let alive = true, timer = 0;
    const tick = () => {
      if (document.hidden) { timer = setTimeout(tick, POLL_MS); return; }
      fetchJSON(API).then(s => { if (!alive) return; setState(s); setError(''); officeRef.current && officeRef.current.update(s); onEventsRef.current(s); })
        .catch(e => alive && setError(String(e && e.message || e)))
        .finally(() => { if (alive) timer = setTimeout(tick, POLL_MS); });
    };
    tick();
    return () => { alive = false; clearTimeout(timer); };
  }, []);

  // Toasts for real events and Brain trips (walkers). On the first load only very recent ones play.
  const [toasts, setToasts] = useState([]);
  const seen = useRef({ events: new Set(), trips: new Set(), first: true });
  const onEvents = s => {
    const S = seen.current, now = s.ts || Date.now() / 1000, names = Object.fromEntries(s.agents.map(a => [a.id, a.name]));
    const fresh = [];
    for (const e of s.events || []) {
      if (S.events.has(e.id)) continue;
      S.events.add(e.id);
      if (!S.first || now - e.at < 90) fresh.push({ ...e, who: e.agent ? names[e.agent] || e.agent : '' , key: e.id });
    }
    for (const a of s.agents) for (const tr of a.brainTrips || []) {
      if (S.trips.has(tr.id)) continue;
      S.trips.add(tr.id);
      if (!S.first || now - tr.at < 60) officeRef.current && officeRef.current.walk(a.id, tr.kind);
    }
    S.first = false;
    if (fresh.length) {
      setToasts(t => [...fresh.slice(0, 3).reverse(), ...t].slice(0, 3));
      for (const f of fresh.slice(0, 3)) setTimeout(() => setToasts(t => t.filter(x => x.key !== f.key)), 7000);
    }
  };
  const onEventsRef = useRef(onEvents); onEventsRef.current = onEvents;

  // Minimap: polled from the scene a few times a second (cheap, no React work per frame).
  const [map, setMap] = useState(null);
  useEffect(() => {
    const id = setInterval(() => { const o = officeRef.current; if (o && !document.hidden) setMap(o.mapData()); }, 400);
    return () => clearInterval(id);
  }, []);

  useEffect(() => { officeRef.current && officeRef.current.select(sel); }, [sel]);
  useEffect(() => { officeRef.current && officeRef.current.setLite(lite); try { localStorage.setItem('agent-office.lite', lite ? '1' : '0'); } catch (e) { /* ignore */ } }, [lite]);

  const agent = state && sel ? state.agents.find(a => a.id === sel) : null;
  const pickAgent = id => { setSel(id); setTab('office'); };
  const narrow = rootRef.current ? rootRef.current.clientWidth <= 720 || height < 500 : false;   // phones, either way round
  const sheet = narrow && height > 500 && panelOpen;      // phone portrait with the bottom sheet open
  const full = () => { const r = rootRef.current; if (document.fullscreenElement) document.exitFullscreen(); else if (r && r.requestFullscreen) r.requestFullscreen().catch(() => {}); };

  return (
    <div ref={rootRef} className={'ao-root' + (sheet ? ' has-sheet' : '')} style={{ height }}>
      <div ref={stageRef} className="ao-stage" />
      <div className="ao-overlay">
        {state && state.agents.filter(a => !sel || a.id === sel || !narrow).map(a => <LabelCard key={a.id} a={a} innerRef={el => { labelRefs.current[a.id] = el; }} onClick={() => pickAgent(a.id)} />)}
        {state && <button ref={brainRef} className="ao-label ao-brain-label" onClick={() => setTab('brain')}>
          <span className="ao-label-txt"><b className="ao-mono">THE BRAIN</b><span className="ao-mono">{state.brain.notes.toLocaleString('en')} notes · shared memory</span></span></button>}
        {state && state.agents.filter(a => !narrow || a.id === sel).flatMap(a => a.helpers.map((h, i) => (
          <div key={h.id} ref={el => { helperRefs.current[h.id] = el; }} className="ao-subtag ao-mono" style={{ '--ao-c': colorOf(a), opacity: 0 }}>
            <Dot status="working" /><span className="ao-subtag-t">Sub {i + 1} · {h.task}</span>{h.model ? <em>· {h.model}</em> : null}
          </div>)))}
      </div>

      <div className="ao-toasts" aria-live="polite" ref={toastRef}>
        {toasts.slice(0, narrow ? 1 : 3).map(t => {
          const a = state && state.agents.find(x => x.id === t.agent);
          return <div key={t.key} className="ao-toast-card" style={{ '--ao-c': a ? colorOf(a) : '#5fd8ff' }}>
            <span className="ao-toast-ico"><Icon name={t.kind === 'push' ? 'code' : t.kind === 'helpers' ? 'bolt' : 'star'} size={13} /></span>
            <span><b>{t.who || 'Git'}</b> · {t.text}</span></div>;
        })}
      </div>

      <header className="ao-top">
        <div className="ao-brand"><span className="ao-logo"><Icon name="bolt" size={15} /></span><span className="ao-hide-sm">Agent Office</span></div>
        <nav className="ao-tabs">
          {[['office', 'Office'], ['tasks', 'Tasks'], ['brain', 'Brain']].map(([k, l]) => (
            <button key={k} className={tab === k ? 'on' : ''} onClick={() => { setTab(k); if (k !== 'office') setSel(null); }}>
              {l}{k === 'tasks' && state ? <em>{state.agents.length + state.counts.helpers}</em> : null}</button>
          ))}
        </nav>
        <div className="ao-pill ao-mono"><Dot status={state && state.counts.running ? 'working' : 'idle'} />
          <span className="ao-long">{state ? headline(state) : 'loading…'}</span>
          <span className="ao-short">{state ? `${state.counts.running}/${state.counts.agents}` : '…'}</span></div>
      </header>

      {error && <div className="ao-toast ao-error">Can't reach the office data ({error}). Retrying…</div>}

      {tab === 'office' && <DetailPanel a={agent} onClose={() => setSel(null)} />}
      {tab !== 'office' && state && <ListPanel tab={tab} state={state} onPick={pickAgent} onClose={() => setTab('office')} />}

      <footer className="ao-runs" ref={runsRef}>
        <span className="ao-mono ao-muted">RUNS ON</span>
        {state && state.runsOn.map(m => <span key={m} className="ao-chip">{m}</span>)}
      </footer>
      <div className="ao-controls" ref={ctrlRef}>
        <div className="ao-map-head"><span className="ao-mono ao-muted">MAP</span>
          <button className={'ao-chip ao-lite' + (lite ? ' on' : '')} onClick={() => setLite(!lite)} title="Low-power mode: no shadows, fewer pixels, 30 fps">Lite</button></div>
        <Minimap map={map} onPan={(x, y) => officeRef.current.panTo(x, y)} onPick={pickAgent} />
        <div className="ao-map-btns">
          <button className="ao-icon-btn" onClick={() => officeRef.current.zoom(1 / 1.25)} aria-label="Zoom out"><Icon name="minus" /></button>
          <button className="ao-icon-btn" onClick={() => officeRef.current.zoom(1.25)} aria-label="Zoom in"><Icon name="plus" /></button>
          <button className="ao-icon-btn" onClick={() => officeRef.current.fit()} aria-label="Fit"><Icon name="fit" /></button>
          {document.fullscreenEnabled && <button className="ao-icon-btn" onClick={full} aria-label="Full screen"><Icon name="full" /></button>}
        </div>
      </div>
    </div>
  );
}
