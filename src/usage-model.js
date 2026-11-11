// Pure helpers for the usage rings (design 3.5). Feeds from GET /api/plugins/agent-office/usage only.
// Plan windows (five_hour, seven_day) come from the Claude login when it is readable. When a plan % is missing, the
// ring falls back to token totals from Hermes state.db (usage.tokens): a ratio against the user's own history, not a
// plan limit. Claude percentages are estimated: Pro weekly % has no public API.

import { colourOf, hashedColour } from './office-model.js';

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

// ---- Usage tab (batch 1 / P1): window chips, per-agent bars, daily trend, footer. Source: GET /usage/breakdown. ----
// Pure helpers only (no DOM). Tokens are input + output (the backend's `tokens`); cache and reasoning are shown apart.

/** Plan usage and breakdown refresh while the Usage tab is open and the page is visible. */
export const USAGE_POLL_MS = 60000;
/** The windows the chips offer. The backend clamps 1..30; the chips only ever send these three. */
export const USAGE_DAYS = [1, 7, 30];
export const DEFAULT_DAYS = 7;
const CLAUDE_PROVIDER = 'claude-subscription-directsdk-experimental';
const PROVIDER_LABEL = { [CLAUDE_PROVIDER]: 'Claude', deepseek: 'DeepSeek', unknown: 'Unknown' };
const COST_BADGE = {
  actual: { label: 'actual', cls: 'is-actual' },
  estimated: { label: 'est.', cls: 'is-est' },
  mixed: { label: 'mixed', cls: 'is-mixed' },
};

/** A window in USAGE_DAYS (number or numeric string); anything else is DEFAULT_DAYS. */
export function validDays(d) {
  const n = typeof d === 'string' && d.trim() !== '' ? Number(d) : d;
  return typeof n === 'number' && USAGE_DAYS.includes(n) ? n : DEFAULT_DAYS;
}

/** The window chips: [{id, label: '7d', selected}]. An invalid `selected` selects DEFAULT_DAYS. */
export function windowChips(selected) {
  const on = validDays(selected);
  return USAGE_DAYS.map(id => ({ id, label: `${id}d`, selected: id === on }));
}

/** A count from the payload: a non-negative finite number, anything else is 0. */
function num(v) {
  if (v == null || v === '' || typeof v === 'boolean') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}

/** A cost from the payload: a finite number, or null when there is none (never a made-up 0). */
function costNum(v) {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Agent colour as '#RRGGBB': the agent's own colour when its id is in `agents`, else the hashed palette colour. */
export function agentColour(name, agents) {
  const list = Array.isArray(agents) ? agents.filter(Boolean) : [];
  const hit = list.find(a => a.id === name);
  return hit ? colourOf(hit) : hashedColour(name);
}

/** Money text: '$1.50', '<$0.01' for tiny costs, '$0.00' for zero, 'no cost data' for null. */
export function costText(v) {
  const n = costNum(v);
  if (n == null) return 'no cost data';
  if (n === 0) return '$0.00';
  if (n < 0.01) return '<$0.01';
  return '$' + n.toFixed(2);
}

/** Badge for an agent's cost_kind: {kind, label, cls} for actual | estimated | mixed; null for none or unknown. */
export function costBadge(kind) {
  if (typeof kind !== 'string' || !Object.prototype.hasOwnProperty.call(COST_BADGE, kind)) return null;
  return { kind, ...COST_BADGE[kind] };
}

/** True when any agent or the totals carry a cost. False means the cost column is hidden. */
export function hasAnyCost(bd) {
  if (!bd || typeof bd !== 'object') return false;
  if (costNum(bd.totals && bd.totals.cost_usd) != null) return true;
  return (Array.isArray(bd.agents) ? bd.agents : []).some(a => a && costNum(a.cost_usd) != null);
}

/** Provider split of one agent: [{key, label, tokens, share}], biggest first. Shares are 0..1 (0 when no tokens). */
export function providerRows(byProvider) {
  if (!byProvider || typeof byProvider !== 'object') return [];
  const rows = Object.entries(byProvider).map(([key, v]) => ({ key, label: PROVIDER_LABEL[key] || key, tokens: num(v) }));
  const total = rows.reduce((s, r) => s + r.tokens, 0);
  for (const r of rows) r.share = total > 0 ? r.tokens / total : 0;
  return rows.sort((x, y) => y.tokens - x.tokens || (x.label < y.label ? -1 : x.label > y.label ? 1 : 0));
}

/**
 * One row per agent, biggest first (ties by name): {agent, label, colour, tokens, share, sharePct, cost_usd, costText,
 * costBadge, sessions, api_calls, input, output, cache_read, cache_write, reasoning, providers}.
 * share is tokens / total tokens (0..1). label is the agent's name from `agents`, else its folder name.
 */
export function agentBars(bd, agents) {
  const list = Array.isArray(bd && bd.agents) ? bd.agents.filter(a => a && typeof a === 'object') : [];
  const known = Array.isArray(agents) ? agents : [];
  const rows = list.map(a => {
    const name = String(a.agent || 'unknown');
    const hit = known.find(x => x && x.id === name);
    const cost = costNum(a.cost_usd);
    return {
      agent: name,
      label: (hit && hit.name) || name,
      colour: agentColour(name, agents),
      tokens: num(a.tokens),
      share: 0,
      sharePct: 0,
      cost_usd: cost,
      costText: costText(cost),
      costBadge: costBadge(a.cost_kind),
      sessions: num(a.sessions),
      api_calls: num(a.api_calls),
      input: num(a.input),
      output: num(a.output),
      cache_read: num(a.cache_read),
      cache_write: num(a.cache_write),
      reasoning: num(a.reasoning),
      providers: providerRows(a.by_provider),
    };
  });
  const total = rows.reduce((s, r) => s + r.tokens, 0);
  for (const r of rows) {
    r.share = total > 0 ? r.tokens / total : 0;
    r.sharePct = Math.round(r.share * 100);
  }
  return rows.sort((x, y) => y.tokens - x.tokens || (x.agent < y.agent ? -1 : x.agent > y.agent ? 1 : 0));
}

/** Totals strip: tokens and calls as short text, cost as money text (hasCost false -> 'no cost data'). */
export function totalsView(bd) {
  const t = bd && bd.totals && typeof bd.totals === 'object' ? bd.totals : {};
  const tokens = num(t.tokens);
  const apiCalls = num(t.api_calls);
  const cost = costNum(t.cost_usd);
  return {
    tokens, tokensText: compactTokens(tokens),
    apiCalls, apiCallsText: compactTokens(apiCalls),
    cost, costText: costText(cost), hasCost: cost != null,
  };
}

/** True when the payload has at least one agent. False is the empty state. */
export function hasAgents(bd) {
  return !!(bd && Array.isArray(bd.agents) && bd.agents.length > 0);
}

/** 'YYYY-MM-DD' -> 'MM-DD'. Anything else comes back unchanged. */
export function shortDay(day) {
  const s = String(day == null ? '' : day);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s.slice(5) : s;
}

/** Footer lines for unreadable state.db files: 'state.db unreadable: <agent>'. */
export function errorLines(bd) {
  const list = Array.isArray(bd && bd.errors) ? bd.errors : [];
  return list.filter(e => e && typeof e === 'object').map(e => `state.db unreadable: ${String(e.agent || 'unknown')}`);
}

/**
 * Daily trend, oldest first. Empty days are kept. Each day: {day, label, tokens, empty, heightPct, costText, aria,
 * segments: [{agent, tokens, heightPct, colour}]}. heightPct is 0..100 relative to the largest day; segments follow
 * agentOrder (bottom of the stack first), then any unknown agent from by_agent in name order. max is the largest day.
 */
export function trendStack(trend, agentOrder, agents) {
  const days = (Array.isArray(trend) ? trend : [])
    .filter(d => d && typeof d === 'object' && typeof d.day === 'string')
    .sort((x, y) => (x.day < y.day ? -1 : x.day > y.day ? 1 : 0));
  const order = Array.isArray(agentOrder) ? agentOrder.map(String) : [];
  const names = [...order];
  const seen = new Set(order);
  const extra = [];
  const byAgentOf = d => (d.by_agent && typeof d.by_agent === 'object' ? d.by_agent : {});
  for (const d of days) {
    for (const k of Object.keys(byAgentOf(d))) {
      if (!seen.has(k)) { seen.add(k); extra.push(k); }
    }
  }
  names.push(...extra.sort());
  const dayTokens = d => Math.max(num(d.tokens), Object.values(byAgentOf(d)).reduce((s, v) => s + num(v), 0));
  const max = Math.max(0, ...days.map(dayTokens));
  const pct = v => (max > 0 ? (num(v) / max) * 100 : 0);
  const out = days.map(d => {
    const byAgent = byAgentOf(d);
    const tokens = dayTokens(d);
    const cText = costText(d.cost_usd);
    return {
      day: d.day,
      label: shortDay(d.day),
      tokens,
      empty: tokens === 0,
      heightPct: pct(tokens),
      costText: cText,
      aria: `${d.day}: ${compactTokens(tokens)} tokens, ${cText}`,
      segments: names.filter(n => num(byAgent[n]) > 0).map(n => ({
        agent: n, tokens: num(byAgent[n]), heightPct: pct(byAgent[n]), colour: agentColour(n, agents),
      })),
    };
  });
  return { days: out, max };
}
