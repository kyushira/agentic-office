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
  const spots = [[0.7, 0.9, 0], [-1.9, -1.5, Math.PI / 2], [2.6, -1.3, 0], [-1.6, 2.9, 0], [3.1, 1.7, -Math.PI / 2]];
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
  // Spare desks: a helper beams in here inside a light column with a floor ring (hidden until used).
  const spares = desks.slice(1).map((d, i) => {
    const seat = new THREE.Group(); seat.position.set(0, 0, 0.78); d.group.add(seat);
    const person = makeCharacter(agent.id + '-sub' + i); person.scale.setScalar(1.25); person.visible = false; seat.add(person);
    const colM = glow(shade(color, 0.45), 0); colM.opacity = 0;
    colM.transparent = true; colM.depthWrite = false; colM.blending = THREE.AdditiveBlending;
    const column = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.85, 4.2, 28, 1, true), colM); column.position.y = 2.1; column.visible = false; seat.add(column);
    const ringM2 = glow(shade(color, 0.6), 0); ringM2.transparent = true; ringM2.depthWrite = false; ringM2.blending = THREE.AdditiveBlending;
    const fr = new THREE.Mesh(new THREE.RingGeometry(0.78, 0.95, 40), ringM2); fr.rotation.x = -Math.PI / 2; fr.position.y = 0.03; fr.visible = false; seat.add(fr);
    for (const s of d.monitors) s.material.emissiveIntensity = 0.1;
    return { seat, person, column, colM, ring: fr, ringM: ringM2, state: 0, target: 0, helperId: null, monitors: d.monitors };
  });
  g.userData.parts = { chart, chartM: scrM, desks, person, lamp, ringM, ring, color, spares };
  g.traverse(o => { o.userData.agentId = agent.id; });
  return g;
}

// ---------- the Brain ----------
const glow = (color, opacity = 1) => new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity, depthWrite: opacity >= 1, blending: opacity < 1 ? THREE.AdditiveBlending : THREE.NormalBlending, side: THREE.DoubleSide });
const CORE_Y = 2.6;

/** THE BRAIN (ref 05): dark round platform with a raised dais, 3 concentric glowing cyan rings,
 *  a soft core inside a cage of orbit rings, a vertical light beam and rising particles. */
function buildBrain() {
  const g = new THREE.Group();
  const base = cyl(HUB_R + 0.25, HUB_R + 0.45, 0.5, mat(0x111833, { metal: 0.55, rough: 0.35 }), 72); base.position.y = -0.25; g.add(base);
  const top = new THREE.Mesh(new THREE.CircleGeometry(HUB_R + 0.2, 72), mat(0x0c1229, { metal: 0.6, rough: 0.28 }));
  top.rotation.x = -Math.PI / 2; top.position.y = 0.005; top.receiveShadow = true; g.add(top);
  const dais = cyl(HUB_R * 0.58, HUB_R * 0.62, 0.32, mat(0x141d3d, { metal: 0.6, rough: 0.25 }), 64); dais.position.y = 0.16; g.add(dais);
  // the three bright concentric rings (bloom picks them up)
  const ringMs = [];
  for (const [r, t, y] of [[HUB_R + 0.12, 0.075, 0.02], [HUB_R * 0.8, 0.05, 0.02], [HUB_R * 0.6, 0.06, 0.33]]) {
    const m = glow(0x7fe6ff); ringMs.push(m);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(r, t, 8, 112), m); ring.rotation.x = Math.PI / 2; ring.position.y = y; g.add(ring);
  }
  // faint swirl arcs on the floor
  const rings = [];
  for (const [r, w, o, len] of [[HUB_R * 0.92, 0.05, 0.45, 1.3], [HUB_R * 0.7, 0.04, 0.35, 1.1], [HUB_R * 0.42, 0.04, 0.5, 1.5]]) {
    const ring = new THREE.Mesh(new THREE.RingGeometry(r - w, r, 96, 1, 0, Math.PI * len), glow(0x5fd8ff, o));
    ring.rotation.x = -Math.PI / 2; ring.position.y = r < HUB_R * 0.6 ? 0.335 : 0.03; g.add(ring); rings.push(ring);
  }
  // soft glowing core + halo
  const core = new THREE.Mesh(new THREE.SphereGeometry(0.85, 32, 20), new THREE.MeshStandardMaterial({ color: 0xc9f3ff, emissive: 0x4fc8f0, emissiveIntensity: 0.75, roughness: 0.35 }));
  core.position.y = CORE_Y; g.add(core);
  const halo = new THREE.Mesh(new THREE.SphereGeometry(1.25, 24, 16), glow(0x5fd8ff, 0.06)); halo.position.y = CORE_Y; g.add(halo);
  // cage of thin orbit rings
  const cage = new THREE.Group(); cage.position.y = CORE_Y; g.add(cage);
  const orbitM = glow(0xbff0ff, 0.55);
  for (let i = 0; i < 6; i++) {
    const o = new THREE.Mesh(new THREE.TorusGeometry(1.75 + (i % 2) * 0.12, 0.012, 4, 96), orbitM);
    o.rotation.set((i * Math.PI) / 6, (i * Math.PI) / 3.3, i * 0.4); cage.add(o);
  }
  const eq = new THREE.Mesh(new THREE.TorusGeometry(2.05, 0.02, 4, 120), glow(0xdff8ff, 0.8)); eq.rotation.x = Math.PI / 2 + 0.25; cage.add(eq);
  // vertical light beam
  const beamM = glow(0x7fe6ff, 0.1);
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.5, 12, 24, 1, true), beamM); beam.position.y = 6; g.add(beam);
  const beamCore = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.14, 12, 12, 1, true), glow(0xe8fbff, 0.22)); beamCore.position.y = 6; g.add(beamCore);
  // rising particles (fixed count, positions animated in place)
  const N = 140, pos = new Float32Array(N * 3), seed = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const a = Math.random() * Math.PI * 2, r = 0.6 + Math.sqrt(Math.random()) * (HUB_R - 0.6);
    pos[i * 3] = Math.cos(a) * r; pos[i * 3 + 1] = Math.random() * 5; pos[i * 3 + 2] = Math.sin(a) * r; seed[i] = 0.25 + Math.random() * 0.6;
  }
  const pg = new THREE.BufferGeometry(); pg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const particles = new THREE.Points(pg, new THREE.PointsMaterial({ color: 0xbff0ff, size: 2.4, sizeAttenuation: false, transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending }));
  g.add(particles);
  g.userData = { rings, core, cage, halo, beamM, particles, pseed: seed, ringMs };
  return g;
}

/** Standing low-poly character holding a tablet (for Brain trips). Faces +x. */
function makeWalker(seed) {
  const g = new THREE.Group();
  const skin = mat(SKIN[hashN(seed + 's', SKIN.length)], { rough: 0.6 });
  const shirt = mat(SHIRT[hashN(seed + 'c', SHIRT.length)], { rough: 0.7 }), pants = mat(0x2c3550), hair = mat(HAIR[hashN(seed + 'h', HAIR.length)], { rough: 0.8 });
  const legs = [];
  for (const s of [-1, 1]) {
    const hip = new THREE.Group(); hip.position.set(0, 0.62, 0.11 * s); g.add(hip);
    hip.add(box(0.15, 0.6, 0.15, pants, 0, -0.3, 0));
    hip.add(box(0.24, 0.08, 0.16, mat(0x1d2028), 0.04, -0.6, 0));
    legs.push(hip);
  }
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.34, 6, 12), shirt); body.position.y = 0.98; body.castShadow = true; g.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 18, 12), skin); head.position.y = 1.5; head.castShadow = true; g.add(head);
  const hm = new THREE.Mesh(new THREE.SphereGeometry(0.235, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), hair); hm.position.set(-0.02, 1.53, 0); hm.rotation.z = 0.3; g.add(hm);
  for (const s of [-1, 1]) {   // forearms forward, holding the tablet
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.065, 0.32, 4, 8), shirt); arm.rotation.z = Math.PI / 2.3; arm.position.set(0.17, 0.95, 0.2 * s); g.add(arm);
  }
  const tab = box(0.06, 0.34, 0.46, mat(0x1d2028), 0.36, 1.02, 0); tab.rotation.z = -0.5; g.add(tab);
  const scr = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.27, 0.38), glow(0x7fe6ff)); scr.position.set(0.39, 1.035, 0); scr.rotation.z = -0.5; g.add(scr);
  g.userData = { legs };
  g.scale.setScalar(1.15);
  return g;
}

// ---------- walkway + light line ----------
/** Dark walkway (dashed centre line, small glowing markers in the room colour) from the Brain to a
 *  room, plus a curved light line in the room colour with orbs travelling along it. Built in a local
 *  frame where +x points from the hub to the room; `path` holds the walkers too. */
function buildLink(angle, radius, color) {
  const g = new THREE.Group();
  const edge = (ROOM / 2) / Math.max(Math.abs(Math.cos(angle)), Math.abs(Math.sin(angle)));
  const start = HUB_R + 0.35, end = radius - edge + 0.1, len = Math.max(0.5, end - start);
  const path = new THREE.Group(); path.rotation.y = -angle; g.add(path);
  path.add(box(len, 0.18, 1.7, mat(0x161c30, { rough: 0.55, metal: 0.25 }), start + len / 2, -0.11, 0));
  const dashM = new THREE.MeshBasicMaterial({ color: 0xdfe6ff });
  for (let x = start + 0.25; x < end - 0.2; x += 0.62) path.add(box(0.3, 0.02, 0.06, dashM, x + 0.15, -0.01, 0));
  const edgeM = glow(shade(color, 0.35), 0.9);
  const markers = [];
  for (let x = start + 0.4, i = 0; x < end - 0.2; x += 1.1, i++) {
    for (const z of [-0.7, 0.7]) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.14, 0.14), edgeM);
      m.position.set(x + (z > 0 ? 0.55 : 0), 0.08, z); m.rotation.y = 0.6; path.add(m); markers.push(m);
    }
  }
  // curved light line from the Brain core, low over the walkway, into the room
  const a = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
  const p0 = new THREE.Vector3(0, CORE_Y, 0).addScaledVector(a, 1.2);
  const p3 = a.clone().multiplyScalar(radius - ROOM * 0.25).setY(2.2);
  const side = new THREE.Vector3(-a.z, 0, a.x).multiplyScalar(1.6);
  const curve = new THREE.CubicBezierCurve3(p0, a.clone().multiplyScalar(radius * 0.35).add(side).setY(4.2), a.clone().multiplyScalar(radius * 0.7).sub(side).setY(3.6), p3);
  const lineM = glow(shade(color, 0.2), 0.6);
  g.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 64, 0.045, 6), lineM));
  const orbs = [];
  for (let i = 0; i < 3; i++) {
    const o = new THREE.Mesh(new THREE.SphereGeometry(0.15, 12, 8), glow(shade(color, 0.6)));
    g.add(o); orbs.push(o);
  }
  g.userData = { start, len, end, curve, orbs, lineM, edgeM, markers, path, walkers: [] };
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
    composer.addPass(new UnrealBloomPass(new THREE.Vector2(256, 256), 0.6, 0.45, 0.86));
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

  const SR = new THREE.Vector3(1, 0, -1).normalize(), SU = new THREE.Vector3(-1, 0, -1).normalize();   // screen right / screen up, on the ground
  let portrait = false;

  /** Room centres on a ring; in portrait the ring is squeezed sideways and stretched vertically (in
   *  screen terms) as far as it goes without rooms touching each other or the Brain. */
  function positions(n, squeeze) {
    const radius = Math.max(14.6, n > 1 ? 7.4 / Math.sin(Math.PI / n) : 14.6);
    const base = [];
    for (let i = 0; i < n; i++) {
      const angle = (-3 * Math.PI) / 4 + (i * 2 * Math.PI) / n;   // first room at the back, the rest clockwise
      base.push(new THREE.Vector3(Math.cos(angle) * radius, 0, Math.sin(angle) * radius));
    }
    if (!squeeze || n < 2) return base;
    // Phone portrait, 3 rooms: a vertical composition. Lead room on top, the other two stepped below the
    // Brain (offset sideways by less than a room width, but far enough apart along a world axis that
    // their floors never meet), so the scene is ~35% bigger than a squeezed ring.
    if (n === 3) {
      const at = (sr, su) => new THREE.Vector3().addScaledVector(SR, sr).addScaledVector(SU, su);
      return [at(0, 15.5), at(4.6, -18.5), at(-4.6, -12)];
    }
    const ok = ps => ps.every((p, i) => Math.hypot(p.x, p.z) - ROOM * 0.72 > HUB_R + 0.6 &&
      ps.every((q, j) => j <= i || Math.abs(p.x - q.x) > ROOM + 0.8 || Math.abs(p.z - q.z) > ROOM + 0.8));
    for (let kx = 0.55; kx < 1; kx += 0.05) {
      const ps = base.map(p => new THREE.Vector3().addScaledVector(SR, p.dot(SR) * kx).addScaledVector(SU, p.dot(SU) * 1.2));
      if (ok(ps)) return ps;
    }
    return base;
  }

  function layout(ids) {
    const ps = positions(Math.max(1, ids.length), portrait);
    ids.forEach((id, i) => {
      const r = rooms.get(id), p = ps[i];
      const angle = Math.atan2(p.z, p.x), radius = Math.hypot(p.x, p.z);
      r.angle = angle; r.radius = radius;
      r.group.position.copy(p);
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
    const p = w / h < 0.8;
    if (p !== portrait) { portrait = p; if (order.length) { layout(order); return; } }
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
    // (portrait: let the outermost floor corners graze the screen edge so the rooms come out bigger)
    fitted = Math.max(hy * 1.04 * (h / fh), (hx * (portrait ? 0.96 : 1.04) / aspect) * (w / fw));
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
      // Helpers keep their desk while they run; new ones take a free desk; finished ones fade out.
      const ids = (a.helpers || []).map(h => h.id);
      for (const s of p.spares) if (s.helperId && !ids.includes(s.helperId)) { s.target = 0; s.helperId = null; }
      for (const h of a.helpers || []) {
        if (p.spares.some(s => s.helperId === h.id)) continue;
        const free = p.spares.find(s => !s.helperId && s.state < 0.05) || p.spares.find(s => !s.helperId);
        if (free) { free.helperId = h.id; free.target = 1; }
      }
    }
    for (const id of [...rooms.keys()]) if (!ids.includes(id)) {
      const r = rooms.get(id); scene.remove(r.group); scene.remove(r.light); if (r.link) scene.remove(r.link); rooms.delete(id); changed = true;
    }
    if (changed) { layout(ids); applyShadows(); }
  }

  const toPx = (v, w, h) => ({ x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * h });

  /** Screen anchors for the HTML overlay. Room cards sit just outside the room's screen box on the
   *  side facing away from the Brain (side: above/below/left/right), so they never cover a room's
   *  floor or the walkways. Helper tags float above their desks. */
  function project() {
    const out = { __helpers: {} }, w = el.clientWidth, h = el.clientHeight, v = new THREE.Vector3();
    const hub = toPx(v.set(0, 0, 0).project(camera), w, h);
    for (const [id, r] of rooms) {
      const p = r.group.position, hr = ROOM / 2;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const sx of [-hr, hr]) for (const sz of [-hr, hr]) for (const y of [-0.5, WALL_H]) {
        const q = toPx(v.set(p.x + sx, y, p.z + sz).project(camera), w, h);
        x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y);
      }
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, dx = cx - hub.x, dy = cy - hub.y;
      const side = Math.abs(dx) > Math.abs(dy) * 1.6 ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'below' : 'above';
      out[id] = side === 'above' ? { x: cx, y: y0, side } : side === 'below' ? { x: cx, y: y1, side }
        : side === 'right' ? { x: x1, y: cy, side } : { x: x0, y: cy, side };
      out[id].box = { x0, y0, x1, y1 };
      r.group.updateMatrixWorld();
      for (const s of r.group.userData.parts.spares) {
        if (!s.helperId || s.state < 0.3) continue;
        s.seat.getWorldPosition(v); v.y += 2.9;
        out.__helpers[s.helperId] = toPx(v.project(camera), w, h);
      }
    }
    out.__brain = toPx(v.set(HUB_R * 0.74, 0, HUB_R * 0.74).project(camera), w, h);   // under the platform's front edge
    out.__brain.side = 'below';
    const hb = [toPx(v.set(-HUB_R, 0, -HUB_R).project(camera), w, h), toPx(v.set(HUB_R, 0, HUB_R).project(camera), w, h),
      toPx(v.set(HUB_R, 0, -HUB_R).project(camera), w, h), toPx(v.set(-HUB_R, 0, HUB_R).project(camera), w, h), toPx(v.set(0, CORE_Y + 2.2, 0).project(camera), w, h)];
    out.__hubBox = { x0: Math.min(...hb.map(q => q.x)), x1: Math.max(...hb.map(q => q.x)), y0: Math.min(...hb.map(q => q.y)), y1: Math.max(...hb.map(q => q.y)) };
    return out;
  }

  /** A character carries a tablet from the room to the Brain and back (memory / vault access). */
  function walk(agentId, kind) {
    const r = rooms.get(agentId); if (!r || !r.link) return;
    const L = r.link.userData;
    if (L.walkers.length >= 2) return;
    const wk = makeWalker(agentId + kind + L.walkers.length);
    const lane = L.walkers.length ? -0.38 : 0.38;
    wk.position.set(r.radius - 2.2, 0, lane); L.path.add(wk);
    L.walkers.push({ g: wk, t0: clock.getElapsedTime(), from: r.radius - 2.2, to: HUB_R + 0.9, lane });
  }

  /** Minimap data in screen-plane units: rooms, the Brain and the visible rectangle. */
  function mapData() {
    const sinT = DIR.y, half = fitted / zoom, aspect = (container.clientWidth || 1) / (container.clientHeight || 1);
    return {
      rooms: [...rooms.values()].map(r => ({ id: r.agent.id, color: COLORS[r.agent.color] ?? COLORS.blue, x: r.group.position.dot(SR), y: r.group.position.dot(SU), status: r.agent.status })),
      view: { x: target.dot(SR), y: target.dot(SU), w: half * aspect, h: half / sinT },
      size: ROOM, hub: HUB_R,
    };
  }
  function panTo(x, y) { target.set(0, 0, 0).addScaledVector(SR, x).addScaledVector(SU, y); userMoved = true; updateCamera(); }

  // ---------- animation ----------
  let raf = 0, last = 0, running = true;
  const clock = new THREE.Clock();
  function animate(now) {
    raf = requestAnimationFrame(animate);
    if (!running) return;
    if (lite && now - last < 33) return;          // ~30 fps in lite mode
    last = now;
    const t = clock.getElapsedTime();
    const dt = Math.min(0.1, t - (animate.lt ?? t)); animate.lt = t;
    const b = brain.userData;
    b.rings.forEach((r, i) => { r.rotation.z = t * (0.15 + i * 0.12) * (i % 2 ? -1 : 1); });
    b.cage.rotation.y = t * 0.22; b.cage.rotation.z = Math.sin(t * 0.3) * 0.08;
    const bob = Math.sin(t * 1.4) * 0.1;
    b.core.position.y = b.halo.position.y = CORE_Y + bob; b.cage.position.y = CORE_Y + bob;
    b.halo.scale.setScalar(1 + Math.sin(t * 2.1) * 0.06);
    b.beamM.opacity = 0.09 + Math.sin(t * 2) * 0.03;
    b.ringMs.forEach((m, i) => m.color.setHSL(0.53, 1, 0.68 + Math.sin(t * 1.6 + i * 1.3) * 0.08));
    if (!lite || (Math.floor(t * 30) % 2 === 0)) {        // particles drift upward (half rate in lite)
      const pa = b.particles.geometry.attributes.position, arr = pa.array;
      for (let i = 0; i < b.pseed.length; i++) { arr[i * 3 + 1] += b.pseed[i] * dt * (lite ? 2 : 1); if (arr[i * 3 + 1] > 5.5) arr[i * 3 + 1] = 0; }
      pa.needsUpdate = true;
    }
    for (const r of rooms.values()) {
      const st = r.agent.status, p = r.group.userData.parts, ud = p.person.userData;
      const working = st === 'working', waiting = st === 'waiting', off = st === 'offline';
      const k = working ? 1 : waiting ? 0.7 : off ? 0.08 : 0.35;
      for (const d of p.desks.slice(0, 1)) for (const s of d.monitors) s.material.emissiveIntensity = 0.25 + k * (0.85 + (working ? Math.sin(t * 9 + ud.phase) * 0.08 : 0));
      // helpers beaming in / out at the spare desks
      for (const s of p.spares) {
        s.state += Math.sign(s.target - s.state) * Math.min(Math.abs(s.target - s.state), dt * 1.1);
        const on = s.state > 0.01;
        s.person.visible = s.column.visible = s.ring.visible = on;
        if (!on) { for (const m of s.monitors) m.material.emissiveIntensity = 0.1; continue; }
        const e = s.state * s.state * (3 - 2 * s.state);
        s.person.scale.set(1.25, 1.25 * Math.max(0.02, e), 1.25);
        s.colM.opacity = 0.1 * e + 0.4 * Math.sin(Math.PI * Math.min(1, s.state)) * (s.target ? 1 : 0.8);
        s.ringM.opacity = 0.35 * e + 0.25 * Math.sin(t * 4 + s.seat.id) * e;
        s.ring.scale.setScalar(1 + ((t * 0.5) % 0.3) * e);
        const ud2 = s.person.userData;
        ud2.arms.forEach((a, i) => { a.rotation.x = Math.sin(t * 15 + i * 2 + ud2.phase) * 0.12 * e; });
        for (const m of s.monitors) m.material.emissiveIntensity = 0.1 + 0.9 * e;
      }
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
      const busy = working || waiting;
      L.orbs.forEach((o, i) => {
        o.visible = busy || i === 0;
        o.position.copy(L.curve.getPoint(((t * (working ? 0.22 : 0.08)) + i / L.orbs.length + r.angle) % 1));
      });
      L.lineM.opacity = (working ? 0.75 : waiting ? 0.55 : 0.3) * (selected && selected !== r.agent.id ? 0.5 : 1);
      L.edgeM.opacity = working ? 0.95 : 0.55;
      // tablet carriers: out to the Brain, a short stop, back to the room
      for (let i = L.walkers.length - 1; i >= 0; i--) {
        const wk = L.walkers[i], dist = wk.from - wk.to, walkT = dist / 1.5, age = t - wk.t0, total = walkT * 2 + 1.2;
        let x, dir;
        if (age < walkT) { x = wk.from - (age / walkT) * dist; dir = -1; }
        else if (age < walkT + 1.2) { x = wk.to; dir = 0; }
        else { x = wk.to + Math.min(1, (age - walkT - 1.2) / walkT) * dist; dir = 1; }
        wk.g.position.set(x, 0, wk.lane);
        wk.g.rotation.y = dir < 0 ? Math.PI : dir > 0 ? 0 : Math.PI;
        wk.g.userData.legs.forEach((leg, j) => { leg.rotation.z = dir ? Math.sin(age * 9 + j * Math.PI) * 0.45 : 0; });
        wk.g.position.y = dir ? Math.abs(Math.sin(age * 9)) * 0.05 : 0;
        if (age > total) { L.path.remove(wk.g); L.walkers.splice(i, 1); }
      }
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
    update, project, fit, walk, mapData, panTo,
    isPortrait: () => portrait,
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
