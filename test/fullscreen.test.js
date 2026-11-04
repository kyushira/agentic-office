// Unit tests for src/fullscreen.js (run by `npm test` via node:test).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  isStandalone,
  wantsFull,
  withFullParam,
  requestNativeFullscreen,
  exitNativeFullscreen,
} from '../src/fullscreen.js';

const mm = (matches) => () => ({ matches });

describe('isStandalone', () => {
  test('missing window is not standalone', () => {
    assert.equal(isStandalone(undefined), false);
    assert.equal(isStandalone(null), false);
  });
  test('no matchMedia and no navigator is false', () => {
    assert.equal(isStandalone({}), false);
  });
  test('display-mode standalone matches', () => {
    const win = { matchMedia: (q) => ({ matches: q === '(display-mode: standalone)' }) };
    assert.equal(isStandalone(win), true);
  });
  test('display-mode fullscreen matches', () => {
    const win = { matchMedia: (q) => ({ matches: q === '(display-mode: fullscreen)' }) };
    assert.equal(isStandalone(win), true);
  });
  test('no display-mode match is false', () => {
    assert.equal(isStandalone({ matchMedia: mm(false) }), false);
  });
  test('iOS navigator.standalone true is standalone', () => {
    assert.equal(isStandalone({ navigator: { standalone: true } }), true);
  });
  test('navigator.standalone non-true is false', () => {
    assert.equal(isStandalone({ navigator: { standalone: false } }), false);
    assert.equal(isStandalone({ navigator: { standalone: 'yes' } }), false);
  });
  test('throwing matchMedia does not throw', () => {
    const win = { matchMedia: () => { throw new Error('boom'); }, navigator: { standalone: true } };
    assert.equal(isStandalone(win), true);
    assert.equal(isStandalone({ matchMedia: () => { throw new Error('boom'); } }), false);
  });
});

describe('wantsFull', () => {
  test('standalone forces full', () => {
    assert.equal(wantsFull('', true), true);
  });
  test('full=1 in search turns it on', () => {
    assert.equal(wantsFull('?full=1', false), true);
    assert.equal(wantsFull('?a=b&full=1', false), true);
  });
  test('other values or absence are not full', () => {
    assert.equal(wantsFull('', false), false);
    assert.equal(wantsFull('?full=0', false), false);
    assert.equal(wantsFull('?full=true', false), false);
    assert.equal(wantsFull('?full=', false), false);
  });
});

describe('withFullParam', () => {
  test('sets full=1 and keeps other params and hash', () => {
    assert.equal(withFullParam('https://x.test/p?a=1#h', true), '/p?a=1&full=1#h');
  });
  test('removes full and keeps other params', () => {
    assert.equal(withFullParam('https://x.test/p?full=1&a=1', false), '/p?a=1');
  });
  test('removing when absent is a no-op; no query leaves no "?"', () => {
    assert.equal(withFullParam('https://x.test/p', false), '/p');
    assert.equal(withFullParam('https://x.test/p?full=1', false), '/p');
  });
  test('sets on a bare path', () => {
    assert.equal(withFullParam('https://x.test/', true), '/?full=1');
  });
});

describe('requestNativeFullscreen', () => {
  test('missing element resolves false', async () => {
    assert.equal(await requestNativeFullscreen(null), false);
    assert.equal(await requestNativeFullscreen(undefined), false);
  });
  test('unsupported element resolves false', async () => {
    assert.equal(await requestNativeFullscreen({}), false);
  });
  test('standard requestFullscreen success resolves true and binds el', async () => {
    let seen = null;
    const el = { requestFullscreen() { seen = this; return Promise.resolve(); } };
    assert.equal(await requestNativeFullscreen(el), true);
    assert.equal(seen, el);
  });
  test('rejecting requestFullscreen resolves false', async () => {
    const el = { requestFullscreen: () => Promise.reject(new Error('denied')) };
    assert.equal(await requestNativeFullscreen(el), false);
  });
  test('throwing requestFullscreen resolves false', async () => {
    const el = { requestFullscreen: () => { throw new Error('sync'); } };
    assert.equal(await requestNativeFullscreen(el), false);
  });
  test('webkit path works when undefined return (not a promise)', async () => {
    let called = false;
    const el = { webkitRequestFullscreen() { called = true; } };
    assert.equal(await requestNativeFullscreen(el), true);
    assert.equal(called, true);
  });
  test('webkit path rejecting resolves false', async () => {
    const el = { webkitRequestFullscreen: () => Promise.reject(new Error('no')) };
    assert.equal(await requestNativeFullscreen(el), false);
  });
  test('standard method preferred over webkit', async () => {
    const calls = [];
    const el = {
      requestFullscreen: () => { calls.push('std'); },
      webkitRequestFullscreen: () => { calls.push('wk'); },
    };
    assert.equal(await requestNativeFullscreen(el), true);
    assert.deepEqual(calls, ['std']);
  });
});

describe('exitNativeFullscreen', () => {
  test('null doc does nothing', async () => {
    await assert.doesNotReject(exitNativeFullscreen(null));
  });
  test('not in fullscreen does not call exit', async () => {
    let called = false;
    await exitNativeFullscreen({ exitFullscreen: () => { called = true; } });
    assert.equal(called, false);
  });
  test('calls exitFullscreen when fullscreenElement set', async () => {
    let called = false;
    const doc = { fullscreenElement: {}, exitFullscreen() { called = true; return Promise.resolve(); } };
    await exitNativeFullscreen(doc);
    assert.equal(called, true);
  });
  test('webkit path when webkitFullscreenElement set', async () => {
    let called = false;
    const doc = { webkitFullscreenElement: {}, webkitExitFullscreen() { called = true; } };
    await exitNativeFullscreen(doc);
    assert.equal(called, true);
  });
  test('rejecting exit is swallowed', async () => {
    const doc = { fullscreenElement: {}, exitFullscreen: () => Promise.reject(new Error('x')) };
    await assert.doesNotReject(exitNativeFullscreen(doc));
  });
  test('throwing exit is swallowed', async () => {
    const doc = { webkitFullscreenElement: {}, webkitExitFullscreen: () => { throw new Error('x'); } };
    await assert.doesNotReject(exitNativeFullscreen(doc));
  });
});
