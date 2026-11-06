import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildItems, headerCounts, durationText, modelText, modelParts, usageText, meterLevel, activeTokens, currentSessionId, eventLabel, detailRows, traceModel, newToolCalls, countStep, todayParts, newWalks, walkLabel, toolRing, newBrainTrips, brainCounts, brainText, brainNotes, helperChanges, swarmTip, needsYou, statusWord, greeting, shortDuration, rosterDuration, clockText, resetSoon } from '../src/deck-model.js';

const now = 1_800_000_000;
const state = {
  agents: [
    { id: 'default', name: 'Ash', status: 'idle', activity: 'idle · last: writing files', lastActive: now - 720, helpers: [], recentHelpers: [] },
    { id: 'dev', name: 'Dev', status: 'working', activity: 'delegating · 2 helpers', lastActive: now,
      helpers: [{ id: 'x-0', task: 'Run tests', model: 'Haiku', activity: 'running commands', since: now - 90 },
                { id: 'x-1', task: 'Shots', model: 'Haiku', activity: 'thinking', since: now - 60 }],
      recentHelpers: [{ id: 'y-0', task: 'Old', model: 'Haiku', since: now - 600, ended: now - 180 },
                      { id: 'y-1', task: 'Older', model: 'Haiku', since: now - 2000, ended: now - 1000 }] },
    { id: 'red', name: 'Red', status: 'idle', activity: 'idle', lastActive: now - 3600, helpers: [], recentHelpers: [] },
  ],
  sessions: { dev: [{ id: 'dev/s1', status: 'working', ctxPct: 26 }] },
  walks: [{ id: 'w1', at: now - 30, from: 'default', to: 'dev', kind: 'brief' }, { id: 'w2', at: now - 400, from: 'dev', to: 'red', kind: 'message' }],
};

test('helpers follow their parent; finished ones older than 15 min drop out', () => {
  const items = buildItems(state, now);
  assert.deepEqual(items.map(i => i.key), ['a:default', 'a:dev', 'h:dev:x-0', 'h:dev:x-1', 'h:dev:y-0', 'a:red']);
  const done = items.find(i => i.key === 'h:dev:y-0');
  assert.equal(done.done, true);
  assert.equal(done.status, 'done · 3m ago');
  assert.equal(items.find(i => i.key === 'h:dev:x-0').parentName, 'Dev');
});

test('agent status, ctx only while working, helper count and hand-off chip', () => {
  const [ash, dev] = buildItems(state, now);
  assert.equal(ash.status, 'idle · 12m ago');
  assert.equal(ash.ctxPct, null);
  assert.equal(dev.status, 'working · delegating');
  assert.equal(dev.ctxPct, 26);
  assert.equal(dev.helperCount, 2);
  assert.equal(dev.chip.text, 'Ash · new brief');
  const red = buildItems(state, now).find(i => i.key === 'a:red');
  assert.equal(red.chip, null, 'chips expire after ~2 minutes');
});

test('header counts agents and running helpers', () => {
  assert.deepEqual(headerCounts(buildItems(state, now)), { working: 1, idle: 2, helpers: 2 });
});

test('durationText', () => {
  assert.equal(durationText({ since: now - 90 }, now), '2m');
  assert.equal(durationText({ since: now - 30, ended: now - 10 }, now), '20s');
});

test('agent accent comes from the backend colour; a missing one falls back to one neutral colour', () => {
  const st = { agents: [{ id: 'nova', name: 'Nova', color: '#8b5cf6', status: 'idle', helpers: [], recentHelpers: [] },
                        { id: 'x', name: 'X', status: 'idle', helpers: [], recentHelpers: [] }] };
  const [nova, x] = buildItems(st, now);
  assert.equal(nova.color, '#8b5cf6');
  assert.equal(x.color, '#8a8a8a');
});

test('modelParts: main model and helpers, split for the two-line phone layout', () => {
  assert.deepEqual(modelParts({ model: 'Opus 5.5', helperModels: ['Haiku', 'Haiku'] }), { main: 'Opus 5.5', helpers: 'Haiku' });
  assert.deepEqual(modelParts({ model: 'Opus 5.5' }), { main: 'Opus 5.5', helpers: '' });
  assert.deepEqual(modelParts({}), { main: '—', helpers: '' });
});

test('modelText: main model, then distinct helper models', () => {
  assert.equal(modelText({ model: 'Opus 5.5', helperModels: ['Haiku'] }), 'Opus 5.5 · helpers Haiku');
  assert.equal(modelText({ model: 'Sonnet 5.5', helperModels: ['DeepSeek V4 Flash', 'DeepSeek V4 Flash'] }),
    'Sonnet 5.5 · helpers DeepSeek V4 Flash');
  assert.equal(modelText({ model: 'Gemini 3.6 Flash', helperModels: [] }), 'Gemini 3.6 Flash');
  assert.equal(modelText({}), '—');
});

test('usageText: unavailable payload shows n/a and level na', () => {
  for (const u of [{ available: false }, null, undefined]) {
    const r = usageText(u);
    assert.equal(r.short, '5h n/a · wk n/a');
    assert.equal(r.level, 'na');
    assert.equal(r.title, 'Plan usage n/a: unknown');
    assert.equal(r.reason, 'unknown');
  }
});

test('usageText: unavailable payload surfaces its reason in title and reason', () => {
  const r = usageText({ available: false, reason: 'no Claude subscription login found' });
  assert.equal(r.title, 'Plan usage n/a: no Claude subscription login found');
  assert.equal(r.reason, 'no Claude subscription login found');
  assert.equal(r.level, 'na');
});

test('usageText: available payload has no reason', () => {
  assert.equal(usageText({ available: true, five_hour: { pct: 10 }, seven_day: { pct: 20 } }).reason, null);
});

test('usageText: normal windows round and stay ok below 70%', () => {
  const r = usageText({ available: true, five_hour: { pct: 42.4, resets_at: 1_800_000_000 }, seven_day: { pct: 13.6, resets_at: 1_800_500_000 } });
  assert.equal(r.short, '5h 42% · wk 14%');
  assert.equal(r.level, 'ok');
  assert.match(r.title, /^Claude plan: 5-hour resets (?!n\/a).+; weekly resets (?!n\/a).+$/);
});

test('usageText: a null window shows n/a for that window only', () => {
  const r = usageText({ available: true, five_hour: { pct: null, resets_at: null }, seven_day: { pct: 55, resets_at: 1_800_500_000 } });
  assert.equal(r.short, '5h n/a · wk 55%');
  assert.equal(r.level, 'ok');
  assert.match(r.title, /^Claude plan: 5-hour resets n\/a; weekly resets (?!n\/a).+$/);
});

test('usageText: warn at 70 and hot at 90, from the larger window', () => {
  const warn = usageText({ available: true, five_hour: { pct: 75 }, seven_day: { pct: 20 } });
  assert.equal(warn.level, 'warn');
  assert.equal(warn.short, '5h 75% · wk 20%');
  const hot = usageText({ available: true, five_hour: { pct: 30 }, seven_day: { pct: 91.2 } });
  assert.equal(hot.level, 'hot');
  assert.equal(hot.short, '5h 30% · wk 91%');
});

test('activeTokens: sums tokens of working agents only', () => {
  const items = [
    { type: 'agent', working: true, tokens: 1200 },
    { type: 'agent', working: false, tokens: 9000 },
    { type: 'helper', done: false, tokens: undefined },
    { type: 'agent', working: true, tokens: 300 },
  ];
  assert.equal(activeTokens(items), 1500);
  assert.equal(activeTokens([]), 0);
});

test('buildItems: working agent carries tokens from its working sessions', () => {
  const st = { agents: [{ id: 'dev', name: 'Dev', status: 'working', helpers: [], recentHelpers: [] }],
    sessions: { dev: [{ id: 'a', status: 'working', tokens: 1000 }, { id: 'b', status: 'working', tokens: 500 }, { id: 'c', status: 'idle', tokens: 9999 }] } };
  assert.equal(activeTokens(buildItems(st, now)), 1500);
});

test('eventLabel: tool name, message in, reply, fallbacks', () => {
  assert.equal(eventLabel({ kind: 'tool', name: 'terminal' }), 'terminal');
  assert.equal(eventLabel({ kind: 'tool', name: null }), 'tool');
  assert.equal(eventLabel({ kind: 'user' }), 'message in');
  assert.equal(eventLabel({ kind: 'assistant' }), 'reply');
  assert.equal(eventLabel({ kind: 'system' }), 'system');
  assert.equal(eventLabel({}), '');
});

test('detailRows: activity, last tool and working helper count', () => {
  const d = { status: 'working', activity: 'using terminal', last_tool: { name: 'terminal', at: 1 },
    helpers: [{ status: 'working' }, { status: 'running' }, { status: 'done' }] };
  assert.deepEqual(detailRows(d), { activity: 'using terminal', tool: 'terminal', helpers: '2 working / 3' });
});

test('detailRows: bare payload falls back to status and no tool', () => {
  assert.deepEqual(detailRows({ status: 'idle', helpers: [] }), { activity: 'idle', tool: null, helpers: '0 working / 0' });
  assert.deepEqual(detailRows({}), { activity: 'idle', tool: null, helpers: '0 working / 0' });
});

test('meterLevel: ok below 70, warn from 70, hot from 90, na without a number', () => {
  assert.equal(meterLevel(0), 'ok');
  assert.equal(meterLevel(69.9), 'ok');
  assert.equal(meterLevel(70), 'warn');
  assert.equal(meterLevel(89.9), 'warn');
  assert.equal(meterLevel(90), 'hot');
  assert.equal(meterLevel(100), 'hot');
  assert.equal(meterLevel('42'), 'ok');
  for (const p of [null, undefined, '', NaN, 'abc']) assert.equal(meterLevel(p), 'na', String(p));
});

test('usageText windows: available payload gives both windows with pct, reset text and level', () => {
  const r = usageText({ available: true, five_hour: { pct: 42.4, resets_at: 1_800_000_000 }, seven_day: { pct: 73, resets_at: 1_800_500_000 } });
  assert.deepEqual(r.windows.map(w => [w.key, w.label, w.short, w.pct, w.level]), [
    ['five_hour', 'Session · 5h', '5h', 42.4, 'ok'],
    ['seven_day', 'Week · 7d', 'wk', 73, 'warn'],
  ]);
  assert.notEqual(r.windows[0].resets, 'n/a');
  assert.notEqual(r.windows[1].resets, 'n/a');
  assert.equal(r.aria, 'Claude plan usage: session 5h 42%, week 73%');
  assert.equal(r.short, '5h 42% · wk 73%', 'existing fields unchanged');
  assert.equal(r.level, 'warn');
});

test('usageText windows: a missing pct gives n/a for that window only, resets n/a when missing', () => {
  const r = usageText({ available: true, five_hour: { pct: null, resets_at: null }, seven_day: { pct: 95 } });
  const [five, week] = r.windows;
  assert.equal(five.pct, null);
  assert.equal(five.level, 'na');
  assert.equal(five.resets, 'reset time not reported');
  assert.equal(week.pct, 95);
  assert.equal(week.level, 'hot');
  assert.equal(week.resets, 'reset time not reported');
  assert.equal(r.aria, 'Claude plan usage: session 5h n/a, week 95%');
});

test('usageText windows: unavailable payload has both windows n/a with the reason in aria', () => {
  const r = usageText({ available: false, reason: 'no Claude subscription login found' });
  assert.deepEqual(r.windows.map(w => [w.pct, w.level, w.resets]), [[null, 'na', 'n/a'], [null, 'na', 'n/a']]);
  assert.equal(r.aria, 'Claude plan usage n/a: no Claude subscription login found');
  const none = usageText(null);
  assert.equal(none.windows.length, 2);
  assert.ok(none.windows.every(w => w.pct === null && w.level === 'na'));
});

test('usageText windows: pct is clamped to 0-100', () => {
  const r = usageText({ available: true, five_hour: { pct: 130 }, seven_day: { pct: -4 } });
  assert.deepEqual(r.windows.map(w => w.pct), [100, 0]);
});

test('usageText: unavailable without a reason says so in aria only; reason and title keep old text', () => {
  const r = usageText({ available: false });
  assert.equal(r.aria, 'Claude plan usage n/a: source did not say why');
  assert.equal(r.reason, 'unknown');
  assert.equal(r.title, 'Plan usage n/a: unknown');
});

test('traceModel: missing, empty or all-zero counts give null (rendered as "no data")', () => {
  assert.equal(traceModel(undefined), null);
  assert.equal(traceModel(null), null);
  assert.equal(traceModel({}), null);
  assert.equal(traceModel({ toolCalls: 'nope' }), null);
  assert.equal(traceModel({ toolCalls: [] }), null);
  assert.equal(traceModel({ toolCalls: new Array(12).fill(0) }), null);
});

test('traceModel: 12 hourly buckets give 4 points each plus one flat pad cell, in a 120x16 box', () => {
  const t = traceModel({ toolCalls: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5] });
  assert.equal(t.width, 120);
  assert.equal(t.height, 16);
  assert.equal(t.points.length, 4 * 12 + 2);
  assert.deepEqual(t.points[0], [0, 13]);
  assert.deepEqual(t.points[t.points.length - 1], [130, 13]);
});

test('traceModel: spikes are normalised to the busiest hour (peak at y=2, half of it at y=7.5)', () => {
  const t = traceModel({ toolCalls: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 4] });
  const peakOf = i => t.points[4 * i + 2];           // third point of each bucket is the spike top
  assert.deepEqual(peakOf(11), [115, 2]);            // busiest hour reaches the top
  assert.deepEqual(peakOf(10), [105, 7.5]);          // half of the busiest hour sits halfway
  assert.deepEqual(peakOf(0), [5, 13]);              // an empty hour stays on the baseline
  for (const [, y] of t.points) assert.ok(y >= 2 && y <= 13, 'y in range: ' + y);
});

test('traceModel: non-numeric and negative counts count as zero', () => {
  const t = traceModel({ toolCalls: ['x', -3, null, 2] });
  assert.ok(t, 'one real count is enough to draw');
  assert.deepEqual(t.points[4 * 3 + 2], [35, 2]);     // the 2 is the busiest hour
  assert.deepEqual(t.points[4 * 0 + 2], [5, 13]);
  assert.equal(traceModel({ toolCalls: ['x', -3, null] }), null);
});

test('newToolCalls: no previous poll gives nothing; increases give deltas per agent', () => {
  const prev = { agents: [{ id: 'dev', today: { toolCalls: 10 } }, { id: 'ash', today: { toolCalls: 4 } }] };
  const next = { agents: [{ id: 'dev', today: { toolCalls: 13 } }, { id: 'ash', today: { toolCalls: 4 } }] };
  assert.deepEqual(newToolCalls(null, next), {});
  assert.deepEqual(newToolCalls(prev, next), { dev: 3 });
  assert.deepEqual(newToolCalls(next, next), {}, 'no change, no blip');
});

test('newToolCalls: a drop (midnight reset) gives nothing, and an agent new to the poll is ignored', () => {
  const prev = { agents: [{ id: 'dev', today: { toolCalls: 90 } }] };
  const reset = { agents: [{ id: 'dev', today: { toolCalls: 0 } }] };
  assert.deepEqual(newToolCalls(prev, reset), {});
  const added = { agents: [{ id: 'dev', today: { toolCalls: 90 } }, { id: 'red', today: { toolCalls: 7 } }] };
  assert.deepEqual(newToolCalls(prev, added), {}, 'red has no earlier count to diff against');
  assert.deepEqual(newToolCalls({ agents: [{ id: 'dev' }] }, { agents: [{ id: 'dev', today: { toolCalls: 2 } }] }), {}, 'no today count before');
});

test('countStep: starts at from, lands on to, clamps t', () => {
  assert.equal(countStep(10, 500, 0), 10);
  assert.equal(countStep(10, 500, 1), 500);
  assert.equal(countStep(10, 500, -3), 10);
  assert.equal(countStep(10, 500, 7), 500);
});

test('countStep: ease-out puts the midpoint well past halfway (0.875 of the way at t=0.5)', () => {
  assert.equal(countStep(0, 1000, 0.5), 875);
  assert.equal(countStep(1000, 0, 0.5), 125);
});

test('countStep: moves monotonically toward the target and returns integers', () => {
  const up = [], down = [];
  for (let i = 0; i <= 20; i++) { up.push(countStep(3, 97, i / 20)); down.push(countStep(97, 3, i / 20)); }
  for (let i = 1; i < up.length; i++) { assert.ok(up[i] >= up[i - 1]); assert.ok(down[i] <= down[i - 1]); }
  for (const v of [...up, ...down]) assert.ok(Number.isInteger(v), `not an integer: ${v}`);
});

test('countStep: equal values and non-finite inputs give the target, never NaN', () => {
  assert.equal(countStep(42, 42, 0.3), 42);
  assert.equal(countStep(NaN, 5, 0.5), 5);
  assert.equal(countStep(1, 9, NaN), 9);
  assert.equal(countStep(1, undefined, 0.5), undefined);
});

test('todayParts: no today gives null; missing fields give null; real zeros stay 0', () => {
  assert.equal(todayParts({}), null);
  assert.deepEqual(todayParts({ today: { tokens: 1200, toolCalls: 0, sessions: 2 } }), { tokens: 1200, toolCalls: 0, sessions: 2 });
  assert.deepEqual(todayParts({ today: { tokens: null, toolCalls: 5 } }), { tokens: null, toolCalls: 5, sessions: null });
  assert.deepEqual(todayParts({ today: { tokens: 'x', toolCalls: '', sessions: '7' } }), { tokens: null, toolCalls: null, sessions: 7 });
});

test('newWalks: no previous poll (first load or reload) shows nothing', () => {
  const walks = [{ id: 'w9', at: now - 5, from: 'default', to: 'dev', kind: 'brief' }];
  assert.deepEqual(newWalks(null, { walks }, ['default', 'dev']), []);
  assert.deepEqual(newWalks(undefined, { walks }, ['default', 'dev']), []);
});

test('newWalks: ids already seen in the previous poll are ignored; only new ids come back', () => {
  const prev = { walks: [{ id: 'w1', at: now - 30, from: 'default', to: 'dev' }] };
  const next = { walks: [{ id: 'w1', at: now - 30, from: 'default', to: 'dev' }, { id: 'w2', at: now - 2, from: 'dev', to: 'default', kind: 'reply', subject: 'done' }] };
  assert.deepEqual(newWalks(prev, next, ['default', 'dev']).map(w => w.id), ['w2']);
  assert.deepEqual(newWalks(next, next, ['default', 'dev']), []);
});

test('newWalks: walks touching an agent not on the grid are ignored', () => {
  const prev = { walks: [] };
  const next = { walks: [{ id: 'a', at: now - 2, from: 'default', to: 'ghost' }, { id: 'b', at: now - 2, from: 'ghost', to: 'dev' }, { id: 'c', at: now - 2, from: 'default', to: 'dev' }] };
  assert.deepEqual(newWalks(prev, next, ['default', 'dev']).map(w => w.id), ['c']);
});

test('newWalks: self-walks are ignored', () => {
  const prev = { walks: [] };
  const next = { walks: [{ id: 's', at: now - 2, from: 'dev', to: 'dev' }] };
  assert.deepEqual(newWalks(prev, next, ['dev']), []);
});

test('newWalks: sorted by at, capped at the newest 4 per poll', () => {
  const prev = { walks: [] };
  const walks = [5, 1, 4, 2, 6, 3].map(n => ({ id: 'k' + n, at: now - 10 + n, from: 'default', to: 'dev' }));
  const got = newWalks(prev, { walks }, ['default', 'dev']);
  assert.equal(got.length, 4);
  assert.deepEqual(got.map(w => w.id), ['k3', 'k4', 'k5', 'k6']);
});

test('newWalks: a walk older than a minute (tab was away) counts as seen, not animated', () => {
  const prev = { walks: [] };
  const next = { walks: [{ id: 'old', at: now - 300, from: 'default', to: 'dev' }, { id: 'new', at: now - 3, from: 'default', to: 'dev' }] };
  assert.deepEqual(newWalks(prev, next, ['default', 'dev'], now).map(w => w.id), ['new']);
  assert.deepEqual(newWalks(prev, next, ['default', 'dev']).map(w => w.id), ['old', 'new'], 'no clock given, no age check');
});

test('walkLabel: from, to, kind name and subject; long subject truncated to ~40 with an ellipsis', () => {
  const names = { default: 'Ash', dev: 'Dev' };
  assert.equal(walkLabel({ from: 'default', to: 'dev', kind: 'brief', subject: 'Fix login' }, names), 'Ash → Dev · new brief · Fix login');
  assert.equal(walkLabel({ from: 'dev', to: 'default', kind: 'reply', subject: '' }, names), 'Dev → Ash · report');
  assert.equal(walkLabel({ from: 'dev', to: 'default', kind: 'message' }, names), 'Dev → Ash · message');
  const long = 'x'.repeat(39) + 'yyyyy';
  const label = walkLabel({ from: 'dev', to: 'default', kind: 'message', subject: long }, names);
  const subj = label.split(' · ')[2];
  assert.equal(subj.length, 40);
  assert.equal(subj.slice(-1), '…');
  assert.equal(walkLabel({ from: 'dev', to: 'default', kind: 'message', subject: 'a'.repeat(40) }, names).endsWith('a'.repeat(40)), true, 'exactly 40 is kept whole');
});

test('walkLabel: unknown names and kinds fall back to the raw id and kind', () => {
  assert.equal(walkLabel({ from: 'nova', to: 'dev', kind: 'poke' }, { dev: 'Dev' }), 'nova → Dev · poke');
});

test('toolRing: no tools, null tools or all-zero counts give no segments and "no data"', () => {
  for (const tools of [[], null, undefined, [{ name: 'read_file', label: 'reading files', count: 0 }]]) {
    const r = toolRing(tools, 'reading files · x', 'working');
    assert.deepEqual(r.segments, []);
    assert.equal(r.total, 0);
    assert.equal(r.active, null);
    assert.equal(r.aria, 'Tools today: no data');
  }
});

test('toolRing: segments are shares of the total, in the order given, starting where the last one ended', () => {
  const tools = [{ name: 'read_file', label: 'reading files', count: 12 }, { name: 'patch', label: 'editing', count: 6 },
    { name: 'terminal', label: 'running commands', count: 2 }];
  const r = toolRing(tools, 'idle · last: x', 'idle');
  assert.equal(r.total, 20);
  assert.deepEqual(r.segments.map(s => s.name), ['read_file', 'patch', 'terminal']);
  assert.equal(r.segments[0].frac, 0.6);
  assert.equal(r.segments[1].offset, 0.6);
  assert.ok(Math.abs(r.segments[2].offset - 0.9) < 1e-9);
  assert.ok(Math.abs(r.segments.reduce((n, s) => n + s.frac, 0) - 1) < 1e-9);
  assert.equal(r.segments[0].shade, 1);
  assert.ok(r.segments[1].shade < 1);
});

test('toolRing: a single tool is a full ring; bad counts are dropped, not summed', () => {
  const r = toolRing([{ name: 'a', label: 'a', count: 5 }, { name: 'b', label: 'b', count: 'x' },
    { name: 'c', label: 'c', count: -3 }, { name: 'd', label: 'd', count: NaN }], '', 'idle');
  assert.deepEqual(r.segments.map(s => s.name), ['a']);
  assert.equal(r.segments[0].frac, 1);
  assert.equal(r.total, 5);
});

test('toolRing: the tool named by activity is active only while working', () => {
  const tools = [{ name: 'read_file', label: 'reading files', count: 12 }, { name: 'patch', label: 'editing', count: 5 }];
  const working = toolRing(tools, 'reading files · notes.md', 'working');
  assert.equal(working.active, 'reading files');
  assert.deepEqual(working.segments.map(s => s.active), [true, false]);
  const idle = toolRing(tools, 'reading files · notes.md', 'idle');
  assert.equal(idle.active, null);
  assert.ok(idle.segments.every(s => !s.active));
});

test('toolRing: no match when the activity names no tool, or the activity is a delegation', () => {
  const tools = [{ name: 'read_file', label: 'reading files', count: 3 }];
  assert.equal(toolRing(tools, 'delegating · 2 helpers', 'working').active, null);
  assert.equal(toolRing(tools, 'thinking', 'working').active, null);
  assert.equal(toolRing(tools, '', 'working').active, null);
  assert.equal(toolRing(tools, 'reading files', 'working').active, 'reading files');
});

test('toolRing: aria lists the labels and counts', () => {
  const r = toolRing([{ name: 'read_file', label: 'reading files', count: 12 }, { name: 'patch', label: 'editing', count: 5 }], '', 'idle');
  assert.equal(r.aria, 'Tools today: reading files 12, editing 5');
});

test('toolRing: more than six tools still get shades (the last one takes the faintest)', () => {
  const tools = Array.from({ length: 8 }, (_, i) => ({ name: 't' + i, label: 't' + i, count: 8 - i }));
  const r = toolRing(tools, '', 'idle');
  assert.equal(r.segments.length, 8);
  assert.equal(r.segments[7].shade, r.segments[6].shade);
  assert.ok(r.segments.every(s => s.shade > 0 && s.shade <= 1));
});

const tripState = (trips, extra = {}) => ({ agents: [
  { id: 'dev', brainTrips: trips.dev || [] },
  { id: 'ash', brainTrips: trips.ash || [] },
], ...extra });
const trip = (id, at, kind) => ({ id, at, kind });

test('newBrainTrips: first load (no previous poll) gives nothing, so nothing replays', () => {
  assert.deepEqual(newBrainTrips(null, tripState({ dev: [trip('d1', now - 5, 'read')] }), now), {});
});

test('newBrainTrips: same ids in the next poll give nothing; a new id is returned for its agent only', () => {
  const prev = tripState({ dev: [trip('d1', now - 30, 'read')], ash: [trip('a1', now - 90, 'write')] });
  assert.deepEqual(newBrainTrips(prev, tripState({ dev: [trip('d1', now - 30, 'read')], ash: [trip('a1', now - 90, 'write')] }), now), {});
  const next = tripState({ dev: [trip('d2', now - 2, 'write'), trip('d1', now - 30, 'read')], ash: [trip('a1', now - 90, 'write')] });
  const d = newBrainTrips(prev, next, now);
  assert.deepEqual(Object.keys(d), ['dev']);
  assert.deepEqual(d.dev.map(t => t.id), ['d2']);
});

test('newBrainTrips: an agent missing from the previous poll, or with no brainTrips there, gives nothing', () => {
  const prev = { agents: [{ id: 'dev', brainTrips: [] }, { id: 'ash' }] };
  const next = tripState({ dev: [trip('d1', now - 3, 'read')], ash: [trip('a1', now - 3, 'read')] });
  assert.deepEqual(newBrainTrips(prev, next, now), { dev: [trip('d1', now - 3, 'read')] });
  assert.deepEqual(newBrainTrips({ agents: [] }, next, now), {});
});

test('newBrainTrips: a trip older than a minute (tab was away) counts as seen, not pulsed', () => {
  const prev = tripState({ dev: [] });
  const next = tripState({ dev: [trip('old', now - 600, 'read'), trip('new', now - 4, 'write')] });
  assert.deepEqual(newBrainTrips(prev, next, now).dev.map(t => t.id), ['new']);
});

test('newBrainTrips: at most three per agent per poll, the newest ones, oldest first', () => {
  const prev = tripState({ dev: [] });
  const next = tripState({ dev: [5, 1, 4, 2, 3].map(i => trip('t' + i, now - i, 'read')) });
  assert.deepEqual(newBrainTrips(prev, next, now).dev.map(t => t.id), ['t3', 't2', 't1']);
});

test('brainText and brainCounts: singular/plural, both kinds, no trips is null', () => {
  assert.equal(brainText([]), null);
  assert.equal(brainText(undefined), null);
  assert.equal(brainText([trip('a', 1, 'read')]), '1 read');
  assert.equal(brainText([trip('a', 1, 'read'), trip('b', 2, 'read'), trip('c', 3, 'write')]), '2 reads · 1 write');
  assert.equal(brainText([trip('a', 1, 'write'), trip('b', 2, 'write')]), '2 writes');
  assert.deepEqual(brainCounts([trip('a', 1, 'read'), trip('b', 2, 'other'), null]), { reads: 1, writes: 0 });
});

test('brainNotes: a count when present, null when missing, non-numeric or negative', () => {
  assert.equal(brainNotes({ notes: 1204 }), 1204);
  assert.equal(brainNotes({ notes: 0 }), 0);
  assert.equal(brainNotes({ notes: '42' }), 42);
  assert.equal(brainNotes({ notes: null }), null);
  assert.equal(brainNotes({}), null);
  assert.equal(brainNotes(null), null);
  assert.equal(brainNotes({ notes: 'many' }), null);
  assert.equal(brainNotes({ notes: -1 }), null);
});

test('helperChanges: first load gives nothing, a new live id is spawned, a gone or finished id is exited', () => {
  const h1 = { id: 'h1', task: 'Read logs', model: 'haiku' };
  const h2 = { id: 'h2', task: 'Write tests', model: 'sonnet' };
  const h3 = { id: 'h3', task: 'Scan deps', model: 'haiku' };
  const prev = { agents: [{ id: 'dev', helpers: [h1, h2], recentHelpers: [] }, { id: 'ash', helpers: [], recentHelpers: [] }] };
  // h1 finished (moved to recentHelpers), h2 gone, h3 new
  const next = { agents: [{ id: 'dev', helpers: [h3], recentHelpers: [{ ...h1, ended: 1 }] }, { id: 'ash', helpers: [], recentHelpers: [] }] };
  assert.deepEqual(helperChanges(null, next), {});
  assert.deepEqual(helperChanges(prev, null), {});
  assert.deepEqual(helperChanges(next, next), {}, 'no change, no events');
  assert.deepEqual(helperChanges(prev, next), {
    dev: { spawned: ['h3'], exited: [{ id: 'h1', task: 'Read logs', model: 'haiku' }, { id: 'h2', task: 'Write tests', model: 'sonnet' }] },
  });
});

test('helperChanges: an agent new to this poll is not animated, and a finished helper seen again is not spawned', () => {
  const h1 = { id: 'h1', task: 'Read logs', model: 'haiku' };
  const prev = { agents: [{ id: 'dev', helpers: [h1], recentHelpers: [] }] };
  const next = { agents: [{ id: 'dev', helpers: [], recentHelpers: [{ ...h1, ended: 1 }] }, { id: 'new', helpers: [h1], recentHelpers: [] }] };
  const out = helperChanges(prev, next);
  assert.deepEqual(Object.keys(out), ['dev']);
  assert.deepEqual(out.dev.spawned, []);
  assert.deepEqual(out.dev.exited.map(e => e.id), ['h1']);
});

test('swarmTip: a count line then model and task per live helper, empty when none', () => {
  assert.equal(swarmTip([]), '');
  assert.equal(swarmTip(undefined), '');
  assert.equal(swarmTip([{ id: 'a', task: ' Read logs ', model: 'haiku' }]), '1 helper running\nhaiku · Read logs');
  assert.equal(swarmTip([{ id: 'a', task: 'X', model: '' }, { id: 'b', task: '', model: 'sonnet' }]),
    '2 helpers running\nhelper · X\nsonnet · task');
});


// ---- Deck revamp phase 1: needs-you lane, roster and header helpers ----

test('needsYou: waiting-for-approval and asking-a-question agents, in agent order', () => {
  const agents = [
    { id: 'default', name: 'Ash', status: 'idle', activity: 'idle · last: writing files', color: '#1' },
    { id: 'dev', name: 'Dev', status: 'waiting', activity: 'waiting for approval', color: '#2' },
    { id: 'red', name: 'Red', status: 'working', activity: 'asking a question · which branch?', color: '#3' },
    { id: 'ops', name: 'Ops', status: 'waiting', activity: 'delegating · 2 helpers', color: '#4' },
    { id: 'off', name: 'Off', status: 'offline', activity: 'no data' },
  ];
  const got = needsYou(agents);
  assert.deepEqual(got.map(n => n.id), ['dev', 'red']);
  assert.deepEqual(got[0], { id: 'dev', name: 'Dev', color: '#2', kind: 'approval', label: 'waiting for approval' });
  assert.equal(got[1].kind, 'question');
  assert.equal(got[1].label, 'asking a question');
});

test('needsYou: empty, missing and malformed input give an empty list', () => {
  assert.deepEqual(needsYou([]), []);
  assert.deepEqual(needsYou(undefined), []);
  assert.deepEqual(needsYou([null, { id: 'x', status: 'working', activity: 'running tests' }]), []);
});

test('statusWord: words for each status, unknown reads as Idle', () => {
  assert.equal(statusWord('working'), 'Working');
  assert.equal(statusWord('waiting'), 'Waiting');
  assert.equal(statusWord('idle'), 'Idle');
  assert.equal(statusWord('offline'), 'Offline');
  assert.equal(statusWord('weird'), 'Idle');
});

test('greeting: morning, afternoon, evening by local hour', () => {
  assert.equal(greeting(4), 'Good evening');
  assert.equal(greeting(5), 'Good morning');
  assert.equal(greeting(11), 'Good morning');
  assert.equal(greeting(12), 'Good afternoon');
  assert.equal(greeting(17), 'Good afternoon');
  assert.equal(greeting(18), 'Good evening');
});

test('shortDuration: <1m, minutes, hours; bad input gives null', () => {
  assert.equal(shortDuration(30), '<1m');
  assert.equal(shortDuration(39 * 60 + 20), '39m');
  assert.equal(shortDuration(2 * 3600 + 900), '2h');
  assert.equal(shortDuration(-5), null);
  assert.equal(shortDuration(NaN), null);
});

test('rosterDuration: from the earliest working session; null when not working or no start', () => {
  const sessions = [{ status: 'working', started: now - 2340 }, { status: 'working', started: now - 60 }, { status: 'idle', started: now - 9000 }];
  assert.equal(rosterDuration({ status: 'working' }, sessions, now), '39m');
  assert.equal(rosterDuration({ status: 'idle' }, sessions, now), null);
  assert.equal(rosterDuration({ status: 'working' }, [{ status: 'working' }], now), null);
  assert.equal(rosterDuration({ status: 'working' }, undefined, now), null);
});

test('clockText: 24h HH:MM with leading zeros', () => {
  assert.equal(clockText(new Date(2026, 10, 6, 7, 5)), '07:05');
  assert.equal(clockText(new Date(2026, 10, 6, 23, 59)), '23:59');
});

test('resetSoon: true only for a reset 0 to 15 minutes away', () => {
  const at = ms => new Date(now * 1000 + ms).toISOString();
  assert.equal(resetSoon(at(10 * 60000), now * 1000), true);
  assert.equal(resetSoon(at(20 * 60000), now * 1000), false);
  assert.equal(resetSoon(at(-60000), now * 1000), false);
  assert.equal(resetSoon(null, now * 1000), false);
  assert.equal(resetSoon(now + 300, now * 1000), true, 'unix seconds are accepted');
});
