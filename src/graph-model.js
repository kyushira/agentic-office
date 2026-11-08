// Pure logic for the Memory node graph (src/Graph.jsx): graph building, the force simulation step, and the
// viewport and hit-test helpers. No DOM access, so `npm test` runs it under node:test (test/graph-model.test.js).
// Data comes only from existing read-only endpoints: /state (agents, sessions, brain) and /projects.
// Projects have no read-only link to agents yet (no field says which agent touched a project), so the graph
// has no project edges. Project nodes float, held only by the centring force.

export const GRAPH_MAX_NODES = 60;
export const GRAPH_PROJECT_MAX = 8;
export const GRAPH_TAP_PX = 6;          // pointer movement below this is a tap, not a drag
export const GRAPH_HIT_PX = 22;         // touch-sized hit radius on screen (CSS px)
export const GRAPH_SETTLE_TICKS = 400;  // static (Lite / reduced motion) layout runs at most this many ticks
export const GRAPH_DPR_CAP = 2;
export const GRAPH_ZOOM_MIN = 0.4;
export const GRAPH_ZOOM_MAX = 4;
export const GRAPH_SPAN = 260;          // flow mode: world distance between the memory, agent and output layers

// Colours. Agents use the backend colour (a.color); the rest mirror tokens.css (--c-live, --c-accent, --text-3).
export const GRAPH_COLOR = { project: '#2FD6C4', memory: '#8B5CF6', session: '#8A8697' };
const NO_COLOR = '#8a8a8a';
const RADIUS = { agent: 9, memory: 7, project: 7, session: 5 };
const LAYER = { memory: -1, agent: 0, project: 1, session: 1 };

// Simulation constants (world px). Tuned by eye on the real harness data.
// anchor: a released node is pulled back to where it was dropped. Not scaled by alpha, so it holds at rest too.
export const SIM = { repulse: 2400, link: 0.04, centre: 0.012, flow: 0.08, damp: 0.6, decay: 0.97, alphaMin: 0.001, eps: 1e-3, anchor: 0.08 };

/** Link slider 0..100 -> resting link length in world px (40..220). */
export function linkDistFor(v) {
  const n = Math.min(100, Math.max(0, Number(v) || 0));
  return 40 + n * 1.8;
}

/**
 * A label that is safe to draw: one line, no paths, no keys or tokens, no e-mail addresses, at most `max` chars.
 * The server already redacts /state; this is a second, client-side pass so a path or secret never reaches the canvas.
 */
export function safeLabel(raw, max = 24) {
  let s = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
  s = s
    .replace(/[\w.~+-]*\/[\w./~+-]*/g, '…')                                  // paths and URLs
    .replace(/\b(?:sk|ghp|gho|xox[bp]|AIza|AKIA)[\w-]{6,}/g, '…')           // provider key prefixes
    .replace(/\b(?:key|token|secret|password)\s*[:=]\s*\S+/gi, '…')          // key=value pairs
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '…')                               // e-mail addresses
    .replace(/[A-Za-z0-9+_=-]{24,}/g, '…')                                   // long token-like runs
    .replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}

/**
 * Graph from /state and /projects. Node budget (maxNodes, default 60), in this order:
 * agents, one state.db memory source per agent, one notes inbox, projects (first GRAPH_PROJECT_MAX),
 * then recent sessions, most recent first, until the budget is used. Edges: agent -> its memory source,
 * agent -> its sessions. Ids are unique; every edge references a node in the graph.
 * Returns { nodes, edges, truncated, counts }. Node: { id, type, label, color, agent, status, count, at }.
 */
export function buildGraph({ agents, sessions, projects, notes, maxNodes = GRAPH_MAX_NODES } = {}) {
  const nodes = [], edges = [], ids = new Set();
  const cap = Math.max(0, Math.floor(maxNodes));
  const add = n => {
    if (ids.has(n.id) || nodes.length >= cap) return false;
    ids.add(n.id);
    nodes.push(n);
    return true;
  };
  const link = (a, b, kind) => { if (ids.has(a) && ids.has(b)) edges.push({ a, b, kind }); };

  const list = (Array.isArray(agents) ? agents : []).filter(a => a && a.id);
  const agentIds = new Set();
  for (const a of list) {
    if (add({ id: 'a:' + a.id, type: 'agent', label: safeLabel(a.name || a.id) || String(a.id), agent: a.id,
      color: a.color || NO_COLOR, status: String(a.status || ''), count: 0 })) agentIds.add(a.id);
  }
  for (const aid of agentIds) {
    if (add({ id: 'm:' + aid, type: 'memory', label: 'state.db', agent: aid, color: GRAPH_COLOR.memory, count: 0 })) {
      link('a:' + aid, 'm:' + aid, 'memory');
    }
  }
  add({ id: 'm:inbox', type: 'memory', label: 'notes inbox', agent: null, color: GRAPH_COLOR.memory, count: Number(notes) || 0 });

  const plist = (Array.isArray(projects) ? projects : []).filter(p => p && p.name).slice(0, GRAPH_PROJECT_MAX);
  for (const p of plist) {
    // project -> agent edges come only from the project's `owner` field ("owned by", not "touched")
    const owner = p.owner && agentIds.has(String(p.owner)) ? String(p.owner) : null;
    const id = 'p:' + p.name;
    if (add({ id, type: 'project', label: safeLabel(p.name) || String(p.name), agent: owner,
      color: GRAPH_COLOR.project, status: String(p.status || ''), count: 0 }) && owner) {
      link('a:' + owner, id, 'owner');
    }
  }

  const all = [];
  const bySess = sessions && typeof sessions === 'object' ? sessions : {};
  for (const aid of Object.keys(bySess)) {
    if (!agentIds.has(aid) || !Array.isArray(bySess[aid])) continue;
    for (const t of bySess[aid]) if (t && t.id) all.push({ aid, t });
  }
  all.sort((x, y) => (Number(y.t.at) || 0) - (Number(x.t.at) || 0));
  let shown = 0;
  for (const { aid, t } of all) {
    const id = 's:' + t.id;
    if (!add({ id, type: 'session', label: safeLabel(t.title || 'untitled') || 'untitled', agent: aid,
      color: GRAPH_COLOR.session, status: String(t.status || 'idle'), count: 0, at: Number(t.at) || 0 })) break;
    shown++;
    link('a:' + aid, id, 'session');
    const owner = nodes.find(n => n.id === 'a:' + aid);
    if (owner) owner.count++;
  }

  const counts = { agent: 0, memory: 0, project: 0, session: 0, total: nodes.length, sessionsTotal: all.length };
  for (const n of nodes) counts[n.type]++;
  return { nodes, edges, truncated: all.length > shown, counts };
}

/** One-sentence summary for the canvas's aria-label. */
export function graphAria(graph) {
  const c = graph.counts;
  const sess = graph.truncated ? `${c.session} sessions shown of ${c.sessionsTotal}` : `${c.session} sessions`;
  return `Memory graph: ${c.agent} agents, ${c.memory} memory sources, ${c.project} projects, ${sess}. ` +
    'Drag a node, tap it for details.';
}

/** Rows for the node detail sheet. `info` is a graph node; `agentNames` maps agent id -> display name. */
export function detailRows(info, agentNames = new Map()) {
  const who = info.agent ? (agentNames.get(info.agent) || info.agent) : null;
  if (info.type === 'agent') return [{ k: 'Type', v: 'Agent' }, { k: 'Status', v: info.status || 'unknown' }, { k: 'Sessions shown', v: String(info.count) }];
  if (info.type === 'memory' && info.id === 'm:inbox') return [{ k: 'Type', v: 'Notes inbox' }, { k: 'Notes', v: String(info.count) }];
  if (info.type === 'memory') return [{ k: 'Type', v: 'Memory source' }, { k: 'Agent', v: who }];
  if (info.type === 'project') return [{ k: 'Type', v: 'Project' }, { k: 'Status', v: info.status || 'unknown' },
    { k: 'Owner', v: who || 'none' }];
  return [{ k: 'Type', v: 'Session' }, { k: 'Agent', v: who || 'unknown' }, { k: 'Status', v: info.status || 'idle' }];
}

// ---------- simulation ----------

function spiral(i) {
  const a = i * 2.399963;               // golden angle: deterministic, no Math.random
  const r = 30 + 22 * Math.sqrt(i);
  return { x: Math.cos(a) * r, y: Math.sin(a) * r };
}

function graphKey(graph) {
  return graph.nodes.map(n => n.id).join('|') + '#' + graph.edges.map(e => e.a + '>' + e.b).join('|');
}

/**
 * Keep the simulation in step with a new graph. If the nodes and edges are the same as `prev`, the same sim
 * object is returned with fresh labels and colours and changed=false (a /state poll must not reheat the layout).
 * Otherwise a new sim is built: surviving nodes keep their position, new ones start on a spiral, alpha = 1.
 */
export function syncSim(prev, graph, opts = {}) {
  const mode = opts.mode === 'flow' ? 'flow' : 'orbit';
  const linkDist = Number.isFinite(opts.linkDist) ? opts.linkDist : linkDistFor(50);
  const key = graphKey(graph);
  if (prev && prev.key === key) {
    for (const n of graph.nodes) { const s = prev.index.get(n.id); if (s) s.info = n; }
    return { sim: prev, changed: false };
  }
  const old = prev ? prev.index : new Map();
  const index = new Map();
  const nodes = graph.nodes.map((info, i) => {
    const o = old.get(info.id);
    const p = o ? { x: o.x, y: o.y } : spiral(i);
    const node = { id: info.id, type: info.type, info, x: p.x, y: p.y, vx: 0, vy: 0, pinned: false,
      anchor: o ? o.anchor : null, r: RADIUS[info.type] || 6, layer: LAYER[info.type] || 0 };
    index.set(info.id, node);
    return node;
  });
  const sedges = graph.edges.filter(e => index.has(e.a) && index.has(e.b))
    .map(e => ({ s: index.get(e.a), t: index.get(e.b), kind: e.kind }));
  return {
    sim: { nodes, index, edges: sedges, key, mode, linkDist, alpha: 1, energy: Infinity },
    changed: true,
  };
}

export function reheat(sim, a = 1) { sim.alpha = Math.max(sim.alpha, a); }
export function setMode(sim, mode) { sim.mode = mode === 'flow' ? 'flow' : 'orbit'; reheat(sim, 1); }
export function setLinkDist(sim, d) { sim.linkDist = d; reheat(sim, 0.6); }

/** Settled: the forces have cooled (alpha at its floor) or the kinetic energy is negligible. */
export function isSettled(sim) { return sim.alpha <= SIM.alphaMin || sim.energy < SIM.eps; }

/**
 * One tick: repulsion between all pairs, springs on edges (rest length sim.linkDist), a pull to the centre
 * (orbit) or to the layer x-targets (flow), then damped integration. Pinned nodes do not move.
 * Returns the kinetic energy after the tick and sets sim.energy.
 */
export function simStep(sim) {
  const ns = sim.nodes, n = ns.length, a = sim.alpha;
  if (n === 0) { sim.energy = 0; return 0; }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const p = ns[i], q = ns[j];
      let dx = q.x - p.x, dy = q.y - p.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 0.01) { dx = 0.1; dy = 0.1; d2 = 0.02; }
      const f = (SIM.repulse / Math.max(d2, 64)) * a;
      const len = Math.sqrt(d2);
      const ux = dx / len, uy = dy / len;
      p.vx -= ux * f; p.vy -= uy * f;
      q.vx += ux * f; q.vy += uy * f;
    }
  }
  for (const e of sim.edges) {
    const p = e.s, q = e.t;
    const dx = q.x - p.x, dy = q.y - p.y;
    const d = Math.max(Math.hypot(dx, dy), 0.01);
    const f = (d - sim.linkDist) * SIM.link * a;
    p.vx += (dx / d) * f; p.vy += (dy / d) * f;
    q.vx -= (dx / d) * f; q.vy -= (dy / d) * f;
  }
  for (const p of ns) {
    if (p.anchor) { p.vx += (p.anchor.x - p.x) * SIM.anchor; p.vy += (p.anchor.y - p.y) * SIM.anchor; }
    if (sim.mode === 'flow') {
      p.vx += (p.layer * GRAPH_SPAN / 2 - p.x) * SIM.flow * a;
      p.vy += -p.y * SIM.centre * a;
    } else {
      p.vx -= p.x * SIM.centre * a;
      p.vy -= p.y * SIM.centre * a;
    }
  }
  let energy = 0;
  for (const p of ns) {
    if (p.pinned) { p.vx = 0; p.vy = 0; continue; }
    p.vx *= SIM.damp; p.vy *= SIM.damp;
    p.x += p.vx; p.y += p.vy;
    energy += p.vx * p.vx + p.vy * p.vy;
  }
  sim.alpha = Math.max(SIM.alphaMin, sim.alpha * SIM.decay);
  sim.energy = energy;
  return energy;
}

/** Run ticks until settled (or max). Used for the static layout under Lite and reduced motion. Returns ticks run. */
export function settle(sim, max = GRAPH_SETTLE_TICKS) {
  let t = 0;
  while (t < max && !isSettled(sim)) { simStep(sim); t++; }
  return t;
}

// ---------- viewport and hit testing ----------

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function makeView(w, h) { return { x: w / 2, y: h / 2, k: 1 }; }

/** Fit every node in the w x h box (world -> screen is x * k + view.x). Zoom is kept between 0.4 and 1.2. */
export function fitView(nodes, w, h, pad = 36) {
  if (!nodes || !nodes.length) return makeView(w, h);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of nodes) {
    x0 = Math.min(x0, n.x - n.r); x1 = Math.max(x1, n.x + n.r);
    y0 = Math.min(y0, n.y - n.r); y1 = Math.max(y1, n.y + n.r);
  }
  const bw = Math.max(1, x1 - x0), bh = Math.max(1, y1 - y0);
  const k = clamp(Math.min((w - 2 * pad) / bw, (h - 2 * pad) / bh), GRAPH_ZOOM_MIN, 1.2);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  return { k, x: w / 2 - cx * k, y: h / 2 - cy * k };
}

export function toWorld(v, sx, sy) { return { x: (sx - v.x) / v.k, y: (sy - v.y) / v.k }; }
export function toScreen(v, wx, wy) { return { x: wx * v.k + v.x, y: wy * v.k + v.y }; }

/** Zoom by `factor` keeping the screen point (sx, sy) fixed. */
export function zoomAt(v, sx, sy, factor) {
  const k = clamp(v.k * factor, GRAPH_ZOOM_MIN, GRAPH_ZOOM_MAX);
  const f = k / v.k;
  return { k, x: sx - (sx - v.x) * f, y: sy - (sy - v.y) * f };
}

export function panBy(v, dx, dy) { return { k: v.k, x: v.x + dx, y: v.y + dy }; }

/** Nearest node whose circle (radius r, or radiusWorld if larger) contains the world point. */
export function hitNode(nodes, wx, wy, radiusWorld) {
  let best = null, bestD = Infinity;
  for (const n of nodes) {
    const d = Math.hypot(n.x - wx, n.y - wy);
    if (d <= Math.max(n.r, radiusWorld) && d < bestD) { best = n; bestD = d; }
  }
  return best;
}

/** True when the pointer moved less than `px` between down and up: a tap. */
export function isTap(a, b, px = GRAPH_TAP_PX) { return Math.hypot(b.x - a.x, b.y - a.y) < px; }

/** Two-pointer geometry: distance between the pointers and their midpoint. */
export function pinchOf(p1, p2) {
  return { dist: Math.hypot(p2.x - p1.x, p2.y - p1.y), x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
}
