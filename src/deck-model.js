// Pure view-model for the Deck (unit-tested in test/deck-model.test.js).
import { ago } from './format.js';

const CHIP_SECS = 120;
const NO_COLOR = '#8a8a8a';   // the backend always sends a.color; this only guards a missing field
const KIND = { brief: 'new brief', reply: 'report', message: 'message' };

/** "Sonnet 5.5 · helpers DeepSeek V4 Flash" (main model, then the distinct helper models). */
export function modelText(a) {
  const main = a.model || '—';
  const helpers = [...new Set(a.helperModels || [])];
  return helpers.length ? `${main} · helpers ${helpers.join(', ')}` : main;
}

export function durationText(h, now) {
  const end = h.ended || now, s = Math.max(0, Math.round(end - (h.since || end)));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`;
}

/**
 * Grid items: each agent, then its running helpers, then helpers that finished in the last ~15 min.
 * Agents keep discovery order so tiles don't jump around.
 */
export function buildItems(state, now) {
  const agents = state.agents || [];
  const names = Object.fromEntries(agents.map(a => [a.id, a.name]));
  const colors = Object.fromEntries(agents.map(a => [a.id, a.color || NO_COLOR]));
  const walks = state.walks || [];
  const items = [];
  for (const a of agents) {
    const working = a.status === 'working' || a.status === 'waiting';
    const sess = ((state.sessions || {})[a.id] || []).find(s => s.status === 'working');
    const step = (a.activity || '').replace(/^delegating · .*/, 'delegating').split(' · ')[0];
    const helpers = a.helpers || [];
    const recent = (a.recentHelpers || []).filter(h => now - h.ended < 900);
    const inbound = walks.filter(w => w.to === a.id && now - w.at < CHIP_SECS).sort((x, y) => y.at - x.at)[0];
    const label = w => `${names[w.from] || w.from} → ${names[w.to] || w.to} · ${KIND[w.kind] || w.kind}`;
    items.push({
      type: 'agent', key: 'a:' + a.id, agent: a, color: colors[a.id], working,
      status: working ? `working · ${step || 'working'}` : `idle · ${ago(a.lastActive, now)}`,
      ctxPct: working && sess ? sess.ctxPct : null,
      helperCount: helpers.length,
      chip: inbound ? { text: `${names[inbound.from] || inbound.from} · ${KIND[inbound.kind] || inbound.kind}`, color: colors[inbound.from] || '#999' } : null,
      walks: walks.filter(w => w.from === a.id || w.to === a.id).map(w => ({ ...w, label: label(w) })),
    });
    for (const h of helpers) items.push(helperItem(h, a, colors[a.id], false, now));
    for (const h of recent) items.push(helperItem(h, a, colors[a.id], true, now));
  }
  // An agent with helpers starts a new grid row (helpers sit right after it), and so does the next
  // agent after a helper group, so a helper is never next to a stranger.
  items.forEach((it, i) => {
    const hasKids = it.type === 'agent' && items[i + 1] && items[i + 1].type === 'helper';
    const afterKids = it.type === 'agent' && i > 0 && items[i - 1].type === 'helper';
    it.rowStart = !!(hasKids || afterKids);
  });
  return items;
}

function helperItem(h, a, color, done, now) {
  return {
    type: 'helper', key: 'h:' + a.id + ':' + h.id, helper: h, done, parentName: a.name, parentColor: color,
    name: `${h.model || 'Helper'} helper`,
    status: done ? `done · ${ago(h.ended, now)}` : h.activity || 'running',
  };
}

export function headerCounts(items) {
  const agents = items.filter(i => i.type === 'agent');
  const working = agents.filter(i => i.working).length;
  return { working, idle: agents.length - working, helpers: items.filter(i => i.type === 'helper' && !i.done).length };
}
