import { React } from './sdk.js';
import { ashView, ASH_ID } from './tabs-model.js';
import { Sprite } from './Sprite.jsx';
import './team-strip.css';

/**
 * Ash card on Home (Chief of Staff, agent id 'default'). Read-only: tapping it opens Ash's agent sheet.
 * There is no chat input here, and no chat request is made (Ash chat is off; the spec hides the panel).
 */
export function AshCard({ agents, sessions, error, loaded, onOpen }) {
  const v = ashView({ agents, sessions, error: !!error, loaded: !!loaded });
  return (
    <button type="button" className={'dk-ash is-' + v.state} onClick={onOpen}>
      <span className="dk-ash-hd">
        <span className="dk-ash-who">
          <span className="dk-bust" aria-hidden="true"><Sprite who={ASH_ID} /></span>
          <span className="dk-ash-name">Ash</span>
        </span>
        <span className="dk-ash-st"><i aria-hidden="true" />{v.word}</span>
      </span>
      <span className="dk-ash-line">{v.line}</span>
    </button>
  );
}
