// Inbox tab: agents that need the user (items from needsYou(state.agents) in deck-model.js).
import { React } from './sdk.js';
import { inboxRow } from './agents-model.js';

const SKELETON = [0, 1, 2];

function Problem({ text, onRetry }) {
  return (
    <div className="dk-ag-state" role="alert">
      <p className="dk-ag-state-t">{text}</p>
      {onRetry && <button type="button" className="dk-ag-retry" onClick={onRetry}>Retry</button>}
    </div>
  );
}

export function InboxTab({ items, loading, error, onRetry, onPick }) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (loading) {
    return (
      <ul className="dk-ib-list" aria-busy="true" aria-label="Loading inbox">
        {SKELETON.map(i => (
          <li key={i} className="dk-ib-row is-skel" aria-hidden="true">
            <span className="dk-ag-bar w60" />
            <span className="dk-ag-bar w30" />
          </li>
        ))}
      </ul>
    );
  }
  if (error && !list.length) return <Problem text="Inbox unavailable." onRetry={onRetry} />;
  if (!list.length) return <p className="dk-ag-state dk-ag-empty" role="status">Nothing needs you.</p>;

  return (
    <section className="dk-ib" aria-label="Inbox">
      {error && <Problem text="Inbox unavailable." onRetry={onRetry} />}
      <ul className="dk-ib-list">
        {list.map(item => {
          const r = inboxRow(item);
          return (
            <li key={r.id} className="dk-ib-row">
              <div className="dk-ib-text">
                <span className="dk-ib-title">{r.label}</span>
                <span className="dk-ib-meta">
                  <span className="dk-ib-agent">{r.name}</span>
                  {r.time && <span className="dk-ib-time">{r.time}</span>}
                </span>
              </div>
              <button type="button" className="dk-ib-open" onClick={() => onPick(r.id)}
                aria-label={`Open ${r.name}: ${r.label}`}>Open</button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
