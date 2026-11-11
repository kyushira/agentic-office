// Unit tests for src/office-flag.js and src/office-frame-model.js (run by `npm test` via node:test).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { officeExactRequested, OFFICE_FLAG_KEY, OFFICE_POLL_MS, pollMsFor } from '../src/office-flag.js';
import { parseFrameMessage, frameScale, isKnownAgent, ROOM_W, ROOM_H } from '../src/office-frame-model.js';
import { diffState } from '../src/office-adapter.js';

const agent = (id, extra = {}) => ({ id, name: id, role: 'developer', remit: 'R', color: '#fff', model: 'M', modelId: 'm',
  status: 'idle', activity: 'idle', lastActive: 1, helpers: [], recent: [], recentHelpers: [], events: [], tools: [], ...extra });

describe('first sync through the adapter (the frame posts diffState(null, state))', () => {
  test('one snapshot seats every present session; offline ones are skipped', () => {
    const state = { ts: 10, agents: [agent('default'), agent('dev'), agent('sentinel', { status: 'offline', activity: 'no data' })] };
    const ev = diffState(null, state);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].type, 'snapshot');
    assert.deepEqual(ev[0].sessions.map(s => s.id), ['default', 'dev']);
  });

  test('a non-object state gives no events (no throw)', () => {
    assert.deepEqual(diffState(null, null), []);
  });
});

describe('pollMsFor (Phase 1d: 4 s only while the exact office is shown)', () => {
  test('the exact office on screen polls at 4000 ms', () => {
    assert.equal(OFFICE_POLL_MS, 4000);
    assert.equal(pollMsFor(true, 15000), 4000);
    assert.equal(pollMsFor(true, 15000 * 2), 4000);
  });

  test('otherwise the base interval is kept (normal and Lite)', () => {
    assert.equal(pollMsFor(false, 15000), 15000);
    assert.equal(pollMsFor(false, 30000), 30000);
    assert.equal(pollMsFor(undefined, 15000), 15000);
    assert.equal(pollMsFor('yes', 15000), 15000);
  });
});

const store = v => () => v;
const throws = () => { throw new Error('SecurityError'); };

describe('officeExactRequested (Phase 1c flag)', () => {
  test('default is off: no hash, nothing stored', () => {
    assert.equal(officeExactRequested('', store(null)), false);
    assert.equal(officeExactRequested('#', store(null)), false);
    assert.equal(officeExactRequested('#home', store(undefined)), false);
  });

  test('hash office=exact turns it on, with or without the tab part', () => {
    assert.equal(officeExactRequested('#office=exact', store(null)), true);
    assert.equal(officeExactRequested('#home?office=exact', store(null)), true);
  });

  test('stored agent-office.officeScene === "exact" turns it on; other values do not', () => {
    assert.equal(OFFICE_FLAG_KEY, 'agent-office.officeScene');
    assert.equal(officeExactRequested('', store('exact')), true);
    assert.equal(officeExactRequested('', store('default')), false);
    assert.equal(officeExactRequested('', store('EXACT')), false);
    assert.equal(officeExactRequested('', store('1')), false);
  });

  test('a throwing storage read (blocked site data) counts as not set, never throws', () => {
    assert.equal(officeExactRequested('', throws), false);
    assert.equal(officeExactRequested('#office=exact', throws), true);
  });

  test('a missing reader or a non-string hash is safe', () => {
    assert.equal(officeExactRequested(undefined, undefined), false);
    assert.equal(officeExactRequested(null, store('exact')), true);
  });
});

describe('parseFrameMessage (inbound from the office iframe)', () => {
  test('ready and pick with a string id are accepted', () => {
    assert.deepEqual(parseFrameMessage({ type: 'hermes-office-ready', v: 1 }), { type: 'ready' });
    assert.deepEqual(parseFrameMessage({ type: 'hermes-office-pick', v: 1, id: 'dev' }), { type: 'pick', id: 'dev' });
  });

  test('wrong version, unknown type, bad or oversized id, and non-objects are rejected', () => {
    assert.equal(parseFrameMessage({ type: 'hermes-office-ready', v: 2 }), null);
    assert.equal(parseFrameMessage({ type: 'hermes-office-ready' }), null);
    assert.equal(parseFrameMessage({ type: 'hermes-office-pick', v: 1, id: 42 }), null);
    assert.equal(parseFrameMessage({ type: 'hermes-office-pick', v: 1, id: '' }), null);
    assert.equal(parseFrameMessage({ type: 'hermes-office-pick', v: 1, id: 'x'.repeat(65) }), null);
    assert.equal(parseFrameMessage({ type: 'something-else', v: 1 }), null);
    assert.equal(parseFrameMessage('hermes-office-ready'), null);
    assert.equal(parseFrameMessage(null), null);
    assert.equal(parseFrameMessage(['hermes-office-ready']), null);
  });
});

describe('frameScale (fit-to-width)', () => {
  test('room is 1056x682 and a pane of that width is scale 1', () => {
    assert.equal(ROOM_W, 1056);
    assert.equal(ROOM_H, 682);
    assert.equal(frameScale(1056), 1);
  });

  test('narrower pane scales down; wider pane never upscales', () => {
    assert.equal(frameScale(528), 0.5);
    assert.equal(frameScale(2000), 1);
  });

  test('unknown or zero width falls back to 1 (never NaN, never 0)', () => {
    assert.equal(frameScale(0), 1);
    assert.equal(frameScale(NaN), 1);
    assert.equal(frameScale(undefined), 1);
  });
});

describe('isKnownAgent (a pick must name a real agent)', () => {
  const state = { agents: [{ id: 'default' }, { id: 'dev' }, null] };
  test('listed ids are known; others, null state and bad rows are not', () => {
    assert.equal(isKnownAgent(state, 'dev'), true);
    assert.equal(isKnownAgent(state, 'default'), true);
    assert.equal(isKnownAgent(state, 'boss'), false);
    assert.equal(isKnownAgent(null, 'dev'), false);
    assert.equal(isKnownAgent({}, 'dev'), false);
  });
});
