// Unit tests for src/team-model.js (run by `npm test` via node:test).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { teamStrip } from '../src/team-model.js';
import { statusOf } from '../src/agents-model.js';

const ag = (id, status, extra = {}) => ({ id, name: id[0].toUpperCase() + id.slice(1), status, activity: 'idle', lastActive: 0, ...extra });

const SEVEN = [
  ag('dev', 'idle'), ag('red', 'offline'), ag('default', 'idle', { name: 'Ash' }), ag('nova', 'offline'),
  ag('pixel', 'idle'), ag('sentinel', 'offline'), ag('prism', 'idle'),
];

describe('teamStrip', () => {
  test('keeps all 7 when all are idle or offline', () => {
    const out = teamStrip(SEVEN);
    assert.equal(out.length, 7);
    assert.deepEqual(out.map(a => a.id).sort(), ['default', 'dev', 'nova', 'pixel', 'prism', 'red', 'sentinel']);
  });

  test('Ash comes first, the rest keep state.agents order', () => {
    const out = teamStrip(SEVEN);
    assert.equal(out[0].id, 'default');
    assert.deepEqual(out.slice(1).map(a => a.id), ['dev', 'red', 'nova', 'pixel', 'sentinel', 'prism']);
  });

  test('offline agents are dim, keep their id, and stay in the list', () => {
    const out = teamStrip(SEVEN);
    const red = out.find(a => a.id === 'red');
    assert.equal(red.status, 'offline');
    assert.equal(red.dim, true);
    assert.equal(out.find(a => a.id === 'dev').dim, false);
    assert.equal(red.label, 'Red · offline');
  });

  test('status matches statusOf (working shows as working, error and waiting kept)', () => {
    const agents = [ag('dev', 'working'), ag('red', 'waiting'), ag('nova', 'error'), ag('pixel', 'idle', { error: 'boom' })];
    const out = teamStrip(agents);
    assert.deepEqual(out.map(a => a.status), ['working', 'waiting', 'error', 'error']);
    for (const a of agents) {
      const row = out.find(r => r.id === a.id);
      const bucket = statusOf(a);
      const expect = { running: 'working', waiting: 'waiting', error: 'error', idle: 'idle' }[bucket];
      assert.equal(row.status, expect);
    }
  });

  test('colour comes from the agent (normalised), never a hardcoded accent', () => {
    const out = teamStrip([ag('dev', 'idle', { color: '#4fd983' }), ag('red', 'idle', { color: '#FF6A3D' })]);
    assert.equal(out[0].color, '#4FD983');
    assert.equal(out[1].color, '#FF6A3D');
  });

  test('invalid or missing input gives an empty list, not a throw', () => {
    assert.deepEqual(teamStrip(undefined), []);
    assert.deepEqual(teamStrip(null), []);
    assert.deepEqual(teamStrip([null, {}, 'x']), []);
  });

  test('duplicate ids are kept once and a missing name falls back to the id', () => {
    const out = teamStrip([ag('dev', 'idle'), ag('dev', 'working'), { id: 'nova', status: 'idle' }]);
    assert.equal(out.length, 2);
    assert.equal(out[0].status, 'idle');
    assert.equal(out[1].name, 'nova');
  });
});
