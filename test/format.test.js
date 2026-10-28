// Unit tests for src/format.js (run by `npm test` via node:test).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ago, compact, sparkPath, statusLabel, headline } from '../src/format.js';

describe('ago', () => {
  const now = 1_000_000;
  test('missing timestamp renders an em dash', () => {
    assert.equal(ago(0, now), '—');
    assert.equal(ago(null, now), '—');
    assert.equal(ago(undefined, now), '—');
  });
  test('under 45 seconds is "now"', () => {
    assert.equal(ago(now, now), 'now');
    assert.equal(ago(now - 10, now), 'now');
    assert.equal(ago(now - 44, now), 'now');
  });
  test('future timestamps clamp to "now"', () => {
    assert.equal(ago(now + 500, now), 'now');
  });
  test('minutes, hours and days', () => {
    assert.equal(ago(now - 45, now), '1m ago');
    assert.equal(ago(now - 30 * 60, now), '30m ago');
    assert.equal(ago(now - 3600, now), '1h ago');
    assert.equal(ago(now - 5 * 3600, now), '5h ago');
    assert.equal(ago(now - 86400, now), '1d ago');
    assert.equal(ago(now - 3 * 86400, now), '3d ago');
  });
  // Regression: 3599s used to render "60m ago".
  test('just under an hour rolls over to "1h ago"', () => {
    assert.equal(ago(now - 3599, now), '1h ago');
  });
});

describe('compact', () => {
  test('small numbers are returned as strings', () => {
    assert.equal(compact(0), '0');
    assert.equal(compact(999), '999');
  });
  test('missing or non-numeric input becomes 0', () => {
    assert.equal(compact(undefined), '0');
    assert.equal(compact(null), '0');
    assert.equal(compact('abc'), '0');
  });
  test('numeric strings are coerced', () => {
    assert.equal(compact('1500'), '1.5k');
  });
  test('thousands', () => {
    assert.equal(compact(1000), '1.0k');
    assert.equal(compact(1500), '1.5k');
    assert.equal(compact(12345), '12k');
  });
  test('millions', () => {
    assert.equal(compact(1_000_000), '1.0M');
    assert.equal(compact(1_500_000), '1.5M');
    assert.equal(compact(12_000_000), '12M');
  });
  // Regression: 999950 used to render "1000k".
  test('values just under 1M do not render as "1000k"', () => {
    assert.equal(compact(999_950), '1.0M');
  });
});

describe('sparkPath', () => {
  test('empty or missing series falls back to a flat two-point line', () => {
    assert.equal(sparkPath(), 'M0.0,26.0 L120.0,26.0');
    assert.equal(sparkPath([]), 'M0.0,26.0 L120.0,26.0');
  });
  test('scales values into the box and spaces points across the width', () => {
    assert.equal(sparkPath([1, 2]), 'M0.0,14.0 L120.0,2.0');
  });
  test('single point is drawn at x=0 with the max scaled to the box', () => {
    assert.equal(sparkPath([5]), 'M0.0,2.0');
  });
  test('all-zero series stays on the baseline (max floored to 1)', () => {
    assert.equal(sparkPath([0, 0, 0]), 'M0.0,26.0 L60.0,26.0 L120.0,26.0');
  });
  test('one segment per value, honouring custom width and height', () => {
    const p = sparkPath([1, 3, 2, 4], 40, 20);
    const segs = p.split(' ');
    assert.equal(segs.length, 4);
    assert.match(segs[0], /^M0\.0,/);
    assert.ok(segs.slice(1).every((s) => /^L\d+\.\d,/.test(s)));
    assert.match(segs[3], /^L40\.0,/);
  });
});

describe('statusLabel', () => {
  test('known statuses map to their labels', () => {
    for (const s of ['working', 'waiting', 'idle', 'offline']) {
      assert.equal(statusLabel({ status: s }), s);
    }
  });
  test('unknown status is passed through unchanged', () => {
    assert.equal(statusLabel({ status: 'bogus' }), 'bogus');
  });
});

describe('headline', () => {
  test('singular agent', () => {
    assert.equal(headline({ counts: { agents: 1, running: 0 } }), '1 agent · 0 running');
  });
  test('plural agents', () => {
    assert.equal(headline({ counts: { agents: 3, running: 2 } }), '3 agents · 2 running');
  });
  test('zero agents', () => {
    assert.equal(headline({ counts: { agents: 0, running: 0 } }), '0 agents · 0 running');
  });
  test('missing state or counts falls back to zeros', () => {
    assert.equal(headline(null), '0 agents · 0 running');
    assert.equal(headline({}), '0 agents · 0 running');
  });
});
