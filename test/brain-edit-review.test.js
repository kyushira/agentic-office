// Review-fix tests for the Brain editor model: the busy / scanner / audit refusals get their own plain copy, and an
// over-limit draft says why Save is blocked (the unsaved-changes prompt uses it). Pure functions only; no DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorInfo, saveBlockedReason } from '../src/brain-edit-model.js';

test('errorInfo: a busy lock (503 from the server) says to try again, and nothing was saved', () => {
  const i = errorInfo({ status: 503, body: { error: 'busy, try again' } });
  assert.equal(i.kind, 'busy');
  assert.equal(i.message, 'Busy, try again in a moment.');
});

test('errorInfo: scanner unavailable (503) says nothing was saved', () => {
  const i = errorInfo({ status: 503, body: { error: 'safety scanner unavailable' } });
  assert.equal(i.kind, 'scanner');
  assert.equal(i.message, 'Safety scanner unavailable; nothing was saved.');
});

test('errorInfo: audit log unavailable (500) says nothing was saved', () => {
  const i = errorInfo({ status: 500, body: { error: 'audit log unavailable' } });
  assert.equal(i.kind, 'audit');
  assert.equal(i.message, 'Audit log unavailable; nothing was saved.');
});

test('errorInfo: an unnamed 500 or 503 is still the generic server message', () => {
  assert.equal(errorInfo({ status: 500, body: {} }).kind, 'server');
  assert.equal(errorInfo({ status: 503, body: {} }).kind, 'server');
});

test('saveBlockedReason: empty within the limit (and at it), says by how much when over', () => {
  assert.equal(saveBlockedReason(2200, 2200), '');
  assert.equal(saveBlockedReason(0, 2200), '');
  assert.equal(saveBlockedReason(2201, 2200), 'Over the limit by 1 characters. Shorten it to save.');
  assert.equal(saveBlockedReason(3200, 2200), 'Over the limit by 1,000 characters. Shorten it to save.');
});
