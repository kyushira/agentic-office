import { React, useState, useEffect, useRef, fetchJSON, API } from './sdk.js';
import { ago, compact } from './format.js';
import { invader, tint } from './sprite.js';
import { buildItems, headerCounts, durationText } from './deck-model.js';

const POLL_MS = 5000, POLL_LITE_MS = 15000;

function Sprite({ seed, color, working, small }) {
  const s = invader(seed);
  const rects = px => px.map(([x, y]) => <rect key={x + '-' + y} x={x} y={y} width="1.02" height="1.02" />);
  return (
    <svg className={'dk-sprite' + (working ? ' is-anim' : '') + (small ? ' is-small' : '')} viewBox={`0 0 ${s.w} ${s.h}`}
      shapeRendering="crispEdges" style={{ fill: color }} aria-hidden="true">
      <g className="dk-fa">{rects(s.a)}</g>
      <g className="dk-fb">{rects(s.b)}</g>
    </svg>
  );
}

function AgentTile({ it, pressed, onPick }) {
  const a = it.agent, working = it.working;
  return (
    <button className={'dk-tile' + (working ? ' is-working' : ' is-rest') + (pressed ? ' is-pressed' : '') + (it.chip ? ' has-chip' : '')} onClick={onPick}
      style={{ '--dk-c': it.color, gridColumnStart: it.rowStart ? 1 : undefined }} aria-label={`${a.name}, ${it.status}`}>
      {working && <i className="dk-badge" />}
      {it.helperCount > 0 && <span className="dk-count-chip">{it.helperCount} helper{it.helperCount > 1 ? 's' : ''}</span>}
      {it.ctxPct != null && !it.helperCount && <span className="dk-ctx">{it.ctxPct}% ctx</span>}
      <span className="dk-art"><Sprite seed={'agent:' + a.id} color={it.color} working={working} />{!working && <em className="dk-zz">zz</em>}</span>
      <b className="dk-name">{a.name}</b>
      <span className="dk-status">{it.status}</span>
      {it.chip && <span className="dk-handoff" style={{ '--dk-from': it.chip.color }}>← {it.chip.text}</span>}
    </button>
  );
}

function HelperTile({ it, pressed, onPick }) {
  const h = it.helper, done = it.done;
  return (
    <button className={'dk-tile is-helper' + (done ? ' is-done' : ' is-working') + (pressed ? ' is-pressed' : '')} onClick={onPick}
      style={{ '--dk-c': it.parentColor }} aria-label={`${it.name}, ${it.status}`}>
      <span className="dk-art"><Sprite seed={'helper:' + h.id} color={done ? '#5f5f5f' : tint('helper:' + h.id)} working={!done} small />
        {done && <em className="dk-zz dk-check">✓</em>}</span>
      <b className="dk-name">{it.name}</b>
      <span className="dk-parent">↳ {it.parentName}</span>
      <span className="dk-status">{it.status}</span>
    </button>
  );
}

const Pill = ({ status }) => <span className={'dk-pill is-' + status}>{status === 'done' ? '✓ done' : status}</span>;

function SessionDetail({ s, now, onBack }) {
  const rows = [
    ['Status', <Pill status={s.status} />], ['Where', s.source], ['Model', s.model || '—'],
    ['Now', s.status === 'working' ? s.step || 'working' : '—'],
    ['Context', s.ctx ? `~${compact(s.ctx)} tokens${s.ctxPct != null ? ` (${s.ctxPct}%)` : ''}` : '—'],
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

function AgentSheet({ it, sessions, now }) {
  const [open, setOpen] = useState(null);
  const a = it.agent;
  const s = open && sessions.find(x => x.id === open);
  if (s) return <SessionDetail s={s} now={now} onBack={() => setOpen(null)} />;
  return (
    <>
      <header><span className="dk-sheet-art"><Sprite seed={'agent:' + a.id} color={it.color} /></span>
        <div className="dk-grow"><h2>{a.name}</h2><small>{a.role} · {it.status}</small></div></header>
      {it.walks.length > 0 && <section><h3>Hand-offs</h3>
        {it.walks.map(w => <div key={w.id} className="dk-row-mini"><span>{w.label}</span><small>{ago(w.at, now)}</small></div>)}</section>}
      <section><h3>Sessions · {sessions.length}</h3>
        {sessions.map(x => (
          <button key={x.id} className={'dk-srow is-' + x.status} onClick={() => setOpen(x.id)}>
            <span className="dk-wrap dk-stitle">{x.title}</span>
            <span className="dk-smeta"><Pill status={x.status} />{x.ctxPct != null && <span>{x.ctxPct}% ctx</span>}
              <span>{ago(x.at, now)}</span>{x.model && <span>{x.model}</span>}<span>{compact(x.tokens)} tok</span></span>
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
      <header><span className="dk-sheet-art"><Sprite seed={'helper:' + h.id} color={it.done ? '#5f5f5f' : tint('helper:' + h.id)} small /></span>
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
  const [state, setState] = useState(null);
  const [error, setError] = useState('');
  const [sel, setSel] = useState(null);
  const [lite, setLite] = useState(readLite);
  const [height, setHeight] = useState(600);
  const [, setTick] = useState(0);
  const timer = useRef(0), alive = useRef(true), liteRef = useRef(lite);
  liteRef.current = lite;

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

  const now = Date.now() / 1000;
  const items = state ? buildItems(state, now, tint) : [];
  const counts = state ? headerCounts(items) : null;
  const picked = items.find(i => i.key === sel) || null;

  return (
    <div ref={rootRef} className={'dk-root' + (lite ? ' is-lite' : '') + (items.length && items.length <= 6 ? ' is-few' : '')} style={{ height }}>
      <header className="dk-top">
        <span className="dk-count"><i className={'dk-dot' + (counts && counts.working ? ' on' : '')} />
          {counts ? `${counts.working} working · ${counts.idle} idle · ${counts.helpers} helper${counts.helpers === 1 ? '' : 's'}` : 'loading…'}</span>
        <span className="dk-grow" />
        <button className={'dk-btn' + (lite ? ' on' : '')} onClick={() => setLite(!lite)} title="Low-power: no animation, refresh every 15s">Lite</button>
        <button className="dk-btn" onClick={load} aria-label="Refresh">↻</button>
      </header>
      {error && <div className="dk-err">Can't reach the deck data ({error}). Retrying…</div>}
      <main className="dk-grid">
        {items.map(it => it.type === 'agent'
          ? <AgentTile key={it.key} it={it} pressed={it.key === sel} onPick={() => setSel(it.key)} />
          : <HelperTile key={it.key} it={it} pressed={it.key === sel} onPick={() => setSel(it.key)} />)}
        {!state && !error && Array.from({ length: 4 }, (_, i) => <div key={i} className="dk-tile is-ghost" />)}
      </main>
      {picked && <Sheet onClose={() => setSel(null)}>
        {picked.type === 'agent'
          ? <AgentSheet key={picked.key} it={picked} sessions={(state.sessions || {})[picked.agent.id] || []} now={now} />
          : <HelperSheet it={picked} now={now} />}
      </Sheet>}
    </div>
  );
}
