// Pure view-model for the Agents and Inbox tabs (unit-tested in test/agents-model.test.js).
import { ago } from './format.js';
import { speechText } from './deck-model.js';

export const FILTERS = ['all', 'running', 'waiting', 'error'];
const FILTER_SET = new Set(FILTERS);
const ERROR_STATUSES = new Set(['error', 'failed']);
const WORDS = { running: 'Running', waiting: 'Waiting', error: 'Error', offline: 'Offline', idle: 'Idle' };

/**
 * Bucket for one agent: 'error' (an `error` field, or an error/failed status), 'running' (status
 * 'working'), 'waiting' (status 'waiting'), else 'idle'. Offline agents without an error field are idle.
 */
export function statusOf(agent) {
  const a = agent || {};
  if (a.error || ERROR_STATUSES.has(a.status)) return 'error';
  if (a.status === 'working') return 'running';
  if (a.status === 'waiting') return 'waiting';
  return 'idle';
}

/** Agents in the filter bucket. 'all' (or an unknown filter) returns every agent, in order. */
export function filterAgents(agents, filter) {
  const list = Array.isArray(agents) ? agents.filter(Boolean) : [];
  const f = FILTER_SET.has(filter) ? filter : 'all';
  return f === 'all' ? list : list.filter(a => statusOf(a) === f);
}

/** Counts for the segmented control: {all, running, waiting, error}. Idle agents count under All only. */
export function counts(agents) {
  const out = { all: 0, running: 0, waiting: 0, error: 0 };
  for (const a of Array.isArray(agents) ? agents.filter(Boolean) : []) {
    out.all++;
    const s = statusOf(a);
    if (s !== 'idle') out[s]++;
  }
  return out;
}

/** Ids of the first `max` running agents (in agent order) that get the pulsing dot. Never more than `max`. */
export function pulseIds(agents, max = 3) {
  const cap = Math.max(0, Math.floor(+max) || 0);
  const ids = [];
  for (const a of Array.isArray(agents) ? agents.filter(Boolean) : []) {
    if (ids.length >= cap) break;
    if (statusOf(a) === 'running') ids.push(a.id);
  }
  return ids;
}

/**
 * Card data: {id, name, status, word, harness, task, time}. status is the bucket from statusOf; word is
 * the visible status text (never colour alone). harness is the first of harness|provider|model that is
 * set, else null. task is the live step (or the current working session's step), else '—'.
 * time is ago(lastActive) with `now` in ms; '—' when lastActive is missing.
 */
export function cardView(agent, sessions, now) {
  const a = agent || {};
  const status = statusOf(a);
  const list = Array.isArray(sessions) ? sessions : [];
  const sessStep = (list.find(s => s && s.status === 'working' && s.step) || {}).step;
  const task = speechText(a.activity).trim() || sessStep || '—';
  const harness = a.harness || a.provider || a.model || null;
  const nowS = now == null || !Number.isFinite(+now) ? undefined : +now / 1000;
  return {
    id: a.id,
    name: a.name || a.id || 'Agent',
    status,
    word: a.status === 'offline' && status === 'idle' ? WORDS.offline : WORDS[status],
    harness: harness ? String(harness) : null,
    task,
    time: ago(a.lastActive, nowS),
  };
}

/**
 * Inbox rows from needsYou(): {id, name, label, time}. time is ago(item.at) when the item carries a
 * timestamp (seconds), else null. Missing fields fall back to the id and an empty label.
 */
export function inboxRow(item, now) {
  const it = item || {};
  const nowS = now == null || !Number.isFinite(+now) ? undefined : +now / 1000;
  const at = Number.isFinite(+it.at) && +it.at > 0 ? +it.at : null;
  return {
    id: it.id,
    name: it.name || it.id || 'Agent',
    label: it.label || 'Needs you',
    time: at == null ? null : ago(at, nowS),
  };
}
