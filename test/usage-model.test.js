import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clampPct, pctLabel, usageRingModel, reasonText, compactTokens, tokenFigures, ringsBreathe,
  USAGE_DAYS, DEFAULT_DAYS, USAGE_POLL_MS, validDays, windowChips, agentColour, agentBars, costBadge, costText,
  hasAnyCost, totalsView, providerRows, trendStack, errorLines, hasAgents, shortDay,
} from '../src/usage-model.js';
import { hashedColour } from '../src/office-model.js';

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

test('reasonText: the full backend reason is shown, never clipped', () => {
  assert.equal(reasonText('usage lookup failed: TimeoutError'), 'usage lookup failed: TimeoutError');
  const long = 'no Claude subscription login found (run `claude` and log in) ' + 'x'.repeat(120);
  assert.equal(reasonText(long), long);
  assert.equal(reasonText('a'.repeat(200)).length, 200);
  assert.equal(reasonText('  padded  '), 'padded');
  assert.equal(reasonText(''), 'the source did not say why');
  assert.equal(reasonText(null), 'the source did not say why');
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

// ---- Usage tab (batch 1 / P1): window chips, per-agent bars, daily trend, footer. Pure: no DOM. ----

const sumOf = (xs) => xs.reduce((s, x) => s + x, 0);
const bd = (agents, extra = {}) => ({ days: 7, agents, trend: [], totals: { tokens: 0, cost_usd: null, api_calls: 0 }, errors: [], ...extra });
const agent = (name, tokens, extra = {}) => ({ agent: name, tokens, input: tokens, output: 0, cache_read: 0, cache_write: 0,
  reasoning: 0, api_calls: 1, sessions: 1, cost_usd: null, cost_kind: 'none', by_provider: {}, ...extra });

test('usage tab constants: windows 1/7/30, default 7, 60s poll', () => {
  assert.deepEqual(USAGE_DAYS, [1, 7, 30]);
  assert.equal(DEFAULT_DAYS, 7);
  assert.equal(USAGE_POLL_MS, 60000);
});

test('validDays: 1, 7, 30 pass; anything else falls back to 7', () => {
  assert.equal(validDays(1), 1);
  assert.equal(validDays(30), 30);
  assert.equal(validDays('30'), 30, 'a numeric string from the URL or state is accepted');
  for (const bad of [14, 0, -1, 1.5, 31, 'x', '', null, undefined, true, NaN, {}]) {
    assert.equal(validDays(bad), 7, `fallback for ${String(bad)}`);
  }
});

test('windowChips: three chips with labels, one selected; invalid selection selects 7d', () => {
  const chips = windowChips(7);
  assert.deepEqual(chips.map(c => c.id), [1, 7, 30]);
  assert.deepEqual(chips.map(c => c.label), ['1d', '7d', '30d']);
  assert.deepEqual(chips.map(c => c.selected), [false, true, false]);
  assert.deepEqual(windowChips(1).map(c => c.selected), [true, false, false]);
  assert.deepEqual(windowChips(99).map(c => c.selected), [false, true, false], 'guard: 99 is not a window');
  assert.deepEqual(windowChips(undefined).map(c => c.selected), [false, true, false]);
});

test('agentBars: sorted by tokens desc, ties by name, names from the agent list', () => {
  const rows = agentBars(bd([agent('red', 30), agent('dev', 60), agent('ash', 60), agent('pixel', 20)]),
    [{ id: 'ash', name: 'Ash', color: '#E07A3F' }]);
  assert.deepEqual(rows.map(r => r.agent), ['ash', 'dev', 'red', 'pixel']);
  assert.equal(rows[0].label, 'Ash');
  assert.equal(rows[1].label, 'dev', 'unknown agent falls back to its folder name');
});

test('agentBars: shares are 0..1 and sum to about 1 when there is use', () => {
  const rows = agentBars(bd([agent('ash', 165), agent('dev', 60), agent('red', 30), agent('pixel', 20)]));
  for (const r of rows) assert.ok(r.share >= 0 && r.share <= 1, `share ${r.share} in range`);
  assert.ok(Math.abs(sumOf(rows.map(r => r.share)) - 1) < 1e-9);
  assert.equal(rows[0].sharePct, 60, 'whole-number percent for the label: 165 of 275');
});

test('agentBars: zero totals give zero shares and no NaN', () => {
  const rows = agentBars(bd([agent('ash', 0), agent('dev', 0)]));
  assert.deepEqual(rows.map(r => r.share), [0, 0]);
  assert.deepEqual(rows.map(r => r.sharePct), [0, 0]);
  assert.ok(rows.every(r => Number.isFinite(r.share)));
});

test('agentBars: missing, null or non-array agents give an empty list', () => {
  assert.deepEqual(agentBars(null), []);
  assert.deepEqual(agentBars({}), []);
  assert.deepEqual(agentBars(bd(null)), []);
  assert.deepEqual(agentBars(bd([null, 'junk', agent('dev', 5)])).map(r => r.agent), ['dev']);
});

test('agentBars: null cost gives "no cost data" and no badge', () => {
  const [r] = agentBars(bd([agent('dev', 5, { cost_usd: null, cost_kind: 'none' })]));
  assert.equal(r.cost_usd, null);
  assert.equal(r.costText, 'no cost data');
  assert.equal(r.costBadge, null);
});

test('agentBars: a mixed cost_kind gets the mixed badge with its cost', () => {
  const [r] = agentBars(bd([agent('ash', 165, { cost_usd: 0.12, cost_kind: 'mixed' })]));
  assert.equal(r.costText, '$0.12');
  assert.deepEqual(r.costBadge, { kind: 'mixed', label: 'mixed', cls: 'is-mixed' });
});

test('agentBars: provider split is sorted by tokens and its shares sum to about 1', () => {
  const [r] = agentBars(bd([agent('dev', 60, { by_provider: { deepseek: 50, 'claude-subscription-directsdk-experimental': 10 } })]));
  assert.deepEqual(r.providers.map(p => p.label), ['DeepSeek', 'Claude']);
  assert.ok(Math.abs(sumOf(r.providers.map(p => p.share)) - 1) < 1e-9);
});

test('agentColour: the agent colour when the id matches, the hashed colour otherwise', () => {
  assert.equal(agentColour('ash', [{ id: 'ash', color: '#e07a3f' }]), '#E07A3F');
  assert.equal(agentColour('dev', []), hashedColour('dev'));
  assert.equal(agentColour('ghost', [{ id: 'ash', color: '#e07a3f' }]), hashedColour('ghost'));
});

test('costBadge: actual, estimated, mixed; none and unknown kinds have no badge', () => {
  assert.deepEqual(costBadge('actual'), { kind: 'actual', label: 'actual', cls: 'is-actual' });
  assert.deepEqual(costBadge('estimated'), { kind: 'estimated', label: 'est.', cls: 'is-est' });
  assert.equal(costBadge('none'), null);
  assert.equal(costBadge(null), null);
  assert.equal(costBadge(undefined), null);
  assert.equal(costBadge('toString'), null, 'no prototype keys leak through');
});

test('costText: money text, and "no cost data" for null', () => {
  assert.equal(costText(null), 'no cost data');
  assert.equal(costText(undefined), 'no cost data');
  assert.equal(costText(NaN), 'no cost data');
  assert.equal(costText(0), '$0.00');
  assert.equal(costText(0.004), '<$0.01');
  assert.equal(costText(0.123), '$0.12');
  assert.equal(costText(12.5), '$12.50');
});

test('hasAnyCost: true when any agent or the totals carry a cost; false when all are null', () => {
  assert.equal(hasAnyCost(null), false);
  assert.equal(hasAnyCost(bd([agent('dev', 5)])), false);
  assert.equal(hasAnyCost(bd([agent('dev', 5), agent('ash', 5, { cost_usd: 0 })])), true, 'a zero cost is still a cost');
  assert.equal(hasAnyCost(bd([agent('dev', 5)], { totals: { tokens: 5, cost_usd: 0.5, api_calls: 1 } })), true);
});

test('totalsView: tokens, calls and cost text; null payload gives zeros and no cost', () => {
  const t = totalsView(bd([agent('ash', 5100000)], { totals: { tokens: 5100000, cost_usd: 1.5, api_calls: 490 } }));
  assert.equal(t.tokensText, '5.1M');
  assert.equal(t.apiCallsText, '490');
  assert.equal(t.costText, '$1.50');
  assert.equal(t.hasCost, true);
  const none = totalsView(null);
  assert.deepEqual([none.tokens, none.apiCalls], [0, 0]);
  assert.equal(none.costText, 'no cost data');
  assert.equal(none.hasCost, false);
});

test('providerRows: known providers get labels, zero total gives zero shares', () => {
  assert.deepEqual(providerRows(null), []);
  const zero = providerRows({ deepseek: 0 });
  assert.deepEqual(zero.map(p => p.share), [0]);
  assert.equal(providerRows({ weird: 3 })[0].label, 'weird', 'an unknown provider keeps its key');
});

test('trendStack: empty days are kept as empty bars with zero height and no segments', () => {
  const t = trendStack([
    { day: '2026-11-04', tokens: 0, cost_usd: null, by_agent: {} },
    { day: '2026-11-05', tokens: 100, cost_usd: null, by_agent: { ash: 100 } },
    { day: '2026-11-06', tokens: 0, cost_usd: null, by_agent: {} },
  ], ['ash'], []);
  assert.equal(t.days.length, 3);
  assert.deepEqual(t.days.map(d => d.empty), [true, false, true]);
  assert.deepEqual(t.days.map(d => d.heightPct), [0, 100, 0]);
  assert.deepEqual(t.days[0].segments, []);
  assert.equal(t.days[0].label, '11-04');
});

test('trendStack: heights are relative to the largest day; segments add up to the day height', () => {
  const t = trendStack([
    { day: '2026-11-05', tokens: 100, by_agent: { ash: 60, dev: 40 } },
    { day: '2026-11-06', tokens: 50, by_agent: { dev: 50 } },
  ], ['ash', 'dev'], []);
  assert.equal(t.max, 100);
  assert.deepEqual(t.days.map(d => d.heightPct), [100, 50]);
  const seg = t.days[0].segments;
  assert.deepEqual(seg.map(s => s.agent), ['ash', 'dev']);
  assert.ok(Math.abs(sumOf(seg.map(s => s.heightPct)) - t.days[0].heightPct) < 1e-9);
});

test('trendStack: an agent in by_agent but not in agentOrder is still drawn, after the known agents', () => {
  const t = trendStack([{ day: '2026-11-05', tokens: 30, by_agent: { ghost: 10, ash: 20 } }], ['ash'], []);
  assert.deepEqual(t.days[0].segments.map(s => s.agent), ['ash', 'ghost']);
  assert.equal(t.days[0].segments[1].colour, hashedColour('ghost'));
});

test('trendStack: days are sorted oldest first and junk entries are dropped', () => {
  const t = trendStack([null, { day: '2026-11-06', tokens: 1, by_agent: {} }, 'x', { day: '2026-11-05', tokens: 1, by_agent: {} }], [], []);
  assert.deepEqual(t.days.map(d => d.day), ['2026-11-05', '2026-11-06']);
});

test('trendStack: all-zero trend has max 0 and no NaN heights', () => {
  const t = trendStack([{ day: '2026-11-05', tokens: 0, by_agent: {} }], [], []);
  assert.equal(t.max, 0);
  assert.deepEqual(t.days.map(d => d.heightPct), [0]);
  assert.equal(trendStack(null, [], []).days.length, 0);
});

test('trendStack: a day button label carries the day, tokens and cost text', () => {
  const t = trendStack([{ day: '2026-11-05', tokens: 2500, cost_usd: null, by_agent: { ash: 2500 } }], ['ash'], []);
  assert.equal(t.days[0].aria, '2026-11-05: 3k tokens, no cost data', 'compactTokens rounds to whole k');
});

test('errorLines: one line per unreadable state.db, nothing for a clean payload', () => {
  assert.deepEqual(errorLines(bd([], { errors: [{ agent: 'red', error: 'OperationalError' }, null] })),
    ['state.db unreadable: red']);
  assert.deepEqual(errorLines(bd([])), []);
  assert.deepEqual(errorLines(null), []);
});

test('hasAgents: false for an empty or missing agent list (empty state)', () => {
  assert.equal(hasAgents(bd([agent('dev', 1)])), true);
  assert.equal(hasAgents(bd([])), false);
  assert.equal(hasAgents(null), false);
});

test('shortDay: MM-DD for ISO days, junk passes through', () => {
  assert.equal(shortDay('2026-11-05'), '11-05');
  assert.equal(shortDay('soon'), 'soon');
});
