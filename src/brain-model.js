// Pure view-model for the Brain view (src/Brain.jsx). No DOM access; unit-tested in test/brain-model.test.js.
// Input is the GET /brain payload (plugin/agent-office/dashboard/brain.py): {agents, limits, unknown_agent}.
// The server has already whitelisted, redacted and capped the text, so this file only shapes it for display.
import { ago, compact } from './format.js';

export const BRAIN_API = '/api/plugins/agent-office/brain';

/** GET URL: the whole overview, or one agent when `agent` is given (the agent sheet). */
export function brainUrl(agent) {
  return agent ? `${BRAIN_API}?agent=${encodeURIComponent(String(agent))}` : BRAIN_API;
}

/** Bar width in percent: the number clamped to 0..100, or null when there is no number. The label keeps the real value. */
export function clampBar(pct) {
  if (pct == null || pct === '' || typeof pct === 'boolean') return null;
  const n = Number(pct);
  if (!Number.isFinite(n)) return null;
  return Math.min(100, Math.max(0, n));
}

/** Colour level of a fill: 'ok' below 70, 'warn' from 70 to under 90, 'full' at 90 and above (also over 100); 'na' without a number. */
export function brainLevel(pct) {
  if (pct == null || pct === '' || typeof pct === 'boolean') return 'na';
  const n = Number(pct);
  if (!Number.isFinite(n)) return 'na';
  if (n < 70) return 'ok';
  if (n < 90) return 'warn';
  return 'full';
}

/** Percent text for a label: whole numbers as '64%', others with one decimal ('98.6%'). Empty when there is no number. */
export function pctText(pct) {
  if (pct == null || pct === '' || typeof pct === 'boolean') return '';
  const n = Number(pct);
  if (!Number.isFinite(n)) return '';
  const r = Math.round(n * 10) / 10;
  return (Number.isInteger(r) ? String(r) : r.toFixed(1)) + '%';
}

/** Thousands separators without relying on the locale: 1408 -> '1,408'. */
export function fmtInt(n) {
  const v = Math.round(Number(n) || 0);
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * One line of fill for a file: '1,408 / 2,200 (64%)' when it has a limit, '5,800 chars' when it has none,
 * 'no file' when it is missing, 'unreadable' when the server could not read it.
 */
export function fillLabel(f) {
  if (!f || !f.exists) return 'no file';
  if (f.error) return 'unreadable';
  const chars = fmtInt(f.chars);
  if (f.limit == null) return `${chars} chars`;
  const p = pctText(f.pct);
  return p ? `${chars} / ${fmtInt(f.limit)} (${p})` : `${chars} / ${fmtInt(f.limit)}`;
}

/** 'updated 3h ago' from the file's mtime (unix seconds); empty when there is no file or no mtime. */
export function updatedLabel(f, now) {
  if (!f || !f.exists || f.mtime == null) return '';
  const t = ago(f.mtime, now);
  return t === 'now' ? 'updated just now' : 'updated ' + t;
}

/**
 * One file as the view needs it. `limit` is the file's own limit, or the endpoint's limits[kind] when the file
 * does not carry one. `bar` is the clamped width for the fill bar (null when there is no limit); `pct` is the real
 * number for the label. `short` is the compact size for the row ('5.8k'), `chars` the exact count.
 */
export function fileView(f, fallbackLimit, now) {
  const exists = !!(f && f.exists);
  const limitRaw = f && f.limit != null ? f.limit : fallbackLimit;
  const limit = limitRaw == null || !Number.isFinite(Number(limitRaw)) ? null : Number(limitRaw);
  const pct = limit != null && f && f.pct != null && Number.isFinite(Number(f.pct)) ? Number(f.pct) : null;
  const chars = exists ? Math.max(0, Math.round(Number(f.chars) || 0)) : 0;
  return {
    exists,
    error: f && f.error ? String(f.error) : '',
    chars,
    short: compact(chars),
    limit,
    pct,
    bar: limit != null ? clampBar(pct) : null,
    level: limit != null ? brainLevel(pct) : 'na',
    label: fillLabel(exists ? { ...f, limit, pct } : f),
    text: exists && typeof f.text === 'string' ? f.text : '',
    truncated: !!(f && f.truncated),
    first: f && typeof f.first === 'string' ? f.first : '',
    updated: updatedLabel(f, now),
  };
}

/** Row text for the soul: 'Soul 5.8k' with the update time after it when known. */
export function soulLine(soul) {
  const size = soul.exists ? `Soul ${soul.short}` : 'Soul: no file';
  return soul.updated ? `${size} · ${soul.updated}` : size;
}

/**
 * The payload as view rows, in endpoint order. Entries without an id are dropped; a missing or malformed
 * payload gives an empty list. Each row has id, name, soul, memory and user (see fileView).
 */
export function brainAgents(payload, now) {
  const limits = (payload && typeof payload.limits === 'object' && payload.limits) || {};
  const list = payload && Array.isArray(payload.agents) ? payload.agents : [];
  return list.filter(a => a && a.id != null).map(a => ({
    id: String(a.id),
    name: a.name || String(a.id),
    soul: fileView(a.soul, null, now),
    memory: fileView(a.memory, limits.memory, now),
    user: fileView(a.user, limits.user, now),
  }));
}
