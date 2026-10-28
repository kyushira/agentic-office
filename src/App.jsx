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

const isLite = () => {
  try { const v = localStorage.getItem('agent-office.lite'); if (v != null) return v === '1'; } catch (e) { /* private mode */ }
  return matchMedia('(pointer: coarse)').matches || (navigator.hardwareConcurrency || 8) <= 4;
};

export default function App() {
  const rootRef = useRef(null), stageRef = useRef(null), officeRef = useRef(null), labelRefs = useRef({}), brainRef = useRef(null);
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
      top: (h < 500 ? 56 : 62) + (w <= 720 ? 36 : 56),
      bottom: panelOpen && sheet ? Math.round(h * 0.62) : (w <= 720 && h > 500 ? 64 : 50),
      left: panelOpen && !sheet ? (h < 500 ? 340 : 380) : 0, right: 0,
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
        const pos = office.project(), W = stageRef.current ? stageRef.current.clientWidth : 1e4;
        // Place cards (bottom-centre anchored), keep them on screen, then push overlapping ones apart vertically.
        const cards = [];
        for (const [id, el] of Object.entries(labelRefs.current)) {
          const p = pos[id]; if (!el || !p) continue;
          const w = el.offsetWidth, h = el.offsetHeight, x = Math.min(Math.max(p.x, w / 2 + 6), W - w / 2 - 6);
          cards.push({ el, x, y: p.y, w, h });
        }
        cards.sort((a, b) => a.y - b.y);
        for (let i = 1; i < cards.length; i++) for (let j = 0; j < i; j++) {
          const a = cards[j], b = cards[i];
          const ox = Math.min(a.x + a.w / 2, b.x + b.w / 2) - Math.max(a.x - a.w / 2, b.x - b.w / 2);
          const oy = Math.min(a.y, b.y) - Math.max(a.y - a.h, b.y - b.h);
          if (ox > 0 && oy > -4) { a.y -= (oy + 4) / 2; b.y += (oy + 4) / 2; }
        }
        for (const c of cards) c.el.style.transform = `translate(-50%, -100%) translate(${c.x.toFixed(1)}px, ${c.y.toFixed(1)}px)`;
        if (brainRef.current && pos.__brain) brainRef.current.style.transform = `translate(-50%, 8px) translate(${pos.__brain.x.toFixed(1)}px, ${pos.__brain.y.toFixed(1)}px)`;
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
      fetchJSON(API).then(s => { if (!alive) return; setState(s); setError(''); officeRef.current && officeRef.current.update(s); })
        .catch(e => alive && setError(String(e && e.message || e)))
        .finally(() => { if (alive) timer = setTimeout(tick, POLL_MS); });
    };
    tick();
    return () => { alive = false; clearTimeout(timer); };
  }, []);

  useEffect(() => { officeRef.current && officeRef.current.select(sel); }, [sel]);
  useEffect(() => { officeRef.current && officeRef.current.setLite(lite); try { localStorage.setItem('agent-office.lite', lite ? '1' : '0'); } catch (e) { /* ignore */ } }, [lite]);

  const agent = state && sel ? state.agents.find(a => a.id === sel) : null;
  const pickAgent = id => { setSel(id); setTab('office'); };
  const narrow = rootRef.current ? rootRef.current.clientWidth <= 720 : false;
  const sheet = narrow && height > 500 && panelOpen;      // phone portrait with the bottom sheet open
  const full = () => { const r = rootRef.current; if (document.fullscreenElement) document.exitFullscreen(); else if (r && r.requestFullscreen) r.requestFullscreen().catch(() => {}); };

  return (
    <div ref={rootRef} className={'ao-root' + (sheet ? ' has-sheet' : '')} style={{ height }}>
      <div ref={stageRef} className="ao-stage" />
      <div className="ao-overlay">
        {state && state.agents.filter(a => !sel || a.id === sel || !narrow).map(a => <LabelCard key={a.id} a={a} innerRef={el => { labelRefs.current[a.id] = el; }} onClick={() => pickAgent(a.id)} />)}
        {state && <button ref={brainRef} className="ao-label ao-brain-label" onClick={() => setTab('brain')}>
          <span className="ao-label-txt"><b className="ao-mono">THE BRAIN</b><span className="ao-mono">{state.brain.notes} notes · shared memory</span></span></button>}
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

      <footer className="ao-runs">
        <span className="ao-mono ao-muted">RUNS ON</span>
        {state && state.runsOn.map(m => <span key={m} className="ao-chip">{m}</span>)}
      </footer>
      <div className="ao-controls">
        <button className="ao-icon-btn" onClick={() => officeRef.current.zoom(1 / 1.25)} aria-label="Zoom out"><Icon name="minus" /></button>
        <button className="ao-icon-btn" onClick={() => officeRef.current.zoom(1.25)} aria-label="Zoom in"><Icon name="plus" /></button>
        <button className="ao-icon-btn" onClick={() => officeRef.current.fit()} aria-label="Fit"><Icon name="fit" /></button>
        {document.fullscreenEnabled && <button className="ao-icon-btn" onClick={full} aria-label="Full screen"><Icon name="full" /></button>}
        <button className={'ao-chip ao-lite' + (lite ? ' on' : '')} onClick={() => setLite(!lite)} title="Low-power mode: no shadows, fewer pixels, 30 fps">Lite</button>
      </div>
    </div>
  );
}
