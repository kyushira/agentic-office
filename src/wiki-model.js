// Pure helpers for the read-only Wiki pane (src/Wiki.jsx). No DOM and no fetch here, so node:test can run
// them (test/wiki-model.test.js). The API base (WIKI_API) is passed in by the caller.

export const WIKI_DIRS = Object.freeze([
  Object.freeze({ dir: 'entities', label: 'Entities', kind: 'entity' }),
  Object.freeze({ dir: 'concepts', label: 'Concepts', kind: 'concept' }),
  Object.freeze({ dir: 'comparisons', label: 'Comparisons', kind: 'comparison' }),
  Object.freeze({ dir: 'queries', label: 'Queries', kind: 'query' }),
]);
export const WIKI_SEARCH_MIN = 2;
export const WIKI_SEARCH_MAX = 100;
export const WIKI_SEARCH_DEBOUNCE_MS = 300;
export const WIKI_LOG_TAIL = 50;
export const WIKI_ALL = 'All';

/** Search query check on the trimmed text: 2 to 100 characters. Only a valid query is sent. */
export function searchCheck(raw) {
  const q = String(raw == null ? '' : raw).trim();
  if (q.length < WIKI_SEARCH_MIN) return { ok: false, q, reason: 'short' };
  if (q.length > WIKI_SEARCH_MAX) return { ok: false, q, reason: 'long' };
  return { ok: true, q, reason: '' };
}

export function listUrl(base, dir) {
  return `${base}/list?dir=${encodeURIComponent(dir)}`;
}

export function pageUrl(base, path) {
  return `${base}/page?path=${encodeURIComponent(path)}`;
}

export function searchUrl(base, q) {
  return `${base}/search?q=${encodeURIComponent(q)}`;
}

export function logUrl(base, tail = WIKI_LOG_TAIL) {
  return `${base}/log?tail=${encodeURIComponent(String(tail))}`;
}

function titleOf(item) {
  return String(item.title || item.path || '');
}

/** Groups the four dir lists in WIKI_DIRS order. Empty groups are dropped; items sorted by title. */
export function groupIndex(lists) {
  const groups = [];
  for (const d of WIKI_DIRS) {
    const raw = lists && Array.isArray(lists[d.dir]) ? lists[d.dir] : [];
    const items = raw.filter(it => it && typeof it.path === 'string')
      .slice()
      .sort((a, b) => titleOf(a).localeCompare(titleOf(b)));
    if (items.length) groups.push({ dir: d.dir, label: d.label, kind: d.kind, items });
  }
  return groups;
}

/** Index row summary, e.g. "entity · entities". */
export function summaryText(item, group) {
  const kind = (item && typeof item.type === 'string' && item.type) || (group && group.kind) || 'page';
  return group ? `${kind} · ${group.dir}` : kind;
}

/** Dates show as YYYY-MM-DD when the value starts with an ISO date; anything else shows as-is, or a dash. */
export function dateText(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  if (m) return m[1];
  return s || '—';
}

/** Meta line values from a page's frontmatter (strings). */
export function pageMeta(frontmatter) {
  const fm = frontmatter && typeof frontmatter === 'object' ? frontmatter : {};
  const conf = typeof fm.confidence === 'string' ? fm.confidence.trim() : '';
  return { updated: dateText(fm.updated), confidence: conf || '—' };
}

/** slug -> path resolver for [[slug]] links, built from a page's links[] ({slug, path|null}). */
export function linkResolver(links) {
  const map = new Map();
  for (const l of Array.isArray(links) ? links : []) {
    if (l && typeof l.slug === 'string' && typeof l.path === 'string' && l.path) map.set(l.slug, l.path);
  }
  return slug => map.get(slug) || null;
}

/** Pushes a view entry: {path: null} for the list, or {path, title, data} for a page. */
export function historyPush(stack, entry) {
  return [...(Array.isArray(stack) ? stack : []), entry];
}

/** Pops the newest entry. `top` is undefined when the stack was empty. */
export function historyPop(stack) {
  const s = Array.isArray(stack) ? stack : [];
  if (!s.length) return { stack: [], top: undefined };
  return { stack: s.slice(0, -1), top: s[s.length - 1] };
}

/** Back bar label for the view it returns to. */
export function backLabel(top, searching) {
  if (top && top.path) return String(top.title || top.path);
  return searching ? 'Search' : 'Index';
}

/** Log filter chips: All first, then the distinct actions in sorted order. */
export function logActions(entries) {
  const set = new Set();
  for (const e of Array.isArray(entries) ? entries : []) {
    if (e && typeof e.action === 'string' && e.action) set.add(e.action);
  }
  return [WIKI_ALL, ...[...set].sort()];
}

export function filterLog(entries, action) {
  const list = Array.isArray(entries) ? entries : [];
  if (!action || action === WIKI_ALL) return list;
  return list.filter(e => e && e.action === action);
}

/** A 404 is a missing page; anything else is a plain error. */
export function errorKind(err) {
  return err && err.status === 404 ? 'missing' : 'error';
}
