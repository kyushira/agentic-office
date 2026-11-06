import { React, useState } from './sdk.js';
import { ago } from './format.js';
import { agentColor, agentName, commsFor } from './mc-model.js';
import { usePoll } from './mission-poll.js';
import { FlowLine } from './MissionBits.jsx';

/** Agent-to-agent messages and delegations, filtered by the selected agent (sender or receiver). */
export default function MissionComms({ agents, agentKey }) {
  const { rows, fresh, err } = usePoll('comms', '');
  const [open, setOpen] = useState({});          // comms row id -> expanded
  const byId = Object.fromEntries(agents.map(a => [a.id, a]));
  const now = Date.now() / 1000;
  const list = rows == null ? null : commsFor(rows, agentKey);
  const who = agentKey ? agentName(agents, agentKey) : '';
  return (
    <>
      {err && <div className="dk-mc-err" role="alert">Feed unavailable: {err}</div>}
      {list == null && !err && <div className="dk-mc-note" role="status">loading…</div>}
      {list != null && !list.length && (
        <div className="dk-mc-note" role="status">No agent-to-agent messages yet{who ? ` for ${who}` : ''}.</div>
      )}
      {list != null && list.length > 0 && (
        <ul className="dk-mc-comms" aria-label="Agent-to-agent messages">
          {list.map(r => {
            const isOpen = !!open[r.id];
            const from = agentName(agents, r.from), to = agentName(agents, r.to);
            return (
              <li key={r.id} className={'dk-mc-bubble is-' + r.kind}>
                <button type="button" className="dk-mc-bubble-btn" aria-expanded={isOpen}
                  onClick={() => setOpen(o => ({ ...o, [r.id]: !o[r.id] }))}>
                  <span className="dk-mc-route">
                    <span className="dk-mc-end" style={{ '--dk-c': agentColor(byId[r.from]) }}>{from}</span>
                    <FlowLine go={fresh.has(r.id)} />
                    <span className="dk-mc-end" style={{ '--dk-c': agentColor(byId[r.to]) }}>{to}</span>
                  </span>
                  <span className="dk-mc-meta">
                    <span className={'dk-mc-kind is-' + r.kind}>{r.kind}</span>
                    <time className="dk-mc-ago" dateTime={r.ts ? new Date(r.ts * 1000).toISOString() : undefined}>{ago(r.ts, now)}</time>
                    <span className="dk-mc-expand" aria-hidden="true">{isOpen ? 'hide' : 'open'}</span>
                  </span>
                  {!isOpen && <span className="dk-mc-prev">{r.preview}</span>}
                </button>
                {isOpen && <pre className="dk-mc-full">{r.body}</pre>}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
