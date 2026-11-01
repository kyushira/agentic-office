import { test } from 'node:test';
import assert from 'node:assert/strict';
import { invader, tint, hash } from '../src/sprite.js';

test('invader is stable per id and symmetric', () => {
  const a = invader('dev/abc'), b = invader('dev/abc');
  assert.deepEqual(a, b);
  const set = new Set(a.a.map(([x, y]) => `${x},${y}`));
  for (const [x, y] of a.a) assert.ok(set.has(`${a.w - 1 - x},${y}`), 'mirrored');
  assert.ok(a.a.length > 12);
});
test('different ids give different sprites and colours', () => {
  const ids = Array.from({ length: 20 }, (_, i) => 'id' + i);
  assert.ok(new Set(ids.map(i => JSON.stringify(invader(i).a))).size > 15);
  assert.ok(new Set(ids.map(tint)).size > 6);
  assert.equal(hash('x'), hash('x'));
});
