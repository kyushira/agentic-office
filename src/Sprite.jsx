import { React } from './sdk.js';
import { portrait } from './portrait.js';

/** Pixel-art bust: base pixels + an eyes layer that blinks; a small bob while working. Shared by the tiles, roster and sheets. */
export function Sprite({ who, working, small, done }) {
  const p = portrait(who);
  const px = list => list.map(([x, y, c]) => <rect key={x + '-' + y} x={x} y={y} width="1" height="1" fill={c} />);
  return (
    <svg className={'dk-sprite' + (working ? ' is-work' : '') + (small ? ' is-small' : '') + (done ? ' is-done' : '')}
      viewBox={`0 0 ${p.size} ${p.size}`} shapeRendering="crispEdges" aria-hidden="true">
      {p.base.map(([x, y, w, c]) => <rect key={x + '-' + y} x={x} y={y} width={w} height="1" fill={c} />)}
      <g className="dk-eyes-open">{px(p.open)}</g>
      <g className="dk-eyes-shut">{px(p.closed)}</g>
    </svg>
  );
}
