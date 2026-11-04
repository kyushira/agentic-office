import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PWA_BASE, headTags, installPwaHead } from '../src/pwa-head.js';

// Minimal fake DOM: supports querySelector for 'tag[attr="value"]' and appendChild.
class FakeElement {
  constructor(tag) {
    this.tagName = tag;
    this.attributes = {};
  }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; }
}

class FakeHead {
  constructor() { this.children = []; }
  appendChild(el) { this.children.push(el); return el; }
  querySelector(sel) {
    const m = /^(\w+)\[(\w+)="([^"]*)"\]$/.exec(sel);
    if (!m) throw new Error(`unsupported selector: ${sel}`);
    const [, tag, attr, value] = m;
    return this.children.find(
      (c) => c.tagName === tag && c.getAttribute(attr) === value,
    ) || null;
  }
}

function fakeDoc({ viewport } = {}) {
  const head = new FakeHead();
  if (viewport !== undefined) {
    const v = new FakeElement('meta');
    v.setAttribute('name', 'viewport');
    v.setAttribute('content', viewport);
    head.appendChild(v);
  }
  return {
    head,
    createElement: (tag) => new FakeElement(tag),
  };
}

test('PWA_BASE is the plugin pwa path', () => {
  assert.equal(PWA_BASE, '/dashboard-plugins/agent-office/pwa');
});

test('headTags returns the 8 expected entries', () => {
  const tags = headTags();
  assert.equal(tags.length, 8);
  assert.deepEqual(tags[0], { tag: 'link', attrs: { rel: 'manifest', href: `${PWA_BASE}/manifest.json` } });
  assert.deepEqual(tags[1], { tag: 'link', attrs: { rel: 'apple-touch-icon', sizes: '180x180', href: `${PWA_BASE}/icon-180.png` } });
  assert.deepEqual(tags[2], { tag: 'link', attrs: { rel: 'icon', type: 'image/png', sizes: '192x192', href: `${PWA_BASE}/icon-192.png` } });
  assert.deepEqual(tags[7], { tag: 'meta', attrs: { name: 'theme-color', content: '#0f1115' } });
});

test('installPwaHead on empty head adds 8 tags and a viewport meta', () => {
  const doc = fakeDoc();
  const added = installPwaHead(doc);
  assert.equal(added, 8);
  const viewport = doc.head.querySelector('meta[name="viewport"]');
  assert.ok(viewport);
  assert.equal(viewport.getAttribute('content'), 'width=device-width, initial-scale=1, viewport-fit=cover');
  const injected = doc.head.children.filter((c) => c.getAttribute('data-agent-office') === 'pwa');
  assert.equal(injected.length, 8);
});

test('installPwaHead is idempotent', () => {
  const doc = fakeDoc({ viewport: 'width=device-width, initial-scale=1' });
  assert.equal(installPwaHead(doc), 8);
  const count = doc.head.children.length;
  assert.equal(installPwaHead(doc), 0);
  assert.equal(doc.head.children.length, count);
});

test('skips tags already present by rel/name key', () => {
  const doc = fakeDoc();
  const existing = new FakeElement('link');
  existing.setAttribute('rel', 'manifest');
  existing.setAttribute('href', '/other.json');
  doc.head.appendChild(existing);
  assert.equal(installPwaHead(doc), 7);
  assert.equal(doc.head.querySelector('link[rel="manifest"]'), existing);
});

test('appends viewport-fit=cover to existing viewport meta', () => {
  const doc = fakeDoc({ viewport: 'width=device-width, initial-scale=1' });
  installPwaHead(doc);
  const v = doc.head.querySelector('meta[name="viewport"]');
  assert.equal(v.getAttribute('content'), 'width=device-width, initial-scale=1, viewport-fit=cover');
});

test('leaves viewport alone when viewport-fit already present', () => {
  const doc = fakeDoc({ viewport: 'width=device-width, viewport-fit=cover' });
  installPwaHead(doc);
  const v = doc.head.querySelector('meta[name="viewport"]');
  assert.equal(v.getAttribute('content'), 'width=device-width, viewport-fit=cover');
});

test('returns 0 when doc or doc.head is missing', () => {
  assert.equal(installPwaHead(undefined), 0);
  assert.equal(installPwaHead(null), 0);
  assert.equal(installPwaHead({}), 0);
  assert.equal(installPwaHead({ head: null }), 0);
});
