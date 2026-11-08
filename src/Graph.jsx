import { React, useState, useEffect, useRef, useMemo, fetchJSON } from './sdk.js';
import { PROJECTS_API } from './ProjectsList.jsx';
import {
  buildGraph, graphAria, detailRows, syncSim, simStep, isSettled, settle, reheat, setMode, setLinkDist, linkDistFor,
  makeView, fitView, toWorld, toScreen, zoomAt, panBy, hitNode, isTap, pinchOf, drawRadius, repulseFor,
  labelCandidates, placeLabels, GRAPH_HIT_PX, GRAPH_DPR_CAP,
} from './graph-model.js';

/**
 * Memory node graph ("visual cortex"): a canvas force layout of agents, memory sources, projects and recent
 * sessions, read from /state and /projects only. Pointer Events drive it: drag a node (it is pinned while
 * held and its neighbours react), tap a node for details, drag empty space or pinch to move the view,
 * wheel to zoom, double-click or double-tap empty space to reset. Animation runs only while the layout is
 * moving or a node is held. In Lite mode or with reduced motion the layout is computed at once and drawn
 * once; drags still redraw. Nothing runs while the document is hidden. Canvas CSS size comes from .dk-gr-cv.
 */
export function NodeGraph({ agents, sessions, brain, lite }) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const simRef = useRef(null);
  const viewRef = useRef(null);
  const sizeRef = useRef({ w: 1, h: 1, dpr: 1 });
  const runningRef = useRef(false);
  const rafRef = useRef(0);
  const frameRef = useRef(0);
  const fitPendingRef = useRef(true);
  const ptrRef = useRef(new Map());
  const gestureRef = useRef(null);
  const lastTapRef = useRef(null);
  const selRef = useRef(null);
  const kbRef = useRef(null);
  const hoverRef = useRef(null);
  const labelsRef = useRef([]);
  const [sel, setSel] = useState(null);
  const [kbOpen, setKbOpen] = useState(false);
  const [ann, setAnn] = useState('');
  const [mode, setModeState] = useState('orbit');
  const [linkVal, setLinkVal] = useState(50);
  const modeRef = useRef(mode), linkRef = useRef(linkVal);
  modeRef.current = mode;
  linkRef.current = linkVal;
  const [projects, setProjects] = useState([]);
  const [projErr, setProjErr] = useState('');
  const sheetRef = useRef(null);

  // Lite (prop, or the Deck's stored flag) and reduced motion: no continuous animation.
  const storedLite = (() => { try { return localStorage.getItem('agent-deck.lite') === '1'; } catch (e) { return false; } })();
  const reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const still = !!lite || storedLite || reduced;
  const stillRef = useRef(still);
  stillRef.current = still;

  useEffect(() => {
    let alive = true;
    const pull = () => {
      if (document.hidden) return;
      fetchJSON(PROJECTS_API)
        .then(d => { if (alive) { setProjects(Array.isArray(d && d.projects) ? d.projects : []); setProjErr(''); } })
        .catch(e => { if (alive) setProjErr(String((e && e.message) || e || 'error')); });
    };
    pull();
    const onVis = () => { if (!document.hidden) pull(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { alive = false; document.removeEventListener('visibilitychange', onVis); };
  }, []);

  const graph = useMemo(
    () => buildGraph({ agents, sessions, projects, notes: brain && brain.notes }),
    [agents, sessions, brain, projects],
  );

  // ----- drawing and the loop. Everything reads refs, so the closures below stay valid across renders.
  const draw = () => {
    const cv = canvasRef.current, sim = simRef.current, v = viewRef.current;
    if (!cv || !v) return;
    const { w, h, dpr } = sizeRef.current;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    cv.dataset.frames = String(frameRef.current);
    if (!sim) { labelsRef.current = []; return; }
    ctx.setTransform(dpr * v.k, 0, 0, dpr * v.k, dpr * v.x, dpr * v.y);
    ctx.lineWidth = 1 / v.k;
    ctx.strokeStyle = 'rgba(232, 230, 240, 0.22)';
    ctx.beginPath();
    for (const e of sim.edges) { ctx.moveTo(e.s.x, e.s.y); ctx.lineTo(e.t.x, e.t.y); }
    ctx.stroke();
    const order = { session: 0, memory: 1, project: 2, agent: 3 };
    const sorted = sim.nodes.slice().sort((a, b) => order[a.type] - order[b.type]);
    for (const n of sorted) {
      const info = n.info;
      const dim = n.type === 'session';
      const rr = drawRadius(n.r, v.k);
      ctx.save();
      ctx.shadowColor = info.color;
      ctx.shadowBlur = (dim ? 6 : 14) * dpr;
      ctx.globalAlpha = dim ? 0.75 : 1;
      ctx.fillStyle = info.color;
      ctx.beginPath();
      ctx.arc(n.x, n.y, rr, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      const focused = n.id === selRef.current || n.id === kbRef.current;
      if (focused) {
        ctx.lineWidth = 2 / v.k;
        ctx.strokeStyle = '#F2F1F6';
        ctx.beginPath();
        ctx.arc(n.x, n.y, rr + 4 / v.k, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    // Labels are drawn in screen px (11px, unaffected by zoom) and placed greedily so no two boxes overlap.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    const boxes = placeLabels(labelCandidates(sim.nodes, v, focusIds()), s => ctx.measureText(s).width);
    labelsRef.current = boxes;
    for (const b of boxes) {
      ctx.fillStyle = b.dim ? 'rgba(179, 176, 191, 0.85)' : '#B3B0BF';
      ctx.fillText(b.text, b.x, b.y);
    }
  };

  // Nodes that get a label whatever the zoom: selected, keyboard focus, hovered, held.
  const focusIds = () => {
    const s = new Set();
    if (selRef.current != null) s.add(selRef.current);
    if (kbRef.current != null) s.add(kbRef.current);
    if (hoverRef.current != null) s.add(hoverRef.current);
    const g = gestureRef.current;
    if (g && g.kind === 'node' && g.node) s.add(g.node.id);
    return s;
  };

  const cancelLoop = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    runningRef.current = false;
  };

  const tick = () => {
    rafRef.current = 0;
    const sim = simRef.current;
    if (!sim || document.hidden) { runningRef.current = false; return; }
    frameRef.current += 1;
    simStep(sim);
    draw();
    const g = gestureRef.current;
    const holding = !!(g && g.kind === 'node' && g.node);
    if (holding || !isSettled(sim)) {
      rafRef.current = requestAnimationFrame(tick);
    } else {
      runningRef.current = false;
      if (fitPendingRef.current) { fitPendingRef.current = false; viewRef.current = fitView(sim.nodes, sizeRef.current.w, sizeRef.current.h); draw(); }
    }
  };

  const wake = () => {
    if (runningRef.current || stillRef.current || document.hidden || !simRef.current) return;
    runningRef.current = true;
    rafRef.current = requestAnimationFrame(tick);
  };

  // Static layout for Lite and reduced motion: settle now, fit, draw once.
  const settleNow = () => {
    const sim = simRef.current;
    if (!sim) return;
    settle(sim);
    if (fitPendingRef.current) { fitPendingRef.current = false; viewRef.current = fitView(sim.nodes, sizeRef.current.w, sizeRef.current.h); }
    draw();
  };

  const resetView = () => {
    const sim = simRef.current, { w, h } = sizeRef.current;
    viewRef.current = sim ? fitView(sim.nodes, w, h) : makeView(w, h);
    draw();
  };

  const local = e => {
    const r = canvasRef.current.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  // ----- mount: size the canvas, follow its box, pause when hidden, wheel zoom, debug hook.
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return undefined;
    const resize = () => {
      const w = Math.max(1, Math.round(cv.clientWidth)), h = Math.max(1, Math.round(cv.clientHeight));
      const dpr = Math.min(window.devicePixelRatio || 1, GRAPH_DPR_CAP);
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      sizeRef.current = { w, h, dpr };
      if (simRef.current) simRef.current.repulse = repulseFor(simRef.current.nodes.length, w);
      if (!viewRef.current) viewRef.current = makeView(w, h);
      draw();
    };
    let ro = null;
    if (window.ResizeObserver) { ro = new ResizeObserver(resize); ro.observe(cv); }
    else window.addEventListener('resize', resize);
    resize();
    const onVis = () => {
      if (document.hidden) cancelLoop();
      else if (stillRef.current) draw();
      else if (simRef.current && !isSettled(simRef.current)) wake();
    };
    document.addEventListener('visibilitychange', onVis);
    const onWheel = e => {
      e.preventDefault();
      const p = { x: e.offsetX, y: e.offsetY };
      viewRef.current = zoomAt(viewRef.current, p.x, p.y, Math.exp(-e.deltaY * 0.0015));
      draw();
    };
    cv.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      if (ro) ro.disconnect(); else window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', onVis);
      cv.removeEventListener('wheel', onWheel);
      cancelLoop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Read-only test hook: node positions in world and canvas CSS px. Removed on unmount.
  useEffect(() => {
    window.__deckGraph = {
      nodes: () => {
        const sim = simRef.current, v = viewRef.current;
        if (!sim || !v) return [];
        return sim.nodes.map(n => {
          const s = toScreen(v, n.x, n.y);
          return { id: n.id, type: n.type, x: n.x, y: n.y, screenX: s.x, screenY: s.y, r: n.r };
        });
      },
      // Label boxes placed by the last draw (screen CSS px, canvas-relative).
      labels: () => labelsRef.current.map(b => ({ id: b.id, text: b.text, x: b.x, y: b.y, w: b.w, h: b.h })),
      zoom: () => (viewRef.current ? viewRef.current.k : null),
      canvas: () => ({ ...sizeRef.current }),
    };
    return () => { delete window.__deckGraph; };
  }, []);

  // ----- sim follows the graph. Same nodes and edges (a /state poll): no reheat.
  useEffect(() => {
    const r = syncSim(simRef.current, graph, {
      mode: modeRef.current, linkDist: linkDistFor(linkRef.current), repulse: repulseFor(graph.nodes.length, sizeRef.current.w),
    });
    simRef.current = r.sim;
    if (r.changed) {
      if (stillRef.current) settleNow();
      else { reheat(r.sim, 1); wake(); }
    }
    draw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph]);

  // ----- layout mode and link distance
  useEffect(() => {
    const sim = simRef.current;
    if (!sim) return;
    setMode(sim, mode);
    setLinkDist(sim, linkDistFor(linkVal));
    fitPendingRef.current = true;
    if (stillRef.current) settleNow(); else wake();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, linkVal]);

  // ----- pointer gestures
  // Release: the node stays where it was dropped (soft anchor); its neighbours settle around it.
  const releaseNode = () => {
    const g = gestureRef.current;
    if (g && g.kind === 'node' && g.node) {
      g.node.pinned = false;
      if (g.moved) g.node.anchor = { x: g.node.x, y: g.node.y };
    }
  };

  const onPointerDown = e => {
    if (e.button > 0) return;
    const cv = canvasRef.current, sim = simRef.current, v = viewRef.current;
    const p = local(e);
    ptrRef.current.set(e.pointerId, p);
    try { cv.setPointerCapture(e.pointerId); } catch (err) { /* synthetic or stale pointer: capture not needed */ }
    if (ptrRef.current.size === 1) {
      const w = toWorld(v, p.x, p.y);
      const hit = sim ? hitNode(sim.nodes, w.x, w.y, GRAPH_HIT_PX / v.k) : null;
      gestureRef.current = {
        kind: hit ? 'node' : 'pan', node: hit, id: e.pointerId, type: e.pointerType || 'mouse',
        down: p, last: p, moved: false, off: hit ? { x: hit.x - w.x, y: hit.y - w.y } : null,
      };
      if (hit) { hit.pinned = true; hit.vx = 0; hit.vy = 0; reheat(sim, 0.3); wake(); }
    } else if (ptrRef.current.size === 2) {
      releaseNode();
      const [a, b] = [...ptrRef.current.values()];
      gestureRef.current = { kind: 'pinch', node: null, pinch: pinchOf(a, b), moved: true };
    }
  };

  const onPointerMove = e => {
    if (!ptrRef.current.has(e.pointerId)) {
      // mouse hover (no button down): label the node under the pointer
      if (e.pointerType === 'mouse' && simRef.current && viewRef.current) {
        const q = local(e), w = toWorld(viewRef.current, q.x, q.y);
        const hit = hitNode(simRef.current.nodes, w.x, w.y, GRAPH_HIT_PX / viewRef.current.k);
        const id = hit ? hit.id : null;
        if (id !== hoverRef.current) { hoverRef.current = id; draw(); }
      }
      return;
    }
    const p = local(e);
    ptrRef.current.set(e.pointerId, p);
    const g = gestureRef.current;
    if (!g) return;
    if (g.kind === 'pinch' && ptrRef.current.size >= 2) {
      const [a, b] = [...ptrRef.current.values()];
      const pn = pinchOf(a, b);
      let v = zoomAt(viewRef.current, pn.x, pn.y, pn.dist / Math.max(1, g.pinch.dist));
      v = panBy(v, pn.x - g.pinch.x, pn.y - g.pinch.y);
      viewRef.current = v;
      g.pinch = pn;
      draw();
      return;
    }
    if (g.id !== e.pointerId) return;
    if (!g.moved) {
      if (isTap(g.down, p)) return;   // still inside the tap radius: nothing to move yet
      g.moved = true;
      g.last = g.down;                // the drag starts from where the pointer went down
    }
    const sim = simRef.current, v = viewRef.current;
    if (g.kind === 'node' && g.node) {
      if (g.moved) {
        const w = toWorld(v, p.x, p.y);
        g.node.x = w.x + g.off.x;
        g.node.y = w.y + g.off.y;
        g.node.vx = 0; g.node.vy = 0;
        if (stillRef.current && sim) for (let i = 0; i < 3; i++) simStep(sim);
        draw();
      }
    } else if (g.kind === 'pan' && g.moved) {
      viewRef.current = panBy(v, p.x - g.last.x, p.y - g.last.y);
      draw();
    }
    g.last = p;
  };

  const onPointerUp = e => {
    if (!ptrRef.current.has(e.pointerId)) return;
    const p = local(e);
    ptrRef.current.delete(e.pointerId);
    const g = gestureRef.current;
    if (!g) return;
    if (ptrRef.current.size === 0) {
      gestureRef.current = null;
      const sim = simRef.current;
      if (g.kind === 'node' && g.node) {
        releaseNode();
        if (!g.moved) {
          // tap: the node was pinned where it sat and never moved. Open its sheet.
          selRef.current = g.node.id;
          setKbOpen(false);
          setSel(g.node.id);
          draw();
        } else {
          if (sim) reheat(sim, 0.4);
          if (stillRef.current) settleNow(); else wake();
        }
      } else if (g.kind === 'pan' && !g.moved) {
        // tap on empty space: close the sheet; two quick touch taps reset the view
        const now = performance.now(), lt = lastTapRef.current;
        if (g.type === 'touch' && lt && now - lt.t < 320 && Math.hypot(p.x - lt.x, p.y - lt.y) < 30) {
          lastTapRef.current = null;
          resetView();
        } else {
          lastTapRef.current = g.type === 'touch' ? { t: now, x: p.x, y: p.y } : null;
          closeSheet();
        }
      }
    } else if (g.kind === 'pinch' && ptrRef.current.size === 1) {
      const [id, rem] = [...ptrRef.current.entries()][0];
      gestureRef.current = { kind: 'pan', node: null, id, type: g.type || 'touch', down: rem, last: rem, moved: true };
    }
  };

  const onPointerLeave = () => {
    if (hoverRef.current != null) { hoverRef.current = null; draw(); }
  };

  const onDoubleClick = e => {
    const sim = simRef.current, v = viewRef.current;
    if (!sim || !v) return;
    const p = local(e);
    const w = toWorld(v, p.x, p.y);
    if (!hitNode(sim.nodes, w.x, w.y, GRAPH_HIT_PX / v.k)) resetView();
  };

  // ----- sheet and keyboard
  const closeSheet = () => {
    if (selRef.current == null) return;
    selRef.current = null;
    setSel(null);
    setKbOpen(false);
    draw();
  };

  const onKey = e => {
    const sim = simRef.current;
    if (e.key === 'Escape') { if (sel != null) { e.preventDefault(); closeSheet(); } return; }
    if (!sim || !sim.nodes.length) return;
    const ids = sim.nodes.map(n => n.id);
    if (['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      e.preventDefault();
      const cur = ids.indexOf(kbRef.current);
      const fwd = e.key === 'ArrowRight' || e.key === 'ArrowDown';
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? ids.length - 1
        : cur < 0 ? (fwd ? 0 : ids.length - 1)
        : fwd ? (cur + 1) % ids.length : (cur - 1 + ids.length) % ids.length;
      kbRef.current = ids[next];
      const n = sim.nodes[next];
      setAnn(`${n.info.type}: ${n.info.label}`);
      draw();
    } else if ((e.key === 'Enter' || e.key === ' ') && kbRef.current != null) {
      e.preventDefault();
      selRef.current = kbRef.current;
      setKbOpen(true);
      setSel(kbRef.current);
      draw();
    }
  };

  useEffect(() => {
    if (sel != null && kbOpen && sheetRef.current) {
      const btn = sheetRef.current.querySelector('button');
      if (btn) btn.focus({ preventScroll: true });
    }
  }, [sel, kbOpen]);

  const picked = sel != null && simRef.current ? simRef.current.index.get(sel) : null;
  const agentNames = useMemo(() => new Map((agents || []).map(a => [a.id, a.name || a.id])), [agents]);
  const aria = graphAria(graph);
  const linkDist = Math.round(linkDistFor(linkVal));

  return (
    <section className="dk-gr" aria-label="Memory graph">
      <div className="dk-gr-ctrl">
        <div className="dk-gr-seg" role="group" aria-label="Layout">
          {[['orbit', 'Orbit'], ['flow', 'Flow']].map(([id, label]) => (
            <button key={id} type="button" className={'dk-gr-btn' + (mode === id ? ' is-on' : '')}
              aria-pressed={mode === id} onClick={() => setModeState(id)}>{label}</button>
          ))}
        </div>
        <label className="dk-gr-links">
          <span>Links</span>
          <input type="range" min="0" max="100" step="1" value={linkVal} aria-valuetext={linkDist + ' px'}
            onChange={e => setLinkVal(Number(e.target.value))} />
          <output className="dk-gr-val" aria-hidden="true">{linkVal}%</output>
        </label>
        <button type="button" className="dk-gr-reset" onClick={resetView}>Reset view</button>
      </div>
      <div className="dk-gr-wrap" ref={wrapRef} onKeyDown={onKey}>
        <canvas ref={canvasRef} className="dk-gr-cv" role="img" aria-label={aria} tabIndex={0}
          data-nodes={graph.nodes.length} data-edges={graph.edges.length} data-mode={mode} data-frames="0"
          onPointerDown={onPointerDown} onPointerMove={onPointerMove}
          onPointerUp={onPointerUp} onPointerCancel={onPointerUp} onPointerLeave={onPointerLeave}
          onDoubleClick={onDoubleClick} />
        {picked && (
          <div className="dk-gr-sheet" role="dialog" aria-labelledby="dk-gr-sh-t" ref={sheetRef}>
            <div className="dk-gr-sh-h">
              <h3 id="dk-gr-sh-t" className="dk-gr-sh-t" style={{ color: picked.info.color }}>{picked.info.label}</h3>
              <button type="button" className="dk-gr-close" aria-label="Close node details" onClick={closeSheet}>×</button>
            </div>
            <dl className="dk-gr-dl">
              {detailRows(picked.info, agentNames).map(r => (
                <div key={r.k} className="dk-gr-row"><dt>{r.k}</dt><dd>{r.v}</dd></div>
              ))}
            </dl>
          </div>
        )}
        {graph.nodes.length === 0 && <p className="dk-gr-empty">No agents or sessions to draw yet.</p>}
      </div>
      <ul className="dk-sr" aria-label="Graph nodes">
        {graph.nodes.map(n => <li key={n.id}>{n.type}: {n.label}</li>)}
      </ul>
      <div className="dk-sr" role="status" aria-live="polite">{ann}</div>
      <p className="dk-gr-note">
        {projErr ? 'Projects unavailable. ' : ''}Drag a node. Tap it for details. Drag empty space or pinch to move; double-tap to reset.
        {graph.truncated ? ' Showing the most recent sessions.' : ''}
      </p>
    </section>
  );
}
