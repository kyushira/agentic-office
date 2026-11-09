import { React, fetchJSON, SERVER_API } from './sdk.js';
import { view, validServer } from './server-model.js';

const { useState, useEffect, useRef, useCallback } = React;

// Ring geometry: 96px box, 8px stroke, so r = (96 - 8) / 2.
const R = 44;
const C = 2 * Math.PI * R;

/** RAM ring: an arc for used_pct on a track. Loading shows a dashed ring with no arc. */
function RamRing({ ram, loading }) {
  const cls = 'dk-sc-ring' + (ram && ram.pulse ? ' dk-pulse' : '') + (ram ? ' is-' + ram.level : '') + (loading ? ' is-loading' : '');
  const aria = ram ? ram.aria : loading ? 'RAM: reading server' : 'RAM: unavailable';
  const arc = ram && ram.pct != null ? C * ram.pct / 100 : 0;
  return (
    <div className={cls} role="img" aria-label={aria}>
      <svg className="dk-sc-svg" viewBox="0 0 96 96" width="96" height="96" aria-hidden="true" focusable="false">
        <circle className="dk-sc-track" cx="48" cy="48" r={R} fill="none" strokeWidth="8" />
        {ram && ram.pct != null && (
          <circle className="dk-sc-arc" cx="48" cy="48" r={R} fill="none" strokeWidth="8"
            strokeDasharray={`${arc} ${C}`} transform="rotate(-90 48 48)" strokeLinecap="butt" />)}
      </svg>
      <span className="dk-sc-centre">{ram ? ram.centre : '—'}</span>
    </div>);
}

/** Server card (Agent Deck): RAM ring, disk, load, top memory. Fetches on mount and on Refresh only. */
export function ServerCard() {
  const [data, setData] = useState(null);
  const [lastGood, setLastGood] = useState(null);
  const [error, setError] = useState(false);
  const [pending, setPending] = useState(true);
  const alive = useRef(true);

  const load = useCallback(() => {
    setPending(true);
    fetchJSON(SERVER_API).then(p => {
      if (!alive.current) return;
      if (validServer(p)) { setData(p); setLastGood(p); setError(false); }
      else { setData(null); setError(true); }   // a payload the card cannot draw is an error, not an empty ok
    }, () => {
      if (!alive.current) return;
      setData(null); setError(true);
    }).finally(() => { if (alive.current) setPending(false); });
  }, []);

  useEffect(() => {
    alive.current = true;
    load();
    return () => { alive.current = false; };
  }, [load]);

  const v = view({ data, lastGood, error, pending });
  const ok = v.mode === 'ok';
  const loading = v.mode === 'loading';
  const disk = v.disk;
  const dimCls = v.stale ? ' is-stale' : '';

  return (
    <section className="dk-sc" aria-labelledby="dk-sc-h" aria-busy={pending}>
      <header className="dk-sc-head">
        <h2 id="dk-sc-h" className="dk-sc-h">Server</h2>
        <span className="dk-sc-meta">Updated <span className="dk-sc-mono">{v.updated}</span></span>
        <button type="button" className="dk-btn dk-sc-refresh" onClick={load} disabled={v.refreshDisabled}
          aria-label="Refresh server stats">Refresh</button>
      </header>

      <div className={'dk-sc-body' + dimCls}>
        <div className="dk-sc-ram">
          <RamRing ram={v.ram} loading={loading} />
          {v.ram ? (
            <div className="dk-sc-ram-txt">
              <span className={'dk-sc-level is-' + v.ram.level}>{v.ram.word}</span>
              <span className="dk-sc-free">{v.ram.free}</span>
            </div>) : (
            <div className="dk-sc-ram-txt"><span className="dk-sc-level">{loading ? 'Reading server…' : '—'}</span></div>)}
        </div>

        <div className="dk-sc-row dk-sc-disk">
          <span className="dk-sc-k">{disk && disk.label ? disk.label : 'Disk /'}</span>
          {disk && !disk.demo ? (
            <>
              <span className={'dk-meter' + (disk.warn ? ' is-warn' : '')} aria-hidden="true">
                <i style={{ transform: `scaleX(${disk.fillPct / 100})` }} />
              </span>
              <span className="dk-sc-v dk-sc-mono">{disk.free}</span>
            </>) : (
            <>
              <span className="dk-meter" aria-hidden="true" />
              <span className="dk-sc-v dk-sc-mono">—</span>
              {disk && disk.demo && <span className="is-demo">DEMO</span>}
            </>)}
        </div>

        <div className="dk-sc-row dk-sc-load">
          <span className="dk-sc-v dk-sc-mono">{v.load ? v.load.text : '—'}</span>
          {v.load && v.load.demo && <span className="is-demo">DEMO</span>}
        </div>

        <div className="dk-sc-top">
          <h3 className="dk-sc-th">Top memory</h3>
          {v.top && v.top.rows.length > 0 ? (
            <ol className="dk-sc-rows">
              {v.top.rows.map((r, i) => (
                <li key={i} className="dk-sc-row dk-sc-trow">
                  <span className="dk-sc-name">{r.name}</span>
                  <span className="dk-sc-v dk-sc-mono">{r.mbText}</span>
                </li>))}
            </ol>) : (
            <div className="dk-sc-row dk-sc-trow">
              <span className="dk-sc-v dk-sc-mono">—</span>
              {v.top && v.top.demo && <span className="is-demo">DEMO</span>}
            </div>)}
        </div>
      </div>

      {v.mode === 'loading' && <p className="dk-sc-note" role="status">Reading server…</p>}
      {v.mode === 'error' && (
        <p className="dk-sc-note dk-sc-err" role="status">
          Couldn't read server stats.
          {v.stale && <> <span className="dk-sc-mono">Last good {v.lastGood}</span></>}
        </p>)}
    </section>);
}
