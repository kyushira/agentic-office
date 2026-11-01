import { React, useState, useEffect, useRef, fetchJSON, API } from './sdk.js';
import { ago, compact } from './format.js';
import { invader, tint } from './sprite.js';

const POLL_MS = 5000, POLL_LITE_MS = 15000;

function Sprite({ id, working }) {
  const s = invader(id);
  const rects = px => px.map(([x, y]) => <rect key={x + '-' + y} x={x} y={y} width="1.02" height="1.02" />);
  return (
    <svg className={'dk-sprite' + (working ? ' is-anim' : '')} viewBox={`0 0 ${s.w} ${s.h}`} shapeRendering="crispEdges" style={{ fill: tint(id) }} aria-hidden="true">
      <g className="dk-fa">{rects(s.a)}</g>
      <g className="dk-fb">{rects(s.b)}</g>
    </svg>
  );
}

export function statusLine(t, now) {
  if (t.status === 'working') return `working · ${t.ctxPct != null ? t.ctxPct + '% ctx' : compact(t.ctx) + ' ctx'}`;
  return `${t.status} · ${ago(t.at, now)}`;
}

function Tile({ t, now, pressed, onPick }) {
  const working = t.status === 'working';
  return (
    <button className={'dk-tile' + (working ? ' is-working' : ' is-rest') + (pressed ? ' is-pressed' : '')} onClick={() => onPick(t.id)}
      aria-label={`${t.title}, ${statusLine(t, now)}`}>
      {working && <i className="dk-badge" />}
      <span className="dk-art"><Sprite id={t.id} working={working} />{!working && <em className="dk-zz">zz</em>}</span>
      <b className="dk-name">{t.title}</b>
      <span className="dk-status">{statusLine(t, now)}</span>
    </button>
  );
}

function Sheet({ t, agent, now, onClose }) {
  useEffect(() => {
    const k = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  if (!t) return null;
  const rows = [
    ['Agent', `${t.agentName}${agent && agent.role ? ' · ' + agent.role : ''}`],
    ['Where', t.source],
    ['Model', t.model || (agent && agent.model) || '—'],
    ['Status', statusLine(t, now)],
    ['Now', t.status === 'working' ? (t.step || (agent && agent.activity) || 'working') : '—'],
    ['Context', t.ctx ? `~${compact(t.ctx)} tokens${t.ctxPct != null ? ` (${t.ctxPct}%)` : ''}` : '—'],
    ['Session tokens', compact(t.tokens)],
    ['Agent tokens today', agent ? compact(agent.today.tokens) : '—'],
  ];
  const helpers = (agent && agent.helpers) || [];
  return (
    <div className="dk-scrim" onClick={onClose}>
      <aside className="dk-sheet" onClick={e => e.stopPropagation()} role="dialog" aria-label={t.title}>
        <header><span className="dk-sheet-art"><Sprite id={t.id} working={t.status === 'working'} /></span>
          <div className="dk-grow"><h2>{t.title}</h2><small>{statusLine(t, now)}</small></div>
          <button className="dk-x" onClick={onClose} aria-label="Close">✕</button></header>
        <dl>{rows.map(([k, v]) => <React.Fragment key={k}><dt>{k}</dt><dd>{v}</dd></React.Fragment>)}</dl>
        {helpers.length > 0 && <section><h3>Helpers · {helpers.length}</h3>
          {helpers.map((h, i) => <div key={h.id} className="dk-help"><i className="dk-badge" />Sub {i + 1} · {h.task}<small>{h.model}</small></div>)}</section>}
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
  const [tick, setTick] = useState(0);
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
  useEffect(() => {        // fill the space under the dashboard header
    const size = () => { const r = rootRef.current; if (r) setHeight(Math.max(360, window.innerHeight - Math.max(0, r.getBoundingClientRect().top) - 6)); };
    size(); window.addEventListener('resize', size);
    return () => window.removeEventListener('resize', size);
  }, []);
  useEffect(() => { const id = setInterval(() => setTick(x => x + 1), 30000); return () => clearInterval(id); }, []);   // keep "12m ago" fresh

  const now = Date.now() / 1000 + tick * 0;
  const tiles = (state && state.tiles) || [];
  const working = tiles.filter(t => t.status === 'working').length;
  const tile = tiles.find(t => t.id === sel) || null;
  const agent = tile && state ? state.agents.find(a => a.id === tile.agent) : null;

  return (
    <div ref={rootRef} className={'dk-root' + (lite ? ' is-lite' : '')} style={{ height }}>
      <header className="dk-top">
        <span className="dk-count"><i className={'dk-dot' + (working ? ' on' : '')} />{working} working · {tiles.length - working} idle</span>
        <span className="dk-grow" />
        <button className={'dk-btn' + (lite ? ' on' : '')} onClick={() => setLite(!lite)} title="Low-power: no animation, refresh every 15s">Lite</button>
        <button className="dk-btn" onClick={load} aria-label="Refresh">↻</button>
      </header>
      {error && <div className="dk-err">Can't reach the deck data ({error}). Retrying…</div>}
      <main className="dk-grid">
        {tiles.map(t => <Tile key={t.id} t={t} now={now} pressed={t.id === sel} onPick={setSel} />)}
        {state && !tiles.length && <p className="dk-empty">No sessions in the last 14 days.</p>}
        {!state && !error && Array.from({ length: 8 }, (_, i) => <div key={i} className="dk-tile is-ghost" />)}
      </main>
      <Sheet t={tile} agent={agent} now={now} onClose={() => setSel(null)} />
    </div>
  );
}
