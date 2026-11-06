// Unit tests for src/rail-model.js (run by `npm test` via node:test).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { RAIL_SECTIONS, RAIL_LINE, isAtBottom, pickActive } from '../src/rail-model.js';

const item = (id, top, visible = true) => ({ id, top, visible });

describe('RAIL_SECTIONS', () => {
  test('four buttons in the agreed order, with unique ids and targets', () => {
    assert.deepEqual(RAIL_SECTIONS.map(s => s.id), ['office', 'needs', 'live', 'usage']);
    assert.equal(new Set(RAIL_SECTIONS.map(s => s.id)).size, RAIL_SECTIONS.length);
    assert.equal(new Set(RAIL_SECTIONS.map(s => s.target)).size, RAIL_SECTIONS.length);
  });

  test('every section has a label and a target id, and the reference line is a fraction', () => {
    for (const s of RAIL_SECTIONS) {
      assert.ok(s.label && s.target, s.id);
    }
    assert.ok(RAIL_LINE > 0 && RAIL_LINE < 1);
  });
});

describe('isAtBottom', () => {
  test('true at the end and within the slack, false above it', () => {
    assert.equal(isAtBottom(900, 100, 1000), true);
    assert.equal(isAtBottom(897, 100, 1000), true);
    assert.equal(isAtBottom(0, 100, 1000), false);
    assert.equal(isAtBottom(0, 100, 100), true);   // nothing to scroll
  });
});

describe('pickActive', () => {
  const line = 200;

  test('at the top of the page the first section (Office) is current', () => {
    const items = [item('office', 40), item('needs', null, false), item('live', 40), item('usage', null, false)];
    assert.equal(pickActive({ items, line, current: 'office' }), 'office');
  });

  test('a section whose top has passed the line becomes current', () => {
    const items = [item('office', -500), item('live', 0), item('usage', 800)];
    assert.equal(pickActive({ items, line, current: 'office' }), 'live');
  });

  test('a section below the line is not chosen while one above it exists', () => {
    const items = [item('office', -100), item('live', 500), item('usage', 500)];
    assert.equal(pickActive({ items, line, current: 'office' }), 'office');
  });

  test('when everything is below the line, the topmost visible section is chosen', () => {
    const items = [item('live', 420), item('usage', 420), item('needs', 600, false)];
    assert.equal(pickActive({ items, line, current: 'needs' }), 'usage');
  });

  test('side-by-side tie keeps the current one (a click on one is not undone by its neighbour)', () => {
    const items = [item('office', -300), item('live', 100), item('usage', 100)];
    assert.equal(pickActive({ items, line, current: 'live' }), 'live');
    assert.equal(pickActive({ items, line, current: 'usage' }), 'usage');
  });

  test('side-by-side tie with no current in it picks the later one in rail order', () => {
    const items = [item('office', -300), item('live', 100), item('usage', 100)];
    assert.equal(pickActive({ items, line, current: 'office' }), 'usage');
  });

  test('near-equal tops (within 2px) count as a tie', () => {
    const items = [item('live', 100), item('usage', 101)];
    assert.equal(pickActive({ items, line, current: 'live' }), 'live');
  });

  test('at the bottom of the scroll area the last visible section wins', () => {
    const items = [item('office', -2000, false), item('live', 300), item('usage', 300)];
    assert.equal(pickActive({ items, line, atBottom: true, current: 'office' }), 'usage');
  });

  test('nothing measurable keeps the current id; not-rendered sections are ignored', () => {
    assert.equal(pickActive({ items: [item('needs', null, false)], line, current: 'office' }), 'office');
    assert.equal(pickActive({ items: [], line, current: null }), null);
    assert.equal(pickActive({ items: [item('live', 10, false)], line, current: 'usage' }), 'usage');
  });
});
