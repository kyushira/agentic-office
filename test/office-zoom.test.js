// Fit/zoom model for OfficeHome (src/office-zoom-model.js). Ported from feat/office-exact's office-zoom tests,
// keeping only the zoom and size parts (the postMessage protocol and gesture tests are not carried over).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { frameScale, zoomNext, defaultZoomMode, ZOOM_FIT, ZOOM_ONE, ROOM_W, ROOM_H } from '../src/office-zoom-model.js';

describe('frameScale (fit to the pane width)', () => {
  test('fit scales the 756px room to the pane width', () => {
    assert.equal(frameScale(378, ZOOM_FIT), 0.5);
    assert.equal(frameScale(728, ZOOM_FIT), 728 / ROOM_W);
  });
  test('fit never upscales: a pane wider than the room stays at 1', () => {
    assert.equal(frameScale(1200, ZOOM_FIT), 1);
    assert.equal(frameScale(ROOM_W, ZOOM_FIT), 1);
  });
  test('1x ignores the width', () => {
    assert.equal(frameScale(728, ZOOM_ONE), 1);
    assert.equal(frameScale(0, ZOOM_ONE), 1);
  });
  test('an unknown or zero width is scale 1, never NaN or Infinity', () => {
    assert.equal(frameScale(0), 1);
    assert.equal(frameScale(-5), 1);
    assert.equal(frameScale(NaN), 1);
    assert.equal(frameScale(undefined), 1);
    assert.equal(frameScale('abc'), 1);
  });
  test('the zoom changes only the scale, and the room is wider than tall', () => {
    assert.equal(ROOM_W / ROOM_H > 1, true);
  });
});

describe('zoomNext (the zoom buttons)', () => {
  test('toggle flips between fit and 1.0x', () => {
    assert.equal(zoomNext(ZOOM_FIT, 'toggle'), ZOOM_ONE);
    assert.equal(zoomNext(ZOOM_ONE, 'toggle'), ZOOM_FIT);
  });
  test('in means 1.0x, out means fit, from either state', () => {
    assert.equal(zoomNext(ZOOM_FIT, 'in'), ZOOM_ONE);
    assert.equal(zoomNext(ZOOM_ONE, 'in'), ZOOM_ONE);
    assert.equal(zoomNext(ZOOM_ONE, 'out'), ZOOM_FIT);
    assert.equal(zoomNext(ZOOM_FIT, 'out'), ZOOM_FIT);
  });
  test('a missing or bogus op keeps the mode; an unknown mode normalises to fit', () => {
    assert.equal(zoomNext(ZOOM_ONE, undefined), ZOOM_ONE);
    assert.equal(zoomNext(ZOOM_FIT, 'sideways'), ZOOM_FIT);
    assert.equal(zoomNext('nonsense', 'toggle'), ZOOM_ONE);
    assert.equal(zoomNext(null, 'out'), ZOOM_FIT);
  });
});

describe('defaultZoomMode (landscape on a coarse pointer starts at 1.0x)', () => {
  test('coarse landscape is 1.0x, everything else fits', () => {
    assert.equal(defaultZoomMode({ coarseLandscape: true }), ZOOM_ONE);
    assert.equal(defaultZoomMode({ coarseLandscape: false }), ZOOM_FIT);
    assert.equal(defaultZoomMode({}), ZOOM_FIT);
    assert.equal(defaultZoomMode(), ZOOM_FIT);
  });
});
