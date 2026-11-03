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

test('nova, pixel and sentinel have their own busts, distinct from each other and from an unknown id', () => {
  const sig = k => JSON.stringify(portrait(k).base);
  const named = ['nova', 'pixel', 'sentinel'];
  for (const k of named) {
    assert.notEqual(sig(k), sig('someone-new'), k + ' is not the fallback');
    assert.notEqual(sig(k), sig('default'), k + ' is not Ash');
    assert.notEqual(sig(k), sig('dev'), k + ' is not Dev');
    assert.notEqual(sig(k), sig('red'), k + ' is not Red');
  }
  assert.notEqual(sig('nova'), sig('pixel'));
  assert.notEqual(sig('pixel'), sig('sentinel'));
  assert.notEqual(sig('nova'), sig('sentinel'));
});

test('unknown ids get a stable hashed variant, not one shared fallback', () => {
  const sig = k => JSON.stringify(portrait(k).base);
  assert.equal(sig('someone-new'), sig('someone-new'), 'deterministic');
  const many = new Set(['alpha', 'beta', 'gamma', 'delta', 'omega', 'zeta', 'eta', 'theta'].map(sig));
  assert.ok(many.size >= 4, 'unknown ids vary: ' + many.size + ' distinct of 8');
});

test('deepseek helpers get their own tint, distinct from haiku and gemini', () => {
  const sig = k => JSON.stringify(portrait(k).base);
  assert.notEqual(sig('helper:DeepSeek V4 Flash'), sig('helper:Haiku'));
  assert.notEqual(sig('helper:DeepSeek V4 Flash'), sig('helper:Gemini Flash'));
});

test('characters differ, palettes stay small, and people blink', () => {
  const sig = k => JSON.stringify(portrait(k).base);
  assert.notEqual(sig('default'), sig('dev'));
  assert.notEqual(sig('dev'), sig('red'));
  assert.notEqual(sig('helper:Haiku'), sig('helper:Gemini'), 'helpers tinted by model');
  for (const k of ['default', 'dev', 'red', 'nova', 'pixel', 'sentinel', 'someone-new']) {
    assert.ok(new Set(portrait(k).base.map(r => r[3])).size <= 24, k + ' limited palette');
    assert.equal(portrait(k).open.length, portrait(k).closed.length);
    assert.ok(portrait(k).open.length > 0);
  }
});
