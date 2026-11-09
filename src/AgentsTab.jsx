// Agents tab: filter control and one card per agent. Pure logic lives in agents-model.js.
import { React, useState } from './sdk.js';
import { FILTERS, filterAgents, counts, pulseIds, cardView } from './agents-model.js';

const FILTER_LABEL = { all: 'All', running: 'Running', waiting: 'Waiting', error: 'Error' };
const SKELETON = [0, 1, 2, 3, 4, 5];

function SkeletonCards() {
  return (
    <ul className="dk-ag-list" aria-busy="true" aria-label="Loading agents">
      {SKELETON.map(i => (
        <li key={i} className="dk-ag-card is-skel" aria-hidden="true">
          <span className="dk-ag-bar w30" />
          <span className="dk-ag-bar w60" />
          <span className="dk-ag-bar w85" />
        </li>
      ))}
    </ul>
  );
}

/** Message with a Retry button (error states). role=alert so the failure is announced once. */
function Problem({ text, onRetry }) {
  return (
    <div className="dk-ag-state" role="alert">
      <p className="dk-ag-state-t">{text}</p>
      {onRetry && <button type="button" className="dk-ag-retry" onClick={onRetry}>Retry</button>}
    </div>
  );
}

export function AgentsTab({ agents, sessions, now, loading, error, onRetry, onPick }) {
  const [filter, setFilter] = useState('all');
  const list = Array.isArray(agents) ? agents.filter(Boolean) : [];
  if (loading) return <SkeletonCards />;
  if (error && !list.length) return <Problem text="Couldn't load agents." onRetry={onRetry} />;

  const c = counts(list);
  const shown = filterAgents(list, filter);
  const pulse = new Set(pulseIds(shown));

  return (
    <section className="dk-ag" aria-label="Agents">
      <div className="dk-ag-seg" role="group" aria-label="Filter agents">
        {FILTERS.map(f => (
          <button key={f} type="button" className="dk-ag-seg-btn" aria-pressed={filter === f}
            onClick={() => setFilter(f)}>
            {FILTER_LABEL[f]} <span className="dk-ag-n">{c[f]}</span>
          </button>
        ))}
      </div>
      {error && <Problem text="Couldn't refresh agents." onRetry={onRetry} />}
      {shown.length === 0 ? (
        <p className="dk-ag-state dk-ag-empty" role="status">No agents in this state.</p>
      ) : (
        <ul className="dk-ag-list">
          {shown.map(a => {
            const v = cardView(a, (sessions || {})[a.id], now);
            return (
              <li key={v.id}>
                <button type="button" className={'dk-ag-card is-' + v.status} onClick={() => onPick(v.id)}
                  aria-label={`${v.name}, ${v.word}, ${v.task}`}>
                  <span className="dk-ag-top">
                    <span className={'dk-ag-dot' + (pulse.has(v.id) ? ' dk-pulse' : '')} aria-hidden="true" />
                    <span className="dk-ag-word">{v.word}</span>
                    {v.harness && <span className="dk-ag-chip">{v.harness}</span>}
                    <span className="dk-ag-time">{v.time}</span>
                  </span>
                  <span className="dk-ag-name">{v.name}</span>
                  <span className="dk-ag-task">{v.task}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
