// Pure view-model for the Deck office scene: no React, no DOM (unit-tested in test/office-model.test.js).
// Status comes only from agents-model.js statusOf, so the scene can never disagree with the Agents grid.
import { statusOf } from './agents-model.js';
import { speechText } from './deck-model.js';

/** Where the dashboard serves plugin/agent-office/dashboard/office/ from. */
export const OFFICE_BASE = '/dashboard-plugins/agent-office/office';

/**
 * Shipped office art: file name -> native pixel size. Measured from the WebP headers (the test re-reads
 * each file and checks these). Nothing is loaded just to size a box.
 */
export const SPRITES = {
  'char-claude.webp': { width: 54, height: 110 },
  'char-frontend.webp': { width: 50, height: 105 },
  'char-me.webp': { width: 56, height: 128 },
  'char-dev.webp': { width: 38, height: 107 },
  'char-employee.webp': { width: 54, height: 110 },
  'char-explore.webp': { width: 46, height: 128 },
  'char-security.webp': { width: 46, height: 127 },
  'desk.webp': { width: 145, height: 182 },
  'coffee-off.webp': { width: 74, height: 94 },
  'whiteboard.webp': { width: 187, height: 249 },
  'plant.webp': { width: 98, height: 140 },
};

// Profile id -> character set (deck-office-scene.md section 3). Ash's profile id is 'default' (collect.py NAMES).
const ALIAS = new Map([['default', 'ash']]);
const SPRITE_BY_ID = new Map([
  ['ash', 'char-claude.webp'],
  ['dev', 'char-dev.webp'],
  ['red', 'char-explore.webp'],
  ['nova', 'char-frontend.webp'],
  ['pixel', 'char-me.webp'],
  ['sentinel', 'char-security.webp'],
  ['prism', 'char-employee.webp'],
]);
const FALLBACK_SPRITE = 'char-employee.webp';

// Stable seating order; unknown ids come after these, alphabetically.
const KNOWN_ORDER = ['ash', 'dev', 'red', 'nova', 'pixel', 'sentinel', 'prism'];
const KNOWN_RANK = new Map(KNOWN_ORDER.map((id, i) => [id, i]));

// Same palette and hash as collect.py accent(): crc32(id) % 8. Keep in step with collect.py.
const PALETTE = ['#7EA8FF', '#5BE38B', '#FFB347', '#C792FF', '#FF6B8A', '#4FE0D2', '#F5E663', '#FF8A5C'];

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const GLOW = { running: 1, idle: 0.45, error: 0.3, waiting: 1 };
const WORD = { running: 'running', waiting: 'waiting', error: 'error', idle: 'idle' };

// Rows of at most four desks. Columns sit inside the 10%..88% band (door left, coffee right) so a 44 px hit
// box never clips either. Rows are spread so they stay >= 25.8% (44 px at 171 px) apart up to three rows.
const COLS = { 1: [50], 2: [34, 66], 3: [18, 49, 80], 4: [18, 38.7, 59.3, 80] };
const ROW_CAP = 4;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(str) {
  let c = 0xffffffff;
  for (const b of new TextEncoder().encode(str)) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const canon = id => {
  const s = typeof id === 'string' ? id.toLowerCase() : '';
  return ALIAS.get(s) || s;
};

/** Sprite file for a profile id; unknown or missing ids use the employee set. */
export function spriteFor(agentId) {
  return SPRITE_BY_ID.get(canon(agentId)) || FALLBACK_SPRITE;
}

function parseHex(hex) {
  if (typeof hex !== 'string') return null;
  const m = HEX.exec(hex.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split('').map(ch => ch + ch).join('');
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
}

/** Deterministic palette colour for an id (same as collect.py accent()'s hash), as '#RRGGBB'. */
export function hashedColour(id) {
  return PALETTE[crc32(id == null ? '' : String(id)) % PALETTE.length];
}

/** 'r,g,b' for a '#rgb' or '#rrggbb' colour; an invalid colour falls back to hashedColour(fallbackId). */
export function hexToRgb(hex, fallbackId = '') {
  const rgb = parseHex(hex) || parseHex(hashedColour(fallbackId));
  return rgb.join(',');
}

/** Agent colour as normalised '#RRGGBB': agent.color when valid, else the hashed colour for agent.id. */
export function colourOf(agent) {
  const a = agent || {};
  const rgb = parseHex(a.color);
  if (!rgb) return hashedColour(a.id);
  return '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
}

const idOf = x => (x && typeof x === 'object' ? x.id : x);

function rankOf(id) {
  const r = KNOWN_RANK.get(canon(id));
  return r === undefined ? Infinity : r;
}

function byOrder(a, b) {
  const ra = rankOf(a), rb = rankOf(b);
  if (ra !== rb) return ra < rb ? -1 : 1;
  if (ra < Infinity) return 0;
  return a < b ? -1 : a > b ? 1 : 0;
}

function uniqueIds(list) {
  const seen = new Set();
  const ids = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const id = idOf(raw);
    if (typeof id !== 'string' && typeof id !== 'number') continue;
    const s = String(id);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    ids.push(s);
  }
  return ids.sort(byOrder);
}

function rowYs(n) {
  if (n === 0) return [];
  if (n === 1) return [50];
  if (n === 2) return [30, 72];
  // Three rows: 22, 53, 84 (31% apart). More than three rows (more than 12 agents) cannot keep 25.8% apart.
  return Array.from({ length: n }, (_, i) => Math.round((22 + (i * 62) / (n - 1)) * 10) / 10);
}

/**
 * Desk positions for the agents, as {id, x, y} in percent of the room (x of width, y of height).
 * Order is stable (ash, dev, red, nova, pixel, sentinel, prism, then the rest alphabetically); rows hold
 * four desks, so seven agents are 4 + 3. Duplicate and empty ids are dropped. Accepts ids or agent objects.
 */
export function layout(agentIds) {
  const ids = uniqueIds(agentIds);
  const rows = [];
  for (let i = 0; i < ids.length; i += ROW_CAP) rows.push(ids.slice(i, i + ROW_CAP));
  const ys = rowYs(rows.length);
  const out = [];
  rows.forEach((row, r) => {
    const xs = COLS[row.length];
    row.forEach((id, i) => out.push({ id, x: xs[i], y: ys[r] }));
  });
  return out;
}

/**
 * What the scene shows for one agent. status is statusOf(agent), so it matches the Agents grid.
 * present is false when the /state row is offline (status 'offline' or activity 'no data'), or there is no agent.
 * pose: 'stand' only while waiting. screen: lit | dim | error | off. glow: 1 running, .45 idle, .3 error,
 * 1 waiting, 0 offline. ring and bang: waiting only. label: aria text, e.g. 'Nova, waiting: <reason>'.
 */
export function sceneFor(agent) {
  const a = agent || {};
  const status = statusOf(agent);
  const present = agent != null && a.status !== 'offline' && a.activity !== 'no data';
  const name = agent == null ? 'Agent' : a.name || a.id || 'Agent';
  if (!present) {
    return { status, present: false, pose: 'sit', screen: 'off', glow: 0, ring: false, bang: false, label: `${name}, no data` };
  }
  const reason = speechText(a.activity).trim();
  const suffix = reason && reason.toLowerCase() !== 'idle' ? `: ${reason}` : '';
  const waiting = status === 'waiting';
  const screen = status === 'running' ? 'lit' : status === 'error' ? 'error' : 'dim';
  return {
    status,
    present: true,
    pose: waiting ? 'stand' : 'sit',
    screen,
    glow: GLOW[status],
    ring: waiting,
    bang: waiting,
    label: `${name}, ${WORD[status]}${suffix}`,
  };
}

/**
 * One entry per unique agent, in layout order: {id, x, y, sprite, color, rgb, ...sceneFor(agent)}.
 * Offline agents stay in the list (present false) so their desk shows as empty.
 */
export function sceneModel(agents) {
  const list = Array.isArray(agents) ? agents : [];
  const byId = new Map();
  for (const a of list) {
    const id = idOf(a);
    if ((typeof id === 'string' || typeof id === 'number') && !byId.has(String(id))) byId.set(String(id), a);
  }
  return layout(list).map(pt => {
    const agent = byId.get(pt.id);
    const color = colourOf(agent || { id: pt.id });
    return { id: pt.id, x: pt.x, y: pt.y, sprite: spriteFor(pt.id), color, rgb: hexToRgb(color), ...sceneFor(agent) };
  });
}
