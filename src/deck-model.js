// Pure view-model for the Deck (unit-tested in test/deck-model.test.js).
import { ago } from './format.js';

const CHIP_SECS = 120;
const NO_COLOR = '#8a8a8a';   // the backend always sends a.color; this only guards a missing field
const KIND = { brief: 'new brief', reply: 'report', message: 'message' };

/** Main model and the distinct helper models, as {main, helpers} (helpers is '' when there are none). */
export function modelParts(a) {
  return { main: a.model || '—', helpers: [...new Set(a.helperModels || [])].join(', ') };
}

/** "Sonnet 5.5 · helpers DeepSeek V4 Flash" (main model, then the distinct helper models). */
export function modelText(a) {
  const { main, helpers } = modelParts(a);
  return helpers ? `${main} · helpers ${helpers}` : main;
}

export function durationText(h, now) {
  const end = h.ended || now, s = Math.max(0, Math.round(end - (h.since || end)));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`;
}

/**
 * Grid items: each agent, then its running helpers, then helpers that finished in the last ~15 min.
 * Agents keep discovery order so tiles don't jump around.
 */
export function buildItems(state, now) {
  const agents = state.agents || [];
  const names = Object.fromEntries(agents.map(a => [a.id, a.name]));
  const colors = Object.fromEntries(agents.map(a => [a.id, a.color || NO_COLOR]));
  const walks = state.walks || [];
  const items = [];
  for (const a of agents) {
    const working = a.status === 'working' || a.status === 'waiting';
    const sess = ((state.sessions || {})[a.id] || []).find(s => s.status === 'working');
    const activeTok = ((state.sessions || {})[a.id] || []).filter(s => s.status === 'working').reduce((n, s) => n + (+s.tokens || 0), 0);
    const step = (a.activity || '').replace(/^delegating · .*/, 'delegating').split(' · ')[0];
    const helpers = a.helpers || [];
    const recent = (a.recentHelpers || []).filter(h => now - h.ended < 900);
    const inbound = walks.filter(w => w.to === a.id && now - w.at < CHIP_SECS).sort((x, y) => y.at - x.at)[0];
    const label = w => `${names[w.from] || w.from} → ${names[w.to] || w.to} · ${KIND[w.kind] || w.kind}`;
    items.push({
      type: 'agent', key: 'a:' + a.id, agent: a, color: colors[a.id], working,
      status: working ? `working · ${step || 'working'}` : `idle · ${ago(a.lastActive, now)}`,
      ctxPct: working && sess ? sess.ctxPct : null,
      tokens: working ? activeTok : 0,
      helperCount: helpers.length,
      chip: inbound ? { text: `${names[inbound.from] || inbound.from} · ${KIND[inbound.kind] || inbound.kind}`, color: colors[inbound.from] || '#999' } : null,
      walks: walks.filter(w => w.from === a.id || w.to === a.id).map(w => ({ ...w, label: label(w) })),
    });
    for (const h of helpers) items.push(helperItem(h, a, colors[a.id], false, now));
    for (const h of recent) items.push(helperItem(h, a, colors[a.id], true, now));
  }
  // An agent with helpers starts a new grid row (helpers sit right after it), and so does the next
  // agent after a helper group, so a helper is never next to a stranger.
  items.forEach((it, i) => {
    const hasKids = it.type === 'agent' && items[i + 1] && items[i + 1].type === 'helper';
    const afterKids = it.type === 'agent' && i > 0 && items[i - 1].type === 'helper';
    it.rowStart = !!(hasKids || afterKids);
  });
  return items;
}

function helperItem(h, a, color, done, now) {
  return {
    type: 'helper', key: 'h:' + a.id + ':' + h.id, helper: h, done, parentName: a.name, parentColor: color,
    name: `${h.model || 'Helper'} helper`,
    status: done ? `done · ${ago(h.ended, now)}` : h.activity || 'running',
  };
}

const pctText = p => (p == null || isNaN(+p) ? 'n/a' : Math.round(+p) + '%');
function resetText(ts) {
  if (ts == null || ts === '') return 'n/a';
  const d = new Date(typeof ts === 'number' && ts < 1e12 ? ts * 1000 : ts);
  return isNaN(d) ? 'n/a' : d.toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

/** Level for a percent meter: ok below 70, warn from 70, hot from 90; na when there is no number. */
export function meterLevel(pct) {
  if (pct == null || pct === '' || isNaN(+pct)) return 'na';
  const p = +pct;
  return p >= 90 ? 'hot' : p >= 70 ? 'warn' : 'ok';
}

// Plan windows shown in the header: payload key, panel label, compact label, spoken name for aria.
const PLAN_WINDOWS = [['five_hour', 'Session · 5h', '5h', 'session 5h'], ['seven_day', 'Week · 7d', 'wk', 'week']];

/**
 * Claude plan usage for the header: {short, title, level, reason, windows, aria} from the /usage payload.
 * level is ok|warn|hot|na (from the larger window); reason is set only when unavailable.
 * windows: one per plan window {key, label, short, pct (0-100 or null), resets ('n/a' when missing), level}.
 */
export function usageText(u) {
  const five = (u && u.five_hour) || {}, week = (u && u.seven_day) || {};
  const live = !!(u && u.available);
  const windows = PLAN_WINDOWS.map(([key, label, short]) => {
    const w = live ? (u[key] || {}) : {};
    const pct = live && w.pct != null && !isNaN(+w.pct) ? Math.max(0, Math.min(100, +w.pct)) : null;
    const resets = !live ? 'n/a' : (w.resets_at == null || w.resets_at === '') ? 'reset time not reported' : resetText(w.resets_at);
    return { key, label, short, pct, resets, level: meterLevel(pct) };
  });
  if (!live) {
    const reason = (u && u.reason) || 'unknown';
    return { short: '5h n/a · wk n/a', title: 'Plan usage n/a: ' + reason, level: 'na', reason,
      windows, aria: 'Claude plan usage n/a: ' + ((u && u.reason) || 'source did not say why') };
  }
  const pcts = [five.pct, week.pct].filter(p => p != null && !isNaN(+p)).map(Number);
  const max = pcts.length ? Math.max(...pcts) : null;
  const level = max == null ? 'na' : max >= 90 ? 'hot' : max >= 70 ? 'warn' : 'ok';
  return {
    short: `5h ${pctText(five.pct)} · wk ${pctText(week.pct)}`,
    title: `Claude plan: 5-hour resets ${resetText(five.resets_at)}; weekly resets ${resetText(week.resets_at)}`,
    level,
    reason: null,
    windows,
    aria: 'Claude plan usage: ' + PLAN_WINDOWS.map(([key, , , word]) => `${word} ${pctText(u[key] && u[key].pct)}`).join(', '),
  };
}

/** Tokens used by the sessions of working agents (sums the per-agent tokens from buildItems). */
export function activeTokens(items) {
  return items.filter(i => i.working).reduce((n, i) => n + (+i.tokens || 0), 0);
}

export function headerCounts(items) {
  const agents = items.filter(i => i.type === 'agent');
  const working = agents.filter(i => i.working).length;
  return { working, idle: agents.length - working, helpers: items.filter(i => i.type === 'helper' && !i.done).length };
}

/** Session to show live detail for: the first working session, else the most recent one (by `at`). */
export function currentSessionId(sessions) {
  const list = sessions || [];
  const pick = list.find(s => s.status === 'working') || [...list].sort((x, y) => (y.at || 0) - (x.at || 0))[0];
  return pick ? pick.id : null;
}

/** One-line label for a session event: a tool name, 'message in' or 'reply'. */
export function eventLabel(e) {
  if (e.kind === 'tool') return e.name || 'tool';
  if (e.kind === 'user') return 'message in';
  if (e.kind === 'assistant') return 'reply';
  return e.kind || '';
}

/** Rows for the sheet's "Now" block from a session detail payload. */
export function detailRows(d) {
  const helpers = d.helpers || [];
  const working = helpers.filter(h => h.status === 'working' || h.status === 'running').length;
  return {
    activity: d.activity || d.status || 'idle',
    tool: d.last_tool ? `${d.last_tool.name}` : null,
    helpers: `${working} working / ${helpers.length}`,
  };
}
