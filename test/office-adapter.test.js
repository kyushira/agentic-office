// Unit tests for src/office-adapter.js (run by `npm test` via node:test).
// Fixtures follow the /state shape built by plugin/agent-office/dashboard/collect.py:
//   { ts (seconds), agents: [{id, name, role, remit, status, activity, error?, helpers:[{id,task,model,activity,since}]}],
//     walks: [{id, at (seconds), from, to, kind, subject}], counts }
// Phase 1d mapping: each profile is a session (sessionId = profile id) whose Claude is the native main agent.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  snapshotEvents, diffState, connectionEvent, envelope, clip, ROLE_BY_PROFILE, MAX_WALKS, mainId,
} from '../src/office-adapter.js';

const PROFILES = ['default', 'dev', 'red', 'nova', 'pixel', 'prism', 'sentinel'];
const NAMES = { default: 'Ash', dev: 'Dev', red: 'Red', nova: 'Nova', pixel: 'Pixel', prism: 'Prism', sentinel: 'Sentinel' };

const agent = (id, extra = {}) => ({
  id, name: NAMES[id], role: 'x', remit: `${NAMES[id]} remit`, status: 'idle', activity: 'idle',
  lastActive: 1, helpers: [], recent: [], ...extra,
});
const seven = (over = {}) => ({
  ts: 1_800_000_000,
  agents: PROFILES.map(p => agent(p, over[p] || {})),
  walks: [],
});
const withAgent = (state, id, patch) => ({
  ...state, agents: state.agents.map(a => (a.id === id ? { ...a, ...patch } : a)),
});
const byType = (events, type) => events.filter(e => e.type === type);

describe('first sync: snapshot seats every session and helper', () => {
  test('all 7 profiles become sessions with name, role and task; no helpers', () => {
    const [snap] = snapshotEvents(seven());
    assert.equal(snap.type, 'snapshot');
    assert.equal(snap.sessions.length, 7);
    assert.deepEqual(snap.activeAgents, []);
    const byId = Object.fromEntries(snap.sessions.map(s => [s.id, s]));
    assert.equal(byId.default.name, 'Ash');
    assert.equal(byId.default.role, 'assistant');
    assert.equal(byId.dev.role, 'debugger');
    assert.equal(byId.red.role, 'Explore');
    assert.equal(byId.sentinel.role, 'security-auditor');
    assert.equal(byId.dev.task, 'Dev remit');
    assert.ok(snap.sessions.every(s => s.state === 'active' && s.hooked === true && s.main.state === 'idle'));
  });

  test('the role table covers the seven profiles with the ROLE_TO_CHAR keys', () => {
    assert.deepEqual(Object.keys(ROLE_BY_PROFILE).sort(), [...PROFILES].sort());
    assert.equal(ROLE_BY_PROFILE.nova, 'frontend-developer');
    assert.equal(ROLE_BY_PROFILE.pixel, 'test-engineer');
    assert.equal(ROLE_BY_PROFILE.prism, 'code-reviewer');
  });

  test('a helper present at the first sync is an activeAgent under its parent session', () => {
    const h = { id: 'h1', task: 't', activity: 'reading' };
    const [snap] = snapshotEvents(seven({ dev: { helpers: [h] } }));
    assert.equal(snap.activeAgents.length, 1);
    assert.equal(snap.activeAgents[0].id, 'hermes-dev:helper:h1');
    assert.equal(snap.activeAgents[0].sessionId, 'dev');
  });

  test('diffState with no prev is the same snapshot', () => {
    assert.deepEqual(diffState(null, seven()), snapshotEvents(seven()));
  });

  test('a profile with no DB (offline, no data) is left out', () => {
    const [snap] = snapshotEvents(seven({ red: { status: 'offline', activity: 'no data' } }));
    assert.equal(snap.sessions.length, 6);
    assert.ok(!snap.sessions.some(s => s.id === 'red'));
  });

  test('a read failure (offline with an error) is still seated, in error', () => {
    const [snap] = snapshotEvents(seven({ prism: { status: 'offline', activity: 'data unavailable', error: 'OperationalError' } }));
    const prism = snap.sessions.find(s => s.id === 'prism');
    assert.ok(prism);
    assert.equal(prism.main.state, 'error');
  });
});

describe('session states follow /state', () => {
  test('idle -> working: session_prompt (the boss hands over) then session_main with the activity text', () => {
    const p1 = seven();
    const p2 = withAgent(p1, 'dev', { status: 'working', activity: 'editing src/app.js' });
    const ev = diffState(p1, p2);
    assert.deepEqual(ev.map(e => e.type), ['session_prompt', 'session_main']);
    assert.equal(ev[0].sessionId, 'dev');
    assert.equal(ev[1].main.state, 'working');
    assert.equal(ev[1].main.lastPrompt, 'editing src/app.js');
  });

  test('a working text change sends only session_main (no second boss hand-over)', () => {
    const p1 = withAgent(seven(), 'dev', { status: 'working', activity: 'reading' });
    const p2 = withAgent(p1, 'dev', { status: 'working', activity: 'writing' });
    const ev = diffState(p1, p2);
    assert.deepEqual(ev.map(e => e.type), ['session_main']);
    assert.equal(ev[0].main.lastPrompt, 'writing');
  });

  test('the same working text sends nothing; trailing whitespace is not a change', () => {
    const p1 = withAgent(seven(), 'dev', { status: 'working', activity: 'reading' });
    assert.deepEqual(diffState(p1, withAgent(p1, 'dev', { activity: 'reading ' })), []);
  });

  test('activity text is trimmed to 80 characters with an ellipsis', () => {
    const prev = seven();
    const [, main] = diffState(prev, withAgent(prev, 'dev', { status: 'working', activity: 'x'.repeat(200) }));
    assert.ok(main.main.lastPrompt.length <= 80);
    assert.ok(main.main.lastPrompt.endsWith('…'));
  });

  test('working -> idle: session_turn_end with idle', () => {
    const p1 = withAgent(seven(), 'dev', { status: 'working', activity: 'reading' });
    const ev = diffState(p1, withAgent(p1, 'dev', { status: 'idle', activity: 'idle' }));
    assert.deepEqual(ev, [{ type: 'session_turn_end', sessionId: 'dev', main: { state: 'idle' } }]);
  });

  test('waiting on an approval: session_needs_you with a permission kind (hard)', () => {
    const prev = seven();
    const [ev] = diffState(prev, withAgent(prev, 'nova', { status: 'waiting', activity: 'waiting for approval' }));
    assert.equal(ev.type, 'session_needs_you');
    assert.equal(ev.sessionId, 'nova');
    assert.equal(ev.main.state, 'needs-you');
    assert.equal(ev.main.needsYou.kind, 'permission');
  });

  test('any other wait is a soft idle wait (no chime, no hand)', () => {
    const prev = seven();
    const [ev] = diffState(prev, withAgent(prev, 'nova', { status: 'waiting', activity: 'waiting on a reply' }));
    assert.equal(ev.type, 'session_needs_you');
    assert.equal(ev.main.needsYou.kind, 'idle');
  });

  test('error: session_error carries the error text and main.state error', () => {
    const prev = seven();
    const [ev] = diffState(prev, withAgent(prev, 'prism', { status: 'offline', activity: 'data unavailable', error: 'TimeoutError' }));
    assert.equal(ev.type, 'session_error');
    assert.equal(ev.sessionId, 'prism');
    assert.equal(ev.error, 'TimeoutError');
    assert.equal(ev.main.state, 'error');
  });

  test('a read failure that is still reported leaves the session in error, not ended', () => {
    const prev = seven();
    const ev = diffState(prev, withAgent(prev, 'prism', { status: 'offline', activity: 'data unavailable', error: 'E' }));
    assert.deepEqual(byType(ev, 'session_ended'), []);
    assert.equal(byType(ev, 'session_error').length, 1);
  });

  test('offline (no DB): helpers complete first, then session_ended walks the Claude out', () => {
    const h = { id: 'a1', task: 't', activity: 'x' };
    const prev = seven({ pixel: { helpers: [h] } });
    const ev = diffState(prev, withAgent(prev, 'pixel', { status: 'offline', activity: 'no data' }));
    assert.deepEqual(ev, [
      { type: 'agent_completed', agentId: 'hermes-pixel:helper:a1', result: '' },
      { type: 'session_ended', sessionId: 'pixel', reason: 'offline' },
    ]);
  });

  test('a profile that disappears from /state ends the same way', () => {
    const prev = seven();
    const gone = { ...prev, agents: prev.agents.filter(a => a.id !== 'pixel') };
    assert.deepEqual(diffState(prev, gone), [{ type: 'session_ended', sessionId: 'pixel', reason: 'offline' }]);
  });

  test('a profile that comes back online walks in with session_started (name, role, main)', () => {
    const prev = withAgent(seven(), 'pixel', { status: 'offline', activity: 'no data' });
    const [ev] = diffState(prev, seven());
    assert.equal(ev.type, 'session_started');
    assert.equal(ev.sessionId, 'pixel');
    assert.equal(ev.name, 'Pixel');
    assert.equal(ev.role, 'test-engineer');
    assert.equal(ev.main.state, 'idle');
  });

  test('mainId is the reducer main-agent id', () => {
    assert.equal(mainId('dev'), 'main-dev');
  });
});

describe('helpers are native subagents of their parent session', () => {
  test('helper up: agent_spawned with the parent sessionId; helper down: agent_completed', () => {
    const h = { id: 'abc123-0', task: 'map the repo', model: 'x', activity: 'reading', since: 1 };
    const p1 = seven();
    const p2 = withAgent(p1, 'dev', { helpers: [h] });
    const up = diffState(p1, p2);
    assert.equal(up.length, 1);
    assert.equal(up[0].type, 'agent_spawned');
    assert.equal(up[0].agent.id, 'hermes-dev:helper:abc123-0');
    assert.equal(up[0].agent.sessionId, 'dev');
    assert.equal(up[0].agent.role, 'general-purpose');
    assert.equal(up[0].agent.task, 'map the repo');
    assert.deepEqual(diffState(p2, p1), [{ type: 'agent_completed', agentId: 'hermes-dev:helper:abc123-0', result: '' }]);
  });

  test('a helper activity change is agent_working on the helper', () => {
    const p1 = seven({ dev: { helpers: [{ id: 'h', task: 't', activity: 'reading' }] } });
    const p2 = seven({ dev: { helpers: [{ id: 'h', task: 't', activity: 'writing' }] } });
    assert.deepEqual(diffState(p1, p2), [{ type: 'agent_working', agentId: 'hermes-dev:helper:h', status: 'writing' }]);
  });

  test('a helper with a bad id is skipped', () => {
    const p1 = seven();
    const p2 = withAgent(p1, 'dev', { helpers: [{ id: '../evil', task: 'x' }, null, 5] });
    assert.deepEqual(diffState(p1, p2), []);
  });
});

describe('hand-offs (walks)', () => {
  const walk = (n, from = 'default', to = 'dev', extra = {}) => ({
    id: `w${n}`, at: 1000 + n, from, to, kind: 'brief', subject: `subject ${n}`, ...extra,
  });

  test('a new walk between two online profiles becomes a chat_message between their Claudes', () => {
    const p1 = seven();
    const [ev] = diffState(p1, { ...p1, walks: [walk(1)] });
    assert.equal(ev.type, 'chat_message');
    assert.equal(ev.senderId, 'main-default');
    assert.equal(ev.recipientId, 'main-dev');
    assert.equal(ev.sender, 'Ash');
    assert.equal(ev.msg_type, 'task_handoff');
    assert.equal(ev.text, 'subject 1');
  });

  test('walks already seen in prev are not repeated', () => {
    const p1 = { ...seven(), walks: [walk(1)] };
    const ev = byType(diffState(p1, { ...seven(), walks: [walk(1), walk(2)] }), 'chat_message');
    assert.deepEqual(ev.map(e => e.text), ['subject 2']);
  });

  test(`at most MAX_WALKS (${3}) per diff, newest kept`, () => {
    assert.equal(MAX_WALKS, 3);
    const p1 = seven();
    const ev = byType(diffState(p1, { ...p1, walks: [1, 2, 3, 4, 5].map(n => walk(n)) }), 'chat_message');
    assert.deepEqual(ev.map(e => e.text), ['subject 3', 'subject 4', 'subject 5']);
  });

  test('walks with an offline or unknown endpoint, or from === to, are skipped', () => {
    const p1 = withAgent(seven(), 'red', { status: 'offline', activity: 'no data' });
    const p2 = { ...p1, walks: [walk(1, 'default', 'red'), walk(2, 'dev', 'dev'), walk(3, 'default', 'ghost')] };
    assert.deepEqual(byType(diffState(p1, p2), 'chat_message'), []);
  });
});

describe('connection and envelope', () => {
  test('connectionEvent maps good and failed polls to the reducer socket field', () => {
    assert.deepEqual(connectionEvent(true), { type: 'connection', socket: 'open' });
    assert.deepEqual(connectionEvent(false), { type: 'connection', socket: 'closed' });
  });

  test('envelope carries the protocol tag, version and events', () => {
    const env = envelope(snapshotEvents(seven()));
    assert.equal(env.type, 'hermes-office');
    assert.equal(env.v, 1);
    assert.equal(env.events.length, 1);
    assert.deepEqual(envelope(null).events, []);
  });

  test('no token-looking or extra fields leave the adapter', () => {
    const s = seven({ dev: { token: 'SECRET-123', secret: 'x', password: 'y', status: 'working', activity: 'a' } });
    const text = JSON.stringify(snapshotEvents(s)) + JSON.stringify(diffState(seven(), s));
    assert.ok(!text.includes('SECRET-123'));
    assert.ok(!/"token"|"secret"|"password"/.test(text));
  });

  test('clip collapses whitespace and tolerates non-strings', () => {
    assert.equal(clip('  a \n  b  '), 'a b');
    assert.equal(clip(42), '');
    assert.equal(clip('x'.repeat(100), 10).length, 10);
  });
});

describe('malformed input never throws', () => {
  const junk = [
    undefined, null, 0, 'x', [], {}, { agents: 'nope' }, { agents: [null, 1, 'a', { id: 5 }] },
    { agents: [{ id: 'dev' }] }, { agents: [{ id: 'dev', status: 'working', helpers: 'x' }] },
    { agents: [{ id: 'dev', status: 'working', helpers: [null, { id: {} }] }], walks: 'x' },
    { agents: [{ id: 'dev', status: 'working' }], walks: [null, {}, { id: 'a', from: 'dev' }] },
  ];

  test('snapshotEvents and diffState survive every junk input in both positions', () => {
    for (const bad of junk) {
      assert.doesNotThrow(() => snapshotEvents(bad));
      assert.doesNotThrow(() => diffState(bad, seven()));
      assert.doesNotThrow(() => diffState(seven(), bad));
      assert.doesNotThrow(() => diffState(bad, bad));
    }
    assert.deepEqual(diffState(seven(), null), []);
    assert.deepEqual(diffState(seven(), 'junk'), []);
  });

  test('a row missing optional fields still produces a valid session_started', () => {
    const [ev] = diffState({ agents: [] }, { agents: [{ id: 'dev' }] });
    assert.equal(ev.type, 'session_started');
    assert.equal(ev.sessionId, 'dev');
    assert.equal(ev.name, 'dev');
  });
});
