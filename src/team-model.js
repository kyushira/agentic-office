// Pure view-model for the Home team strip: every agent in state.agents, Ash first (unit-tested in
// test/team-model.test.js). Status comes from agents-model.js statusOf, so the strip agrees with the
// Agents tab at the same moment. Idle and offline agents are always kept; nothing is filtered out.
import { statusOf } from './agents-model.js';
import { colourOf } from './office-model.js';
import { ASH_ID } from './tabs-model.js';

/** Strip status: statusOf's bucket, with 'running' shown as 'working' and an offline idle agent as 'offline'. */
function stripStatus(agent) {
  const bucket = statusOf(agent);
  if (bucket === 'running') return 'working';
  if (bucket === 'idle' && agent.status === 'offline') return 'offline';
  return bucket;                       // 'waiting' | 'idle' | 'error'
}

/**
 * [{id, name, color, status, label, dim}] for every agent with an id, Ash (ASH_ID) first, then the
 * rest in state.agents order. `color` is the agent's accent as '#RRGGBB'. `label` is 'Name · status'.
 * `dim` is true for offline agents (dimmed, still tappable). Duplicate ids are kept once (first wins).
 */
export function teamStrip(agents) {
  const list = Array.isArray(agents) ? agents.filter(a => a && typeof a === 'object' && a.id != null) : [];
  const seen = new Set();
  const unique = [];
  for (const a of list) {
    const key = String(a.id);
    if (!seen.has(key)) { seen.add(key); unique.push(a); }
  }
  const ordered = [...unique.filter(a => a.id === ASH_ID), ...unique.filter(a => a.id !== ASH_ID)];
  return ordered.map(a => {
    const name = a.name || String(a.id);
    const status = stripStatus(a);
    return {
      id: a.id,
      name,
      color: colourOf(a),
      status,
      label: `${name} · ${status}`,
      dim: status === 'offline',
    };
  });
}
