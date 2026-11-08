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
const RADIUS = { agent: 10, memory: 8, project: 8, session: 6 };   // world px; drawRadius() keeps a screen minimum
export const GRAPH_FIT_PAD = 16;        // screen px between the fitted content and the canvas edge
export const GRAPH_DRAW_MIN_PX = 6;     // drawn node radius never smaller than this on screen (zoomed-out taps)
export const GRAPH_LABEL_CHARS = 18;    // labels longer than this end in an ellipsis
export const GRAPH_LABEL_MIN_ZOOM = 1.6; // sessions get labels only at or above this zoom (or when focused)
const LABEL_CHAR_PX = 6.4;              // generous per-character width at 11px system-ui (fit estimate)
const LABEL_H = 13, LABEL_DY = 6, LABEL_GAP = 4, LABEL_SEP = 2;  // label box: height, lift above centre, gap from node, min gap
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
  const repulse = Number.isFinite(opts.repulse) ? opts.repulse : SIM.repulse;
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
    sim: { nodes, index, edges: sedges, key, mode, linkDist, repulse, alpha: 1, energy: Infinity },
    changed: true,
  };
}

/**
 * Repulsion strength for a graph of `count` nodes on a canvas `w` CSS px wide. More nodes and a narrower canvas
 * need a stronger push so the initial layout does not pile into the centre. Capped at 2.2x the base value.
 */
export function repulseFor(count, w) {
  const crowd = Math.min(2.2, Math.max(1, Math.sqrt(Math.max(1, count) / 24)));
  const narrow = Number(w) > 0 && Number(w) < 480 ? 1.25 : 1;
  return SIM.repulse * crowd * narrow;
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
  const ns = sim.nodes, n = ns.length, a = sim.alpha, rep = sim.repulse || SIM.repulse;
  if (n === 0) { sim.energy = 0; return 0; }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const p = ns[i], q = ns[j];
      let dx = q.x - p.x, dy = q.y - p.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 0.01) { dx = 0.1; dy = 0.1; d2 = 0.02; }
      const f = (rep / Math.max(d2, 64)) * a;
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

/** Drawn radius (world px) of a node at zoom k: its own radius, or enough to be GRAPH_DRAW_MIN_PX on screen. */
export function drawRadius(r, k) { return Math.max(r, GRAPH_DRAW_MIN_PX / Math.max(k, 1e-6)); }

/** Label text: at most `max` characters, the last one an ellipsis. */
export function truncLabel(s, max = GRAPH_LABEL_CHARS) {
  const t = String(s == null ? '' : s).trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

// Bounding box (world) of the nodes, their drawn circles, and the labels every non-session node shows.
// Label size is in screen px, so in world units it shrinks as k grows; the fit below accounts for that.
function fitBox(nodes, k) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of nodes) {
    const r = drawRadius(n.r, k);
    x0 = Math.min(x0, n.x - r); x1 = Math.max(x1, n.x + r);
    y0 = Math.min(y0, n.y - r); y1 = Math.max(y1, n.y + r);
    if (n.type !== 'session') {
      const text = truncLabel((n.info && n.info.label) || n.label || '');
      const lx = n.x + r + LABEL_GAP / k;
      x1 = Math.max(x1, lx + (text.length * LABEL_CHAR_PX) / k);
      y0 = Math.min(y0, n.y - LABEL_DY / k); y1 = Math.max(y1, n.y + (LABEL_H - LABEL_DY) / k);
    }
  }
  return { x0, y0, x1, y1 };
}

/**
 * Fit every node, its circle and its label in the w x h box, with `pad` screen px to each edge (default 16).
 * Zoom is kept between GRAPH_ZOOM_MIN and 1.2. The loop only lowers k, so the result always fits.
 */
export function fitView(nodes, w, h, pad = GRAPH_FIT_PAD) {
  if (!nodes || !nodes.length) return makeView(w, h);
  const fitK = b => clamp(Math.min((w - 2 * pad) / Math.max(1, b.x1 - b.x0), (h - 2 * pad) / Math.max(1, b.y1 - b.y0)), GRAPH_ZOOM_MIN, 1.2);
  let k = 1.2;
  for (let i = 0; i < 8; i++) {
    const next = Math.min(k, fitK(fitBox(nodes, k)));
    if (next >= k) break;
    k = next;
  }
  const b = fitBox(nodes, k);
  const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
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

// ---------- labels (screen space) ----------

/**
 * Label candidates in screen px for the nodes in view v. Agents always get one. Focused nodes (selected, hovered,
 * held) get one. Memory sources and projects get one. Sessions get one only at zoom >= GRAPH_LABEL_MIN_ZOOM.
 * Each candidate has a priority: agent 0, focused 0.5, memory 1, project 2, session 3.
 */
export function labelCandidates(nodes, v, focusIds = new Set(), minZoom = GRAPH_LABEL_MIN_ZOOM) {
  const out = [];
  for (const n of nodes || []) {
    const info = n.info || n;
    const text = truncLabel(info.label || '');
    if (!text) continue;
    const focus = focusIds.has(n.id);
    if (n.type === 'session' && !focus && v.k < minZoom) continue;
    const r = drawRadius(n.r, v.k) * v.k;
    const sx = n.x * v.k + v.x, sy = n.y * v.k + v.y;
    const prio = n.type === 'agent' ? 0 : focus ? 0.5 : n.type === 'memory' ? 1 : n.type === 'project' ? 2 : 3;
    out.push({ id: n.id, type: n.type, text, x: sx + r + LABEL_GAP, y: sy - LABEL_DY, prio, dim: n.type === 'session',
      sx, sy, r });
  }
  return out;
}

/** Two label boxes overlap when they are closer than `gap` px on both axes (gap 0 = touching is fine). */
export function boxesOverlap(a, b, gap = 0) {
  return !(a.x + a.w + gap <= b.x || b.x + b.w + gap <= a.x || a.y + a.h + gap <= b.y || b.y + b.h + gap <= a.y);
}

/**
 * Greedy placement by priority. A non-agent label is skipped when its box overlaps one already placed (LABEL_SEP px
 * margin). An agent label is always shown: it tries right, left, below, then above its node, and takes the first
 * spot that is clear. Only if all four collide does it take the right spot anyway. `measure(text)` gives the width in
 * px (canvas measureText when drawing; an estimate otherwise). Returns boxes {id, type, text, x, y, w, h, dim, forced}.
 */
export function placeLabels(cands, measure = s => s.length * LABEL_CHAR_PX) {
  const order = (cands || []).slice().sort((a, b) => a.prio - b.prio);
  const placed = [];
  for (const c of order) {
    const w = measure(c.text);
    const at = (x, y) => ({ id: c.id, type: c.type, text: c.text, x, y, w, h: LABEL_H, dim: !!c.dim });
    const right = at(c.x, c.y);
    if (c.prio > 0) {
      if (!placed.some(p => boxesOverlap(p, right, LABEL_SEP))) placed.push(right);
      continue;
    }
    const spots = [
      right,
      at(c.sx - c.r - LABEL_GAP - w, c.y),                       // left
      at(c.sx - w / 2, c.sy + c.r + LABEL_GAP),                  // below
      at(c.sx - w / 2, c.sy - c.r - LABEL_GAP - LABEL_H),        // above
    ];
    const free = spots.find(b => !placed.some(p => boxesOverlap(p, b, LABEL_SEP)));
    placed.push(free || Object.assign(right, { forced: true }));
  }
  return placed;
}
