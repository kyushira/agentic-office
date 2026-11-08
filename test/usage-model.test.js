import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampPct, pctLabel, usageRingModel, clipReason, compactTokens, tokenFigures, ringsBreathe } from '../src/usage-model.js';

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

test('clipReason: short reasons pass through, long ones clip to 90 characters with an ellipsis', () => {
  assert.equal(clipReason('usage lookup failed: TimeoutError'), 'usage lookup failed: TimeoutError');
  const out = clipReason('x'.repeat(200));
  assert.equal(out.length, 90);
  assert.equal(out.endsWith('…'), true);
  assert.equal(clipReason('a'.repeat(90)), 'a'.repeat(90));
  assert.equal(clipReason(''), 'the source did not say why');
  assert.equal(clipReason(null), 'the source did not say why');
});

test('compactTokens: short counts for the ring centre', () => {
  assert.equal(compactTokens(490000), '490k');
  assert.equal(compactTokens(5100000), '5.1M');
  assert.equal(compactTokens(10000000), '10M');
  assert.equal(compactTokens(999000), '999k');
  assert.equal(compactTokens(999600), '1M');
  assert.equal(compactTokens(73000), '73k');
  assert.equal(compactTokens(640), '640');
  assert.equal(compactTokens(0), '0');
  assert.equal(compactTokens(undefined), '0');
  assert.equal(compactTokens(NaN), '0');
});

test('tokenFigures: 5h is against the average 5h window of the week (7d * 5 / 168)', () => {
  // 5,040,000 tokens in 7d -> average 5h window is 150,000; 210,000 in the last 5h is 140%.
  const f = tokenFigures({ five_hour: 210000, seven_day: 5040000, prev_seven_day: 4200000, sessions_7d: 3 });
  assert.equal(f.fiveHour.caption, '140% of 7d avg, est.');
  assert.equal(f.fiveHour.fill, 100);
  assert.equal(f.fiveHour.centre, '210k');
  assert.equal(f.sevenDay.caption, '120% vs last wk, est.');
  assert.equal(f.sevenDay.fill, 100);
  assert.equal(f.sevenDay.centre, '5M');
});

test('tokenFigures: a 5h share under the average gives a partial arc', () => {
  const f = tokenFigures({ five_hour: 75000, seven_day: 5040000, prev_seven_day: 10080000 });
  assert.equal(f.fiveHour.fill, 50);
  assert.equal(f.fiveHour.caption, '50% of 7d avg, est.');
  assert.equal(f.sevenDay.fill, 50);
  assert.equal(f.sevenDay.caption, '50% vs last wk, est.');
});

test('tokenFigures: no prior week gives a full arc; no use at all gives no data', () => {
  const f = tokenFigures({ five_hour: 0, seven_day: 73000, prev_seven_day: 0 });
  assert.equal(f.sevenDay.fill, 100);
  assert.equal(f.sevenDay.caption, 'new vs last wk, est.');
  assert.equal(f.fiveHour.fill, 0);
  assert.equal(f.fiveHour.caption, '0% of 7d avg, est.');
  const none = tokenFigures({ five_hour: 0, seven_day: 0, prev_seven_day: 0 });
  assert.equal(none.fiveHour.fill, null);
  assert.equal(none.sevenDay.fill, null);
  assert.equal(none.sevenDay.caption, 'no data yet');
});

test('tokenFigures: 5h use with no 7d history gives a full arc, not a division by zero', () => {
  const f = tokenFigures({ five_hour: 5000, seven_day: 0, prev_seven_day: 0 });
  assert.equal(f.fiveHour.fill, 100);
  assert.equal(f.fiveHour.caption, 'no 7d average yet, est.');
});

test('tokenFigures: missing or non-object entry gives null', () => {
  assert.equal(tokenFigures(undefined), null);
  assert.equal(tokenFigures(null), null);
  assert.equal(tokenFigures('x'), null);
});

test('usageRingModel: with no plan % the Claude rings use token estimates, labelled est.', () => {
  const m = usageRingModel({
    available: false, reason: 'no Claude subscription login found',
    tokens: { claude: { five_hour: 210000, seven_day: 5040000, prev_seven_day: 4200000, sessions_7d: 3 },
      deepseek: { five_hour: 0, seven_day: 73000, prev_seven_day: 0, sessions_7d: 1 }, source: 'state.db', fetched_at: 1 },
  });
  const [five, week, ds] = m.rings;
  assert.equal(five.source, 'tokens');
  assert.equal(five.pct, 100);
  assert.equal(five.centre, '210k');
  assert.equal(five.unit, 'tok est.');
  assert.equal(five.sub, '140% of 7d avg, est.');
  assert.equal(week.sub, '120% vs last wk, est.');
  assert.equal(week.estimated, true);
  assert.equal(ds.source, 'tokens');
  assert.equal(ds.demo, false, 'DEMO badge dropped once tokens.deepseek exists');
  assert.equal(ds.centre, '73k');
  assert.equal(ds.pct, 100);
  assert.equal(m.available, false);
  assert.equal(m.reason, 'no Claude subscription login found');
});

test('usageRingModel: a plan % stays primary over token estimates', () => {
  const m = usageRingModel({
    available: true, five_hour: { pct: 61, resets_at: '2026-11-08T18:00:00Z' }, seven_day: { pct: 30 },
    tokens: { claude: { five_hour: 210000, seven_day: 5040000, prev_seven_day: 4200000 } },
  });
  assert.equal(m.rings[0].source, 'plan');
  assert.equal(m.rings[0].label, '61% est.');
  assert.equal(m.rings[0].unit, null);
  assert.equal(m.rings[1].label, '30% est.');
  assert.equal(m.rings[1].source, 'plan');
});

test('usageRingModel: DeepSeek keeps DEMO only when usage.tokens has no deepseek entry', () => {
  const withEntry = usageRingModel({ available: false, tokens: { claude: {}, deepseek: { five_hour: 0, seven_day: 0, prev_seven_day: 0 } } });
  assert.equal(withEntry.rings[2].demo, false);
  assert.equal(withEntry.rings[2].pct, null);
  assert.equal(withEntry.rings[2].source, 'none');
  const noEntry = usageRingModel({ available: false, tokens: { claude: {} } });
  assert.equal(noEntry.rings[2].demo, true);
});

test('usageRingModel: the first n/a ring is the only one that breathes', () => {
  const m = usageRingModel({ available: false, reason: 'no login' });
  assert.deepEqual(m.rings.map(r => r.source), ['none', 'none', 'none']);
  assert.deepEqual(m.rings.map(r => r.breathe), [true, false, false]);
  assert.equal(m.breathing, true);
  assert.equal(ringsBreathe(null), true);
});

test('usageRingModel: no n/a ring means nothing breathes', () => {
  const usage = { available: true, five_hour: { pct: 10 }, seven_day: { pct: 20 },
    tokens: { deepseek: { five_hour: 0, seven_day: 5, prev_seven_day: 5 } } };
  const m = usageRingModel(usage);
  assert.deepEqual(m.rings.map(r => r.breathe), [false, false, false]);
  assert.equal(m.breathing, false);
  assert.equal(ringsBreathe(usage), false);
});

test('usageRingModel: an n/a ring says it has no data yet', () => {
  const m = usageRingModel(null);
  assert.equal(m.rings[0].sub, 'no data yet');
  assert.equal(m.rings[0].centre, 'n/a');
});
