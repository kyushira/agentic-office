// Pure view-model for Mission Control (unit-tested in test/mc-model.test.js).
export const FEED_API = '/api/plugins/agent-office/feed';
export const COMMS_API = '/api/plugins/agent-office/comms';
export const THINK_API = '/api/plugins/agent-office/thinking';
export const MC_CAP = 300;        // rows kept per panel
export const FEED_LIMIT = 150;    // rows asked for per feed poll
export const COMMS_LIMIT = 100;   // rows asked for per comms poll
const NO_COLOR = '#8a8a8a';       // /state always sends a.color; this only guards a missing field

const key = r => String(r.id);

/** Rows merged newest-first by ts. A duplicate id keeps the incoming copy; the result is capped at `cap`. */
export function mergeRows(old, incoming, cap = MC_CAP) {
  const seen = new Map();
  for (const r of [...(incoming || []), ...(old || [])]) {
    if (!r || r.id == null || seen.has(key(r))) continue;
    seen.set(key(r), r);
  }
  return [...seen.values()]
    .sort((a, b) => (b.ts || 0) - (a.ts || 0) || (key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : 0))
    .slice(0, cap);
}

/** Ids in `incoming` that `old` does not have. No old list (first load) means nothing is new. */
export function newIds(old, incoming) {
  if (!old) return [];
  const have = new Set(old.map(key));
  return (incoming || []).filter(r => r && r.id != null && !have.has(key(r))).map(r => r.id);
}

/**
 * Agent counts from /state agents[].status. Only the statuses /state reports (working, waiting, idle,
 * offline). /state has no 'stuck' signal, so there is no stuck count. Unknown statuses are not counted.
 */
export function statusCounts(agents) {
  const c = { working: 0, waiting: 0, idle: 0, offline: 0 };
  for (const a of agents || []) {
    if (a && Object.prototype.hasOwnProperty.call(c, a.status)) c[a.status] += 1;
  }
  return c;
}

/** Local clock time of a unix-seconds timestamp, HH:MM:SS. */
export function shortTime(ts) {
  if (!ts) return '--:--:--';
  const d = new Date(ts * 1000);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function agentColor(a) {
  return (a && a.color) || NO_COLOR;
}

export function agentName(agents, id) {
  const a = (agents || []).find(x => x.id === id);
  return (a && a.name) || id || '—';
}

/** Chip pill text: the real /state status, then the real /state activity line (e.g. 'working · running commands'). */
export function chipLabel(a) {
  const act = String(a.activity || '').trim();
  if (!act || act === a.status) return a.status;
  if (act.startsWith(a.status)) return act;
  return `${a.status} · ${act}`;
}

/** Comms rows where the agent is the sender or the receiver; no agent means all rows. */
export function commsFor(rows, agentId) {
  if (!agentId) return rows || [];
  return (rows || []).filter(r => r.from === agentId || r.to === agentId);
}

/** Feed URL: one agent (server-side filter) or all, incremental when `since` is the newest ts seen. */
export function feedQuery(agentId, since) {
  const q = [`limit=${FEED_LIMIT}`];
  if (agentId) q.push(`agent=${encodeURIComponent(agentId)}`);
  if (since > 0) q.push(`since=${since}`);
  return `${FEED_API}?${q.join('&')}`;
}

export function commsQuery(since) {
  const q = [`limit=${COMMS_LIMIT}`];
  if (since > 0) q.push(`since=${since}`);
  return `${COMMS_API}?${q.join('&')}`;
}

export function thinkLabel(chars) {
  return chars == null ? 'Thinking' : `Thinking · ${chars} chars`;
}

/** A call row's text is 'tool: arg' from the server; split it into tool and arg for display. */
export function callParts(row) {
  const t = String(row.text || '');
  const tool = row.tool || '';
  if (!tool) return { tool: t, arg: '' };
  const arg = t.startsWith(tool + ': ') ? t.slice(tool.length + 2) : '';
  return { tool, arg };
}

/** Characters revealed per frame for the typewriter: a row of any length finishes in about 90 frames. */
export function typeStep(len) {
  return Math.max(1, Math.ceil(len / 90));
}

/** Thinking agents seen so far for one key: the union of `prev` and `next`, first-seen order kept. */
export function mergeThinking(prev, next) {
  const out = [];
  for (const id of [...(prev || []), ...(next || [])]) {
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** The 'Thoughts = narration + plan' note shows for a selected agent that has no real thinking rows. */
export function showThoughtsNote(thinkingAgents, agentId) {
  return !!agentId && !(thinkingAgents || []).includes(agentId);
}
