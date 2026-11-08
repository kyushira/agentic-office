import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardState, cardWord, cardMeta, pulseIds, PULSE_MAX } from '../src/deck-model.js';

test('cardState: working is running, waiting is waiting, idle and unknown are idle', () => {
  assert.equal(cardState({ status: 'working' }), 'running');
  assert.equal(cardState({ status: 'waiting' }), 'waiting');
  assert.equal(cardState({ status: 'idle' }), 'idle');
  assert.equal(cardState({ status: 'weird' }), 'idle');
  assert.equal(cardState({}), 'idle');
});

test('cardState: offline status is offline; an error field wins and reads as error', () => {
  assert.equal(cardState({ status: 'offline' }), 'offline');
  assert.equal(cardState({ status: 'offline', error: 'OperationalError' }), 'error');
  assert.equal(cardState({ status: 'idle', error: 'KeyError' }), 'error');
});

test('cardState: missing agent is offline', () => {
  assert.equal(cardState(null), 'offline');
  assert.equal(cardState(undefined), 'offline');
});

test('cardWord: every state has a text word (state is never colour alone)', () => {
  assert.equal(cardWord('running'), 'Running');
  assert.equal(cardWord('waiting'), 'Waiting for you');
  assert.equal(cardWord('error'), 'Error');
  assert.equal(cardWord('offline'), 'Offline');
  assert.equal(cardWord('idle'), 'Idle');
  assert.equal(cardWord('nope'), 'Idle');
});

test('pulseIds: only the first three running agents pulse, in list order', () => {
  const agents = [
    { id: 'dev', status: 'working' },
    { id: 'nova', status: 'idle' },
    { id: 'pixel', status: 'working' },
    { id: 'prism', status: 'working' },
    { id: 'red', status: 'working' },
    { id: 'sentinel', status: 'waiting' },
  ];
  assert.equal(PULSE_MAX, 3);
  assert.deepEqual([...pulseIds(agents)], ['dev', 'pixel', 'prism']);
});

test('pulseIds: fewer than three running, non-running never pulse, empty input is safe', () => {
  assert.deepEqual([...pulseIds([{ id: 'a', status: 'working' }, { id: 'b', status: 'waiting' }])], ['a']);
  assert.equal(pulseIds([{ id: 'a', status: 'idle' }, { id: 'b', status: 'offline' }]).size, 0);
  assert.equal(pulseIds(undefined).size, 0);
  assert.equal(pulseIds([{ id: 'x', status: 'working', error: 'E' }]).size, 0);
});

test('cardMeta: running with a duration says "for" and drops the time (never "now · 35m")', () => {
  const now = 1_800_000_000;
  assert.deepEqual(cardMeta({ lastActive: now }, 'running', '35m', now), { word: 'Running', time: null, dur: 'for 35m' });
});

test('cardMeta: no last-active time omits the time, never a bare dash', () => {
  assert.deepEqual(cardMeta({}, 'idle', null, 1_800_000_000), { word: 'Idle', time: null, dur: null });
  assert.deepEqual(cardMeta(null, 'offline', null, 1_800_000_000), { word: 'Offline', time: null, dur: null });
});

test('cardMeta: idle with a last-active time shows the time', () => {
  const now = 1_800_000_000;
  assert.deepEqual(cardMeta({ lastActive: now - 720 }, 'idle', null, now), { word: 'Idle', time: '12m ago', dur: null });
});

test('cardMeta: running without a duration keeps the time; a duration on a non-running card is dropped', () => {
  const now = 1_800_000_000;
  assert.deepEqual(cardMeta({ lastActive: now - 720 }, 'running', null, now), { word: 'Running', time: '12m ago', dur: null });
  assert.deepEqual(cardMeta({ lastActive: now - 720 }, 'error', '5m', now), { word: 'Error', time: '12m ago', dur: null });
});
