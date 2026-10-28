/*
 * Agent Office 3D scene (plain three.js, no React reconciler): floating
 * low-poly rooms around "The Brain", isometric orthographic camera,
 * drag / pinch / wheel controls, tap to select a room.
 *
 * createOffice(container, { lite, onSelect }) -> { update(state), select(id), zoom(k), fit(), setLite(b), dispose(), project() }
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

export const COLORS = {
  blue: 0x3f6fe0, green: 0x2fa05a, orange: 0xe58a2b, purple: 0x8b5cf6,
  red: 0xe0474c, teal: 0x14a6a0, pink: 0xd94fc4, yellow: 0xe0b82b,
};
const ROOM = 9;            // floor size
const WALL_H = 3.0;
const HUB_R = 4.2;
const SKIN = [0xf1c7a5, 0xd9a07a, 0xa86b45, 0xf3d2b8];
const HAIR = [0x3b2416, 0x8a3a1c, 0x1c1c22, 0xc98a3a, 0x5a3825];
const SHIRT = [0xf28c38, 0x58c4a8, 0x6a8cff, 0xe25d6d, 0xf2d04b, 0x9b7bff];

// ---------- small helpers ----------
const matCache = new Map();
function mat(color, o = {}) {
  const key = color + JSON.stringify(o);
  if (!matCache.has(key)) {
    matCache.set(key, new THREE.MeshStandardMaterial({ color, roughness: o.rough ?? 0.78, metalness: o.metal ?? 0.02,
      emissive: o.emissive ?? 0x000000, emissiveIntensity: o.ei ?? 1, flatShading: !!o.flat,
      transparent: !!o.opacity, opacity: o.opacity ?? 1, map: o.map || null }));
  }
  return matCache.get(key);
}
function box(w, h, d, m, x = 0, y = 0, z = 0) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  mesh.position.set(x, y, z); mesh.castShadow = true; mesh.receiveShadow = true;
  return mesh;
}
function cyl(rt, rb, h, m, seg = 16) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), m);
  mesh.castShadow = true; mesh.receiveShadow = true;
  return mesh;
}
function shade(hex, k) {             // k<0 darker, k>0 lighter
  const c = new THREE.Color(hex);
  return k < 0 ? c.multiplyScalar(1 + k) : c.lerp(new THREE.Color(0xffffff), k);
}
function canvasTex(w, h, draw) {
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  draw(cv.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  t.userData.canvas = cv;
  return t;
}
const hashN = (s, n) => { let h = 7; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h % n; };

// ---------- textures ----------
function floorTex(color) {
  return canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = '#' + shade(color, -0.05).getHexString(); g.fillRect(0, 0, w, h);
    g.strokeStyle = '#' + shade(color, 0.12).getHexString(); g.lineWidth = 2;
    for (let i = 0; i <= 8; i++) { g.beginPath(); g.moveTo(i * 32, 0); g.lineTo(i * 32, h); g.stroke(); g.beginPath(); g.moveTo(0, i * 32); g.lineTo(w, i * 32); g.stroke(); }
  });
}
function wallTex(color) {
  return canvasTex(256, 128, (g, w, h) => {
    g.fillStyle = '#' + shade(color, -0.12).getHexString(); g.fillRect(0, 0, w, h);
    g.fillStyle = '#' + shade(color, -0.24).getHexString();
    for (let x = 6; x < w; x += 12) g.fillRect(x, 0, 2, h);
  });
}
function codeTex(seed, tint) {
  return canvasTex(128, 80, (g, w, h) => {
    g.fillStyle = '#0d1424'; g.fillRect(0, 0, w, h);
    const cols = ['#7fd1ff', '#9effc2', '#ffd27f', '#c9b6ff', '#' + new THREE.Color(tint).getHexString()];
    let r = seed || 1;
    for (let y = 8; y < h - 4; y += 7) {
      let x = 6 + ((r = (r * 9301 + 49297) % 233280) % 3) * 8;
      while (x < w - 10) {
        const len = 6 + ((r = (r * 9301 + 49297) % 233280) % 26);
        g.fillStyle = cols[r % cols.length]; g.globalAlpha = 0.85; g.fillRect(x, y, Math.min(len, w - 8 - x), 3);
        x += len + 5; if (r % 5 === 0) break;
      }
    }
  });
}
function drawChart(tex, name, series, color) {
  const cv = tex.userData.canvas, g = cv.getContext('2d'), w = cv.width, h = cv.height;
  g.fillStyle = '#0b1222'; g.fillRect(0, 0, w, h);
  g.fillStyle = '#' + new THREE.Color(color).getHexString(); g.fillRect(0, 0, w, 6);
  g.fillStyle = '#e8eefc'; g.font = 'bold 22px system-ui, sans-serif'; g.fillText(name.toUpperCase(), 16, 34);
  g.fillStyle = '#8fa0c4'; g.font = '15px ui-monospace, monospace'; g.fillText('tool calls · last 12h', 16, 56);
  const total = series.reduce((a, b) => a + b, 0);
  g.fillStyle = '#e8eefc'; g.font = 'bold 30px system-ui, sans-serif'; g.textAlign = 'right'; g.fillText(String(total), w - 16, 40); g.textAlign = 'left';
  const max = Math.max(1, ...series), x0 = 16, y0 = h - 18, cw = w - 32, ch = h - 96;
  g.strokeStyle = 'rgba(143,160,196,.25)'; g.lineWidth = 1;
  for (let i = 0; i < 4; i++) { const y = y0 - (ch * i) / 3; g.beginPath(); g.moveTo(x0, y); g.lineTo(x0 + cw, y); g.stroke(); }
  const pts = series.map((v, i) => [x0 + (cw * i) / Math.max(1, series.length - 1), y0 - (v / max) * ch]);
  const grad = g.createLinearGradient(0, y0 - ch, 0, y0);
  grad.addColorStop(0, 'rgba(96,200,255,.45)'); grad.addColorStop(1, 'rgba(96,200,255,0)');
  g.beginPath(); g.moveTo(pts[0][0], y0); pts.forEach(p => g.lineTo(p[0], p[1])); g.lineTo(pts[pts.length - 1][0], y0); g.closePath(); g.fillStyle = grad; g.fill();
  g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]))); g.strokeStyle = '#6fd0ff'; g.lineWidth = 3; g.stroke();
  tex.needsUpdate = true;
}

// ---------- furniture ----------
function makeDesk(color) {
  const g = new THREE.Group();
  g.add(box(1.7, 0.08, 0.85, mat(0xeadfca, { rough: 0.6 }), 0, 0.78, 0));
  const leg = mat(0x23262e, { metal: 0.4, rough: 0.5 });
  for (const [x, z] of [[-0.78, -0.36], [0.78, -0.36], [-0.78, 0.36], [0.78, 0.36]]) g.add(box(0.05, 0.78, 0.05, leg, x, 0.39, z));
  return g;
}
function makeMonitor(seed, tint) {
  const g = new THREE.Group();
  g.add(box(0.06, 0.28, 0.06, mat(0x1d2028), 0, 0.96, 0));
  g.add(box(0.28, 0.02, 0.2, mat(0x1d2028), 0, 0.83, 0));
  g.add(box(0.95, 0.56, 0.05, mat(0x15171d, { rough: 0.4 }), 0, 1.3, 0));
  const tex = codeTex(seed, tint);
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.88, 0.5),
    new THREE.MeshStandardMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.9, roughness: 0.4 }));
  screen.position.set(0, 1.3, 0.028); g.add(screen);
  g.userData.screen = screen;
  return g;
}
function makeChair() {
  const g = new THREE.Group(), m = mat(0x2a2e38, { rough: 0.6 });
  g.add(box(0.62, 0.1, 0.6, m, 0, 0.5, 0));
  g.add(box(0.62, 0.62, 0.08, m, 0, 0.86, 0.3));
  const post = cyl(0.04, 0.04, 0.42, mat(0x15171d, { metal: 0.5 })); post.position.y = 0.27; g.add(post);
  for (let i = 0; i < 5; i++) { const a = (i / 5) * Math.PI * 2, leg = box(0.38, 0.04, 0.06, mat(0x15171d), Math.cos(a) * 0.17, 0.05, Math.sin(a) * 0.17); leg.rotation.y = -a; g.add(leg); }
  return g;
}
function makePlant(s = 1) {
  const g = new THREE.Group();
  const pot = cyl(0.26 * s, 0.2 * s, 0.42 * s, mat(0xf2f2f2, { rough: 0.5 })); pot.position.y = 0.21 * s; g.add(pot);
  const leaf = mat(0x3fa35b, { flat: true, rough: 0.7 }), leaf2 = mat(0x2f8a4a, { flat: true, rough: 0.7 });
  for (const [x, y, z, r, m] of [[0, 0.75, 0, 0.36, leaf], [0.16, 0.95, 0.08, 0.26, leaf2], [-0.14, 0.92, -0.06, 0.24, leaf], [0.02, 1.12, -0.05, 0.2, leaf2]]) {
    const b = new THREE.Mesh(new THREE.IcosahedronGeometry(r * s, 0), m); b.position.set(x * s, y * s, z * s); b.castShadow = true; g.add(b);
  }
  return g;
}
function makeLamp() {
  const g = new THREE.Group();
  const base = cyl(0.22, 0.26, 0.06, mat(0x1d2028)); base.position.y = 0.03; g.add(base);
  const pole = cyl(0.025, 0.025, 2.1, mat(0x1d2028, { metal: 0.5 })); pole.position.y = 1.08; g.add(pole);
  const shadeM = new THREE.MeshStandardMaterial({ color: 0xfff3d6, emissive: 0xffe2a8, emissiveIntensity: 1.6, roughness: 0.4 });
  const sh = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.34, 0.34, 20, 1, true), shadeM); sh.position.y = 2.2; g.add(sh);
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 8), shadeM); bulb.position.y = 2.08; g.add(bulb);
  g.userData.shade = shadeM;
  return g;
}
function makeShelf(color) {
  const g = new THREE.Group();
  g.add(box(0.3, 0.06, 1.5, mat(0xeadfca), 0, 0, 0));
  const books = [0xe2524f, 0xf2c14e, 0x5b8def, 0x4fc08d, 0xc77dff, 0xf28c38, shade(color, 0.35).getHex()];
  let z = -0.62;
  for (let i = 0; i < 9 && z < 0.66; i++) {
    const h = 0.28 + ((i * 37) % 10) / 60, t = 0.09 + ((i * 13) % 4) / 60;
    g.add(box(0.22, h, t, mat(books[i % books.length]), 0, 0.03 + h / 2, z + t / 2)); z += t + 0.015;
  }
  return g;
}
/** Seated low-poly character. Returns group with parts in userData for animation. */
function makeCharacter(seed) {
  const g = new THREE.Group();
  const skin = mat(SKIN[hashN(seed + 's', SKIN.length)], { rough: 0.6 });
  const shirtC = SHIRT[hashN(seed + 'c', SHIRT.length)];
  const shirt = mat(shirtC, { rough: 0.7 }), pants = mat(0x2c3550), hair = mat(HAIR[hashN(seed + 'h', HAIR.length)], { rough: 0.8 });
  const torso = new THREE.Group(); torso.position.set(0, 0.55, 0.12); g.add(torso);
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.24, 0.32, 6, 14), shirt); body.position.y = 0.38; body.castShadow = true; torso.add(body);
  const head = new THREE.Group(); head.position.y = 0.92; torso.add(head);
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.25, 20, 14), skin); skull.castShadow = true; head.add(skull);
  const hairM = new THREE.Mesh(new THREE.SphereGeometry(0.265, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.55), hair);
  hairM.rotation.x = 0.35; hairM.position.set(0, 0.03, 0.03); head.add(hairM);
  if (hashN(seed + 'p', 3) === 0) {           // headphones
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.27, 0.035, 8, 20, Math.PI), mat(0x1d2028)); band.rotation.z = 0; band.position.y = 0.02; head.add(band);
    for (const x of [-0.27, 0.27]) { const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.07, 12), mat(0x1d2028)); cup.rotation.z = Math.PI / 2; cup.position.set(x, 0, 0); head.add(cup); }
  }
  const arms = [];
  for (const s of [-1, 1]) {
    const arm = new THREE.Group(); arm.position.set(0.3 * s, 0.55, 0); torso.add(arm);
    const a = new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.42, 4, 8), shirt); a.rotation.x = Math.PI / 2.4; a.position.set(0, -0.08, -0.22); a.castShadow = true; arm.add(a);
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 8), skin); hand.position.set(0, -0.2, -0.45); arm.add(hand);
    arms.push(arm);
  }
  for (const s of [-1, 1]) {                   // thighs forward, shins down
    g.add(box(0.17, 0.16, 0.5, pants, 0.12 * s, 0.62, -0.12));
    g.add(box(0.15, 0.48, 0.15, pants, 0.12 * s, 0.3, -0.36));
    g.add(box(0.16, 0.08, 0.24, mat(0x1d2028), 0.12 * s, 0.04, -0.42));
  }
  g.userData = { torso, head, arms, phase: hashN(seed, 100) / 16 };
  return g;
}

// ---------- room ----------
function buildRoom(agent) {
  const color = COLORS[agent.color] ?? COLORS.blue;
  const g = new THREE.Group(); g.userData.agentId = agent.id;
  const half = ROOM / 2;
  // floor slab with a lighter rim and tiled top
  const slab = box(ROOM, 0.5, ROOM, mat(shade(color, -0.18).getHex()), 0, -0.25, 0);
  g.add(slab);
  const ft = floorTex(color); ft.wrapS = ft.wrapT = THREE.RepeatWrapping; ft.repeat.set(2, 2);
  const top = new THREE.Mesh(new THREE.PlaneGeometry(ROOM - 0.3, ROOM - 0.3), new THREE.MeshStandardMaterial({ map: ft, roughness: 0.85 }));
  top.rotation.x = -Math.PI / 2; top.position.y = 0.005; top.receiveShadow = true; g.add(top);
  const rug = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 3.8), mat(shade(color, 0.55).getHex(), { rough: 0.95 }));
  rug.rotation.x = -Math.PI / 2; rug.position.set(0.6, 0.012, 0.6); rug.receiveShadow = true; g.add(rug);
  // two back walls (camera sits at +x +z, so walls go on -x and -z)
  const wt = wallTex(color), wm = new THREE.MeshStandardMaterial({ map: wt, roughness: 0.85 });
  wt.wrapS = THREE.RepeatWrapping; wt.repeat.set(3, 1);
  const wallZ = new THREE.Mesh(new THREE.BoxGeometry(ROOM, WALL_H, 0.25), wm); wallZ.position.set(0, WALL_H / 2, -half + 0.125); wallZ.receiveShadow = true; g.add(wallZ);
  const wallX = new THREE.Mesh(new THREE.BoxGeometry(0.25, WALL_H, ROOM), wm); wallX.position.set(-half + 0.125, WALL_H / 2, 0); wallX.receiveShadow = true; g.add(wallX);
  const cap = mat(shade(color, 0.25).getHex());
  g.add(box(ROOM, 0.08, 0.3, cap, 0, WALL_H, -half + 0.125), box(0.3, 0.08, ROOM, cap, -half + 0.125, WALL_H, 0));
  // wall screen with the agent's real tool-call chart
  const chart = canvasTex(512, 300, () => {});
  const scrM = new THREE.MeshStandardMaterial({ map: chart, emissive: 0xffffff, emissiveMap: chart, emissiveIntensity: 0.85, roughness: 0.35 });
  g.add(box(2.7, 1.62, 0.08, mat(0x101420), 0.6, 1.85, -half + 0.3));
  const scr = new THREE.Mesh(new THREE.PlaneGeometry(2.56, 1.5), scrM); scr.position.set(0.6, 1.85, -half + 0.345); g.add(scr);
  // shelf + plants + lamp
  const shelf = makeShelf(color); shelf.position.set(-half + 0.42, 1.65, 1.4); g.add(shelf);
  const p1 = makePlant(1); p1.position.set(half - 0.75, 0, half - 0.75); g.add(p1);
  const p2 = makePlant(0.8); p2.position.set(-half + 0.75, 0, half - 0.8); g.add(p2);
  const p3 = makePlant(0.9); p3.position.set(half - 0.8, 0, -half + 0.9); g.add(p3);
  const lamp = makeLamp(); lamp.position.set(-half + 0.8, 0, -half + 0.8); g.add(lamp);
  // desks: [lead, spare, spare] (spares are where helpers will beam in, v2)
  const desks = [];
  const spots = [[0.7, 0.9, 0], [-1.9, -1.5, Math.PI / 2], [2.6, -1.3, 0]];
  spots.forEach(([x, z, ry], i) => {
    const d = new THREE.Group(); d.position.set(x, 0, z); d.rotation.y = ry; g.add(d);
    d.add(makeDesk(color));
    const mon = makeMonitor(hashN(agent.id + i, 999) + 3, color); mon.position.set(0, 0, -0.2); d.add(mon);
    if (i === 0) { const mon2 = makeMonitor(hashN(agent.id + 'b', 999) + 5, color); mon2.position.set(0.62, 0, -0.12); mon2.rotation.y = -0.35; d.add(mon2); }
    const chair = makeChair(); chair.position.set(0, 0, 0.75); chair.rotation.y = Math.PI; d.add(chair);
    desks.push({ group: d, monitors: d.children.filter(c => c.userData.screen).map(c => c.userData.screen) });
  });
  const person = makeCharacter(agent.id); person.position.set(0, 0, 0.78); person.scale.setScalar(1.3); desks[0].group.add(person);
  // status ring on the floor around the lead
  const ringM = new THREE.MeshBasicMaterial({ color: 0x46e08a, transparent: true, opacity: 0.0, depthWrite: false });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.85, 1.0, 40), ringM); ring.rotation.x = -Math.PI / 2; ring.position.set(0, 0.02, 0.75);
  desks[0].group.add(ring);
  // glowing rim around the slab (picked up by bloom)
  const rimM = new THREE.MeshBasicMaterial({ color: shade(color, 0.45) });
  for (const [w, d, x, z] of [[ROOM, 0.07, 0, half], [ROOM, 0.07, 0, -half], [0.07, ROOM, half, 0], [0.07, ROOM, -half, 0]]) g.add(box(w, 0.07, d, rimM, x, 0.01, z));
  g.add(box(ROOM, 0.05, 0.05, rimM, 0, -0.5, half), box(0.05, 0.05, ROOM, rimM, half, -0.5, 0));
  g.userData.parts = { chart, chartM: scrM, desks, person, lamp, ringM, ring, color };
  g.traverse(o => { o.userData.agentId = agent.id; });
  return g;
}

// ---------- the Brain ----------
function buildBrain() {
  const g = new THREE.Group();
  const disk = cyl(HUB_R, HUB_R + 0.2, 0.45, mat(0x151b30, { metal: 0.5, rough: 0.35 }), 64); disk.position.y = -0.22; g.add(disk);
  const top = new THREE.Mesh(new THREE.CircleGeometry(HUB_R - 0.05, 64), mat(0x0f1426, { metal: 0.6, rough: 0.3 }));
  top.rotation.x = -Math.PI / 2; top.position.y = 0.01; top.receiveShadow = true; g.add(top);
  const rings = [];
  for (const [r, w, o] of [[HUB_R - 0.25, 0.08, 0.9], [HUB_R - 1.1, 0.05, 0.6], [HUB_R - 1.9, 0.04, 0.45]]) {
    const m = new THREE.MeshBasicMaterial({ color: 0x5fd8ff, transparent: true, opacity: o, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending });
    const ring = new THREE.Mesh(new THREE.RingGeometry(r - w, r, 96, 1, 0, Math.PI * 1.7), m); ring.rotation.x = -Math.PI / 2; ring.position.y = 0.03; g.add(ring); rings.push(ring);
  }
  const coreM = new THREE.MeshStandardMaterial({ color: 0x9feaff, emissive: 0x3cc8ff, emissiveIntensity: 2.2, roughness: 0.2 });
  const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.75, 2), coreM); core.position.y = 2.2; g.add(core);
  const shell = new THREE.Mesh(new THREE.IcosahedronGeometry(1.1, 1), new THREE.MeshBasicMaterial({ color: 0x7fe3ff, wireframe: true, transparent: true, opacity: 0.35 }));
  shell.position.y = 2.2; g.add(shell);
  const beamM = new THREE.MeshBasicMaterial({ color: 0x5fd8ff, transparent: true, opacity: 0.16, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.6, 5, 24, 1, true), beamM); beam.position.y = 2.5; g.add(beam);
  const pedestal = cyl(0.55, 0.8, 0.9, mat(0x1b2340, { metal: 0.6, rough: 0.3 }), 24); pedestal.position.y = 0.45; g.add(pedestal);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(HUB_R + 0.05, 0.07, 8, 96), new THREE.MeshBasicMaterial({ color: 0x8feaff }));
  rim.rotation.x = Math.PI / 2; rim.position.y = 0.02; g.add(rim);
  g.userData = { rings, core, shell, beamM };
  return g;
}

// ---------- walkway + light line ----------
function buildLink(angle, radius, color) {
  const g = new THREE.Group();
  const start = HUB_R + 0.1, end = radius - ROOM * 0.5 * 1.05, len = Math.max(0.5, end - start);
  const path = new THREE.Group(); path.rotation.y = -angle; g.add(path);
  path.add(box(len, 0.16, 1.5, mat(0x1a2034, { rough: 0.5, metal: 0.3 }), start + len / 2, -0.12, 0));
  const edgeM = new THREE.MeshBasicMaterial({ color: shade(color, 0.4), transparent: true, opacity: 0.9 });
  for (const z of [-0.72, 0.72]) path.add(new THREE.Mesh(new THREE.BoxGeometry(len, 0.04, 0.05), edgeM).translateX(start + len / 2).translateY(-0.02).translateZ(z));
  const dots = [];
  for (let i = 0; i < 4; i++) {
    const d = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    d.position.set(start + (len * i) / 4, 0.08, 0); path.add(d); dots.push(d);
  }
  // arcing light line from the Brain core to above the room
  const target = new THREE.Vector3(Math.cos(angle) * radius, 4.2, Math.sin(angle) * radius);
  const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(0, 2.2, 0), new THREE.Vector3(target.x * 0.5, 7, target.z * 0.5), target);
  const lineM = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.45, depthWrite: false, blending: THREE.AdditiveBlending });
  g.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 48, 0.06, 6), lineM));
  const pulse = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95 }));
  g.add(pulse);
  g.userData = { dots, start, len, curve, pulse, lineM, edgeM };
  return g;
}

// ---------- the office ----------
export function createOffice(container, opts = {}) {
  let lite = !!opts.lite;
  const renderer = new THREE.WebGLRenderer({ antialias: !lite, alpha: false, powerPreference: lite ? 'low-power' : 'high-performance' });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);
  renderer.domElement.className = 'ao-canvas';

  const scene = new THREE.Scene();
  // Painted navy + stars backdrop (opaque, so the bloom pass composites cleanly).
  scene.background = canvasTex(1024, 1024, (g, w, h) => {
    const gr = g.createRadialGradient(w / 2, h * 0.42, 0, w / 2, h / 2, w * 0.72);
    gr.addColorStop(0, '#18235a'); gr.addColorStop(0.45, '#0c1334'); gr.addColorStop(1, '#05070f');
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
    let r = 7;
    for (let i = 0; i < 260; i++) {
      r = (r * 9301 + 49297) % 233280; const x = (r / 233280) * w; r = (r * 9301 + 49297) % 233280; const y = (r / 233280) * h;
      const s = i % 9 ? 1.3 : 2.4; g.fillStyle = `rgba(255,255,255,${0.25 + (i % 5) * 0.12})`; g.fillRect(x, y, s, s);
    }
  });
  let composer = null;
  function makeComposer() {
    if (composer) return;
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    composer.addPass(new UnrealBloomPass(new THREE.Vector2(256, 256), 0.8, 0.5, 0.8));
    composer.addPass(new OutputPass());
  }
  const hemi = new THREE.HemisphereLight(0xbfd0ff, 0x1a1f3a, 1.25); scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff1e0, 1.7); sun.position.set(18, 30, 10); scene.add(sun); scene.add(sun.target);
  sun.shadow.mapSize.set(1536, 1536); const sc = sun.shadow.camera; sc.left = sc.bottom = -32; sc.right = sc.top = 32; sc.near = 1; sc.far = 90; sun.shadow.bias = -0.0005;
  const fill = new THREE.DirectionalLight(0x8fb6ff, 0.45); fill.position.set(-20, 12, 18); scene.add(fill);
  const brain = buildBrain(); scene.add(brain);
  const brainLight = new THREE.PointLight(0x4fd1ff, 30, 16, 1.6); brainLight.position.set(0, 3, 0); scene.add(brainLight);

  const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 400);
  const DIR = new THREE.Vector3(1, 1.05, 1).normalize();
  const target = new THREE.Vector3();
  let zoom = 1, fitted = 1, userMoved = false;
  const insets = () => Object.assign({ top: 0, bottom: 0, left: 0, right: 0 }, opts.insets ? opts.insets() : {});

  const rooms = new Map();            // id -> { group, link, light, angle, radius, agent }
  let order = [];
  let selected = null;

  function layout(ids) {
    const n = Math.max(1, ids.length);
    // Close enough that the walkways are short (as in the reference), never overlapping the hub or each other.
    const radius = Math.max(10.6, n > 1 ? 7.0 / Math.sin(Math.PI / n) : 10.6);
    ids.forEach((id, i) => {
      const angle = (-3 * Math.PI) / 4 + (i * 2 * Math.PI) / n;   // first room at the back, the rest clockwise
      const r = rooms.get(id);
      r.angle = angle; r.radius = radius;
      r.group.position.set(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
      if (r.link) scene.remove(r.link);
      r.link = buildLink(angle, radius, COLORS[r.agent.color] ?? COLORS.blue); scene.add(r.link);
      r.light.position.set(r.group.position.x - ROOM / 2 + 0.8, 2.3, r.group.position.z - ROOM / 2 + 0.8);
    });
    order = ids;
    fit();
  }

  function applyShadows() {
    renderer.shadowMap.enabled = !lite; sun.castShadow = !lite;
    for (const r of rooms.values()) r.light.visible = !lite;
    brainLight.visible = !lite;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, lite ? 1.25 : 1.75));
    { makeComposer(); composer.setPixelRatio(renderer.getPixelRatio()); composer.setSize(container.clientWidth || 1, container.clientHeight || 1); }
    scene.traverse(o => { if (o.material) o.material.needsUpdate = true; });
  }

  function bounds() {
    // Analytic (world matrices may not be updated yet): hub + every room's footprint up to the wall tops.
    const b = new THREE.Box3(new THREE.Vector3(-HUB_R, -0.5, -HUB_R), new THREE.Vector3(HUB_R, 3, HUB_R));
    const h = ROOM / 2;
    for (const r of rooms.values()) {
      const p = r.group.position;
      b.expandByPoint(new THREE.Vector3(p.x - h, -0.5, p.z - h)).expandByPoint(new THREE.Vector3(p.x + h, WALL_H, p.z + h));
    }
    return b;
  }

  function resize() {
    const w = container.clientWidth || 1, h = container.clientHeight || 1;
    renderer.setSize(w, h, false);
    if (composer) composer.setSize(w, h);
    if (!userMoved) fit(); else updateCamera();
  }

  function fit() {
    const w = container.clientWidth || 1, h = container.clientHeight || 1, aspect = w / h;
    const b = bounds(), c = b.getCenter(new THREE.Vector3());
    // project the box corners on the camera's right/up axes to get the needed half extents
    camera.position.copy(c).addScaledVector(DIR, 100); camera.lookAt(c); camera.updateMatrixWorld();
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0), up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
    // Extents over the real corners (rooms + hub), not the AABB: the AABB of a ring of rooms is much bigger in iso.
    const pts = [];
    for (const r of rooms.values()) {
      const p = r.group.position, hr = ROOM / 2;
      for (const sx of [-hr, hr]) for (const sz of [-hr, hr]) for (const y of [-0.5, WALL_H]) pts.push(new THREE.Vector3(p.x + sx, y, p.z + sz));
    }
    for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(a) * HUB_R, 0, Math.sin(a) * HUB_R)); }
    const sc0 = new THREE.Vector2(Infinity, Infinity), sc1 = new THREE.Vector2(-Infinity, -Infinity);
    for (const v of pts) { const d = v.clone().sub(c), sx = d.dot(right), sy = d.dot(up); sc0.min(new THREE.Vector2(sx, sy)); sc1.max(new THREE.Vector2(sx, sy)); }
    const hx = (sc1.x - sc0.x) / 2, hy = (sc1.y - sc0.y) / 2;
    // re-centre on the screen-space middle of those corners
    c.addScaledVector(right, (sc0.x + sc1.x) / 2).addScaledVector(up, (sc0.y + sc1.y) / 2);
    // Fit into the free area between the UI bars (opts.insets: px), leaving headroom for the labels.
    const ins = insets(), fh = Math.max(80, h - ins.top - ins.bottom), fw = Math.max(80, w - ins.left - ins.right);
    fitted = Math.max(hy * 1.04 * (h / fh), (hx * 1.04 / aspect) * (w / fw));
    // move c along the view direction down to the ground so panning/zoom stay ground-anchored
    target.copy(c).addScaledVector(DIR, -c.y / DIR.y);
    zoom = 1; userMoved = false;
    updateCamera();
  }

  function updateCamera() {
    const w = container.clientWidth || 1, h = container.clientHeight || 1, aspect = w / h;
    const half = fitted / zoom;
    camera.left = -half * aspect; camera.right = half * aspect; camera.top = half; camera.bottom = -half;
    // Centre the target in the free area, not the whole canvas (the top bar and labels take space).
    const ins = insets(), perPx = (2 * half) / h;
    camera.position.copy(target).addScaledVector(DIR, 100); camera.lookAt(target); camera.updateMatrixWorld();
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0), up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
    const shift = new THREE.Vector3().addScaledVector(up, ((ins.top - ins.bottom) / 2) * perPx).addScaledVector(right, -((ins.left - ins.right) / 2) * perPx);
    const look = target.clone().add(shift);
    camera.position.copy(look).addScaledVector(DIR, 100); camera.lookAt(look);
    camera.updateProjectionMatrix(); camera.updateMatrixWorld();
  }

  // ---------- input: drag to pan, wheel / pinch to zoom, tap to select ----------
  const el = renderer.domElement;
  el.style.touchAction = 'none';
  const pointers = new Map();
  let downAt = null, pinch0 = 0, zoom0 = 1, moved = 0;
  const raycaster = new THREE.Raycaster(), ndc = new THREE.Vector2();
  const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  function groundAt(x, y) {
    const r = el.getBoundingClientRect(), p = new THREE.Vector3();
    ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    return raycaster.ray.intersectPlane(ground, p) ? p : null;
  }
  /** Drag: the ground point under the finger stays under the finger. */
  function panBy(x, y, px, py) {
    const a = groundAt(px, py), b = groundAt(x, y);
    if (!a || !b) return;
    target.add(a.sub(b)); target.y = 0;
    userMoved = true; updateCamera();
  }
  function setZoom(z) { zoom = Math.min(4, Math.max(0.6, z)); userMoved = true; updateCamera(); }
  el.addEventListener('pointerdown', e => {
    el.setPointerCapture(e.pointerId); pointers.set(e.pointerId, [e.clientX, e.clientY]);
    if (pointers.size === 1) { downAt = [e.clientX, e.clientY, performance.now()]; moved = 0; }
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch0 = Math.hypot(a[0] - b[0], a[1] - b[1]); zoom0 = zoom; }
  });
  el.addEventListener('pointermove', e => {
    if (!pointers.has(e.pointerId)) return;
    const prev = pointers.get(e.pointerId); pointers.set(e.pointerId, [e.clientX, e.clientY]);
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; const d = Math.hypot(a[0] - b[0], a[1] - b[1]); if (pinch0 > 0) setZoom(zoom0 * (d / pinch0)); moved += 99; return; }
    const dx = e.clientX - prev[0], dy = e.clientY - prev[1]; moved += Math.abs(dx) + Math.abs(dy);
    if (moved > 6) panBy(e.clientX, e.clientY, prev[0], prev[1]);
  });
  const up = e => {
    const wasTap = pointers.size === 1 && downAt && moved <= 6 && performance.now() - downAt[2] < 600;
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch0 = 0;
    if (wasTap) pick(e.clientX, e.clientY);
  };
  el.addEventListener('pointerup', up); el.addEventListener('pointercancel', e => { pointers.delete(e.pointerId); });
  el.addEventListener('wheel', e => { e.preventDefault(); setZoom(zoom * Math.exp(-e.deltaY * 0.0015)); }, { passive: false });
  function pick(x, y) {
    const r = el.getBoundingClientRect();
    ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects([...rooms.values()].map(v => v.group), true);
    const id = hits.length ? hits[0].object.userData.agentId : null;
    if (opts.onSelect) opts.onSelect(id || null);
  }

  // ---------- data ----------
  function update(state) {
    const ids = state.agents.map(a => a.id);
    let changed = ids.length !== order.length || ids.some((id, i) => id !== order[i]);
    for (const a of state.agents) {
      let r = rooms.get(a.id);
      if (!r) {
        const group = buildRoom(a); scene.add(group);
        const light = new THREE.PointLight(0xffd9a0, 9, 9, 1.8); scene.add(light);
        r = { group, light, agent: a }; rooms.set(a.id, r); changed = true;
      }
      r.agent = a;
      const p = r.group.userData.parts;
      drawChart(p.chart, a.name, (a.spark && a.spark.toolCalls) || [], p.color);
    }
    for (const id of [...rooms.keys()]) if (!ids.includes(id)) {
      const r = rooms.get(id); scene.remove(r.group); scene.remove(r.light); if (r.link) scene.remove(r.link); rooms.delete(id); changed = true;
    }
    if (changed) { layout(ids); applyShadows(); }
  }

  /** Screen positions for the HTML label cards. */
  function project() {
    const out = {}, w = el.clientWidth, h = el.clientHeight, v = new THREE.Vector3();
    for (const [id, r] of rooms) {
      v.set(r.group.position.x - 1.2, WALL_H + 1.2, r.group.position.z - 1.2).project(camera);
      out[id] = { x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * h };
    }
    v.set(HUB_R * 0.75, 0, HUB_R * 0.75).project(camera);          // under the hub's front edge
    out.__brain = { x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * h };
    return out;
  }

  // ---------- animation ----------
  let raf = 0, last = 0, running = true;
  const clock = new THREE.Clock();
  function animate(now) {
    raf = requestAnimationFrame(animate);
    if (!running) return;
    if (lite && now - last < 33) return;          // ~30 fps in lite mode
    last = now;
    const t = clock.getElapsedTime();
    const b = brain.userData;
    b.rings.forEach((r, i) => { r.rotation.z = t * (0.15 + i * 0.12) * (i % 2 ? -1 : 1); });
    b.core.rotation.y = t * 0.4; b.shell.rotation.y = -t * 0.25; b.shell.rotation.x = t * 0.1;
    b.core.position.y = b.shell.position.y = 2.2 + Math.sin(t * 1.4) * 0.12;
    b.beamM.opacity = 0.13 + Math.sin(t * 2) * 0.04;
    for (const r of rooms.values()) {
      const st = r.agent.status, p = r.group.userData.parts, ud = p.person.userData;
      const working = st === 'working', waiting = st === 'waiting', off = st === 'offline';
      const k = working ? 1 : waiting ? 0.7 : off ? 0.08 : 0.35;
      for (const d of p.desks.slice(0, 1)) for (const s of d.monitors) s.material.emissiveIntensity = 0.25 + k * (0.85 + (working ? Math.sin(t * 9 + ud.phase) * 0.08 : 0));
      for (const d of p.desks.slice(1)) for (const s of d.monitors) s.material.emissiveIntensity = 0.12;
      p.chartM.emissiveIntensity = 0.35 + k * 0.6;
      p.lamp.userData.shade.emissiveIntensity = off ? 0.1 : 0.8 + k * 0.9;
      r.light.intensity = off ? 0 : 4 + k * 7;
      // character: typing / leaning back / looking around
      ud.torso.rotation.x = working ? -0.08 : waiting ? 0 : 0.18;
      ud.arms.forEach((a, i) => { a.rotation.x = working ? Math.sin(t * 16 + i * 2 + ud.phase) * 0.12 : waiting ? 0.1 : 0.5; });
      ud.head.rotation.y = waiting ? Math.sin(t * 1.3 + ud.phase) * 0.5 : working ? Math.sin(t * 0.7 + ud.phase) * 0.08 : 0.15;
      ud.head.rotation.x = working ? Math.sin(t * 2.2 + ud.phase) * 0.05 : 0;
      // status ring under the lead
      p.ringM.color.set(working ? 0x46e08a : waiting ? 0xffc04d : 0x8a94b0);
      p.ringM.opacity = working ? 0.55 + Math.sin(t * 3) * 0.25 : waiting ? 0.5 + Math.sin(t * 5) * 0.3 : 0.12;
      p.ring.scale.setScalar(1 + (working ? (t * 0.6) % 0.25 : 0));
      // walkway dots and the pulse on the light line run while the agent works
      const L = r.link.userData;
      L.dots.forEach((d, i) => { d.visible = working || waiting; d.position.x = L.start + ((((t * (working ? 0.35 : 0.12)) + i / L.dots.length) % 1) * L.len); });
      L.pulse.visible = working || waiting;
      if (L.pulse.visible) L.pulse.position.copy(L.curve.getPoint((t * (working ? 0.45 : 0.2) + r.angle) % 1));
      L.lineM.opacity = (working ? 0.6 : waiting ? 0.45 : 0.2) * (selected && selected !== r.agent.id ? 0.5 : 1);
      L.edgeM.opacity = working ? 0.9 : 0.4;
      // selected room lifts slightly
      const lift = selected === r.agent.id ? 0.35 : 0;
      r.group.position.y += (lift - r.group.position.y) * 0.15;
    }
    if (composer) composer.render(); else renderer.render(scene, camera);
    if (opts.onFrame) opts.onFrame();
  }
  const ro = new ResizeObserver(resize); ro.observe(container);
  const onVis = () => { running = !document.hidden; };
  document.addEventListener('visibilitychange', onVis);
  resize(); applyShadows();
  raf = requestAnimationFrame(animate);

  return {
    update, project, fit,
    select(id) { selected = id; },
    zoom(k) { setZoom(zoom * k); },
    setLite(b) { lite = !!b; applyShadows(); },
    focus(id) {
      const r = rooms.get(id); if (!r) return;
      const narrow = (container.clientWidth || 1000) < 560;
      target.set(r.group.position.x, 0, r.group.position.z); zoom = Math.max(zoom, narrow ? 1.25 : 1.7); userMoved = true; updateCamera();
    },
    dispose() {
      cancelAnimationFrame(raf); ro.disconnect(); document.removeEventListener('visibilitychange', onVis);
      renderer.dispose(); el.remove();
      scene.traverse(o => { if (o.geometry) o.geometry.dispose(); });
    },
  };
}
