// Unit tests for src/graph-model.js (run by `npm test` via node:test). No DOM.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  GRAPH_MAX_NODES, GRAPH_SETTLE_TICKS, buildGraph, safeLabel, graphAria, detailRows, syncSim, simStep, settle,
  isSettled, reheat, setMode, linkDistFor, fitView, makeView, toWorld, toScreen, zoomAt, panBy, hitNode, isTap,
  pinchOf,
} from '../src/graph-model.js';

const AGENTS = ['default', 'dev', 'nova', 'pixel', 'prism', 'red', 'sentinel'].map((id, i) => ({
  id, name: id === 'default' ? 'Ash' : id[0].toUpperCase() + id.slice(1), color: '#' + (0x100000 * (i + 1) + 0x3F).toString(16).padStart(6, '0'), status: 'idle',
}));

function fixture({ perAgent = 12, projects = 20 } = {}) {
  const sessions = {};
  let t = 1000;
  for (const a of AGENTS) {
    sessions[a.id] = [];
    for (let i = 0; i < perAgent; i++) {
      t += 7;
      sessions[a.id].push({ id: `${a.id}-${i}`, title: `Session ${a.id} ${i} with a long title`, status: 'idle', at: t });
    }
  }
  const proj = Array.from({ length: projects }, (_, i) => ({ name: `project-${i}`, status: 'active' }));
  return { agents: AGENTS, sessions, projects: proj, notes: 4 };
}

describe('safeLabel', () => {
  test('truncates to 24 characters with an ellipsis', () => {
    const s = safeLabel('alpha beta gamma delta epsilon zeta eta theta');
    assert.ok(s.length <= 24 && s.length >= 20, `length ${s.length}`);
    assert.ok(s.endsWith('…'));
  });
  test('never shows paths, key values, e-mail addresses or long tokens', () => {
    const out = [
      safeLabel('see /opt/data/profiles/dev/state.db now'),
      safeLabel('token=abc123secret'),
      safeLabel('mail me at jev@example.com'),
      safeLabel('sk-proj-AAAAAAAAAAAAAAAAAAAA'),
      safeLabel('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'),
    ].join(' | ');
    assert.doesNotMatch(out, /\/opt|state\.db|abc123|example\.com|sk-proj|deadbeef/);
  });
  test('empty and missing input give an empty label', () => {
    assert.equal(safeLabel(null), '');
    assert.equal(safeLabel('   '), '');
  });
});

describe('buildGraph', () => {
  test('caps the graph at 60 nodes even with many sessions and projects', () => {
    const g = buildGraph(fixture({ perAgent: 40, projects: 30 }));
    assert.equal(g.nodes.length, GRAPH_MAX_NODES);
    assert.equal(GRAPH_MAX_NODES, 60);
    assert.equal(g.truncated, true);
    assert.equal(g.counts.total, 60);
  });
  test('small data is not truncated and has every expected node', () => {
    const g = buildGraph(fixture({ perAgent: 2, projects: 3 }));
    assert.equal(g.truncated, false);
    assert.equal(g.counts.agent, 7);
    assert.equal(g.counts.memory, 8);          // one state.db per agent plus the notes inbox
    assert.equal(g.counts.project, 3);
    assert.equal(g.counts.session, 14);
  });
  test('ids are unique and every edge references existing nodes', () => {
    const g = buildGraph(fixture({ perAgent: 40, projects: 30 }));
    const ids = new Set(g.nodes.map(n => n.id));
    assert.equal(ids.size, g.nodes.length);
    for (const e of g.edges) {
      assert.ok(ids.has(e.a), `edge source ${e.a} exists`);
      assert.ok(ids.has(e.b), `edge target ${e.b} exists`);
    }
  });
  test('agent edges go only to its own memory source, sessions, and projects it owns', () => {
    const f = fixture({ perAgent: 3, projects: 2 });
    f.projects = [{ name: 'owned-by-dev', owner: 'dev' }, { name: 'orphan', owner: null }, { name: 'ghost', owner: 'nobody' }];
    const g = buildGraph(f);
    const byId = new Map(g.nodes.map(n => [n.id, n]));
    for (const e of g.edges) {
      const a = byId.get(e.a);
      assert.equal(a.type, 'agent');
      const b = byId.get(e.b);
      if (b.type === 'project') { assert.equal(e.kind, 'owner'); assert.equal(b.agent, a.agent); continue; }
      assert.ok(b.type === 'memory' || b.type === 'session');
      assert.equal(b.agent, a.agent);
    }
    assert.ok(g.edges.some(e => e.b === 'p:owned-by-dev'), 'owner edge exists');
    assert.ok(!g.edges.some(e => e.b === 'p:orphan' || e.b === 'p:ghost'), 'unowned or unknown owner: no edge');
  });
  test('sessions fill the budget most recent first', () => {
    const f = fixture({ perAgent: 40, projects: 30 });
    const g = buildGraph(f);
    const shown = g.nodes.filter(n => n.type === 'session').map(n => n.at);
    const newest = Math.max(...Object.values(f.sessions).flat().map(s => s.at));
    assert.equal(shown[0], newest);
    assert.deepEqual([...shown].sort((a, b) => b - a), shown);
  });
  test('agent colours come from the backend and a missing colour falls back', () => {
    const g = buildGraph({ agents: [{ id: 'x', name: 'X' }], sessions: {}, projects: [] });
    assert.equal(g.nodes[0].color, '#8a8a8a');
  });
  test('summary string names the counts', () => {
    const g = buildGraph(fixture({ perAgent: 40, projects: 30 }));
    assert.match(graphAria(g), /7 agents, 8 memory sources, 8 projects, \d+ sessions shown of 280/);
  });
  test('project detail shows the owner, or none when there is no owner', () => {
    const rows = detailRows({ id: 'p:x', type: 'project', status: 'active', count: 0, agent: 'dev' }, new Map([['dev', 'Dev']]));
    assert.equal(rows.find(r => r.k === 'Owner').v, 'Dev');
    const none = detailRows({ id: 'p:y', type: 'project', status: 'quiet', count: 0, agent: null });
    assert.equal(none.find(r => r.k === 'Owner').v, 'none');
  });
});

describe('simulation', () => {
  test('same graph keeps the same sim and positions (a /state poll must not reheat)', () => {
    const g = buildGraph(fixture({ perAgent: 2, projects: 2 }));
    const first = syncSim(null, g, { mode: 'orbit' }).sim;
    settle(first);
    const before = first.nodes.map(n => [n.x, n.y]);
    const again = syncSim(first, buildGraph(fixture({ perAgent: 2, projects: 2 })), { mode: 'orbit' });
    assert.equal(again.changed, false);
    assert.equal(again.sim, first);
    assert.deepEqual(first.nodes.map(n => [n.x, n.y]), before);
  });
  test('a new session keeps old positions and reheats', () => {
    const f = fixture({ perAgent: 2, projects: 2 });
    const sim = syncSim(null, buildGraph(f), { mode: 'orbit' }).sim;
    settle(sim);
    const old = new Map(sim.nodes.map(n => [n.id, [n.x, n.y]]));
    f.sessions.dev.unshift({ id: 'fresh', title: 'new', status: 'working', at: 99999 });
    const r = syncSim(sim, buildGraph(f), { mode: 'orbit' });
    assert.equal(r.changed, true);
    assert.equal(r.sim.alpha, 1);
    for (const n of r.sim.nodes) if (old.has(n.id)) assert.deepEqual([n.x, n.y], old.get(n.id));
  });
  test('layout is deterministic (same input, same positions)', () => {
    const a = syncSim(null, buildGraph(fixture({ perAgent: 3, projects: 2 })), {}).sim;
    const b = syncSim(null, buildGraph(fixture({ perAgent: 3, projects: 2 })), {}).sim;
    settle(a, 100); settle(b, 100);
    assert.deepEqual(a.nodes.map(n => [n.x, n.y]), b.nodes.map(n => [n.x, n.y]));
  });
  test('a sim step reduces energy and the sim converges to settled', () => {
    const sim = syncSim(null, buildGraph(fixture({ perAgent: 12, projects: 8 })), {}).sim;
    simStep(sim);
    const early = sim.energy;
    for (let i = 0; i < 40; i++) simStep(sim);
    const mid = sim.energy;
    assert.ok(mid < early, `energy falls (${early.toFixed(3)} -> ${mid.toFixed(3)})`);
    const ticks = settle(sim);
    assert.ok(isSettled(sim), 'settled');
    assert.ok(ticks < GRAPH_SETTLE_TICKS, `settles within ${GRAPH_SETTLE_TICKS} ticks (took ${ticks})`);
  });
  test('a pinned node is not moved by the sim while neighbours move', () => {
    const sim = syncSim(null, buildGraph(fixture({ perAgent: 3, projects: 2 })), {}).sim;
    settle(sim);
    const pin = sim.index.get('a:dev');
    const nb = sim.edges.filter(e => e.s === pin || e.t === pin).map(e => (e.s === pin ? e.t : e.s));
    pin.pinned = true;
    const x0 = pin.x, y0 = pin.y;
    const nbBefore = nb.map(n => [n.x, n.y]);
    reheat(sim, 1);
    for (let i = 0; i < 200; i++) simStep(sim);
    assert.equal(pin.x, x0);
    assert.equal(pin.y, y0);
    const moved = nb.some((n, i) => n.x !== nbBefore[i][0] || n.y !== nbBefore[i][1]);
    assert.ok(moved, 'at least one neighbour moved');
  });
  test('a released node with an anchor stays near its drop point while neighbours move', () => {
    const sim = syncSim(null, buildGraph(fixture({ perAgent: 3, projects: 2 })), {}).sim;
    settle(sim);
    const n = sim.index.get('a:dev');
    const x0 = n.x, y0 = n.y;
    n.x += 120; n.y += 40;                    // dragged, then released where it lies
    n.anchor = { x: n.x, y: n.y };
    const dropX = n.x, dropY = n.y;
    const others = sim.nodes.filter(o => o !== n).map(o => [o.x, o.y]);
    reheat(sim, 0.4);
    for (let i = 0; i < 400; i++) simStep(sim);
    assert.ok(Math.hypot(n.x - dropX, n.y - dropY) < 12, `anchored node held (off ${Math.hypot(n.x - dropX, n.y - dropY).toFixed(1)}px)`);
    assert.ok(Math.hypot(n.x - x0, n.y - y0) > 80, 'it did not snap back to the old spot');
    const moved = sim.nodes.filter(o => o !== n).filter((o, i) => Math.hypot(o.x - others[i][0], o.y - others[i][1]) > 3).length;
    assert.ok(moved > 0, 'neighbours reacted');
  });
  test('an anchor survives a graph update (a poll that adds a session)', () => {
    const f = fixture({ perAgent: 2, projects: 2 });
    const sim = syncSim(null, buildGraph(f), {}).sim;
    settle(sim);
    sim.index.get('a:dev').anchor = { x: 5, y: 6 };
    f.sessions.dev.unshift({ id: 'fresh2', title: 'x', status: 'idle', at: 99998 });
    const r = syncSim(sim, buildGraph(f), {});
    assert.deepEqual(r.sim.index.get('a:dev').anchor, { x: 5, y: 6 });
  });
  test('flow mode puts memory sources left of agents left of sessions', () => {
    const sim = syncSim(null, buildGraph(fixture({ perAgent: 4, projects: 2 })), { mode: 'flow' }).sim;
    setMode(sim, 'flow');
    settle(sim, 600);
    const xs = t => sim.nodes.filter(n => n.type === t).map(n => n.x);
    const avg = a => a.reduce((s, v) => s + v, 0) / a.length;
    assert.ok(avg(xs('memory')) < avg(xs('agent')), 'memory left of agents');
    assert.ok(avg(xs('agent')) < avg(xs('session')), 'agents left of sessions');
  });
  test('link slider maps to a rest length in range', () => {
    assert.equal(linkDistFor(0), 40);
    assert.equal(linkDistFor(100), 220);
    assert.equal(linkDistFor(999), 220);
  });
});

describe('viewport and hit testing', () => {
  test('zoom keeps the point under the pointer fixed', () => {
    const v = { x: 100, y: 80, k: 1.5 };
    const before = toWorld(v, 150, 120);
    const z = zoomAt(v, 150, 120, 1.7);
    const after = toWorld(z, 150, 120);
    assert.ok(Math.abs(before.x - after.x) < 1e-9 && Math.abs(before.y - after.y) < 1e-9);
  });
  test('zoom is clamped', () => {
    assert.ok(zoomAt({ x: 0, y: 0, k: 1 }, 0, 0, 100).k <= 4);
    assert.ok(zoomAt({ x: 0, y: 0, k: 1 }, 0, 0, 0.001).k >= 0.4);
  });
  test('pan shifts the screen position of a world point by the pan amount', () => {
    const v = makeView(360, 320);
    const s0 = toScreen(v, 10, 10);
    const s1 = toScreen(panBy(v, 30, -20), 10, 10);
    assert.equal(s1.x - s0.x, 30);
    assert.equal(s1.y - s0.y, -20);
  });
  test('fitView keeps every node inside the box', () => {
    const sim = syncSim(null, buildGraph(fixture({ perAgent: 12, projects: 8 })), {}).sim;
    settle(sim);
    const v = fitView(sim.nodes, 360, 320);
    for (const n of sim.nodes) {
      const s = toScreen(v, n.x, n.y);
      assert.ok(s.x >= 0 && s.x <= 360 && s.y >= 0 && s.y <= 320, `node ${n.id} inside`);
    }
  });
  test('hitNode returns the nearest node in reach and null outside', () => {
    const nodes = [{ id: 'a', x: 0, y: 0, r: 9 }, { id: 'b', x: 100, y: 0, r: 9 }];
    assert.equal(hitNode(nodes, 4, 3, 2).id, 'a');
    assert.equal(hitNode(nodes, 60, 0, 2), null);
  });
  test('tap is under 6px of movement, drag is at or over it', () => {
    assert.equal(isTap({ x: 0, y: 0 }, { x: 3, y: 4 }), true);
    assert.equal(isTap({ x: 0, y: 0 }, { x: 6, y: 0 }), false);
  });
  test('pinchOf gives distance and midpoint', () => {
    const p = pinchOf({ x: 0, y: 0 }, { x: 30, y: 40 });
    assert.equal(p.dist, 50);
    assert.deepEqual([p.x, p.y], [15, 20]);
  });
});
