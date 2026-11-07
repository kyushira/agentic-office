import { React, useState, useEffect, useRef, fetchJSON } from './sdk.js';
import { agentColor, agentName, shortTime, callParts, thinkLabel, showThoughtsNote, THINK_API } from './mc-model.js';
import { usePoll } from './mission-poll.js';
import { cleanToolResult } from './format.js';
import { liveFeedMs } from './deck-model.js';
import { Typed } from './MissionBits.jsx';

/** Live transcript for one agent, or all merged. Remounted per agent so its reveal and typing state reset. */
export function Live({ agentKey, agents, lite = false }) {
  const { rows, fresh, thinking, err } = usePoll('feed', agentKey, liveFeedMs(lite));
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
        <ol className="dk-mc-log" role="log" aria-live="off" aria-label={`Transcript, ${name}`}>
          {rows.map(r => {
            const who = multi && byId[r.agent]
              ? <span className="dk-mc-who" style={{ color: agentColor(byId[r.agent]) }}>{byId[r.agent].name}</span>
              : null;
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
            const display = isCall ? `▸ ${c.tool}${c.arg ? '  ' + c.arg : ''}` : cleanToolResult(r.text);
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
