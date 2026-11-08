// Pure helpers for the Memory search pane (src/Memory.jsx). No DOM access; unit-tested in test/memory-model.test.js.
// The backend (plugin/agent-office/dashboard/memory.py) caps the query at 200 characters and 8 terms, so the
// client check mirrors that instead of guessing. Snippets are plain text: highlightParts returns pieces, never HTML.

export const MEMORY_API = '/api/plugins/agent-office/memory';
export const MEMORY_MIN_CHARS = 2;
export const MEMORY_DEBOUNCE_MS = 400;
export const MEMORY_LIMIT = 20;
const Q_CAP = 200;
// Same word notion as the server's \w+ (Unicode letters, digits and underscore).
const WORD = /[\p{L}\p{N}_]+/gu;

/** Lower-cased word terms of a query, unique, longest first (so a longer term wins in a highlight). */
export function queryTerms(q) {
  const words = String(q == null ? '' : q).toLowerCase().match(WORD) || [];
  return [...new Set(words)].sort((a, b) => b.length - a.length);
}

/**
 * Query validation before any request. Whitespace is collapsed and the text capped at 200 characters.
 * ok needs at least 2 characters and at least one letter or digit; reason says why not ('short' | 'no-words').
 */
export function checkQuery(raw) {
  const q = String(raw == null ? '' : raw).replace(/\s+/g, ' ').slice(0, Q_CAP).trim();
  if (q.length < MEMORY_MIN_CHARS) return { ok: false, reason: 'short', q };
  if (!queryTerms(q).length) return { ok: false, reason: 'no-words', q };
  return { ok: true, reason: null, q };
}

/** GET URL for the memory endpoint. The agent filter is sent only when one is chosen (empty means All). */
export function memoryUrl(q, agent = '', limit = MEMORY_LIMIT) {
  const p = new URLSearchParams({ q: String(q), limit: String(limit) });
  if (agent) p.set('agent', String(agent));
  return `${MEMORY_API}?${p.toString()}`;
}

/**
 * A snippet as one line of plain text for the result card. Literal backslash-n and backslash-t sequences (the
 * backend sometimes keeps them escaped) and real newlines or tabs all become a single space; other whitespace
 * runs collapse to one space. Pure text in, text out, so the view never needs HTML.
 */
export function cleanSnippet(s) {
  if (s == null) return '';
  return String(s).replace(/\\[nt]/g, ' ').replace(/\s+/g, ' ').trim();
}

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Splits a snippet into [{text, hit}] pieces so the view can wrap hits in spans. Matching is case-insensitive
 * substring on the query's terms. The pieces concatenate back to the original text exactly.
 */
export function highlightParts(text, query) {
  const s = text == null ? '' : String(text);
  if (!s) return [];
  const terms = queryTerms(query);
  if (!terms.length) return [{ text: s, hit: false }];
  const re = new RegExp('(' + terms.map(escapeRe).join('|') + ')', 'giu');
  // split with a capture group puts the matches at odd indexes; filter after mapping so parity holds
  return s.split(re).map((part, i) => ({ text: part, hit: i % 2 === 1 })).filter(p => p.text !== '');
}

/** The search mode chip: 'keyword search' when every searched DB has the FTS5 index, else 'basic search'. */
export function searchMode(fts5) {
  return fts5
    ? { label: 'keyword search', title: 'Full-text index (FTS5) over assistant and tool messages' }
    : { label: 'basic search', title: 'Substring scan of recent assistant and tool messages (no full-text index)' };
}

/** '3 redacted' when the response redacted something, else ''. */
export function redactedNote(n) {
  const k = Number(n) || 0;
  return k > 0 ? `${k} redacted` : '';
}

/** Agent select options: All first, then each agent with its colour. */
export function agentOptions(agents) {
  const opts = [{ value: '', label: 'All agents', color: '' }];
  for (const a of Array.isArray(agents) ? agents : []) {
    if (a && a.id) opts.push({ value: a.id, label: a.name || a.id, color: a.color || '' });
  }
  return opts;
}

/**
 * Which body the pane shows. 'hint' when the query is not valid (nothing is fetched); otherwise loading, error,
 * empty, results. Error also covers a response where no agent store could be searched at all.
 */
export function memoryView({ check, loading, error, data }) {
  if (!check || !check.ok) return 'hint';
  if (loading) return 'loading';
  if (error) return 'error';
  if (!data) return 'idle';
  if (!Array.isArray(data.results)) return 'error';
  if (!data.results.length) return (Array.isArray(data.searched) && !data.searched.length && (data.errors || []).length) ? 'error' : 'empty';
  return 'results';
}
