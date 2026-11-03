import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildItems, headerCounts, durationText, modelText, modelParts } from '../src/deck-model.js';

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
