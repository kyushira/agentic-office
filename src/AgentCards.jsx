import { React } from './sdk.js';
import { ago } from './format.js';
import { cardState, cardWord, pulseIds, rosterDuration } from './deck-model.js';

// Glow hue per state (design 3.7): running teal, waiting gold, error red. Idle and offline have no glow.
const STATE_RGB = { running: 'var(--c-live-rgb)', waiting: 'var(--c-gold-rgb)', error: 'var(--c-danger-rgb)' };

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
          const st = cardState(a), word = cardWord(st);
          const running = st === 'running';
          const dur = rosterDuration(a, (sessions || {})[a.id], now);
          const task = String(a.activity || '').trim() || 'no current task';
          const pressed = sel === 'a:' + a.id;
          const rgb = STATE_RGB[st];
          return (
            <li key={a.id} className="dk-acard-li">
              <button type="button" className={'dk-acard is-' + st + (pressed ? ' is-pressed' : '')}
                style={{ '--dk-c': a.color || '#8a8a8a', ...(rgb ? { '--c-rgb': rgb } : {}) }} onClick={() => onPick(a.id)}
                aria-label={`${a.name || a.id}, ${word}, ${task}${dur ? `, ${dur}` : ''}. Open panel`}>
                <span className="dk-acard-a">
                  <i className={'dk-acard-dot' + (pulse.has(a.id) ? ' is-pulse' : '')} aria-hidden="true" />
                  <span className="dk-acard-name">{a.name || a.id}</span>
                  {a.model && <span className="dk-acard-chip" title={a.modelId || a.model}>{a.model}</span>}
                </span>
                <span className="dk-acard-task">{task}</span>
                <span className="dk-acard-c">
                  <span className="dk-acard-state">{word}</span>
                  <span aria-hidden="true">·</span>
                  <time>{ago(a.lastActive, now)}</time>
                  {dur && <span className="dk-acard-dur">· {dur}</span>}
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
