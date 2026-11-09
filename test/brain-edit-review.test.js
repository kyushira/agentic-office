// Review-fix tests for the Brain editor model: the busy / scanner / audit refusals get their own plain copy, and an
// over-limit draft says why Save is blocked (the unsaved-changes prompt uses it). Pure functions only; no DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorInfo, saveBlockedReason, overridableFindings, scanNotice, confirmLabel, restoreRequest, saveRequest } from '../src/brain-edit-model.js';

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

test('restore gate: a 422 blocked pattern that is overridable opens the warning with the findings listed', () => {
  const f = overridableFindings({ status: 422, body: { error: 'blocked pattern', findings: ['zero-width chars'], overridable: true } });
  assert.deepEqual(f, ['zero-width chars']);
  assert.deepEqual(scanNotice({ findings: f }), { tone: 'alert', text: 'This version trips the safety scanner: zero-width chars' });
  assert.equal(confirmLabel({ verb: 'restore', override: true }), 'Restore anyway');
});

test('restore gate: the override is sent only after Restore anyway (override_findings true), never on a plain restore', () => {
  const plain = JSON.parse(restoreRequest({ agent: 'dev', file: 'memory', id: 'v', base_sha: 's' }).body);
  assert.equal('override_findings' in plain, false);
  const anyway = JSON.parse(restoreRequest({ agent: 'dev', file: 'memory', id: 'v', base_sha: 's', override_findings: true }).body);
  assert.equal(anyway.override_findings, true);
});

test('scan unavailable: the note says restore will be refused; the 503 keeps its plain copy', () => {
  assert.equal(scanNotice({ findings: null, scan_unavailable: true }).text, 'Safety scan unavailable; restore will be refused.');
  assert.equal(errorInfo({ status: 503, body: { error: 'safety scanner unavailable' } }).message, 'Safety scanner unavailable; nothing was saved.');
});

test('confirm token: a save after a 428 sends the fresh token, and a refused save keeps the token single-use on the server', () => {
  const r = JSON.parse(saveRequest({ agent: 'default', file: 'soul', text: 't', base_sha: 's', confirm_token: 'fresh' }).body);
  assert.equal(r.confirm_token, 'fresh');
  assert.equal(errorInfo({ status: 428, body: { error: 'confirm token invalid or expired' } }).message, 'Confirmation expired. Tap again to confirm.');
});
