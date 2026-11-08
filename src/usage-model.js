// Pure helpers for the usage rings (design 3.5). Feeds from GET /api/plugins/agent-office/usage only.
// The backend reports Claude plan windows (five_hour, seven_day). Nothing reports DeepSeek usage, so its ring is
// n/a with a DEMO badge. Claude percentages are estimated: Pro weekly % has no public API.

/** Clamp a percentage to 0..100. Anything missing or not a number is null (never a made-up 0). */
export function clampPct(v) {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n));
}

/** Label for a ring or bar: "42% est." for estimated Claude values, "42%" for exact, "n/a" when unknown. */
export function pctLabel(pct, estimated = false) {
  const p = clampPct(pct);
  if (p == null) return 'n/a';
  return `${Math.round(p)}%${estimated ? ' est.' : ''}`;
}

/**
 * The ring list for the usage panel. Each entry: {id, name, pct, label, estimated, demo, resetsAt, provider}.
 * `demo` marks a placeholder with no real data source. `available` false means the Claude source is down; `reason`
 * is the backend's own text.
 */
export function usageRingModel(usage) {
  const live = !!(usage && usage.available);
  const reason = (usage && usage.reason) || null;
  const claude = (key, name) => {
    const w = (live && usage && usage[key]) || {};
    const pct = live ? clampPct(w.pct) : null;
    return { id: key, name, provider: 'claude', pct, label: pctLabel(pct, true), estimated: true, demo: false,
      resetsAt: pct == null ? null : (w.resets_at || null) };
  };
  const rings = [claude('five_hour', 'Session 5h'), claude('seven_day', 'Week 7d'),
    { id: 'deepseek', name: 'DeepSeek', provider: 'deepseek', pct: null, label: 'n/a', estimated: false, demo: true,
      resetsAt: null }];
  return { available: live, reason, rings };
}
