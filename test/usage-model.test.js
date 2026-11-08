import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampPct, pctLabel, usageRingModel } from '../src/usage-model.js';

test('clampPct: clamps to 0..100 and never invents a value', () => {
  assert.equal(clampPct(42), 42);
  assert.equal(clampPct(-5), 0);
  assert.equal(clampPct(250), 100);
  assert.equal(clampPct('37.5'), 37.5);
  assert.equal(clampPct(null), null);
  assert.equal(clampPct(undefined), null);
  assert.equal(clampPct(''), null);
  assert.equal(clampPct('abc'), null);
  assert.equal(clampPct(NaN), null);
  assert.equal(clampPct(true), null);
});

test('pctLabel: estimated values say est., unknown says n/a', () => {
  assert.equal(pctLabel(42.4, true), '42% est.');
  assert.equal(pctLabel(42.4), '42%');
  assert.equal(pctLabel(null, true), 'n/a');
  assert.equal(pctLabel('x'), 'n/a');
});

test('usageRingModel: available Claude data is estimated and keeps reset times', () => {
  const m = usageRingModel({
    available: true,
    five_hour: { pct: 61, resets_at: '2026-11-08T18:00:00Z' },
    seven_day: { pct: 130, resets_at: '2026-11-12T00:00:00Z' },
  });
  assert.equal(m.available, true);
  const [five, week, ds] = m.rings;
  assert.equal(five.label, '61% est.');
  assert.equal(five.estimated, true);
  assert.equal(five.provider, 'claude');
  assert.equal(five.resetsAt, '2026-11-08T18:00:00Z');
  assert.equal(week.pct, 100);
  assert.equal(week.label, '100% est.');
  assert.equal(ds.demo, true);
  assert.equal(ds.label, 'n/a');
});

test('usageRingModel: unavailable source gives n/a rings and carries the backend reason', () => {
  const m = usageRingModel({ available: false, reason: 'usage lookup failed: TimeoutError',
    five_hour: { pct: 80 }, seven_day: { pct: 20 } });
  assert.equal(m.available, false);
  assert.equal(m.reason, 'usage lookup failed: TimeoutError');
  assert.deepEqual(m.rings.slice(0, 2).map(r => r.label), ['n/a', 'n/a']);
  assert.deepEqual(m.rings.slice(0, 2).map(r => r.pct), [null, null]);
});

test('usageRingModel: missing payload never shows a number', () => {
  const m = usageRingModel(null);
  assert.equal(m.available, false);
  assert.equal(m.reason, null);
  assert.equal(m.rings.every(r => r.pct === null), true);
  assert.equal(m.rings.find(r => r.provider === 'deepseek').demo, true);
});
