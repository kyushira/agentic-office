import { React, useState, useEffect } from './sdk.js';
import { typeStep } from './mc-model.js';
import { reducedMotion } from './mission-poll.js';

/**
 * Types `text` out once, on mount, when `go` is set (a row that arrived in the latest poll). Rows that
 * were already on screen mount with go false and show in full. Reduced motion shows the full text.
 */
export function Typed({ text, go }) {
  const [n, setN] = useState(() => (go && !reducedMotion() ? 0 : text.length));
  const step = typeStep(text.length);
  useEffect(() => {
    if (n >= text.length) return undefined;
    const t = setTimeout(() => setN(x => Math.min(text.length, x + step)), 16);
    return () => clearTimeout(t);
  }, [n, text, step]);
  const typing = n < text.length;
  return <>{text.slice(0, n)}{typing && <span className="dk-mc-caret" aria-hidden="true">▍</span>}</>;
}

/**
 * Flow line between two agent chips. It draws once, when mounted for a new comms row (go); rows
 * already on screen are drawn static. Reduced motion never animates (CSS and JS both guard it).
 */
export function FlowLine({ go }) {
  const [anim] = useState(() => !!go && !reducedMotion());
  return (
    <svg className={'dk-mc-flow' + (anim ? ' is-anim' : '')} viewBox="0 0 48 10" aria-hidden="true" focusable="false">
      <line x1="1" y1="5" x2="41" y2="5" pathLength="100" />
      <polyline points="37,1.5 42,5 37,8.5" fill="none" />
    </svg>
  );
}
