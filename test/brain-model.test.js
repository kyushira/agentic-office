import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BRAIN_API, brainUrl, clampBar, brainLevel, pctText, fmtInt, fillLabel, updatedLabel, fileView, soulLine, brainAgents } from '../src/brain-model.js';

const now = 1_800_000_000;
const F = (over = {}) => ({ exists: true, mtime: now - 10800, chars: 1408, limit: 2200, pct: 64, text: 'x', truncated: false, first: 'x', redacted: 0, error: null, ...over });

test('brainUrl: overview is the bare route; one agent is a narrowed, encoded query', () => {
  assert.equal(brainUrl(), BRAIN_API);
  assert.equal(brainUrl(''), BRAIN_API);
  assert.equal(brainUrl('dev'), BRAIN_API + '?agent=dev');
  assert.equal(brainUrl('a&b'), BRAIN_API + '?agent=a%26b');
});

test('clampBar: clamps to 0..100 for the bar width, keeps no-number as null', () => {
  assert.equal(clampBar(98.6), 98.6);
  assert.equal(clampBar(105), 100);
  assert.equal(clampBar(-3), 0);
  assert.equal(clampBar(null), null);
  assert.equal(clampBar(''), null);
  assert.equal(clampBar(true), null);
  assert.equal(clampBar('nope'), null);
});

test('brainLevel: ok below 70, warn from 70 to under 90, full from 90 (also over 100)', () => {
  assert.equal(brainLevel(0), 'ok');
  assert.equal(brainLevel(69.9), 'ok');
  assert.equal(brainLevel(70), 'warn');
  assert.equal(brainLevel(89.9), 'warn');
  assert.equal(brainLevel(90), 'full');
  assert.equal(brainLevel(120), 'full');
  assert.equal(brainLevel(null), 'na');
  assert.equal(brainLevel('x'), 'na');
});

test('pctText: whole numbers have no decimal, others keep one', () => {
  assert.equal(pctText(64), '64%');
  assert.equal(pctText(98.6), '98.6%');
  assert.equal(pctText(100.04), '100%');
  assert.equal(pctText(null), '');
});

test('fmtInt: thousands separators, no locale dependence', () => {
  assert.equal(fmtInt(1408), '1,408');
  assert.equal(fmtInt(2200), '2,200');
  assert.equal(fmtInt(999), '999');
  assert.equal(fmtInt(1234567), '1,234,567');
  assert.equal(fmtInt(undefined), '0');
});

test('fillLabel: limited file reads 1,408 / 2,200 (64%); unlimited reads chars; missing and unreadable say so', () => {
  assert.equal(fillLabel(F()), '1,408 / 2,200 (64%)');
  assert.equal(fillLabel(F({ limit: null, pct: null })), '1,408 chars');
  assert.equal(fillLabel(F({ exists: false, chars: 0, mtime: null, text: '' })), 'no file');
  assert.equal(fillLabel(F({ error: 'unreadable', text: '' })), 'unreadable');
  assert.equal(fillLabel(null), 'no file');
});

test('updatedLabel: relative time from the mtime; empty when there is no file or mtime', () => {
  assert.equal(updatedLabel(F(), now), 'updated 3h ago');
  assert.equal(updatedLabel(F({ mtime: now - 5 }), now), 'updated just now');
  assert.equal(updatedLabel(F({ exists: false, mtime: null }), now), '');
  assert.equal(updatedLabel(F({ mtime: null }), now), '');
});

test('fileView: Ash memory at 98.6% keeps the real number and clamps the bar', () => {
  const v = fileView(F({ chars: 2169, limit: 2200, pct: 98.6 }), null, now);
  assert.equal(v.bar, 98.6);
  assert.equal(v.level, 'full');
  assert.equal(v.label, '2,169 / 2,200 (98.6%)');
  const over = fileView(F({ chars: 2400, limit: 2200, pct: 109.1 }), null, now);
  assert.equal(over.bar, 100);
  assert.equal(over.pct, 109.1);
  assert.equal(over.label, '2,400 / 2,200 (109.1%)');
});

test('fileView: soul has no limit, so no bar and level na; short size is compact', () => {
  const v = fileView(F({ chars: 5800, limit: null, pct: null }), null, now);
  assert.equal(v.bar, null);
  assert.equal(v.level, 'na');
  assert.equal(v.short, '5.8k');
  assert.equal(v.label, '5,800 chars');
});

test('fileView: the endpoint limit is used when the file does not carry one', () => {
  const v = fileView({ exists: true, mtime: now, chars: 500, pct: 22.7, text: '', truncated: false, first: '', error: null }, 2200, now);
  assert.equal(v.limit, 2200);
  assert.equal(v.label, '500 / 2,200 (22.7%)');
});

test('fileView: a missing file has no text, no bar fill and reads no file', () => {
  const v = fileView({ exists: false, mtime: null, chars: 0, limit: 1375, pct: 0, text: '', truncated: false, first: '', redacted: 0, error: null }, 1375, now);
  assert.equal(v.exists, false);
  assert.equal(v.label, 'no file');
  assert.equal(v.text, '');
  assert.equal(soulLine(fileView(null, null, now)), 'Soul: no file');
});

test('soulLine: size and update time, dot separated', () => {
  assert.equal(soulLine(fileView(F({ chars: 5800, limit: null, pct: null }), null, now)), 'Soul 5.8k · updated 3h ago');
  assert.equal(soulLine(fileView(F({ chars: 5800, limit: null, pct: null, mtime: null }), null, now)), 'Soul 5.8k');
});

test('fileView: truncated flag and first line pass through; text is never HTML-parsed here', () => {
  const v = fileView(F({ truncated: true, first: 'Ash <b>x</b>', text: '<img src=x>' }), null, now);
  assert.equal(v.truncated, true);
  assert.equal(v.first, 'Ash <b>x</b>');
  assert.equal(v.text, '<img src=x>');
});

test('brainAgents: endpoint order kept, limits applied, bad rows dropped, malformed payload is empty', () => {
  const payload = {
    limits: { memory: 2200, user: 1375 },
    agents: [
      { id: 'default', name: 'Ash', soul: F({ chars: 5800, limit: null, pct: null }), memory: F({ chars: 2169, pct: 98.6 }), user: F({ chars: 900, limit: 1375, pct: 65.5 }) },
      null,
      { name: 'no id' },
      { id: 'dev', name: 'Dev', soul: F({ exists: false, chars: 0, mtime: null, text: '' }), memory: F({ chars: 1408, pct: 64 }), user: F({ exists: false, chars: 0, mtime: null, text: '', pct: 0 }) },
    ],
  };
  const rows = brainAgents(payload, now);
  assert.deepEqual(rows.map(r => r.id), ['default', 'dev']);
  assert.equal(rows[0].name, 'Ash');
  assert.equal(rows[0].memory.label, '2,169 / 2,200 (98.6%)');
  assert.equal(rows[0].user.label, '900 / 1,375 (65.5%)');
  assert.equal(rows[1].soul.label, 'no file');
  assert.equal(rows[1].memory.label, '1,408 / 2,200 (64%)');
  assert.deepEqual(brainAgents(null, now), []);
  assert.deepEqual(brainAgents({}, now), []);
  assert.deepEqual(brainAgents({ agents: 'nope' }, now), []);
});
