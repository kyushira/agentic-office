// Pure logic for the five-tab shell (unit-tested in test/tabs-model.test.js). No DOM access here.

/** Tabs in nav order. `id` is the location.hash value (#home, #agents, ...). */
export const TABS = [
  { id: 'home', label: 'Home' },
  { id: 'agents', label: 'Agents' },
  { id: 'inbox', label: 'Inbox' },
  { id: 'wiki', label: 'Wiki' },
  { id: 'menu', label: 'Menu' },
];

export const DEFAULT_TAB = 'home';

export function isTab(id) {
  return TABS.some(t => t.id === id);
}

/** '#agents' or 'agents' -> 'agents'. Anything that is not a tab id (empty, unknown, '#/x') -> 'home'. */
export function parseHash(hash) {
  const id = String(hash || '').replace(/^#/, '');
  return isTab(id) ? id : DEFAULT_TAB;
}

/** Tab id -> hash string. An unknown id maps to the home hash. */
export function hashFor(id) {
  return '#' + (isTab(id) ? id : DEFAULT_TAB);
}

/**
 * Arrow / Home / End movement for the tablist (WAI-ARIA tabs). Returns the next index, or -1 for keys
 * that do not move the selection. Left and Up go back, Right and Down forward (wraps), Home/End jump.
 */
export function tabStep(i, key, n) {
  if (!n) return -1;
  if (key === 'ArrowRight' || key === 'ArrowDown') return (i + 1) % n;
  if (key === 'ArrowLeft' || key === 'ArrowUp') return (i - 1 + n) % n;
  if (key === 'Home') return 0;
  if (key === 'End') return n - 1;
  return -1;
}

/** Ash is the Chief of Staff: the default profile, id 'default' in collect.py (NAMES['default'] = 'Ash'). */
export const ASH_ID = 'default';

const clean = v => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');

/**
 * Ash card model.
 *   state: 'checking' (no state yet), 'offline' (last poll failed, or no Ash agent, or the agent reports offline),
 *          'thinking' (working or waiting), 'ready' (idle).
 *   word:  Checking | Offline | Thinking | Ready (the status word is always shown, colour is not the only cue).
 *   line:  what Ash is doing (current step while working) or the newest session title; '—' when there is none.
 * There is no reply text in the deck state, so the line is the best available activity field, not a chat reply.
 */
export function ashView({ agents, sessions, error = false, loaded = true } = {}) {
  if (error) return { state: 'offline', word: 'Offline', line: '—' };
  if (!loaded) return { state: 'checking', word: 'Checking', line: '—' };
  const ash = Array.isArray(agents) ? agents.find(a => a && a.id === ASH_ID) : null;
  if (!ash || ash.status === 'offline') return { state: 'offline', word: 'Offline', line: '—' };
  const thinking = ash.status === 'working' || ash.status === 'waiting';
  return { state: thinking ? 'thinking' : 'ready', word: thinking ? 'Thinking' : 'Ready', line: ashLine(ash, sessions) };
}

function ashLine(ash, sessions) {
  const list = sessions && Array.isArray(sessions[ASH_ID]) ? sessions[ASH_ID].filter(s => s && typeof s === 'object') : [];
  const step = list.find(s => s.status === 'working' && clean(s.step));
  if (step) return clean(step.step);
  const latest = list.filter(s => clean(s.title)).sort((x, y) => (+y.at || 0) - (+x.at || 0))[0];
  if (latest) return clean(latest.title);
  const act = clean(ash.activity);
  if (act && act !== 'idle') return act;
  return '—';
}
