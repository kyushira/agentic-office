// Pure logic for the Brain editor (src/BrainEdit.jsx, src/Brain.jsx). No DOM access; unit-tested in
// test/brain-edit-model.test.js. Server contract: plugin/agent-office/dashboard/brain_edit.py (PUT /brain, POST
// /brain/restore, GET /brain/versions, GET /brain/version). Text is only ever shown as text nodes by the UI.
import { BRAIN_API, fmtInt } from './brain-model.js';

export const WRITE_HEADERS = Object.freeze({ 'Content-Type': 'application/json', 'X-Requested-With': 'agent-deck' });
export const NEAR_LIMIT = 0.9;
export const FILE_TITLES = Object.freeze({ soul: 'Soul', memory: 'Memory', user: 'User profile' });
/** The noun used in the confirm copy: 'Tap again to save Ash's soul'. */
export const FILE_NOUN = Object.freeze({ soul: 'soul', memory: 'memory', user: 'profile' });
export const TOAST_MS = 5000;
export const NO_VERSIONS = 'No saved versions yet.';

/** CRLF to LF, as the server does before it counts or writes. Nothing else changes. */
export function normText(s) {
  return String(s == null ? '' : s).replace(/\r\n/g, '\n');
}

/** Characters as the server counts them: after CRLF->LF, by code point (Python len), not UTF-16 units. */
export function countChars(s) {
  return Array.from(normText(s)).length;
}

/**
 * Counter for a draft against its limit. chars is the draft's count (use countChars). level: 'ok' below 90% of the
 * limit, 'warn' from 90% up to and including the limit, 'over' above it. blocked: Save must be disabled. The cue is
 * the text that goes with the colour, so colour is never the only signal.
 */
export function counterState(chars, limit) {
  const n = Math.max(0, Math.round(Number(chars) || 0));
  const lim = Math.max(0, Math.round(Number(limit) || 0));
  const over = n > lim;
  const near = !over && lim > 0 && n * 10 >= lim * 9;   // integer compare: exactly 90% is already near
  const overBy = over ? n - lim : 0;
  return {
    label: `${fmtInt(n)} / ${fmtInt(lim)}`,
    level: over ? 'over' : near ? 'warn' : 'ok',
    blocked: over,
    overBy,
    cue: over ? `Over limit by ${fmtInt(overBy)}` : near ? 'Near limit' : '',
  };
}

/** Save and Restore rules: is the draft different from the stored text? Compared after CRLF->LF. */
export function isDirty(draft, stored) {
  return normText(draft) !== normText(stored);
}

/** Lines of a text. Empty text has no lines (not one empty line), so '' vs 'x' is a single add. */
export function splitLines(text) {
  const t = normText(text);
  return t === '' ? [] : t.split('\n');
}

const MAX_CELLS = 4000000;   // LCS table cap: beyond it the middle is shown as all removed, then all added

/**
 * Line diff from a to b: [{type:'same'|'del'|'add', text}] in file order. The common prefix and suffix are trimmed
 * first, so an edit in a long file costs only its middle. The middle uses an LCS table (Uint16, so at most 65535
 * lines a side; the cap above bounds memory).
 */
export function lineDiff(a, b) {
  const A = splitLines(a), B = splitLines(b);
  const ops = [];
  let s = 0;
  while (s < A.length && s < B.length && A[s] === B[s]) s++;
  let ea = A.length, eb = B.length;
  while (ea > s && eb > s && A[ea - 1] === B[eb - 1]) { ea--; eb--; }
  for (let i = 0; i < s; i++) ops.push({ type: 'same', text: A[i] });
  const a2 = A.slice(s, ea), b2 = B.slice(s, eb);
  const n = a2.length, m = b2.length;
  if (n === 0 || m === 0 || n * m > MAX_CELLS) {
    for (const t of a2) ops.push({ type: 'del', text: t });
    for (const t of b2) ops.push({ type: 'add', text: t });
  } else {
    const W = m + 1;
    const L = new Uint16Array((n + 1) * W);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        L[i * W + j] = a2[i] === b2[j] ? L[(i + 1) * W + j + 1] + 1 : Math.max(L[(i + 1) * W + j], L[i * W + j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a2[i] === b2[j]) { ops.push({ type: 'same', text: a2[i] }); i++; j++; }
      else if (L[(i + 1) * W + j] >= L[i * W + j + 1]) { ops.push({ type: 'del', text: a2[i] }); i++; }
      else { ops.push({ type: 'add', text: b2[j] }); j++; }
    }
    while (i < n) { ops.push({ type: 'del', text: a2[i] }); i++; }
    while (j < m) { ops.push({ type: 'add', text: b2[j] }); j++; }
  }
  for (let k = ea; k < A.length; k++) ops.push({ type: 'same', text: A[k] });
  return ops;
}

/** Counts for the summary line: { added, removed, same }. */
export function diffSummary(ops) {
  const out = { added: 0, removed: 0, same: 0 };
  for (const o of ops || []) {
    if (o.type === 'add') out.added++;
    else if (o.type === 'del') out.removed++;
    else out.same++;
  }
  return out;
}

/** '+3 / -1 lines' (ASCII minus so the text reads the same everywhere). */
export function diffSummaryText(ops) {
  const s = diffSummary(ops);
  return `+${s.added} / -${s.removed} lines`;
}

/**
 * For display: unchanged runs longer than 2*ctx+1 lines are replaced by one {type:'gap', count} item, keeping ctx
 * lines next to each change. At the start or end of the file only the side next to a change is kept.
 */
export function diffView(ops, ctx = 2) {
  const out = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].type !== 'same') { out.push(ops[i]); i++; continue; }
    let j = i;
    while (j < ops.length && ops[j].type === 'same') j++;
    const run = j - i;
    if (run <= ctx * 2 + 1) {
      for (let k = i; k < j; k++) out.push(ops[k]);
    } else {
      const head = i === 0 ? 0 : ctx;
      const tail = j === ops.length ? 0 : ctx;
      for (let k = i; k < i + head; k++) out.push(ops[k]);
      out.push({ type: 'gap', count: run - head - tail });
      for (let k = j - tail; k < j; k++) out.push(ops[k]);
    }
    i = j;
  }
  return out;
}

/** SOUL always needs the extra tap, and so does Ash (agent id 'default') for any file. */
export function needsExtraConfirm(agentId, file) {
  return agentId === 'default' || file === 'soul';
}

/**
 * Button label. Not armed: 'Confirm save' (or 'Restore'). Armed (the first tap of an extra-confirm write):
 * "Tap again to save Ash's soul". verb is 'save' or 'restore'.
 */
export function confirmLabel({ verb = 'save', name, file, armed = false }) {
  if (!armed) return verb === 'restore' ? 'Restore' : 'Confirm save';
  return `Tap again to ${verb === 'restore' ? 'restore' : 'save'} ${name || 'this agent'}'s ${FILE_NOUN[file] || 'file'}`;
}

/** Why a block cannot be edited, from file.edit_block; null when it can (or when there is no block). */
export function blockReason(editBlock) {
  if (!editBlock) return null;
  if (editBlock === 'redacted') return 'Has redacted secrets, edit on the server';
  if (editBlock === 'too_large') return 'Too large to edit here';
  if (editBlock === 'unreadable') return 'Could not be read';
  return 'Not editable here';
}

/** A raw body (JSON text, or an already-parsed object) as a plain object; anything else becomes {}. */
function bodyObject(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return {};
  try {
    const p = JSON.parse(raw || '{}');
    return p && typeof p === 'object' && !Array.isArray(p) ? p : {};
  } catch (e) { return {}; }
}

/**
 * Turns a failed request into {status, body}.
 * Preferred: the host's ApiError (web/src/lib/api-error.ts) carries a numeric .status (0 = no response) and the raw
 * response text in .body; .message is a humanised sentence and is not parsed. Fallback for older fetchJSON shapes:
 * Error('<status>: <raw body>'), and a bare status number in the message. A body that is not a JSON object becomes {}.
 */
export function parseFailure(err) {
  if (err && typeof err === 'object' && typeof err.status === 'number' && Number.isFinite(err.status)) {
    return { status: Math.trunc(err.status), body: bodyObject(err.body) };
  }
  const raw = err && err.message != null ? String(err.message) : String(err || '');
  const m = /^(\d{3})(?::\s*([\s\S]*))?$/.exec(raw.trim());
  if (!m) return { status: 0, body: {} };
  return { status: Number(m[1]), body: bodyObject(m[2] || '{}') };
}

const REASON_PHRASE = { redacted: 'it has redacted secrets', too_large: 'it is too large', unreadable: 'it could not be read' };

/**
 * Failure -> {kind, message}. Messages never carry file text or paths. kind 'changed' is the one that gets a Reload
 * action; the draft is kept in every case.
 */
export function errorInfo(failure) {
  const s = failure && failure.status;
  const b = (failure && failure.body) || {};
  const err = typeof b.error === 'string' ? b.error : '';
  if (s === 0) return { kind: 'network', message: 'Could not reach the server. Your draft is still here; try again.' };
  if (s === 403) return { kind: 'refused', message: 'The server refused the request. Reload the page and try again.' };
  if (s === 404) return { kind: 'missing', message: 'Unknown agent or file.' };
  if (s === 409) {
    if (err === 'changed since loaded') return { kind: 'changed', message: 'Changed since you opened it' };
    if (err === 'not editable') {
      const why = REASON_PHRASE[b.reason] || 'it cannot be edited here';
      return { kind: 'blocked', message: `Can't edit this file here: ${why}.` };
    }
    if (err === 'not a regular file') return { kind: 'blocked', message: "This isn't a regular file, so it can't be changed." };
    if (err === 'backup path is unsafe') return { kind: 'blocked', message: 'The backup folder is not safe to write to. Nothing was changed.' };
    return { kind: 'conflict', message: 'The server could not apply this change. Nothing was changed.' };
  }
  if (s === 413) return { kind: 'large', message: 'The text is too large to send.' };
  if (s === 422) {
    if (err === 'over limit') {
      const over = Math.max(0, Number(b.chars) - Number(b.limit));
      return { kind: 'over', message: Number.isFinite(over) && over > 0 ? `Over the limit by ${fmtInt(over)} characters. Nothing was changed.` : 'Over the limit. Nothing was changed.' };
    }
    if (err === 'text looks like it contains a secret') return { kind: 'secret', message: 'The text looks like it contains a secret, so nothing was saved. Remove it and try again.' };
    if (err === 'blocked pattern') return { kind: 'pattern', message: 'The text matches a blocked pattern, so nothing was saved.' };
    if (err === 'version is not UTF-8' || err === 'version too large') return { kind: 'version', message: "This version can't be restored here." };
    return { kind: 'invalid', message: 'The server refused this text. Nothing was changed.' };
  }
  if (s === 428) return { kind: 'confirm', message: 'Confirmation is needed. Tap again to confirm.' };
  if (s === 503 && err === 'busy, try again') return { kind: 'busy', message: 'Busy, try again in a moment.' };
  if (s === 503 && err === 'safety scanner unavailable') return { kind: 'scanner', message: 'Safety scanner unavailable; nothing was saved.' };
  if (s === 500 && err === 'audit log unavailable') return { kind: 'audit', message: 'Audit log unavailable; nothing was saved.' };
  if (s === 500 || s >= 500) return { kind: 'server', message: 'The server could not save. Nothing was changed; try again.' };
  return { kind: 'other', message: `Could not complete this (${s || 'error'}). Nothing was changed.` };
}

/** Why Save cannot be used for a draft of `chars` against `limit` ('' when it can). Shown by the unsaved prompt. */
export function saveBlockedReason(chars, limit) {
  const c = counterState(chars, limit);
  return c.blocked ? `Over the limit by ${fmtInt(c.overBy)} characters. Shorten it to save.` : '';
}

/** Whether a save/restore response means the file on disk changed (the toast offers Undo only then). */
export function undoable(backup) {
  return backup != null && backup !== '';
}

/** Save request: PUT. confirm is added to the body only when the caller passes it. */
export function saveRequest({ agent, file, text, base_sha, confirm } = {}) {
  const body = { agent, file, text, base_sha };
  if (confirm !== undefined) body.confirm = confirm;
  return { method: 'PUT', url: BRAIN_API, headers: { ...WRITE_HEADERS }, body: JSON.stringify(body) };
}

/** Restore request: POST /brain/restore. confirm is added only when passed. */
export function restoreRequest({ agent, file, id, base_sha, confirm } = {}) {
  const body = { agent, file, id, base_sha };
  if (confirm !== undefined) body.confirm = confirm;
  return { method: 'POST', url: `${BRAIN_API}/restore`, headers: { ...WRITE_HEADERS }, body: JSON.stringify(body) };
}

function query(params) {
  return Object.keys(params).map(k => `${k}=${encodeURIComponent(String(params[k]))}`).join('&');
}

/** GET list of backups for one file, newest first. */
export function versionsUrl(agent, file) {
  return `${BRAIN_API}/versions?${query({ agent, file })}`;
}

/** GET one backup's text (redacted) and restorable flag. */
export function versionUrl(agent, file, id) {
  return `${BRAIN_API}/version?${query({ agent, file, id })}`;
}

/** Edit affordance for one file object: editable flag plus the reason shown instead when it is not. */
export function editState(file) {
  const editable = !!(file && file.editable);
  return { editable, reason: editable ? '' : (blockReason(file && file.edit_block) || 'Not editable here') };
}

/** 'Nov 9, 14:02 UTC · 1,408 chars' for a version row. Absolute time, so it does not drift while the sheet is open. */
export function versionLabel(v) {
  const ts = Number(v && v.ts);
  const when = Number.isFinite(ts) ? new Date(ts * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'unknown time';
  return `${when} · ${fmtInt(v && v.chars)} chars`;
}

/** Restore is possible only when the server says the version is restorable (valid UTF-8 and within the limit). */
export function restoreState(version) {
  const ok = !!(version && version.restorable);
  return { restorable: ok, reason: ok ? '' : "This version can't be restored here: it is not valid text or is over the limit." };
}
