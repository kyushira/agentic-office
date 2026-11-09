import { React, useState, useEffect, useRef, fetchJSON } from './sdk.js';
import { BRAIN_API, brainUrl, brainAgents, soulLine, fmtInt } from './brain-model.js';

/**
 * Read-only Brain view (GET /brain). Two entry points: BrainOverview at the top of the Memory pane (every agent,
 * one row each, expandable) and BrainDetail in the agent sheet's Brain tab (one agent). No polling: the overview
 * fetches when the pane becomes visible and on Refresh; the sheet fetches when its tab opens. Text is rendered as
 * plain text nodes, never as HTML.
 */

const nowSec = () => Date.now() / 1000;

/** Thin fill bar with a text label beside the numbers. The track is decorative (aria-hidden): the value is printed. */
function FillBar({ label, f }) {
  const w = f.bar == null ? 0 : f.bar;
  const lvl = f.level === 'full' ? 'hot' : f.level === 'warn' ? 'warn' : '';
  return (
    <span className="dk-bv-bar">
      <span className="dk-bv-bl">{label}</span>
      <span className={'dk-meter' + (lvl ? ' is-' + lvl : '')} aria-hidden="true"><i style={{ transform: `scaleX(${w / 100})` }} /></span>
      <span className="dk-bv-bv">{f.label}</span>
    </span>
  );
}

/** One of the three blocks (Soul, Memory, User profile): size line, optional fill bar, full redacted text. */
/** `control` (Edit / reason, sheet only) sits under the title; `editor` replaces the text while a block is edited. */
export function BrainBlock({ title, f, bar, id, control, editor }) {
  const meta = f.exists ? [`${fmtInt(f.chars)} chars`, f.updated].filter(Boolean).join(' · ') : 'no file';
  return (
    <section className="dk-bv-blk" aria-labelledby={id}>
      <h4 id={id} className="dk-bv-blk-h">{title}</h4>
      {control || null}
      <p className="dk-bv-meta">{meta}</p>
      {bar && <FillBar label={title === 'User profile' ? 'User' : 'Memory'} f={f} />}
      {!editor && !f.exists && <p className="dk-note">No file yet.</p>}
      {!editor && f.exists && f.error && <p className="dk-note">This file could not be read.</p>}
      {editor ? editor : (f.exists && !f.error && <pre className="dk-bv-text" tabIndex={0} aria-label={title + ' text'}>{f.text || '(empty)'}</pre>)}
      {!editor && f.exists && f.truncated && <p className="dk-note">Shortened: only the first part of this file is shown.</p>}
    </section>
  );
}

/** The three blocks for one agent row (used by both the overview row and the sheet). */
function BrainBlocks({ r, idp }) {
  return (
    <>
      <BrainBlock title="Soul" f={r.soul} id={idp + '-soul'} />
      <BrainBlock title="Memory" f={r.memory} bar id={idp + '-memory'} />
      <BrainBlock title="User profile" f={r.user} bar id={idp + '-user'} />
    </>
  );
}

/** Hook: one GET of the brain route per call of `load`, aborted on unmount or the next load. */
function useBrainLoad(url) {
  const [st, setSt] = useState({ status: 'idle', data: null, error: '' });
  const ctrl = useRef(null);
  const load = () => {
    if (ctrl.current) ctrl.current.abort();
    const c = new AbortController();
    ctrl.current = c;
    setSt(s => ({ status: 'loading', data: s.data, error: '' }));
    fetchJSON(url, { signal: c.signal })
      .then(d => { if (!c.signal.aborted) setSt({ status: 'ok', data: d, error: '' }); })
      .catch(e => { if (!c.signal.aborted) setSt(s => ({ status: 'error', data: s.data, error: String((e && e.message) || e || 'error') })); });
  };
  useEffect(() => () => { if (ctrl.current) ctrl.current.abort(); }, []);
  return [st, load];
}

/**
 * Overview at the top of the Memory pane: one row per agent. Fetches when the pane becomes visible (`hidden`
 * false) and on Refresh. A hidden phone pane fetches nothing.
 */
export function BrainOverview({ hidden, agents }) {
  const [st, load] = useBrainLoad(BRAIN_API);
  const [open, setOpen] = useState(() => new Set());
  const wasHidden = useRef(true);
  useEffect(() => {
    if (!hidden && wasHidden.current) load();   // fetch on open, not on every render
    wasHidden.current = !!hidden;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hidden]);

  const now = nowSec();
  const rows = st.data ? brainAgents(st.data, now) : [];
  const byId = Object.fromEntries((Array.isArray(agents) ? agents : []).filter(a => a && a.id).map(a => [a.id, a]));
  const toggle = id => setOpen(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <section className="dk-bv" aria-labelledby="dk-bv-h">
      <div className="dk-bv-hd">
        <h3 id="dk-bv-h" className="dk-bv-h">Brains</h3>
        <button type="button" className="dk-bv-refresh" onClick={load} disabled={st.status === 'loading'}>
          {st.status === 'loading' ? 'Loading…' : 'Refresh'}
        </button>
      </div>
      {st.status === 'error' && <div className="dk-err" role="alert">Can't read the brains ({st.error}). <button type="button" className="dk-bv-refresh" onClick={load}>Retry</button></div>}
      {st.status === 'loading' && !st.data && <p className="dk-mem-hint-t" role="status" aria-busy="true">Loading brains…</p>}
      {st.data && rows.length === 0 && <p className="dk-note">No agents to show.</p>}
      {rows.length > 0 && (
        <ul className="dk-bv-list" aria-label="Agent brains">
          {rows.map(r => {
            const isOpen = open.has(r.id);
            const idp = 'dk-bv-' + r.id;
            const color = byId[r.id] && byId[r.id].color;
            return (
              <li key={r.id} className="dk-bv-row" style={{ '--dk-c': color || 'var(--text-3)' }}>
                <button type="button" className={'dk-bv-btn' + (isOpen ? ' is-open' : '')} aria-expanded={isOpen}
                  aria-controls={idp} onClick={() => toggle(r.id)}>
                  <span className="dk-bv-head">
                    <i className="dk-bv-dot" aria-hidden="true" />
                    <b className="dk-bv-name">{r.name}</b>
                    <span className="dk-bv-soul">{soulLine(r.soul)}</span>
                    <span className="dk-bv-chev" aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
                  </span>
                  <FillBar label="Memory" f={r.memory} />
                  <FillBar label="User" f={r.user} />
                  <span className="dk-bv-first">{r.memory.first || 'no memory yet'}</span>
                </button>
                <div id={idp} className="dk-bv-body" hidden={!isOpen}>
                  {isOpen && <BrainBlocks r={r} idp={idp} />}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}


