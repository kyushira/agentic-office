// Unit tests for src/office-adapter.js (run by `npm test` via node:test).
// Fixtures follow the /state shape built by plugin/agent-office/dashboard/collect.py:
//   { ts, agents: [{id, name, role, remit, status, activity, helpers:[{id,task,model,activity,since}], error?}],
//     walks: [{id, at, from, to, kind, subject}], counts }
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  snapshotEvents, diffState, connectionEvent, envelope, clip, ROLE_BY_PROFILE, MAX_WALKS,
} from '../src/office-adapter.js';

// Ash's /state id is 'default' (collect.py NAMES = {"default": "Ash"}); his stable id is hermes-default.
const PROFILES = ['default', 'dev', 'red', 'nova', 'pixel', 'prism', 'sentinel'];

const agent = (id, extra = {}) => ({
  id, name: id[0].toUpperCase() + id.slice(1), role: 'x', remit: '',
  status: 'idle', activity: 'idle', lastActive: 1, helpers: [], recent: [], ...extra,
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

describe('snapshot (first sync)', () => {
  test('all 7 profiles come online as one snapshot with stable hermes- ids and sprite roles', () => {
    const [snap] = snapshotEvents(seven());
    assert.equal(snap.type, 'snapshot');
    assert.equal(snap.activeAgents.length, 7);
    assert.deepEqual(snap.sessions, []);
    const ids = snap.activeAgents.map(a => a.id).sort();
    assert.deepEqual(ids, PROFILES.map(p => `hermes-${p}`).sort());
    const role = Object.fromEntries(snap.activeAgents.map(a => [a.id, a.role]));
    assert.equal(role['hermes-default'], 'assistant');
    assert.equal(role['hermes-dev'], 'debugger');
    assert.equal(role['hermes-red'], 'Explore');
    assert.equal(role['hermes-sentinel'], 'security-auditor');
    assert.ok(snap.activeAgents.every(a => a.state === 'idle'));
  });

  test('diffState with no prev is the same snapshot', () => {
    assert.deepEqual(diffState(null, seven()), snapshotEvents(seven()));
  });

  test('offline / no-data agents are left out of the snapshot', () => {
    const s = seven({ red: { status: 'offline', activity: 'no data' } });
    const [snap] = snapshotEvents(s);
    assert.equal(snap.activeAgents.length, 6);
    assert.ok(!snap.activeAgents.some(a => a.id === 'hermes-red'));
  });
});

describe('diff: one agent changes', () => {
  test('idle -> working emits agent_working with the activity text', () => {
    const prev = seven();
    const next = withAgent(prev, 'dev', { status: 'working', activity: 'editing src/app.js' });
    assert.deepEqual(diffState(prev, next), [
      { type: 'agent_working', agentId: 'hermes-dev', status: 'editing src/app.js' },
    ]);
  });

  test('activity text is trimmed to 80 characters with an ellipsis', () => {
    const long = 'x'.repeat(200);
    const prev = seven();
    const [ev] = diffState(prev, withAgent(prev, 'dev', { status: 'working', activity: long }));
    assert.equal(ev.type, 'agent_working');
    assert.ok(ev.status.length <= 80);
    assert.ok(ev.status.endsWith('…'));
  });

  test('working text change emits agent_working again, unchanged text does not', () => {
    const p1 = withAgent(seven(), 'dev', { status: 'working', activity: 'reading' });
    const p2 = withAgent(p1, 'dev', { status: 'working', activity: 'writing' });
    assert.equal(byType(diffState(p1, p2), 'agent_working')[0].status, 'writing');
    assert.deepEqual(diffState(p1, withAgent(p1, 'dev', { activity: 'reading ' })), []);
  });

  test('working -> idle emits nothing', () => {
    const p1 = withAgent(seven(), 'dev', { status: 'working', activity: 'reading' });
    const p2 = withAgent(p1, 'dev', { status: 'idle', activity: 'idle' });
    assert.deepEqual(diffState(p1, p2), []);
  });

  test('waiting emits agent_working with a waiting status', () => {
    const prev = seven();
    const [ev] = diffState(prev, withAgent(prev, 'nova', { status: 'waiting', activity: 'waiting for approval' }));
    assert.equal(ev.type, 'agent_working');
    assert.equal(ev.agentId, 'hermes-nova');
    assert.match(ev.status, /^waiting/);
  });

  test('error emits agent_working with an error status', () => {
    const prev = seven();
    const next = withAgent(prev, 'prism', { status: 'error', activity: 'tool failed', error: 'TimeoutError' });
    const [ev] = diffState(prev, next);
    assert.equal(ev.type, 'agent_working');
    assert.match(ev.status, /^error · /);
  });

  test('offline / gone agent walks out with agent_completed', () => {
    const prev = seven();
    const off = diffState(prev, withAgent(prev, 'pixel', { status: 'offline', activity: 'no data' }));
    assert.deepEqual(off, [{ type: 'agent_completed', agentId: 'hermes-pixel', result: '' }]);
    const gone = { ...prev, agents: prev.agents.filter(a => a.id !== 'pixel') };
    assert.deepEqual(diffState(prev, gone), [{ type: 'agent_completed', agentId: 'hermes-pixel', result: '' }]);
  });

  test('an agent that reappears walks in with agent_spawned', () => {
    const prev = withAgent(seven(), 'pixel', { status: 'offline', activity: 'no data' });
    const [ev] = diffState(prev, seven());
    assert.equal(ev.type, 'agent_spawned');
    assert.equal(ev.agent.id, 'hermes-pixel');
    assert.equal(ev.agent.role, ROLE_BY_PROFILE.pixel);
  });
});

describe('helpers', () => {
  test('helper appears under the same session as agent_spawned, then agent_completed when it leaves', () => {
    const h = { id: 'abc123-0', task: 'map the repo', model: 'x', activity: 'reading', since: 1 };
    const p1 = seven();
    const p2 = withAgent(p1, 'dev', { helpers: [h] });
    const up = diffState(p1, p2);
    assert.equal(up.length, 1);
    assert.equal(up[0].type, 'agent_spawned');
    assert.equal(up[0].agent.id, 'hermes-dev:helper:abc123-0');
    assert.equal(up[0].agent.role, 'general-purpose');
    assert.equal(up[0].agent.task, 'map the repo');
    assert.deepEqual(diffState(p2, p1), [
      { type: 'agent_completed', agentId: 'hermes-dev:helper:abc123-0', result: '' },
    ]);
  });

  test('helpers already present at the first sync appear in the snapshot', () => {
    const h = { id: 'h1', task: 't', activity: 'a' };
    const [snap] = snapshotEvents(seven({ dev: { helpers: [h] } }));
    assert.ok(snap.activeAgents.some(a => a.id === 'hermes-dev:helper:h1'));
  });

  test('helper with a bad id is skipped', () => {
    const p1 = seven();
    const p2 = withAgent(p1, 'dev', { helpers: [{ id: '../evil', task: 'x' }, null, 5] });
    assert.deepEqual(diffState(p1, p2), []);
  });
});

describe('hand-offs (walks)', () => {
  const walk = (n, from = 'default', to = 'dev', extra = {}) => ({
    id: `w${n}`, at: 1000 + n, from, to, kind: 'brief', subject: `subject ${n}`, ...extra,
  });

  test('a new walk between two online profiles becomes a chat_message', () => {
    const p1 = seven();
    const p2 = { ...p1, walks: [walk(1)] };
    const [ev] = diffState(p1, p2);
    assert.equal(ev.type, 'chat_message');
    assert.equal(ev.senderId, 'hermes-default');
    assert.equal(ev.recipientId, 'hermes-dev');
    assert.equal(ev.msg_type, 'task_handoff');
    assert.equal(ev.text, 'subject 1');
  });

  test('walks already seen in prev are not repeated', () => {
    const p1 = { ...seven(), walks: [walk(1)] };
    const p2 = { ...seven(), walks: [walk(1), walk(2)] };
    const ev = byType(diffState(p1, p2), 'chat_message');
    assert.equal(ev.length, 1);
    assert.equal(ev[0].text, 'subject 2');
  });

  test('at most MAX_WALKS per diff, newest kept', () => {
    assert.equal(MAX_WALKS, 3);
    const p1 = seven();
    const p2 = { ...p1, walks: [1, 2, 3, 4, 5].map(n => walk(n)) };
    const ev = byType(diffState(p1, p2), 'chat_message');
    assert.equal(ev.length, 3);
    assert.deepEqual(ev.map(e => e.text), ['subject 3', 'subject 4', 'subject 5']);
  });

  test('walks with an offline or unknown endpoint, or from === to, are skipped', () => {
    const p1 = withAgent(seven(), 'red', { status: 'offline', activity: 'no data' });
    const p2 = {
      ...p1,
      walks: [walk(1, 'default', 'red'), walk(2, 'dev', 'dev'), walk(3, 'default', 'ghost')],
    };
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

  test('a row missing optional fields still produces a valid spawn', () => {
    const [ev] = diffState({ agents: [] }, { agents: [{ id: 'dev' }] });
    assert.equal(ev.type, 'agent_spawned');
    assert.equal(ev.agent.id, 'hermes-dev');
    assert.equal(ev.agent.name, 'dev');
  });
});
