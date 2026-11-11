// The PWA manifest opens and scopes the Office tab (/office), not the old /deck.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(here, '..', 'plugin', 'agent-office', 'dashboard', 'pwa', 'manifest.json'), 'utf8'));
const tab = JSON.parse(readFileSync(join(here, '..', 'plugin', 'agent-office', 'dashboard', 'manifest.json'), 'utf8'));

test('pwa manifest starts and scopes at /office', () => {
  assert.equal(manifest.start_url, '/office');
  assert.equal(manifest.scope, '/office');
  assert.equal(manifest.id, '/office');
});

test('start_url is inside scope', () => {
  assert.equal(manifest.start_url.startsWith(manifest.scope), true);
});

test('the dashboard tab is labelled Office at /office, with the API routes unchanged', () => {
  assert.equal(tab.label, 'Office');
  assert.equal(tab.tab.path, '/office');
  assert.equal(tab.entry, 'dist/index.js');
  assert.equal(tab.api, 'plugin_api.py');
});
