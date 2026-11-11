// Deck-side Hermes -> Claude-Office adapter. Pure: no DOM, no fetch, no timers, no window.
// The Deck's Home polls GET /api/plugins/agent-office/state (every 4 s while the exact office is shown);
// it calls diffState(prev, next) on each good poll and postMessage()s the envelope into the iframe.
//
// DECISION (Phase 1d): SESSION PER PROFILE, WITH A ROLE SPRITE.
// Each Hermes profile is a session: sessionId = the profile id ('default' for Ash, 'dev', 'red', ...).
// Its character is the session's own Claude (`main-<profile>`, officeReducer ensureClaude), which has the
// native main-thread states idle / working / needs-you / error and a status line. The reducer's
// ensureClaude takes name and role from the session info (Phase 1d patch), so the sprite is the profile's
// role (ROLE_BY_PROFILE, a ROLE_TO_CHAR key) and the name is the /state name. Each session takes a free desk
// (spawnAgent falls back to pickSpot when the preferred desk is taken).
// Why not the plain agent path (Phase 1b): agent_working never leaves 'working' in the reducer, so a
// character typed forever. Session events give idle/working/needs-you/error from the same /state row.
// Helpers are native subagents of their parent session: agent_spawned with the parent's sessionId.
//
// Event mapping (state fields are the real /state shape from plugin/agent-office/dashboard/collect.py):
//   first diff (prev null)            -> snapshot {activeAgents: helpers, sessions: [...], timestamp}  (seats everyone)
//   profile online (was absent/off)   -> session_started {sessionId, name, role, task, main}          (walks in)
//   idle -> working                   -> session_prompt (boss hands over; no text) + session_main {main.lastPrompt}
//   working, activity text changes    -> session_main {main: {state: working, lastPrompt: activity}}   (bubble text)
//   working / waiting / error -> idle -> session_turn_end {main: {state: idle}}
//   waiting                           -> session_needs_you (kind 'permission' if activity says approval, else soft 'idle')
//   error (error text)                -> session_error {error: text}
//   offline or gone (no DB)           -> helpers agent_completed, then session_ended {reason: offline}  (walks out)
//   read failed (status offline + error) -> session_error, the Claude stays in error until the read recovers
//   helpers[] id added / removed      -> agent_spawned / agent_completed, sessionId = parent profile
//   helper activity text changes      -> agent_working {agentId: helper, status}
//   walks[] new id (A -> B)           -> chat_message {sender, senderId: main-A, recipient, recipientId: main-B}
//                                        (the reducer's A2A visit), newest MAX_WALKS per diff
//   every good poll / failed poll     -> connectionEvent(true|false)  (the caller adds it to the envelope)
//   /usage -> session_status          -> TODO Phase 3: /state has no usage fields; /usage is a separate endpoint.
//
// Only ids, names, roles, status and activity text leave this module. Nothing else from /state is copied.

export const PROTOCOL = 'hermes-office';
export const PROTOCOL_V = 1;
export const MAX_TEXT = 80;
export const MAX_WALKS = 3;

const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const HELPER_RE = /^[A-Za-z0-9_-]{1,40}$/;
// A waiting row whose activity names an approval is a permission wait (hard: the scene's needs-you hand);
// any other wait is soft ('idle': Claude Code's idle prompt, no chime, no title hand).
const APPROVAL_RE = /approv|permission/i;

// Profile -> reducer role. Each value is a ROLE_TO_CHAR key in office-src/src/config.ts (sprite, no new art).
// 'default' is Ash (collect.py NAMES). 'Explore' keeps its FILING_ROLES behaviour (it browses the cabinet).
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

/** The session's Claude agent id in the reducer (mainId in mainState.ts is `main-<sessionId>`). */
export const mainId = profile => `main-${profile}`;
export const helperId = (profile, hid) => `hermes-${profile}:helper:${hid}`;

// present: the /state row is online. collect.py sets status 'offline' + activity 'no data' when the profile has
// no DB (gone), and status 'offline' + error '<ExceptionName>' when a read failed (still here, in error).
const present = a => {
  if (a.activity === 'no data') return false;
  if (a.status === 'offline') return typeof a.error === 'string' && a.error !== '';
  return true;
};

// Bucket matches agents-model.js statusOf, so the scene and the Agents grid agree.
function bucket(a) {
  if (a.error || a.status === 'error' || a.status === 'failed') return 'error';
  if (a.status === 'working') return 'running';
  if (a.status === 'waiting') return 'waiting';
  return 'idle';
}

const errorText = a => clip(typeof a.error === 'string' ? a.error : '', 60) || clip(a.activity, 60) || 'failed';

/** What a change in the session's state must show: the text the reducer will print (empty when idle). */
function keyOf(a, b) {
  if (b === 'running' || b === 'waiting') return clip(a.activity);
  if (b === 'error') return errorText(a);
  return '';
}

/** The session's main-thread record (the server's SessionMain shape the reducer reads). */
function mainOf(a) {
  const b = bucket(a);
  if (b === 'running') {
    const act = clip(a.activity);
    return act ? { state: 'working', lastPrompt: act } : { state: 'working' };
  }
  if (b === 'waiting') {
    const kind = APPROVAL_RE.test(String(a.activity || '')) ? 'permission' : 'idle';
    return { state: 'needs-you', needsYou: { kind, summary: clip(a.activity, 60) || undefined } };
  }
  if (b === 'error') return { state: 'error', error: { error: errorText(a) } };
  return { state: 'idle' };
}

function nameOf(profile, a) {
  return clip(a && a.name, 40) || profile;
}

/** Fields that name and role the session's Claude (ensureClaude reads them, Phase 1d). */
function sessionFields(profile, a) {
  const out = { sessionId: profile, name: nameOf(profile, a), role: roleOf(profile) };
  const task = clip(a.remit);
  if (task) out.task = task;
  return out;
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

/** A helper is a native subagent of its parent session: the parent's sessionId, no desk of its own. */
function helperFields(profile, a, hid, h) {
  const out = {
    id: helperId(profile, hid),
    name: clip(`${nameOf(profile, a)} helper`, 40),
    role: HELPER_ROLE,
    sessionId: profile,
  };
  const task = clip(h.task);
  if (task) out.task = task;
  out.status = clip(h.activity) || 'working';
  return out;
}

/** The session-state events for a session that is online and whose state or text changed. b0/b1: buckets. */
function transitionEvents(profile, a1, b0, b1) {
  const sid = profile;
  if (b1 === 'running') {
    const out = [];
    // The boss hands the prompt over only when the turn starts (idle -> working), never on each text change
    if (b0 === 'idle') out.push({ type: 'session_prompt', sessionId: sid });
    out.push({ type: 'session_main', sessionId: sid, main: mainOf(a1), ...(b0 === 'waiting' ? { reason: 'answered' } : {}) });
    return out;
  }
  if (b1 === 'idle') return [{ type: 'session_turn_end', sessionId: sid, main: { state: 'idle' } }];
  if (b1 === 'waiting') return [{ type: 'session_needs_you', sessionId: sid, main: mainOf(a1) }];
  return [{ type: 'session_error', sessionId: sid, error: errorText(a1), main: mainOf(a1) }];
}

/** One online session row for the snapshot's sessions[] (the reducer's SessionInfo). */
function sessionRow(profile, a) {
  return { id: profile, ...sessionFields(profile, a), state: 'active', hooked: true, main: mainOf(a) };
}

/** First sync: every online profile as a session (seats its Claude) plus its live helpers. One snapshot. */
export function snapshotEvents(state, opts = {}) {
  const activeAgents = [];
  const sessions = [];
  for (const [pid, a] of agentsById(state)) {
    if (!present(a)) continue;
    sessions.push(sessionRow(pid, a));
    for (const [hid, h] of helpersOf(a)) {
      activeAgents.push({ ...helperFields(pid, a, hid, h), state: 'working' });
    }
  }
  return [{ type: 'snapshot', activeAgents, sessions, timestamp: timestampOf(state, opts) }];
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

  // Gone or offline: its helpers go first, then the session ends and its Claude walks out after the grace.
  for (const [pid, a0] of before) {
    if (!present(a0)) continue;
    const a1 = after.get(pid);
    if (a1 && present(a1)) continue;
    for (const hid of helpersOf(a0).keys()) {
      events.push({ type: 'agent_completed', agentId: helperId(pid, hid), result: '' });
    }
    events.push({ type: 'session_ended', sessionId: pid, reason: 'offline' });
  }

  for (const [pid, a1] of after) {
    if (!present(a1)) continue;
    const a0 = before.get(pid);
    if (!a0 || !present(a0)) {
      events.push({ type: 'session_started', ...sessionFields(pid, a1), main: mainOf(a1) });
      for (const [hid, h] of helpersOf(a1)) {
        events.push({ type: 'agent_spawned', agent: helperFields(pid, a1, hid, h) });
      }
      continue;
    }
    const b0 = bucket(a0);
    const b1 = bucket(a1);
    if (b0 !== b1 || keyOf(a0, b0) !== keyOf(a1, b1)) {
      events.push(...transitionEvents(pid, a1, b0, b1));
    }
    const h0 = helpersOf(a0);
    const h1 = helpersOf(a1);
    for (const [hid, h] of h1) {
      if (!h0.has(hid)) {
        events.push({ type: 'agent_spawned', agent: helperFields(pid, a1, hid, h) });
      } else {
        const t0 = clip(h0.get(hid).activity), t1 = clip(h.activity);
        if (t0 !== t1) events.push({ type: 'agent_working', agentId: helperId(pid, hid), status: t1 || 'working' });
      }
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
      senderId: mainId(w.from),
      recipient: nameOf(w.to, after.get(w.to)),
      recipientId: mainId(w.to),
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
