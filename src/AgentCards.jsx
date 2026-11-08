import { React } from './sdk.js';
import { cardState, cardMeta, cardRgb, pulseIds, rosterDuration } from './deck-model.js';

/**
 * One status card per agent (design 3.7 and 6). Row A: status dot, name, model chip. Row B: the current task,
 * one line. Row C: state word, last-active time, and a 2px hairline when running. Tapping a card opens the
 * agent sheet. Phone: a vertical list; desktop: two columns (CSS). Only the first three running agents pulse.
 */
export function AgentCards({ agents, sessions, now, sel, onPick }) {
  if (!agents.length) return null;
  const pulse = pulseIds(agents);
  return (
    <section id="dk-roster" className="dk-roster-wrap" aria-label="Agent status">
      <ul className="dk-acards">
        {agents.map(a => {
          const st = cardState(a);
          const running = st === 'running';
          const meta = cardMeta(a, st, rosterDuration(a, (sessions || {})[a.id], now), now);
          const task = String(a.activity || '').trim() || 'no current task';
          const pressed = sel === 'a:' + a.id;
          return (
            <li key={a.id} className="dk-acard-li">
              <button type="button" className={'dk-acard is-' + st + (pressed ? ' is-pressed' : '')}
                style={{ '--dk-c': a.color || '#8a8a8a', '--c-rgb': cardRgb(a, st) }} onClick={() => onPick(a.id)}
                aria-label={`${a.name || a.id}, ${meta.word}, ${task}${meta.dur ? `, ${meta.dur}` : ''}. Open panel`}>
                <span className="dk-acard-a">
                  <i className={'dk-acard-dot' + (pulse.has(a.id) ? ' is-pulse' : '')} aria-hidden="true" />
                  <span className="dk-acard-name">{a.name || a.id}</span>
                  {a.model && <span className="dk-acard-chip" title={a.modelId || a.model}>{a.model}</span>}
                </span>
                <span className="dk-acard-task">{task}</span>
                <span className="dk-acard-c">
                  <span className="dk-acard-state">{meta.word}</span>
                  {meta.time && <><span aria-hidden="true">·</span><time>{meta.time}</time></>}
                  {meta.dur && <><span aria-hidden="true">·</span><span className="dk-acard-dur">{meta.dur}</span></>}
                </span>
                {running && <i className="dk-acard-hair" aria-hidden="true" />}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
