// Unit tests for src/agents-model.js (run by `npm test` via node:test).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { statusOf, filterAgents, counts, pulseIds, cardView, inboxRow, FILTERS } from '../src/agents-model.js';

const now = 1_800_000_000_000;          // ms, as the component receives it
const sec = now / 1000;

const ag = (id, status, extra = {}) => ({ id, name: id.toUpperCase(), status, activity: 'idle', lastActive: sec - 120, ...extra });

describe('statusOf', () => {
  test('working is running', () => {
    assert.equal(statusOf(ag('a', 'working')), 'running');
  });
  test('waiting is waiting', () => {
    assert.equal(statusOf(ag('a', 'waiting')), 'waiting');
  });
  test('idle is idle', () => {
    assert.equal(statusOf(ag('a', 'idle')), 'idle');
  });
  test('offline without an error field is idle (All only)', () => {
    assert.equal(statusOf(ag('a', 'offline')), 'idle');
  });
  test('an error field marks the agent as error, whatever its status', () => {
    assert.equal(statusOf(ag('a', 'offline', { error: 'OperationalError' })), 'error');
    assert.equal(statusOf(ag('a', 'working', { error: 'x' })), 'error');
  });
  test('error and failed statuses are error', () => {
    assert.equal(statusOf(ag('a', 'error')), 'error');
    assert.equal(statusOf(ag('a', 'failed')), 'error');
  });
  test('missing agent or missing status is idle, not a crash', () => {
    assert.equal(statusOf(null), 'idle');
    assert.equal(statusOf({ id: 'x' }), 'idle');
  });
});

describe('filterAgents and counts', () => {
  const agents = [
    ag('a', 'working'), ag('b', 'waiting'), ag('c', 'idle'),
    ag('d', 'offline', { error: 'OSError' }), ag('e', 'working'),
  ];
  test('All returns every agent in order', () => {
    assert.deepEqual(filterAgents(agents, 'all').map(a => a.id), ['a', 'b', 'c', 'd', 'e']);
  });
  test('Running, Waiting and Error filter by bucket', () => {
    assert.deepEqual(filterAgents(agents, 'running').map(a => a.id), ['a', 'e']);
    assert.deepEqual(filterAgents(agents, 'waiting').map(a => a.id), ['b']);
    assert.deepEqual(filterAgents(agents, 'error').map(a => a.id), ['d']);
  });
  test('unknown filter behaves as All', () => {
    assert.equal(filterAgents(agents, 'nope').length, 5);
  });
  test('counts: idle agents appear in All only', () => {
    assert.deepEqual(counts(agents), { all: 5, running: 2, waiting: 1, error: 1 });
  });
  test('counts of nothing is all zeros', () => {
    assert.deepEqual(counts([]), { all: 0, running: 0, waiting: 0, error: 0 });
    assert.deepEqual(counts(undefined), { all: 0, running: 0, waiting: 0, error: 0 });
  });
  test('filter list is the four segmented-control values', () => {
    assert.deepEqual(FILTERS, ['all', 'running', 'waiting', 'error']);
  });
  test('filterAgents tolerates a missing list', () => {
    assert.deepEqual(filterAgents(undefined, 'all'), []);
  });
});

describe('pulseIds', () => {
  test('caps the pulse at three running agents, in agent order', () => {
    const agents = [ag('a', 'working'), ag('b', 'working'), ag('c', 'waiting'), ag('d', 'working'), ag('e', 'working')];
    assert.deepEqual(pulseIds(agents), ['a', 'b', 'd']);
  });
  test('fewer than three running gives only those', () => {
    assert.deepEqual(pulseIds([ag('a', 'idle'), ag('b', 'working')]), ['b']);
  });
  test('no running agents gives no pulse', () => {
    assert.deepEqual(pulseIds([ag('a', 'waiting'), ag('b', 'offline', { error: 'x' })]), []);
  });
  test('an explicit max is honoured and never exceeded', () => {
    const agents = [ag('a', 'working'), ag('b', 'working')];
    assert.deepEqual(pulseIds(agents, 1), ['a']);
    assert.deepEqual(pulseIds(agents, 0), []);
  });
  test('missing list is safe', () => {
    assert.deepEqual(pulseIds(null), []);
  });
});

describe('cardView', () => {
  test('running agent: status word, time from lastActive, harness from model', () => {
    const v = cardView(ag('dev', 'working', { activity: 'running commands · PokeSurvivor', model: 'Opus 5.5', lastActive: sec - 30 }), [], now);
    assert.equal(v.id, 'dev');
    assert.equal(v.status, 'running');
    assert.equal(v.word, 'Running');
    assert.equal(v.harness, 'Opus 5.5');
    assert.equal(v.task, 'running commands · PokeSurvivor');
    assert.equal(v.time, 'now');
  });
  test('waiting and error words', () => {
    assert.equal(cardView(ag('a', 'waiting'), [], now).word, 'Waiting');
    assert.equal(cardView(ag('a', 'offline', { error: 'x', activity: 'data unavailable' }), [], now).word, 'Error');
    assert.equal(cardView(ag('a', 'error'), [], now).word, 'Error');
  });
  test('idle and offline words', () => {
    assert.equal(cardView(ag('a', 'idle'), [], now).word, 'Idle');
    assert.equal(cardView(ag('a', 'offline'), [], now).word, 'Offline');
  });
  test('harness prefers harness, then provider, then model, else null', () => {
    assert.equal(cardView(ag('a', 'idle', { harness: 'Codex', provider: 'OpenAI', model: 'GPT' }), [], now).harness, 'Codex');
    assert.equal(cardView(ag('a', 'idle', { provider: 'DeepSeek', model: 'V4' }), [], now).harness, 'DeepSeek');
    assert.equal(cardView(ag('a', 'idle'), [], now).harness, null);
  });
  test('task falls back to the working session step when activity is empty', () => {
    const v = cardView(ag('a', 'working', { activity: '' }), [{ status: 'done', step: 'x' }, { status: 'working', step: 'reading files' }], now);
    assert.equal(v.task, 'reading files');
  });
  test('task is an em dash when nothing says what the agent is doing', () => {
    assert.equal(cardView(ag('a', 'idle', { activity: '' }), undefined, now).task, '—');
  });
  test('missing lastActive shows an em dash', () => {
    assert.equal(cardView(ag('a', 'idle', { lastActive: null }), [], now).time, '—');
  });
  test('missing name falls back to the id; missing agent does not throw', () => {
    assert.equal(cardView({ id: 'zed', status: 'idle' }, [], now).name, 'zed');
    const v = cardView(null, null, null);
    assert.equal(v.status, 'idle');
    assert.equal(v.word, 'Idle');
  });
});

describe('inboxRow', () => {
  test('keeps title, agent and an ago time when the item has a timestamp', () => {
    const r = inboxRow({ id: 'ash', name: 'Ash', label: 'asking a question', at: sec - 600 }, now);
    assert.deepEqual(r, { id: 'ash', name: 'Ash', label: 'asking a question', time: '10m ago' });
  });
  test('no timestamp gives a null time (the row shows no time)', () => {
    assert.equal(inboxRow({ id: 'ash', name: 'Ash', label: 'waiting for approval' }, now).time, null);
  });
  test('missing fields fall back safely', () => {
    const r = inboxRow({ id: 'dev' }, now);
    assert.equal(r.name, 'dev');
    assert.equal(r.label, 'Needs you');
    assert.equal(inboxRow(null, now).label, 'Needs you');
  });
});
