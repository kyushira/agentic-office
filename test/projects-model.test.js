import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectWord, projectTone, clipSubject, projectRows, PROJECT_SUBJECT_MAX } from '../src/projects-model.js';

test('projectWord and projectTone: active teal, quiet gold, stale grey, each with a word', () => {
  assert.equal(projectWord('active'), 'Active');
  assert.equal(projectWord('quiet'), 'Quiet');
  assert.equal(projectWord('stale'), 'Stale');
  assert.equal(projectWord('bogus'), 'Stale');
  assert.equal(projectTone('active'), 'live');
  assert.equal(projectTone('quiet'), 'gold');
  assert.equal(projectTone('stale'), 'grey');
});

test('clipSubject: short text unchanged, long text cut with an ellipsis, empty is empty', () => {
  assert.equal(clipSubject('  fix the rail  '), 'fix the rail');
  const long = 'x'.repeat(PROJECT_SUBJECT_MAX + 20);
  const out = clipSubject(long);
  assert.equal(out.length, PROJECT_SUBJECT_MAX);
  assert.ok(out.endsWith('…'));
  assert.equal(clipSubject(null), '');
});

test('projectRows: sorted newest first, missing commit gives null subject, not a made-up one', () => {
  const rows = projectRows({ projects: [
    { name: 'old', status: 'stale', last_activity: 100, last_commit: null },
    { name: 'new', status: 'active', last_activity: 900, last_commit: { subject: 'add usage rings', branch: 'main' } },
    { name: 'mid', status: 'quiet', last_activity: 500, last_commit: { subject: 'x' } },
  ] });
  assert.deepEqual(rows.map(r => r.name), ['new', 'mid', 'old']);
  assert.equal(rows[0].subject, 'add usage rings');
  assert.equal(rows[0].branch, 'main');
  assert.equal(rows[2].subject, null);
  assert.equal(rows[2].word, 'Stale');
  assert.equal(rows[1].tone, 'gold');
});

test('projectRows: empty or malformed payloads give an empty list', () => {
  assert.deepEqual(projectRows(null), []);
  assert.deepEqual(projectRows({}), []);
  assert.deepEqual(projectRows({ projects: [null, { status: 'active' }] }), []);
});
