import { test } from 'node:test';
import assert from 'node:assert/strict';
import { portrait, SIZE } from '../src/portrait.js';

const area = p => p.base.reduce((n, r) => n + r[2], 0);

test('each character is a filled 32×32 bust that stays in bounds', () => {
  for (const k of ['default', 'dev', 'red', 'helper:Haiku', 'helper:Gemini', 'someone-new']) {
    const p = portrait(k);
    assert.equal(p.size, SIZE);
    assert.ok(area(p) > 300, k + ' has a body');
    for (const [x, y, w] of p.base) assert.ok(x >= 0 && y >= 0 && x + w <= SIZE && y < SIZE, k + ' in bounds');
  }
});

test('characters differ, palettes stay small, and people blink', () => {
  const sig = k => JSON.stringify(portrait(k).base);
  assert.notEqual(sig('default'), sig('dev'));
  assert.notEqual(sig('dev'), sig('red'));
  assert.notEqual(sig('helper:Haiku'), sig('helper:Gemini'), 'helpers tinted by model');
  for (const k of ['default', 'dev', 'red']) {
    assert.ok(new Set(portrait(k).base.map(r => r[3])).size <= 24, k + ' limited palette');
    assert.equal(portrait(k).open.length, portrait(k).closed.length);
    assert.ok(portrait(k).open.length > 0);
  }
});
