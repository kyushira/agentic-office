// Home's team strip: one chip per agent under the office scene. Always shows all agents (idle and
// offline included), because the scene only seats the working ones. Pure logic: team-model.js.
import { React } from './sdk.js';
import { Sprite } from './Sprite.jsx';
import { teamStrip } from './team-model.js';
import './team-strip.css';

export function TeamStrip({ agents, onPick }) {
  const team = teamStrip(agents);
  if (!team.length) return null;
  return (
    <ul className="dk-ts" aria-label="Team">
      {team.map(a => (
        <li key={a.id} className="dk-ts-item">
          <button type="button" className={'dk-ts-chip is-' + a.status + (a.dim ? ' is-dim' : '')}
            style={{ '--a': a.color }} aria-label={`${a.name}, ${a.status} — open sheet`} title={a.label}
            onClick={() => onPick(a.id)}>
            <span className="dk-ts-art"><Sprite who={a.id} working={a.status === 'working'} /></span>
            <span className="dk-ts-name">{a.name}</span>
            <span className="dk-ts-st"><i aria-hidden="true" />{a.status}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
