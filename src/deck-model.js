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

const TRACE = { cell: 10, base: 13, top: 2, height: 16 };   // viewBox units: one hour = 10 wide, 16 tall

/**
 * Activity strip geometry from spark.toolCalls (hourly buckets, oldest first). Each hour is a flat
 * baseline with a spike up to its share of the busiest hour. One flat cell is added on the right so
 * the slow scroll never shows an empty edge. Null means "no data": missing, empty or all zeros.
 */
export function traceModel(spark) {
  const raw = spark && Array.isArray(spark.toolCalls) ? spark.toolCalls : [];
  const counts = raw.map(v => { const n = +v; return Number.isFinite(n) && n > 0 ? n : 0; });
  if (!counts.some(v => v > 0)) return null;
  const { cell, base, top, height } = TRACE;
  const max = Math.max(...counts);
  const points = [];
  counts.forEach((v, i) => {
    const x = i * cell, peak = base - (v / max) * (base - top);
    points.push([x, base], [x + 4, base], [x + 5, peak], [x + 6, base]);
  });
  const end = counts.length * cell;
  points.push([end, base], [end + cell, base]);
  return { width: end, height, points };
}

function toolTotal(a) {
  const v = a && a.today ? a.today.toolCalls : null;
  const n = v == null ? NaN : +v;
  return Number.isFinite(n) ? n : null;
}

/**
 * Tool calls that landed between two consecutive /state polls: {agentId: delta}, deltas > 0 only.
 * No previous poll, an agent not in the previous poll, or a drop (midnight reset) gives nothing.
 */
export function newToolCalls(prev, next) {
  const out = {};
  if (!prev || !next) return out;
  const before = new Map((prev.agents || []).map(a => [a.id, a]));
  for (const a of next.agents || []) {
    const was = before.has(a.id) ? toolTotal(before.get(a.id)) : null;
    const now = toolTotal(a);
    if (was != null && now != null && now > was) out[a.id] = now - was;
  }
  return out;
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

/** Count-up duration in ms (CountUp in Deck.jsx). */
export const COUNT_MS = 700;

/**
 * Value on the way from `from` to `to` at progress t (0..1, clamped): ease-out cubic, rounded to an
 * integer. Non-finite inputs return `to` so a bad value jumps rather than shows NaN.
 */
export function countStep(from, to, t) {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return to;
  const p = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 1;
  const e = 1 - Math.pow(1 - p, 3);
  return Math.round(from + (to - from) * e);
}

/**
 * Today's totals for an agent from `today` = {tokens, toolCalls, sessions}. Null when the agent has
 * no `today` at all (render nothing); a field that is missing or not a number is null (render a dash).
 * Real zeros stay 0.
 */
export function todayParts(a) {
  const t = a && a.today;
  if (!t) return null;
  const num = k => {
    if (t[k] == null || t[k] === '') return null;
    const n = +t[k];
    return Number.isFinite(n) ? n : null;
  };
  return { tokens: num('tokens'), toolCalls: num('toolCalls'), sessions: num('sessions') };
}

const FLIGHT_MAX = 4;          // newest new walks shown per poll; the rest are counted as seen and dropped
const WALK_FRESH_S = 60;       // a walk older than this (tab was away) is counted as seen, never animated
const SUBJ_MAX = 40;

/**
 * Walks that are new since the last /state poll, for the message-flow overlay. A walk id seen in
 * prevState (or any walk on the first poll, when prevState is null) never shows, so nothing replays
 * on load or reload. Both ends must be agents on the grid (agentIds) and not the same agent.
 * `now` (unix s, optional) drops walks older than WALK_FRESH_S. Returns the newest FLIGHT_MAX, oldest first.
 */
export function newWalks(prevState, nextState, agentIds, now) {
  if (!prevState || !nextState) return [];
  const seen = new Set((prevState.walks || []).map(w => w.id));
  const shown = new Set(agentIds || []);
  return (nextState.walks || [])
    .filter(w => w.id != null && !seen.has(w.id) && w.from !== w.to && shown.has(w.from) && shown.has(w.to))
    .filter(w => now == null || now - (+w.at || 0) < WALK_FRESH_S)
    .sort((x, y) => (x.at || 0) - (y.at || 0))
    .slice(-FLIGHT_MAX);
}

/** "Ash → Dev · new brief · <subject>"; the subject is cut to ~40 characters with an ellipsis, and omitted when empty. */
export function walkLabel(w, names) {
  const head = `${names[w.from] || w.from} → ${names[w.to] || w.to} · ${KIND[w.kind] || w.kind}`;
  const subj = String(w.subject || '').trim();
  if (!subj) return head;
  const short = subj.length > SUBJ_MAX ? subj.slice(0, SUBJ_MAX - 1).trimEnd() + '…' : subj;
  return `${head} · ${short}`;
}

// Tool-mix ring (idea 4). Shade per rank: the largest tool is full strength, the rest fade.
const RING_SHADES = [1, 0.7, 0.5, 0.36, 0.26, 0.18];

/**
 * Donut model for an agent's top tools today: {segments, total, active, aria}.
 * Each segment: {name, label, count, frac (share of total), offset (where it starts, 0..1), shade, active}.
 * Zero, negative or non-numeric counts are dropped. `active` is set only while status is 'working' and the
 * first part of activity (before ' · ') equals a tool label: that tool is running now. `active` on the model is
 * that label, or null. No tools gives no segments and aria 'Tools today: no data'.
 */
export function toolRing(tools, activity, status) {
  const list = (Array.isArray(tools) ? tools : [])
    .map(t => ({ name: String((t && t.name) || ''), label: String((t && (t.label || t.name)) || ''), count: +(t && t.count) }))
    .filter(t => t.name && Number.isFinite(t.count) && t.count > 0);
  const total = list.reduce((n, t) => n + t.count, 0);
  const step = status === 'working' ? String(activity || '').split(' · ')[0].trim() : '';
  const activeIdx = step ? list.findIndex(t => t.label === step) : -1;
  let start = 0;
  const segments = list.map((t, i) => {
    const frac = t.count / total;
    const seg = { name: t.name, label: t.label, count: t.count, frac, offset: start,
      shade: RING_SHADES[Math.min(i, RING_SHADES.length - 1)], active: i === activeIdx };
    start += frac;
    return seg;
  });
  const aria = segments.length
    ? 'Tools today: ' + segments.map(s => `${s.label} ${s.count}`).join(', ')
    : 'Tools today: no data';
  return { segments, total, active: activeIdx >= 0 ? list[activeIdx].label : null, aria };
}

const TRIP_FRESH_S = 60;      // a trip older than this (tab was away) is counted as seen, never pulsed
const TRIP_MAX = 3;           // newest new trips pulsed per agent per poll

/**
 * Brain trips that are new since the last /state poll: {agentId: [trip, ...]}, oldest first, newest
 * TRIP_MAX per agent. A trip id already in that agent's previous brainTrips is not new. No previous poll,
 * an agent not in the previous poll, or a previous agent with no brainTrips array gives nothing, so
 * nothing replays on load. `now` (unix s, optional) drops trips older than TRIP_FRESH_S.
 */
export function newBrainTrips(prevState, nextState, now) {
  const out = {};
  if (!prevState || !nextState) return out;
  const before = new Map((prevState.agents || []).map(a => [a.id, a]));
  for (const a of nextState.agents || []) {
    const was = before.get(a.id);
    if (!was || !Array.isArray(was.brainTrips)) continue;
    const seen = new Set(was.brainTrips.map(t => t && t.id));
    const fresh = (Array.isArray(a.brainTrips) ? a.brainTrips : [])
      .filter(t => t && t.id != null && !seen.has(t.id) && (now == null || now - (+t.at || 0) < TRIP_FRESH_S))
      .sort((x, y) => (x.at || 0) - (y.at || 0))
      .slice(-TRIP_MAX);
    if (fresh.length) out[a.id] = fresh;
  }
  return out;
}

/** {reads, writes} over an agent's brainTrips; unknown kinds are not counted. */
export function brainCounts(trips) {
  const list = Array.isArray(trips) ? trips : [];
  return {
    reads: list.filter(t => t && t.kind === 'read').length,
    writes: list.filter(t => t && t.kind === 'write').length,
  };
}

/** "3 reads · 1 write" for the sheet and aria; null when there are no trips (render nothing). */
export function brainText(trips) {
  const { reads, writes } = brainCounts(trips);
  if (!reads && !writes) return null;
  const r = `${reads} read${reads === 1 ? '' : 's'}`, w = `${writes} write${writes === 1 ? '' : 's'}`;
  return reads && writes ? `${r} · ${w}` : reads ? r : w;
}

/** Vault note count from state.brain.notes; null when missing or not a number (never invented). */
export function brainNotes(brain) {
  const raw = brain ? brain.notes : null;
  const n = raw == null || raw === '' ? NaN : +raw;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Helper changes between two /state polls, for the swarm dots: {agentId: {spawned: [ids], exited: [{id, task, model}]}}.
 * spawned: a live helper whose id was in neither the previous helpers nor recentHelpers of that agent.
 * exited: a previous live helper that is no longer live (it finished and moved to recentHelpers, or it is gone).
 * No previous poll, or an agent that was not in the previous poll, gives nothing (nothing animates on load).
 * Agents with no change are left out.
 */
export function helperChanges(prev, next) {
  const out = {};
  if (!prev || !next) return out;
  const before = new Map((prev.agents || []).map(a => [a.id, a]));
  for (const a of next.agents || []) {
    const was = before.get(a.id);
    if (!was) continue;
    const prevLive = Array.isArray(was.helpers) ? was.helpers.filter(h => h && h.id != null) : [];
    const prevRecent = Array.isArray(was.recentHelpers) ? was.recentHelpers : [];
    const seen = new Set([...prevLive, ...prevRecent].map(h => h && h.id));
    const nowLive = Array.isArray(a.helpers) ? a.helpers.filter(h => h && h.id != null) : [];
    const nowIds = new Set(nowLive.map(h => h.id));
    const spawned = nowLive.filter(h => !seen.has(h.id)).map(h => h.id);
    const exited = prevLive.filter(h => !nowIds.has(h.id)).map(h => ({ id: h.id, task: h.task, model: h.model }));
    if (spawned.length || exited.length) out[a.id] = { spawned, exited };
  }
  return out;
}

/**
 * Agents that need the user, in agent order: {id, name, color, kind, label}.
 * kind 'question' = activity starts with 'asking a question' (a pending clarify call).
 * kind 'approval' = status 'waiting' (collect.py sets it for 'waiting for approval'). A waiting agent whose
 * activity is 'delegating · …' is excluded: collect.py marks a delegating agent with no live lead as waiting
 * too, but it is waiting on its helpers, not on the user.
 */
export function needsYou(agents) {
  const out = [];
  for (const a of Array.isArray(agents) ? agents : []) {
    if (!a) continue;
    const act = String(a.activity || '').trim();
    const base = { id: a.id, name: a.name || a.id, color: a.color || NO_COLOR };
    if (/^asking a question/.test(act)) out.push({ ...base, kind: 'question', label: 'asking a question' });
    else if (a.status === 'waiting' && !/^delegating/.test(act))
      out.push({ ...base, kind: 'approval', label: /approval/.test(act) ? 'waiting for approval' : (act || 'waiting on you') });
  }
  return out;
}

const STATUS_WORDS = { working: 'Working', waiting: 'Waiting', idle: 'Idle', offline: 'Offline' };
/** Status word for the roster (text, so state is not colour-only). Unknown statuses read as Idle. */
export function statusWord(status) { return STATUS_WORDS[status] || 'Idle'; }

/** Greeting for the header subline from the local hour (0-23). */
export function greeting(hour) {
  return hour >= 5 && hour < 12 ? 'Good morning' : hour >= 12 && hour < 18 ? 'Good afternoon' : 'Good evening';
}

/** Short duration tag: '<1m', '39m', '2h'. Negative or non-finite input gives null (no tag). */
export function shortDuration(sec) {
  const s = +sec;
  if (!Number.isFinite(s) || s < 0) return null;
  if (s < 60) return '<1m';
  return s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
}

/**
 * Duration tag for a roster card: how long the agent's earliest working session has been running, from
 * `started` (unix s) on the session rows. Null when the agent is not working or no started time is known.
 */
export function rosterDuration(a, sessions, now) {
  if (!a || a.status !== 'working') return null;
  const starts = (Array.isArray(sessions) ? sessions : [])
    .filter(s => s && s.status === 'working' && Number.isFinite(+s.started) && +s.started > 0)
    .map(s => +s.started);
  if (!starts.length) return null;
  return shortDuration(now - Math.min(...starts));
}

/** Clock face 'HH:MM' (24h, local) for a Date. */
export function clockText(d) {
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

const SOON_S = 15 * 60;
/** True when a 5h reset is under 15 minutes away (the header pill turns red). */
export function resetSoon(resetsAt, nowMs) {
  if (resetsAt == null || resetsAt === '') return false;
  const t = typeof resetsAt === 'number' ? (resetsAt < 1e12 ? resetsAt * 1000 : resetsAt) : new Date(resetsAt).getTime();
  if (!Number.isFinite(t)) return false;
  const left = (t - nowMs) / 1000;
  return left > 0 && left < SOON_S;
}

/** Tile tooltip for live helpers: "2 helpers running", then one "model · task" line each (empty when none). */
export function swarmTip(helpers) {
  const hs = Array.isArray(helpers) ? helpers.filter(h => h && h.id != null) : [];
  if (!hs.length) return '';
  const head = `${hs.length} helper${hs.length === 1 ? '' : 's'} running`;
  return [head, ...hs.map(h => `${h.model || 'helper'} · ${String(h.task || '').trim() || 'task'}`)].join('\n');
}


/** Desktop right pane (Office sits beside it) opens on Live; Comms stays one click away. */
export const RIGHT_PANE_DEFAULT = 'live';

/**
 * Which feed poller is mounted. Only one of Live and Comms is ever mounted, so only one polls.
 * Desktop: the right pane shows `rightPane`. Phone: the Office | Comms switch shows `pane`, and the
 * right pane is never shown, so Live never polls there.
 */
export function livePolls({ desktop, rightPane }) {
  return !!desktop && rightPane === 'live';
}
export function commsPolls({ desktop, pane, rightPane }) {
  return desktop ? rightPane === 'comms' : pane === 'comms';
}

/**
 * Speech notice text for a working agent. The helper count is dropped because the count chip on the
 * tile already says "N helpers"; repeating it made the phone notice truncate ("delegating · 3 helpers").
 */
export function speechText(activity) {
  return String(activity || '').replace(/\s*·\s*\d+\s+helpers?$/, '');
}
