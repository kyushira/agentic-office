// Pure helpers for the projects list (design 3.8). Source: GET /api/plugins/agent-office/projects (read-only).
// Status is computed by the backend: active < 3d, quiet < 7d, stale otherwise. Each state has a word, not colour alone.

export const PROJECT_WORDS = { active: 'Active', quiet: 'Quiet', stale: 'Stale' };
export const PROJECT_SUBJECT_MAX = 72;

/** Status word for a project status; unknown values read as Stale (the least claim). */
export function projectWord(status) {
  return PROJECT_WORDS[status] || 'Stale';
}

/** Dot class for a project status: active teal, quiet gold, stale grey. */
export function projectTone(status) {
  return status === 'active' ? 'live' : status === 'quiet' ? 'gold' : 'grey';
}

/** Truncate a commit subject for the one-line row. Keeps the whole word count in the title attribute upstream. */
export function clipSubject(text, max = PROJECT_SUBJECT_MAX) {
  const s = String(text || '').trim();
  if (!s) return '';
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}

/**
 * Rows for the list, most recently touched first. Missing fields become null; nothing is invented.
 * `last_commit` may be null (no git or no commits): the row then shows "no commits".
 */
export function projectRows(payload) {
  const list = payload && Array.isArray(payload.projects) ? payload.projects : [];
  return list
    .filter(p => p && p.name)
    .map(p => ({
      name: String(p.name),
      status: Object.prototype.hasOwnProperty.call(PROJECT_WORDS, p.status) ? p.status : 'stale',
      word: projectWord(p.status),
      tone: projectTone(p.status),
      lastActivity: typeof p.last_activity === 'number' ? p.last_activity : null,
      subject: p.last_commit && p.last_commit.subject ? clipSubject(p.last_commit.subject) : null,
      branch: p.last_commit && p.last_commit.branch ? String(p.last_commit.branch) : null,
    }))
    .sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0) || a.name.localeCompare(b.name));
}
