// Usage tab (placeholder for batch 1): plan usage rings only. The full tab (windows, per-agent bars, trend) comes next.
import { React } from './sdk.js';
import { UsageRings } from './UsageRings.jsx';

export default function UsageTab({ usage, now }) {
  return (
    <div className="dk-usage-tab">
      <section id="dk-usage-rings" className="dk-uplan" aria-label="Plan usage">
        <UsageRings usage={usage} now={now} />
      </section>
    </div>
  );
}
