// Unit tests for src/mc-model.js (run by `npm test` via node:test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeRows, newIds, statusCounts, shortTime, agentColor, agentName, chipLabel, commsFor,
  feedQuery, commsQuery, thinkLabel, callParts, typeStep, showThoughtsNote, mergeThinking, MC_CAP,
} from '../src/mc-model.js';

test('mergeThinking: union across polls, first-seen order, nothing lost on an empty poll', () => {
  assert.deepEqual(mergeThinking(['dev'], []), ['dev']);
  assert.deepEqual(mergeThinking(null, ['ash']), ['ash']);
  assert.deepEqual(mergeThinking(['dev'], ['ash', 'dev']), ['dev', 'ash']);
  assert.deepEqual(mergeThinking([], []), []);
  assert.deepEqual(mergeThinking(undefined, undefined), []);
});

test('mergeRows: dedupes by id, newest first, incoming copy wins, capped', () => {
  const old = [{ id: 'a', ts: 10, text: 'old-a' }, { id: 'b', ts: 5 }];
  const incoming = [{ id: 'c', ts: 20 }, { id: 'a', ts: 10, text: 'new-a' }];
  const out = mergeRows(old, incoming);
  assert.deepEqual(out.map(r => r.id), ['c', 'a', 'b']);
  assert.equal(out[1].text, 'new-a');
  assert.equal(mergeRows(null, incoming).length, 2);
  const many = Array.from({ length: MC_CAP + 20 }, (_, i) => ({ id: 'r' + i, ts: i }));
  const capped = mergeRows([], many);
  assert.equal(capped.length, MC_CAP);
  assert.equal(capped[0].id, 'r' + (MC_CAP + 19));
});

test('mergeRows: ignores rows without an id', () => {
  assert.deepEqual(mergeRows([], [null, { ts: 1 }, { id: 'x', ts: 2 }]).map(r => r.id), ['x']);
});

test('newIds: first load has nothing new; later polls report only unseen ids', () => {
  assert.deepEqual(newIds(null, [{ id: 'a' }]), []);
  assert.deepEqual(newIds([{ id: 'a' }], [{ id: 'b' }, { id: 'a' }]), ['b']);
  assert.deepEqual(newIds([{ id: 'a' }], []), []);
});

test('statusCounts: only the statuses /state reports, no stuck count', () => {
  const agents = [
    { id: 'a', status: 'working' }, { id: 'b', status: 'waiting' }, { id: 'c', status: 'idle' },
    { id: 'd', status: 'idle' }, { id: 'e', status: 'offline' }, { id: 'f', status: 'mystery' }, null,
  ];
  const c = statusCounts(agents);
  assert.deepEqual(c, { working: 1, waiting: 1, idle: 2, offline: 1 });
  assert.equal('stuck' in c, false);
  assert.deepEqual(statusCounts(undefined), { working: 0, waiting: 0, idle: 0, offline: 0 });
});

test('shortTime: local HH:MM:SS, placeholder when missing', () => {
  const ts = new Date(2026, 10, 6, 9, 5, 7).getTime() / 1000;
  assert.equal(shortTime(ts), '09:05:07');
  assert.equal(shortTime(null), '--:--:--');
});

test('agentColor and agentName fall back safely', () => {
  assert.equal(agentColor({ color: '#38D6F0' }), '#38D6F0');
  assert.equal(agentColor({}), '#8a8a8a');
  assert.equal(agentName([{ id: 'dev', name: 'Dev' }], 'dev'), 'Dev');
  assert.equal(agentName([], 'ghost'), 'ghost');
});

test('chipLabel: status plus the real /state activity text', () => {
  assert.equal(chipLabel({ status: 'working', activity: 'running commands · PokeSurvivor' }), 'working · running commands · PokeSurvivor');
  assert.equal(chipLabel({ status: 'idle', activity: 'idle · last: writing files' }), 'idle · last: writing files');
  assert.equal(chipLabel({ status: 'idle', activity: 'idle' }), 'idle');
  assert.equal(chipLabel({ status: 'offline', activity: '' }), 'offline');
  assert.equal(chipLabel({ status: 'waiting', activity: 'waiting for approval' }), 'waiting for approval');
});

test('commsFor: filters by sender or receiver, no agent keeps all', () => {
  const rows = [{ id: 1, from: 'dev', to: 'ash' }, { id: 2, from: 'red', to: 'dev' }, { id: 3, from: 'red', to: 'ash' }];
  assert.deepEqual(commsFor(rows, 'dev').map(r => r.id), [1, 2]);
  assert.deepEqual(commsFor(rows, null).map(r => r.id), [1, 2, 3]);
  assert.deepEqual(commsFor(null, 'dev'), []);
});

test('feedQuery and commsQuery build the documented URLs', () => {
  assert.equal(feedQuery(null, 0), '/api/plugins/agent-office/feed?limit=150');
  assert.equal(feedQuery('dev', 1700000000.5), '/api/plugins/agent-office/feed?limit=150&agent=dev&since=1700000000.5');
  assert.equal(feedQuery('a b', 0), '/api/plugins/agent-office/feed?limit=150&agent=a%20b');
  assert.equal(commsQuery(0), '/api/plugins/agent-office/comms?limit=100');
  assert.equal(commsQuery(42), '/api/plugins/agent-office/comms?limit=100&since=42');
});

test('thinkLabel and callParts', () => {
  assert.equal(thinkLabel(412), 'Thinking · 412 chars');
  assert.equal(thinkLabel(null), 'Thinking');
  assert.deepEqual(callParts({ tool: 'terminal', text: 'terminal: ls -la' }), { tool: 'terminal', arg: 'ls -la' });
  assert.deepEqual(callParts({ tool: 'read_file', text: 'read_file' }), { tool: 'read_file', arg: '' });
  assert.deepEqual(callParts({ tool: '', text: 'bare' }), { tool: 'bare', arg: '' });
});

test('typeStep: a row finishes in about 90 frames, never 0', () => {
  assert.equal(typeStep(0), 1);
  assert.equal(typeStep(50), 1);
  assert.equal(typeStep(900), 10);
  assert.equal(Math.ceil(900 / typeStep(900)), 90);
});

test('showThoughtsNote: only for a selected agent without thinking rows', () => {
  assert.equal(showThoughtsNote(['dev'], 'ash'), true);
  assert.equal(showThoughtsNote(['dev'], 'dev'), false);
  assert.equal(showThoughtsNote(['dev'], null), false);
  assert.equal(showThoughtsNote(undefined, 'ash'), true);
});
