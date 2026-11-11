// Office view on the Agents tab (#agents/office): one desk per agent, drawn from office-model.js.
// Layout and status come from the pure model (sceneModel -> statusOf), so this file only places sprites.
// Images render only while this view is mounted, so the art loads on first open (never from index.js).
import { React, useEffect, useRef } from './sdk.js';
import { sceneModel, SPRITES, OFFICE_BASE } from './office-model.js';

// Sizes are % of the room height (the room is 2:1, so 1% of height = 0.5% of width).
const CHAR_H = 28;                 // character height
const DESK_H = 30;                 // desk height; desk bottom sits 2% below the feet
const DESK_W = (DESK_H / 2) * (145 / 182);   // desk width as % of room width (desk.webp is 145x182)
const DESK_DX = -3;                // desk centre sits left of the character so the monitors stay visible
const CHAR_DX = 2;                 // character centre, % of room width, right of the desk centre
const HIT_PX = 44;                 // minimum tap target (phone)

const src = file => OFFICE_BASE + '/' + file;
const pct = v => `${+v.toFixed(2)}%`;

/** Character width as % of room width for a sprite (height CHAR_H% of room height). */
function charWidthPct(file) {
  const s = SPRITES[file] || SPRITES['char-employee.webp'];
  return (CHAR_H / 2) * (s.width / s.height);
}

export function OfficeScene({ agents, onPick }) {
  const roomRef = useRef(null);
  // Pause the idle bob and the waiting pulse while the tab is hidden: a class toggle, no timers, no rAF.
  useEffect(() => {
    const room = roomRef.current;
    if (!room) return undefined;
    const sync = () => room.classList.toggle('dk-off-paused', document.hidden);
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => document.removeEventListener('visibilitychange', sync);
  }, []);

  const scene = sceneModel(Array.isArray(agents) ? agents.filter(Boolean) : []);

  return (
    <div className="dk-off-wrap">
      <div ref={roomRef} className="dk-off-room" role="group" aria-label="Office: one desk per agent">
        <span className="dk-off-door" aria-hidden="true" />
        <img className="dk-off-prop" src={src('whiteboard.webp')} alt="" loading="lazy" decoding="async"
          style={{ left: '1%', top: '3%', height: '30%' }} />
        <img className="dk-off-prop" src={src('plant.webp')} alt="" loading="lazy" decoding="async"
          style={{ left: '88%', top: '2%', height: '34%' }} />
        <img className="dk-off-prop" src={src('coffee-off.webp')} alt="" loading="lazy" decoding="async"
          style={{ left: '87%', top: '64%', height: '32%' }} />

        {scene.map(s => {
          const cx = s.x + CHAR_DX;
          const deskX = s.x + DESK_DX;
          const deskTop = s.y - (DESK_H - 2);
          const cw = charWidthPct(s.sprite);
          // Monitor box on desk.webp: x 0.07..0.71, y 0.01..0.43 of the sprite.
          const scrL = deskX - DESK_W / 2 + 0.07 * DESK_W;
          const scrW = 0.64 * DESK_W;
          const scrT = deskTop + 0.01 * DESK_H;
          const scrH = 0.42 * DESK_H;
          return (
            <div key={s.id} className="dk-off-agent" style={{ '--off-c': s.color, '--off-rgb': s.rgb }}>
              <img className={'dk-off-desk' + (s.present ? '' : ' is-off')} src={src('desk.webp')} alt=""
                loading="lazy" decoding="async"
                style={{ left: pct(deskX), top: pct(deskTop), height: pct(DESK_H), translate: '-50% 0' }} />
              {s.present && (
                <span className={'dk-off-screen is-' + s.screen} aria-hidden="true"
                  style={{ left: pct(scrL), top: pct(scrT), width: pct(scrW), height: pct(scrH) }} />
              )}
              <span className="dk-off-glow" aria-hidden="true"
                style={{ left: pct(cx), top: pct(s.y), width: pct(cw * 1.1), height: '10%', opacity: s.glow }} />
              {s.present && (
                <img className={'dk-off-char is-' + s.status} src={src(s.sprite)} alt="" loading="lazy" decoding="async"
                  style={{ left: pct(cx), top: pct(s.y - CHAR_H), height: pct(CHAR_H), translate: '-50% 0' }} />
              )}
              {s.ring && (
                <span className="dk-off-ring" aria-hidden="true"
                  style={{ left: pct(cx), top: pct(s.y), width: pct(cw * 1.1), height: '7%' }} />
              )}
              {s.bang && (
                <span className="dk-off-bang" aria-hidden="true"
                  style={{ left: pct(cx), top: `calc(${pct(s.y - CHAR_H)} - 2px)` }}>!</span>
              )}
              <span className={'dk-off-tag' + (s.present ? '' : ' is-off') + (s.present && s.status === 'error' ? ' is-error' : '')}
                aria-hidden="true" style={{ left: pct(cx), top: `calc(${pct(s.y)} + 3px)` }}>
                <span className="dk-off-tag-dot" />
                <span className="dk-off-tag-t">{s.tag}</span>
                {s.present && s.status === 'error' && <span className="dk-off-errdot" />}
              </span>
              <button type="button" className="dk-off-hit" aria-label={s.label} data-agent-id={s.id}
                style={{ left: pct(cx), top: pct(s.y - CHAR_H / 2) }} onClick={() => onPick && onPick(s.id)} />
            </div>
          );
        })}
      </div>
      <div className="dk-off-legend">
        <p>Lit screen = running · gold ! = needs you</p>
        <p>Red screen = error · empty desk = no data</p>
      </div>
    </div>
  );
}
