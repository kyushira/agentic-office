import { React } from './sdk.js';
import { usageRingModel, clipReason } from './usage-model.js';
import { resetCountdown } from './format.js';

const { useState } = React;

// Ring (conic, --p drives the arc) or Bar (8px track, no glow). Claude copper; DeepSeek cyan, but its ring is n/a.
const PROVIDER_RGB = { claude: 'var(--c-claude-rgb)', deepseek: 'var(--c-deepseek-rgb)' };

/** Plan usage rings, one per window, with a Ring | Bar segmented toggle. Source: the /usage payload only. */
export function UsageRings({ usage, now }) {
  const [mode, setMode] = useState('ring');
  const m = usageRingModel(usage);
  return (
    <div className="dk-usage-rings" role="group" aria-label="Plan usage">
      <div className="dk-urings-head">
        <h2 className="dk-urings-h">Usage</h2>
        <div className="dk-seg dk-urings-seg" role="radiogroup" aria-label="Usage display">
          {['ring', 'bar'].map(k => (
            <button key={k} type="button" role="radio" aria-checked={mode === k}
              className={'dk-seg-btn' + (mode === k ? ' is-on' : '')} onClick={() => setMode(k)}>
              {k === 'ring' ? 'Ring' : 'Bar'}
            </button>))}
        </div>
      </div>
      <ul className={'dk-urings is-' + mode}>
        {m.rings.map(r => {
          const left = r.resetsAt ? resetCountdown(r.resetsAt, now) : null;
          const rgb = PROVIDER_RGB[r.provider] || 'var(--c-local-rgb)';
          const aria = `${r.name}: ${r.label}${r.estimated ? ', estimated' : ''}${r.demo ? ', demo, no data source' : ''}`;
          // No value: em dash in the centre, no glow, and a static dashed track (CSS .is-empty).
          const empty = r.pct == null;
          const centre = empty ? '—' : r.label;
          return (
            <li key={r.id} className={'dk-uring-li' + (r.demo ? ' is-demo' : '') + (empty ? ' is-empty' : '')}
              data-provider={r.provider}>
              {mode === 'ring' ? (
                <div className="dk-uring-wrap" style={{ '--c-rgb': rgb }} role="img" aria-label={aria}
                  data-provider={r.provider}>
                  <div className="dk-uring" style={{ '--p': empty ? 0 : r.pct }}>
                    <span className="dk-uring-in">{centre}</span>
                  </div>
                </div>
              ) : (
                <div className="dk-ubar-wrap" style={{ '--c-rgb': rgb }} role="img" aria-label={aria}>
                  <div className="dk-ubar" style={{ '--p': empty ? 0 : r.pct }}><i /></div>
                  <span className="dk-ubar-v">{centre}</span>
                </div>
              )}
              <span className="dk-uring-name">{r.name}</span>
              <span className="dk-uring-sub">
                {r.demo ? <span className="demo-badge">DEMO</span>
                  : empty ? 'n/a'
                  : left ? `resets in ${left}` : 'reset time not reported'}
              </span>
            </li>);
        })}
      </ul>
      {!m.available
        ? <p className="dk-note dk-uavail" role="status" title={m.reason || undefined}>
            {`Claude usage unavailable: ${clipReason(m.reason)}`}</p>
        : <p className="dk-note dk-uscope">Claude values are estimated (Pro weekly % has no public API). Account-wide, not per agent.</p>}
    </div>);
}
