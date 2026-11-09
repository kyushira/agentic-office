import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normText, countChars, counterState, isDirty, splitLines, lineDiff, diffSummary, diffSummaryText, diffView,
  needsExtraConfirm, confirmLabel, blockReason, parseFailure, errorInfo, undoable, saveRequest, restoreRequest,
  versionsUrl, versionUrl, editState, versionLabel, restoreState, WRITE_HEADERS, TOAST_MS,
} from '../src/brain-edit-model.js';
import { BRAIN_API } from '../src/brain-model.js';

const SECTION = '\n§\n';   // the entry separator in MEMORY.md / USER.md: must come through every helper byte-exact

test('normText and countChars: CRLF counts as one character, the server count (code points) is matched', () => {
  assert.equal(normText('a\r\nb'), 'a\nb');
  assert.equal(countChars('a\r\nb'), 3);
  assert.equal(countChars('a\nb'), 3);
  assert.equal(countChars('😀'), 1);            // astral: one code point, as Python len() counts it
  assert.equal(countChars(null), 0);
});

test('counterState: 90% boundary is amber (inclusive), 89.9% is not', () => {
  // limit 2200: 90% is 1980 exactly
  assert.equal(counterState(1979, 2200).level, 'ok');
  assert.equal(counterState(1980, 2200).level, 'warn');
  assert.equal(counterState(1980, 2200).cue, 'Near limit');
  assert.equal(counterState(1979, 2200).cue, '');
  assert.equal(counterState(1375 * 0.9, 1375).level, 'warn');   // 1237.5 is not an integer; rounded to 1238 -> warn
});

test('counterState: exactly at the limit is allowed (amber), limit+1 is blocked and says by how much', () => {
  const at = counterState(2200, 2200);
  assert.equal(at.level, 'warn');
  assert.equal(at.blocked, false);
  assert.equal(at.overBy, 0);
  const over = counterState(2201, 2200);
  assert.equal(over.level, 'over');
  assert.equal(over.blocked, true);
  assert.equal(over.overBy, 1);
  assert.equal(over.cue, 'Over limit by 1');
  assert.equal(counterState(2400, 2200).cue, 'Over limit by 200');
});

test('counterState: label uses thousands separators; zero and unknown counts are safe', () => {
  assert.equal(counterState(1840, 2200).label, '1,840 / 2,200');
  assert.equal(counterState(20000, 20000).label, '20,000 / 20,000');
  assert.equal(counterState(undefined, 2200).label, '0 / 2,200');
  assert.equal(counterState(5, 0).blocked, true);
});

test('CRLF in a draft counts the same as LF, so the counter matches the server', () => {
  const crlf = 'a\r\n'.repeat(10);
  assert.equal(countChars(crlf), 20);
  assert.equal(counterState(countChars(crlf), 20).label, '20 / 20');
});

test('section separator survives every helper unchanged', () => {
  const text = `first entry${SECTION}second entry`;
  assert.equal(normText(text), text);
  assert.equal(countChars(text), 'first entry'.length + SECTION.length + 'second entry'.length);
  assert.deepEqual(splitLines(text), ['first entry', '§', 'second entry']);
  assert.equal(isDirty(text, text), false);
  const ops = lineDiff(text, text);
  assert.ok(ops.every(o => o.type === 'same'));
  assert.ok(ops.some(o => o.text === '§'));
  const edited = lineDiff(text, `first entry${SECTION}third entry`);
  assert.ok(edited.some(o => o.type === 'del' && o.text === 'second entry'));
  assert.ok(edited.some(o => o.type === 'add' && o.text === 'third entry'));
  assert.ok(edited.some(o => o.type === 'same' && o.text === '§'));
});

test('isDirty: CRLF against LF is not a change; a real edit is', () => {
  assert.equal(isDirty('a\nb', 'a\r\nb'), false);
  assert.equal(isDirty('a\nc', 'a\nb'), true);
  assert.equal(isDirty('', ''), false);
  assert.equal(isDirty('x', null), true);
});

test('splitLines: empty text has no lines; one trailing newline is one more empty line', () => {
  assert.deepEqual(splitLines(''), []);
  assert.deepEqual(splitLines('a'), ['a']);
  assert.deepEqual(splitLines('a\nb'), ['a', 'b']);
});

test('lineDiff: identical texts have no add or del', () => {
  const t = 'one\ntwo\nthree';
  const ops = lineDiff(t, t);
  assert.equal(ops.filter(o => o.type !== 'same').length, 0);
  assert.equal(ops.length, 3);
  assert.deepEqual(lineDiff('', ''), []);
});

test('lineDiff: one changed line in the middle is one del and one add, in order', () => {
  const ops = lineDiff('a\nb\nc\nd', 'a\nB\nc\nd');
  assert.deepEqual(ops.map(o => o.type), ['same', 'del', 'add', 'same', 'same']);
  assert.equal(ops[1].text, 'b');
  assert.equal(ops[2].text, 'B');
});

test('lineDiff: pure insertions and deletions, both ends', () => {
  assert.deepEqual(lineDiff('', 'x\ny').map(o => o.type), ['add', 'add']);
  assert.deepEqual(lineDiff('x\ny', '').map(o => o.type), ['del', 'del']);
  assert.deepEqual(lineDiff('a\nc', 'a\nb\nc').map(o => o.type), ['same', 'add', 'same']);
  assert.deepEqual(lineDiff('a\nb\nc', 'a\nc').map(o => o.type), ['same', 'del', 'same']);
});

test('lineDiff: LCS finds a true minimal edit, not just prefix and suffix', () => {
  // a b c d e -> b x d f : LCS is b, d; minimal edit is 3 dels, 2 adds ... counted through summary
  const s = diffSummary(lineDiff('a\nb\nc\nd\ne', 'b\nx\nd\nf'));
  assert.equal(s.same, 2);
  assert.equal(s.removed, 3);
  assert.equal(s.added, 2);
});

test('lineDiff: a long file (about 20000 characters, 1000 lines) with one edit stays fast and exact', () => {
  const lines = Array.from({ length: 1000 }, (_, i) => `entry ${i} ${'x'.repeat(10)}`);
  const before = lines.join('\n');
  const after = lines.map((l, i) => (i === 500 ? 'entry 500 changed' : l)).join('\n');
  assert.ok(before.length <= 20000 + 1000);
  const t0 = Date.now();
  const s = diffSummary(lineDiff(before, after));
  assert.ok(Date.now() - t0 < 2000);
  assert.deepEqual(s, { added: 1, removed: 1, same: 999 });
});

test('lineDiff: a huge middle above the cap falls back to all removed then all added', () => {
  const A = Array.from({ length: 3000 }, (_, i) => `a${i}`).join('\n');
  const B = Array.from({ length: 3000 }, (_, i) => `b${i}`).join('\n');
  const s = diffSummary(lineDiff(A, B));
  assert.deepEqual(s, { added: 3000, removed: 3000, same: 0 });
});

test('diffSummary and diffSummaryText', () => {
  const ops = lineDiff('a\nb', 'a\nc\nd');
  assert.deepEqual(diffSummary(ops), { added: 2, removed: 1, same: 1 });
  assert.equal(diffSummaryText(ops), '+2 / -1 lines');
  assert.equal(diffSummaryText([]), '+0 / -0 lines');
});

test('diffView: long unchanged runs collapse to a gap, keeping context next to changes', () => {
  const lines = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n');
  const changed = lines.replace('l10', 'X10');
  const view = diffView(lineDiff(lines, changed), 2);
  const gaps = view.filter(v => v.type === 'gap');
  assert.equal(gaps.length, 2);
  assert.equal(gaps[0].count, 8);   // l0..l7 hidden; l8 and l9 kept before the change
  assert.equal(gaps[1].count, 7);   // l13..l19 hidden; l11 and l12 kept after the change
  assert.equal(view.filter(v => v.type !== 'gap').length, 6);   // l8, l9, del l10, add X10, l11, l12
  assert.ok(view.some(v => v.type === 'del' && v.text === 'l10'));
  assert.ok(view.some(v => v.type === 'add' && v.text === 'X10'));
});

test('diffView: identical long text is one gap', () => {
  const t = Array.from({ length: 12 }, (_, i) => `l${i}`).join('\n');
  assert.deepEqual(diffView(lineDiff(t, t)), [{ type: 'gap', count: 12 }]);
});

test('diffView: short runs are not collapsed', () => {
  const view = diffView(lineDiff('a\nb\nc', 'a\nX\nc'));
  assert.equal(view.some(v => v.type === 'gap'), false);
  assert.equal(view.length, 4);
});

test('needsExtraConfirm: true for SOUL and for Ash (default), false for Dev memory', () => {
  assert.equal(needsExtraConfirm('default', 'soul'), true);
  assert.equal(needsExtraConfirm('default', 'memory'), true);
  assert.equal(needsExtraConfirm('default', 'user'), true);
  assert.equal(needsExtraConfirm('dev', 'soul'), true);
  assert.equal(needsExtraConfirm('dev', 'memory'), false);
  assert.equal(needsExtraConfirm('dev', 'user'), false);
});

test('confirmLabel: plain first, then the armed wording with the agent name and noun', () => {
  assert.equal(confirmLabel({ name: 'Ash', file: 'soul' }), 'Confirm save');
  assert.equal(confirmLabel({ name: 'Ash', file: 'soul', armed: true }), "Tap again to save Ash's soul");
  assert.equal(confirmLabel({ name: 'Ash', file: 'memory', armed: true }), "Tap again to save Ash's memory");
  assert.equal(confirmLabel({ name: 'Ash', file: 'user', armed: true }), "Tap again to save Ash's profile");
  assert.equal(confirmLabel({ verb: 'restore', name: 'Ash', file: 'soul' }), 'Restore');
  assert.equal(confirmLabel({ verb: 'restore', name: 'Ash', file: 'soul', armed: true }), "Tap again to restore Ash's soul");
});

test('blockReason: the three server reasons, and null when editable', () => {
  assert.equal(blockReason('redacted'), 'Has redacted secrets, edit on the server');
  assert.equal(blockReason('too_large'), 'Too large to edit here');
  assert.equal(blockReason('unreadable'), 'Could not be read');
  assert.equal(blockReason(null), null);
  assert.equal(blockReason(undefined), null);
});

test('editState: editable files have no reason; blocked ones say why', () => {
  assert.deepEqual(editState({ editable: true, edit_block: null }), { editable: true, reason: '' });
  assert.deepEqual(editState({ editable: false, edit_block: 'redacted' }), { editable: false, reason: 'Has redacted secrets, edit on the server' });
  assert.equal(editState(null).editable, false);
});

test('parseFailure: fetchJSON style "<status>: <body>" is split; bodies are parsed; network errors are status 0', () => {
  assert.deepEqual(parseFailure(new Error('409: {"error":"changed since loaded","sha":"ab"}')), { status: 409, body: { error: 'changed since loaded', sha: 'ab' } });
  assert.deepEqual(parseFailure(new Error('428: {"error":"confirm required"}')).body, { error: 'confirm required' });
  assert.deepEqual(parseFailure(new Error('500: <html>oops</html>')), { status: 500, body: {} });
  assert.deepEqual(parseFailure(new Error('413')), { status: 413, body: {} });
  assert.deepEqual(parseFailure(new TypeError('Failed to fetch')), { status: 0, body: {} });
  assert.deepEqual(parseFailure(null), { status: 0, body: {} });
  assert.deepEqual(parseFailure(new Error('422: [1,2]')).body, {});
});

test('parseFailure: host ApiError shape (numeric status, raw body text, humanised message) is read from status and body', () => {
  const e409 = { status: 409, body: '{"error":"changed since loaded","sha":"x"}', message: 'changed since loaded' };
  const f = parseFailure(e409);
  assert.equal(f.status, 409);
  assert.equal(f.body.sha, 'x');
  assert.equal(errorInfo(f).kind, 'changed');
  const over = parseFailure({ status: 422, body: '{"error":"over limit","chars":2201,"limit":2200}', message: 'Some of the entered values are not valid.' });
  assert.equal(over.status, 422);
  assert.equal(over.body.chars, 2201);
  assert.equal(over.body.limit, 2200);
  assert.equal(errorInfo(over).message, 'Over the limit by 1 characters. Nothing was changed.');
  assert.deepEqual(parseFailure({ status: 0, body: '', message: 'Failed to fetch' }), { status: 0, body: {} });
  assert.equal(errorInfo(parseFailure({ status: 0, body: '' })).kind, 'network');
  assert.deepEqual(parseFailure({ status: 500, body: '<html>oops</html>', message: 'x' }), { status: 500, body: {} });
  assert.deepEqual(parseFailure({ status: 409, body: { error: 'changed since loaded' } }).body, { error: 'changed since loaded' });
  assert.deepEqual(parseFailure({ status: 409, body: '[1]' }).body, {});
});

test('errorInfo: each server refusal maps to a plain message; changed gets its own kind for Reload', () => {
  assert.equal(errorInfo({ status: 409, body: { error: 'changed since loaded' } }).kind, 'changed');
  assert.equal(errorInfo({ status: 409, body: { error: 'changed since loaded' } }).message, 'Changed since you opened it');
  assert.equal(errorInfo({ status: 409, body: { error: 'not editable', reason: 'redacted' } }).message, "Can't edit this file here: it has redacted secrets.");
  assert.equal(errorInfo({ status: 422, body: { error: 'over limit', chars: 2201, limit: 2200 } }).message, 'Over the limit by 1 characters. Nothing was changed.');
  assert.equal(errorInfo({ status: 422, body: { error: 'text looks like it contains a secret' } }).kind, 'secret');
  assert.equal(errorInfo({ status: 422, body: { error: 'blocked pattern', findings: ['x'] } }).kind, 'pattern');
  assert.equal(errorInfo({ status: 428, body: { error: 'confirm required' } }).kind, 'confirm');
  assert.equal(errorInfo({ status: 413, body: {} }).kind, 'large');
  assert.equal(errorInfo({ status: 403, body: {} }).kind, 'refused');
  assert.equal(errorInfo({ status: 404, body: {} }).kind, 'missing');
  assert.equal(errorInfo({ status: 0, body: {} }).kind, 'network');
  assert.equal(errorInfo({ status: 500, body: {} }).kind, 'server');
  assert.equal(errorInfo({ status: 418, body: {} }).kind, 'other');
});

test('errorInfo: no message carries a body field back (no file text, no paths)', () => {
  const m = errorInfo({ status: 422, body: { error: 'over limit', chars: 9, limit: 2, text: 'SECRET TEXT', path: '/opt/x' } }).message;
  assert.equal(m.includes('SECRET'), false);
  assert.equal(m.includes('/opt'), false);
});

test('undoable: only a real backup id gives an Undo', () => {
  assert.equal(undoable('20261109T101010_000001Z'), true);
  assert.equal(undoable(null), false);
  assert.equal(undoable(undefined), false);
  assert.equal(undoable(''), false);
  assert.equal(TOAST_MS, 5000);
});

test('saveRequest: PUT with the X-Requested-With header; confirm only when passed', () => {
  const r = saveRequest({ agent: 'dev', file: 'memory', text: 'hi', base_sha: 'abc' });
  assert.equal(r.method, 'PUT');
  assert.equal(r.url, BRAIN_API);
  assert.equal(r.headers['X-Requested-With'], 'agent-deck');
  assert.equal(r.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(r.body), { agent: 'dev', file: 'memory', text: 'hi', base_sha: 'abc' });
  assert.equal('confirm' in JSON.parse(r.body), false);
  const c = saveRequest({ agent: 'default', file: 'soul', text: 'hi', base_sha: '', confirm: true });
  assert.equal(JSON.parse(c.body).confirm, true);
  assert.equal(WRITE_HEADERS['X-Requested-With'], 'agent-deck');
});

test('saveRequest: the text goes in the body untouched (separator and CRLF are not rewritten here)', () => {
  const text = `a${SECTION}b\r\nc`;
  assert.equal(JSON.parse(saveRequest({ agent: 'dev', file: 'memory', text, base_sha: 'x' }).body).text, text);
});

test('restoreRequest: POST to /restore with id and the header; confirm only when passed', () => {
  const r = restoreRequest({ agent: 'default', file: 'soul', id: '20261109T101010_000001Z', base_sha: 'sha1', confirm: true });
  assert.equal(r.method, 'POST');
  assert.equal(r.url, BRAIN_API + '/restore');
  assert.equal(r.headers['X-Requested-With'], 'agent-deck');
  assert.deepEqual(JSON.parse(r.body), { agent: 'default', file: 'soul', id: '20261109T101010_000001Z', base_sha: 'sha1', confirm: true });
  assert.equal('confirm' in JSON.parse(restoreRequest({ agent: 'dev', file: 'user', id: 'x', base_sha: 'y' }).body), false);
});

test('versionsUrl and versionUrl: encoded query, GET by default', () => {
  assert.equal(versionsUrl('dev', 'memory'), BRAIN_API + '/versions?agent=dev&file=memory');
  assert.equal(versionUrl('a&b', 'user', '2026x'), BRAIN_API + '/version?agent=a%26b&file=user&id=2026x');
});

test('versionLabel: absolute UTC time and thousands-separated chars; unknown time when ts is missing', () => {
  assert.equal(versionLabel({ ts: 1794187833, chars: 1408 }), '2026-11-09 01:30 UTC · 1,408 chars');
  assert.equal(versionLabel({ chars: 5 }), 'unknown time · 5 chars');
});

test('restoreState: not restorable says why', () => {
  assert.deepEqual(restoreState({ restorable: true }), { restorable: true, reason: '' });
  assert.equal(restoreState({ restorable: false }).restorable, false);
  assert.match(restoreState({ restorable: false }).reason, /can't be restored here/);
  assert.equal(restoreState(null).restorable, false);
});
