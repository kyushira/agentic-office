// Pure helpers for the usage rings (design 3.5). Feeds from GET /api/plugins/agent-office/usage only.
// Plan windows (five_hour, seven_day) come from the Claude login when it is readable. When a plan % is missing, the
// ring falls back to token totals from Hermes state.db (usage.tokens): a ratio against the user's own history, not a
// plan limit. Claude percentages are estimated: Pro weekly % has no public API.

/** Clamp a percentage to 0..100. Anything missing or not a number is null (never a made-up 0). */
export function clampPct(v) {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n));
}

/** The backend's unavailable reason, shown in full (the backend already caps it at 200 characters). Blank gives the fallback. */
export function reasonText(reason) {
  return String(reason || '').trim() || 'the source did not say why';
}

/** Label for a ring or bar: \"42% est.\" for estimated Claude values, \"42%\" for exact, \"n/a\" when unknown. */
export function pctLabel(pct, estimated = false) {
  const p = clampPct(pct);
  if (p == null) return 'n/a';
  return `${Math.round(p)}%${estimated ? ' est.' : ''}`;
}

/** Token count as a short string: 490k, 5.1M. Missing, NaN or zero gives '0'. */
export function compactTokens(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '0';
  if (v >= 999500) {
    const m = v / 1e6;
    return (m >= 10 ? Math.round(m) : Math.round(m * 10) / 10) + 'M';
  }
  if (v >= 1000) return Math.round(v / 1000) + 'k';
  return String(Math.round(v));
}

/** A token count from the payload: a non-negative number, anything else counts as 0. */
function tokenNum(v) {
  if (v == null || v === '' || typeof v === 'boolean') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}

/**
 * Estimate figures for one provider from its usage.tokens entry ({five_hour, seven_day, prev_seven_day}).
 * fill: 0..100 for the ring arc, or null when the window has no data at all (the ring shows n/a).
 * - 5h: five_hour against an average 5-hour window of the last 7 days (seven_day * 5 / 168). Can exceed 100 in the
 *   caption ('140% of 7d avg'); the arc is capped.
 * - 7d: seven_day against the week before (prev_seven_day). No prior week: full arc when there is use now.
 * Returns null when `p` is not an object.
 */
export function tokenFigures(p) {
  if (!p || typeof p !== 'object') return null;
  const five = tokenNum(p.five_hour);
  const week = tokenNum(p.seven_day);
  const prev = tokenNum(p.prev_seven_day);
  const avg = week * 5 / 168;
  let fiveHour;
  if (five === 0 && week === 0) fiveHour = { fill: null, caption: 'no data yet' };
  else if (avg > 0) {
    const r = five / avg;
    fiveHour = { fill: Math.min(100, r * 100), caption: `${Math.round(r * 100)}% of 7d avg, est.` };
  } else fiveHour = { fill: 100, caption: 'no 7d average yet, est.' };
  let sevenDay;
  if (week === 0 && prev === 0) sevenDay = { fill: null, caption: 'no data yet' };
  else if (prev > 0) {
    const r = week / prev;
    sevenDay = { fill: Math.min(100, r * 100), caption: `${Math.round(r * 100)}% vs last wk, est.` };
  } else sevenDay = { fill: 100, caption: 'new vs last wk, est.' };
  return {
    fiveHour: { ...fiveHour, centre: compactTokens(five) },
    sevenDay: { ...sevenDay, centre: compactTokens(week) },
  };
}

/**
 * The ring list for the usage panel. Each entry: {id, name, provider, pct, label, centre, unit, sub, estimated,
 * demo, resetsAt, source}. `pct` is the arc (0..100) or null. `label` is the full reading ('61% est.', '490k tok est.',
 * 'n/a'); `centre` and `unit` are the two lines drawn in the ring. source: 'plan' | 'tokens' | 'none'.
 * `demo` marks a placeholder with no data source (DeepSeek when usage.tokens has no deepseek entry).
 * `available` false means the Claude plan source is down; `reason` is the backend's own text.
 */
export function usageRingModel(usage) {
  const live = !!(usage && usage.available);
  const reason = (usage && usage.reason) || null;
  const tokens = usage && usage.tokens && typeof usage.tokens === 'object' ? usage.tokens : null;
  const figures = tokens ? tokenFigures(tokens.claude) : null;
  const claude = (key, name, figKey) => {
    const w = (live && usage && usage[key]) || {};
    const pct = live ? clampPct(w.pct) : null;
    if (pct != null) {
      return { id: key, name, provider: 'claude', pct, label: pctLabel(pct, true), centre: pctLabel(pct, true),
        unit: null, sub: null, estimated: true, demo: false, resetsAt: w.resets_at || null, source: 'plan' };
    }
    const f = figures && figures[figKey];
    if (f && f.fill != null) {
      return { id: key, name, provider: 'claude', pct: f.fill, label: `${f.centre} tok est.`, centre: f.centre,
        unit: 'tok est.', sub: f.caption, estimated: true, demo: false, resetsAt: null, source: 'tokens' };
    }
    return { id: key, name, provider: 'claude', pct: null, label: 'n/a', centre: 'n/a', unit: null, sub: 'no data yet',
      estimated: false, demo: false, resetsAt: null, source: 'none' };
  };
  const ds = tokens ? tokenFigures(tokens.deepseek) : null;
  const dsWeek = ds && ds.sevenDay.fill != null ? ds.sevenDay : null;
  const deepseek = dsWeek
    ? { id: 'deepseek', name: 'DeepSeek', provider: 'deepseek', pct: dsWeek.fill, label: `${dsWeek.centre} tok est.`,
      centre: dsWeek.centre, unit: 'tok est.', sub: dsWeek.caption, estimated: true, demo: false, resetsAt: null,
      source: 'tokens' }
    : { id: 'deepseek', name: 'DeepSeek', provider: 'deepseek', pct: null, label: 'n/a', centre: 'n/a', unit: null,
      sub: 'no data yet', estimated: false, demo: !(tokens && tokens.deepseek), resetsAt: null, source: 'none' };
  const rings = [claude('five_hour', 'Session 5h', 'fiveHour'), claude('seven_day', 'Week 7d', 'sevenDay'), deepseek];
  // Motion budget: only the FIRST n/a ring breathes (opacity loop); the other n/a rings stay static and faint.
  const firstNa = rings.find(r => r.source === 'none');
  for (const r of rings) r.breathe = r === firstNa;
  return { available: live, reason, rings, breathing: !!firstNa };
}

/** True when a usage ring is breathing on screen (uses one of the three animation slots). */
export function ringsBreathe(usage) {
  return usageRingModel(usage).breathing;
}
