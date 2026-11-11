// Deck-side Hermes -> Claude-Office adapter. Pure: no DOM, no fetch, no timers, no window.
// The Deck's Home already polls GET /api/plugins/agent-office/state every 4 s; it calls
// diffState(prev, next) on each good poll and postMessage()s the envelope into the iframe.
//
// DECISION (Phase 1b): the PLAIN AGENT PATH. Each Hermes profile is an agent_spawned worker with
// id hermes-<profile>, role from ROLE_BY_PROFILE and no sessionId.
// Evidence, read from office-src/src (not executed; the reducer was not run under node):
//   - officeReducer.ts ensureClaude() (L651) is the session path. It seats a Claude whose id starts
//     with 'main-' (mainState.ts MAIN_ID_PREFIX; isMainAgent() is an id-prefix test). Feeding each profile
//     through sessionId would make every profile a main Claude, not a role sprite from ROLE_TO_CHAR.
//   - agent_spawned (L889) uses raw.id and raw.role directly, and works with no sessionId. That is the
//     path that gives the per-profile sprites (dev-1, explore-1, Frontend-dev-1, security-audit-1, ...).
// Consequence: session_needs_you / session_error need a main Claude, so 'waiting' and 'error' are sent as
// agent_working status text instead. Helpers are plain agents (hermes-<p>:helper:<hid>), not sessions.
//
// Event mapping (state fields are the real /state shape from plugin/agent-office/dashboard/collect.py):
//   first diff (prev null)         -> snapshot {activeAgents, sessions: [], timestamp}   (snapshotEvents)
//   agent present, was absent/off  -> agent_spawned {agent:{id,name,role,task:remit,status?}}  (walks in)
//   status idle -> running         -> agent_working {agentId, status: activity (<=80)}
//   running, activity text changes -> agent_working {agentId, status}
//   running -> idle                -> nothing (the reducer idles on its own)
//   status waiting                 -> agent_working {status: 'waiting · <activity>'}
//   error (error field / status)   -> agent_working {status: 'error · <error>'}   (status text only; no failed flag)
//   offline or gone                -> agent_completed {agentId, result: ''}          (walks out)
//   helpers[] id added / removed   -> agent_spawned / agent_completed for hermes-<p>:helper:<hid>
//   walks[] new id (A -> B)        -> chat_message {sender, senderId, recipient, recipientId, text} (reducer's A2A visit)
//                                     newest MAX_WALKS per diff
//   every good poll / failed poll  -> connectionEvent(true|false)  (the caller adds it to the envelope)
//   /usage -> session_status       -> TODO Phase 3: /state has no usage fields; /usage is a separate endpoint.
//
// Only ids, names, roles, status and activity text leave this module. Nothing else from /state is copied.

export const PROTOCOL = 'hermes-office';
export const PROTOCOL_V = 1;
export const MAX_TEXT = 80;
export const MAX_WALKS = 3;

const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const HELPER_RE = /^[A-Za-z0-9_-]{1,40}$/;

// Profile -> reducer role. Each value is a ROLE_TO_CHAR key in office-src/src/config.ts (sprite, no new art).
// 'default' is Ash (collect.py NAMES). 'dev' has no ROLE_TO_CHAR key, so it uses 'debugger' (dev-1).
// 'Explore' keeps its FILING_ROLES behaviour (it browses the cabinet, not a desk).
export const ROLE_BY_PROFILE = Object.freeze({
  default: 'assistant',
  dev: 'debugger',
  red: 'Explore',
  nova: 'frontend-developer',
  pixel: 'test-engineer',
  prism: 'code-reviewer',
  sentinel: 'security-auditor',
});
const FALLBACK_ROLE = 'general-purpose';
const HELPER_ROLE = 'general-purpose';
// brief -> task_handoff icon, reply / message -> message icon (A2A_ICONS keys in officeReducer.ts)
const WALK_MSG_TYPE = Object.freeze({ brief: 'task_handoff', reply: 'message', message: 'message' });

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const validProfile = p => typeof p === 'string' && PROFILE_RE.test(p);
const roleOf = p => (hasOwn(ROLE_BY_PROFILE, p) ? ROLE_BY_PROFILE[p] : FALLBACK_ROLE);

/** Collapse whitespace, trim, and cap at n characters (ellipsis when cut). Non-strings give ''. */
export function clip(v, n = MAX_TEXT) {
  if (typeof v !== 'string') return '';
  const s = v.replace(/\s+/g, ' ').trim();
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…';
}

export const stableId = profile => `hermes-${profile}`;
export const helperId = (profile, hid) => `hermes-${profile}:helper:${hid}`;

// present: the /state row is online (collect.py marks a failed read as offline / 'no data').
const present = a => a.status !== 'offline' && a.activity !== 'no data';

// Bucket matches agents-model.js statusOf, so the scene and the Agents grid agree.
function bucket(a) {
  if (a.error || a.status === 'error' || a.status === 'failed') return 'error';
  if (a.status === 'working') return 'running';
  if (a.status === 'waiting') return 'waiting';
  return 'idle';
}

function textOf(a, b) {
  const act = clip(a.activity);
  if (b === 'running') return act || 'working';
  if (b === 'waiting') return clip(act.startsWith('waiting') ? act : `waiting · ${act || 'on you'}`);
  if (b === 'error') return clip(`error · ${clip(typeof a.error === 'string' ? a.error : '', 40) || act || 'failed'}`);
  return '';
}

function nameOf(profile, a) {
  return clip(a && a.name, 40) || profile;
}

/** profile id -> agent row, first occurrence wins; rows without a valid id are skipped. */
function agentsById(state) {
  const out = new Map();
  const list = isObj(state) && Array.isArray(state.agents) ? state.agents : [];
  for (const a of list) {
    if (!isObj(a) || !validProfile(a.id) || out.has(a.id)) continue;
    out.set(a.id, a);
  }
  return out;
}

/** helper id -> helper row for one agent (helpers[] from collect.py: id, task, model, activity, since). */
function helpersOf(a) {
  const out = new Map();
  for (const h of Array.isArray(a.helpers) ? a.helpers : []) {
    if (!isObj(h)) continue;
    const hid = typeof h.id === 'string' || typeof h.id === 'number' ? String(h.id) : '';
    if (!HELPER_RE.test(hid) || out.has(hid)) continue;
    out.set(hid, h);
  }
  return out;
}

function spawnFields(profile, a) {
  const b = bucket(a);
  const out = { id: stableId(profile), name: nameOf(profile, a), role: roleOf(profile) };
  const remit = clip(a.remit);
  if (remit) out.task = remit;
  if (b !== 'idle') out.status = textOf(a, b);
  return out;
}

function helperFields(profile, a, hid, h) {
  const out = {
    id: helperId(profile, hid),
    name: clip(`${nameOf(profile, a)} helper`, 40),
    role: HELPER_ROLE,
  };
  const task = clip(h.task);
  if (task) out.task = task;
  out.status = clip(h.activity) || 'working';
  return out;
}

/** First sync: every online agent (and live helper) as one snapshot. The reducer seats them in order. */
export function snapshotEvents(state, opts = {}) {
  const activeAgents = [];
  for (const [pid, a] of agentsById(state)) {
    if (!present(a)) continue;
    const b = bucket(a);
    const row = { id: stableId(pid), name: nameOf(pid, a), role: roleOf(pid), state: b === 'idle' ? 'idle' : 'working' };
    const remit = clip(a.remit);
    if (remit) row.task = remit;
    if (b !== 'idle') row.status = textOf(a, b);
    activeAgents.push(row);
    for (const [hid, h] of helpersOf(a)) {
      activeAgents.push({ ...helperFields(pid, a, hid, h), state: 'working' });
    }
  }
  return [{ type: 'snapshot', activeAgents, sessions: [], timestamp: timestampOf(state, opts) }];
}

function timestampOf(state, opts) {
  if (Number.isFinite(+opts.now)) return +opts.now;
  if (isObj(state) && Number.isFinite(+state.ts)) return Math.round(+state.ts * 1000);
  return 0;
}

/**
 * Events for one good poll, given the previous and the new /state object. prev null/absent = first sync.
 * Never throws: malformed or missing fields are skipped. opts: { now (ms), maxWalks }.
 */
export function diffState(prev, next, opts = {}) {
  if (!isObj(next)) return [];
  if (!isObj(prev)) return snapshotEvents(next, opts);
  const maxWalks = Number.isFinite(+opts.maxWalks) ? Math.max(0, Math.floor(+opts.maxWalks)) : MAX_WALKS;
  const before = agentsById(prev);
  const after = agentsById(next);
  const events = [];

  // Gone or offline: its helpers and then the agent walk out.
  for (const [pid, a0] of before) {
    if (!present(a0)) continue;
    const a1 = after.get(pid);
    if (a1 && present(a1)) continue;
    for (const hid of helpersOf(a0).keys()) {
      events.push({ type: 'agent_completed', agentId: helperId(pid, hid), result: '' });
    }
    events.push({ type: 'agent_completed', agentId: stableId(pid), result: '' });
  }

  for (const [pid, a1] of after) {
    if (!present(a1)) continue;
    const a0 = before.get(pid);
    if (!a0 || !present(a0)) {
      events.push({ type: 'agent_spawned', agent: spawnFields(pid, a1) });
      for (const [hid, h] of helpersOf(a1)) {
        events.push({ type: 'agent_spawned', agent: helperFields(pid, a1, hid, h) });
      }
      continue;
    }
    const b0 = bucket(a0);
    const b1 = bucket(a1);
    if (b1 !== 'idle') {
      const t1 = textOf(a1, b1);
      if (b0 !== b1 || textOf(a0, b0) !== t1) {
        events.push({ type: 'agent_working', agentId: stableId(pid), status: t1 });
      }
    }
    const h0 = helpersOf(a0);
    const h1 = helpersOf(a1);
    for (const [hid, h] of h1) {
      if (!h0.has(hid)) events.push({ type: 'agent_spawned', agent: helperFields(pid, a1, hid, h) });
    }
    for (const hid of h0.keys()) {
      if (!h1.has(hid)) events.push({ type: 'agent_completed', agentId: helperId(pid, hid), result: '' });
    }
  }

  // Hand-offs: only walks not seen in prev, both ends online, newest maxWalks of them.
  const seen = new Set((Array.isArray(prev.walks) ? prev.walks : []).map(w => (isObj(w) ? w.id : undefined)));
  const walks = (Array.isArray(next.walks) ? next.walks : [])
    .filter(w => isObj(w) && w.id != null && !seen.has(w.id) && w.from !== w.to
      && validProfile(w.from) && validProfile(w.to)
      && after.has(w.from) && after.has(w.to)
      && present(after.get(w.from)) && present(after.get(w.to))
      && Number.isFinite(+w.at))
    .sort((x, y) => +x.at - +y.at)
    .slice(-maxWalks);
  for (const w of walks) {
    events.push({
      type: 'chat_message',
      sender: nameOf(w.from, after.get(w.from)),
      senderId: stableId(w.from),
      recipient: nameOf(w.to, after.get(w.to)),
      recipientId: stableId(w.to),
      text: clip(w.subject, 40) || 'hand-off',
      msg_type: hasOwn(WALK_MSG_TYPE, w.kind) ? WALK_MSG_TYPE[w.kind] : 'message',
      timestamp: Math.floor(+w.at),
    });
  }

  return events;
}

/** The connection strip: 'open' on a good poll, 'closed' when the poll failed. */
export function connectionEvent(ok) {
  return { type: 'connection', socket: ok ? 'open' : 'closed' };
}

/** The postMessage envelope the iframe accepts. */
export function envelope(events) {
  return { type: PROTOCOL, v: PROTOCOL_V, events: Array.isArray(events) ? events : [] };
}
