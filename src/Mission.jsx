import { React, useState, useEffect, useRef, fetchJSON } from './sdk.js';
import { statusCounts, agentColor, agentName, chipLabel, shortTime, callParts, thinkLabel, showThoughtsNote, THINK_API } from './mc-model.js';
import { usePoll } from './mission-poll.js';
import { Typed } from './MissionBits.jsx';
import MissionComms from './MissionComms.jsx';

const SUBTABS = [['live', 'Live'], ['comms', 'Comms']];

/**
 * Mission Control view: a counts bar and agent chips (from /state), then the Live transcript or the
 * Comms list. The active sub-panel polls only while mounted; this component mounts only while the
 * Mission view is on screen.
 */
export default function Mission({ state }) {
  const agents = (state && state.agents) || [];
  const [sel, setSel] = useState(null);          // null = All
  const [sub, setSub] = useState('live');
  const key = sel && agents.some(a => a.id === sel) ? sel : null;
  const counts = statusCounts(agents);
  const onTabKey = e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next = sub === 'live' ? 'comms' : 'live';
    setSub(next);
    e.currentTarget.querySelector(`#dk-mc-tab-${next}`).focus();
  };
  return (
    <section className="dk-mc" aria-label="Mission Control">
      <div className="dk-mc-bar">
        {state
          ? ['working', 'waiting', 'idle', 'offline'].map(s => (
            <span key={s} className={'dk-mc-cnt is-' + s}><b>{counts[s]}</b> {s}</span>))
          : <span className="dk-mc-cnt">loading…</span>}
      </div>
      <div className="dk-mc-chips" role="group" aria-label="Filter by agent">
        <button type="button" className={'dk-mc-chip' + (key == null ? ' is-on' : '')} aria-pressed={key == null}
          onClick={() => setSel(null)}>All</button>
        {agents.map(a => (
          <button key={a.id} type="button" className={'dk-mc-chip' + (key === a.id ? ' is-on' : '')}
            style={{ '--dk-c': agentColor(a) }} aria-pressed={key === a.id} onClick={() => setSel(a.id)}
            title={`${a.name}: ${chipLabel(a)}`}>
            <span className="dk-mc-cname">{a.name}</span>
            <span className="dk-mc-pill">{chipLabel(a)}</span>
          </button>
        ))}
      </div>
      <div className="dk-mc-tabs" role="tablist" aria-label="Mission Control panels" onKeyDown={onTabKey}>
        {SUBTABS.map(([id, label]) => (
          <button key={id} type="button" role="tab" id={`dk-mc-tab-${id}`} aria-selected={sub === id}
            aria-controls="dk-mc-panel" tabIndex={sub === id ? 0 : -1}
            className={'dk-mc-tab' + (sub === id ? ' is-on' : '')} onClick={() => setSub(id)}>{label}</button>
        ))}
      </div>
      <div id="dk-mc-panel" role="tabpanel" aria-labelledby={`dk-mc-tab-${sub}`} className="dk-mc-body">
        {sub === 'live'
          ? <Live agentKey={key} agents={agents} />
          : <MissionComms agents={agents} agentKey={key} />}
      </div>
    </section>
  );
}

/** Live transcript for one agent, or all merged. Remounted per agent so its reveal and typing state reset. */
function Live({ agentKey, agents }) {
  const { rows, fresh, thinking, err } = usePoll('feed', agentKey);
  const [open, setOpen] = useState({});          // thinking row id -> revealed
  const [texts, setTexts] = useState({});        // thinking row id -> fetched text (component state only)
  const [thinkErr, setThinkErr] = useState({});
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const byId = Object.fromEntries(agents.map(a => [a.id, a]));
  const multi = !agentKey;
  const name = agentKey ? agentName(agents, agentKey) : 'All agents';

  const toggleThought = row => {
    const id = row.id;
    if (open[id]) { setOpen(o => ({ ...o, [id]: false })); return; }
    setOpen(o => ({ ...o, [id]: true }));
    if (texts[id] != null) return;
    fetchJSON(`${THINK_API}?id=${encodeURIComponent(id)}`)
      .then(d => { if (alive.current) setTexts(t => ({ ...t, [id]: String((d && d.text) || '') })); })
      .catch(e => { if (alive.current) setThinkErr(x => ({ ...x, [id]: String((e && e.message) || e) })); });
  };

  return (
    <>
      {err && <div className="dk-mc-err" role="alert">Feed unavailable: {err}</div>}
      {rows == null && !err && <div className="dk-mc-note" role="status">loading…</div>}
      {rows != null && !rows.length && <div className="dk-mc-note" role="status">No transcript rows yet{agentKey ? ` for ${name}` : ''}.</div>}
      {rows != null && agentKey && showThoughtsNote(thinking, agentKey) && rows.length > 0 &&
        <p className="dk-mc-thoughts">Thoughts = narration + plan</p>}
      {rows != null && rows.length > 0 && (
        <ol className="dk-mc-log" role="log" aria-label={`Transcript, ${name}`}>
          {rows.map(r => {
            const who = multi && byId[r.agent]
              ? <span className="dk-mc-who" style={{ color: agentColor(byId[r.agent]) }}>{byId[r.agent].name}</span> : null;
            const time = <time className="dk-mc-t">{shortTime(r.ts)}</time>;
            if (r.kind === 'thinking') {
              const isOpen = !!open[r.id];
              const body = texts[r.id] != null ? texts[r.id] : thinkErr[r.id] ? `couldn't load (${thinkErr[r.id]})` : 'loading…';
              return (
                <li key={r.id} className="dk-mc-row is-thinking">
                  {time}{who}
                  <button type="button" className="dk-mc-think-btn" aria-expanded={isOpen} onClick={() => toggleThought(r)}>
                    {thinkLabel(r.chars)} — {isOpen ? 'tap to hide' : 'tap to reveal'}
                  </button>
                  {isOpen && <pre className="dk-mc-think">{body}</pre>}
                </li>
              );
            }
            const isCall = r.kind === 'call';
            const c = isCall ? callParts(r) : null;
            const display = isCall ? `▸ ${c.tool}${c.arg ? '  ' + c.arg : ''}` : String(r.text || '');
            return (
              <li key={r.id} className={'dk-mc-row is-' + (isCall ? 'call' : r.kind === 'result' ? 'result' : 'text')}>
                {time}{who}
                <span className="dk-mc-txt"><Typed text={display} go={fresh.has(r.id)} /></span>
              </li>
            );
          })}
        </ol>
      )}
    </>
  );
}
