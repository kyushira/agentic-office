// Probe mapping for OfficeHome (src/office-probe-model.js).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { probeOutcome, OFFICE_URL, OFFICE_PROBE_URL } from '../src/office-probe-model.js';

describe('probeOutcome', () => {
  test('the proxy path is the same-origin office page', () => {
    assert.equal(OFFICE_URL, '/api/plugins/agent-office/office/');
  });
  test('the probe is GET on the upstream-backed /health route, not the static office page', () => {
    assert.equal(OFFICE_PROBE_URL, '/api/plugins/agent-office/office/health');
    assert.notEqual(OFFICE_PROBE_URL, OFFICE_URL);
  });
  test('2xx mounts the iframe', () => {
    assert.equal(probeOutcome(200), 'ready');
    assert.equal(probeOutcome(204), 'ready');
  });
  test('401 and 403 mean the dashboard login is needed', () => {
    assert.equal(probeOutcome(401), 'login');
    assert.equal(probeOutcome(403), 'login');
  });
  test('a manual redirect (login page) means the dashboard login is needed', () => {
    assert.equal(probeOutcome(0, 'opaqueredirect'), 'login');
  });
  test('502, 503, 504, 404 and a network error (no status) show the offline card', () => {
    assert.equal(probeOutcome(502), 'offline');
    assert.equal(probeOutcome(503), 'offline');
    assert.equal(probeOutcome(504), 'offline');
    assert.equal(probeOutcome(404), 'offline');
    assert.equal(probeOutcome(null), 'offline');
    assert.equal(probeOutcome(0), 'offline');
    assert.equal(probeOutcome(undefined), 'offline');
    assert.equal(probeOutcome(NaN), 'offline');
  });
});
