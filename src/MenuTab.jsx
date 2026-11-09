import { React } from './sdk.js';
import { ServerCard } from './ServerCard.jsx';
import { UsageRings } from './UsageRings.jsx';

/**
 * Menu tab: server card, plan usage rings, settings. Mounted only while Menu is the active tab, so the
 * server card fetches once per open (its own Refresh is the only other fetch). Flow and Connectors are not here yet.
 */
export default function MenuTab({ usage, now, full, standalone, lite, onEnterFull, onExitFull, onToggleLite }) {
  return (
    <div className="dk-menu">
      <ServerCard />
      <section id="dk-usage-rings" className="dk-uplan" aria-label="Plan usage">
        <UsageRings usage={usage} now={now} />
      </section>
      <section className="dk-menu-set" aria-labelledby="dk-menu-settings-h">
        <h2 id="dk-menu-settings-h" className="dk-menu-h">Settings</h2>
        <div className="dk-menu-row">
          {!full && <button type="button" className="dk-btn dk-menu-btn" onClick={onEnterFull} aria-label="Open fullscreen deck">Fullscreen</button>}
          {full && !standalone && <button type="button" className="dk-btn dk-menu-btn ao-fs-exit" onClick={onExitFull} aria-label="Exit fullscreen deck">Exit fullscreen</button>}
          <button type="button" className={'dk-btn dk-menu-btn' + (lite ? ' on' : '')} aria-pressed={lite} onClick={onToggleLite}
            title="Low-power: no animation, refresh every 15s">Lite</button>
        </div>
      </section>
    </div>
  );
}
