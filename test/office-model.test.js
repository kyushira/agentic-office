// Unit tests for src/office-model.js (run by `npm test` via node:test).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, existsSync } from 'node:fs';
import {
  OFFICE_BASE, SPRITES, spriteFor, hexToRgb, colourOf, layout, sceneFor, sceneModel,
} from '../src/office-model.js';
import { statusOf } from '../src/agents-model.js';

const ROOM_W = 342;   // px, the 360px phone case (deck-office-look.md section 1)
const ROOM_H = 171;
const HIT = 44;       // px, hit box side (deck-office-look.md section 6)
const OFFICE_DIR = new URL('../plugin/agent-office/dashboard/office/', import.meta.url);

const now = 1_800_000_000_000;
const sec = now / 1000;
const ag = (id, status, extra = {}) => ({ id, name: id[0].toUpperCase() + id.slice(1), status, activity: 'idle', lastActive: sec - 120, ...extra });

describe('spriteFor', () => {
  test('maps each of the seven profiles to its character set', () => {
    assert.equal(spriteFor('ash'), 'char-claude.webp');
    assert.equal(spriteFor('dev'), 'char-dev.webp');
    assert.equal(spriteFor('red'), 'char-explore.webp');
    assert.equal(spriteFor('nova'), 'char-frontend.webp');
    assert.equal(spriteFor('pixel'), 'char-me.webp');
    assert.equal(spriteFor('sentinel'), 'char-security.webp');
    assert.equal(spriteFor('prism'), 'char-employee.webp');
  });
  test("Ash's profile id 'default' (collect.py NAMES) uses the Ash set", () => {
    assert.equal(spriteFor('default'), 'char-claude.webp');
  });
  test('unknown ids and empty input use the employee set', () => {
    assert.equal(spriteFor('zed'), 'char-employee.webp');
    assert.equal(spriteFor(''), 'char-employee.webp');
    assert.equal(spriteFor(undefined), 'char-employee.webp');
  });
  test('every mapped file is listed in SPRITES', () => {
    for (const id of ['ash', 'dev', 'red', 'nova', 'pixel', 'sentinel', 'prism', 'zed']) {
      assert.ok(SPRITES[spriteFor(id)], `${id} -> ${spriteFor(id)}`);
    }
  });
  test('OFFICE_BASE is the dashboard path the office folder is served from', () => {
    assert.equal(OFFICE_BASE, '/dashboard-plugins/agent-office/office');
  });
});

describe('SPRITES dimensions match the shipped WebP files', () => {
  // Lossless WebP: RIFF....WEBPVP8L, then 0x2f, then 14-bit width-1 and height-1 (little-endian bit-packed).
  function webpSize(name) {
    const b = readFileSync(new URL(name, OFFICE_DIR));
    assert.equal(b.toString('ascii', 0, 4), 'RIFF');
    assert.equal(b.toString('ascii', 8, 12), 'WEBP');
    assert.equal(b.toString('ascii', 12, 16), 'VP8L');
    const bits = b.readUInt32LE(21);
    return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
  }
  for (const [name, dims] of Object.entries(SPRITES)) {
    test(`${name} is ${dims.width}x${dims.height}`, () => {
      assert.ok(existsSync(new URL(name, OFFICE_DIR)), 'file exists');
      const { w, h } = webpSize(name);
      assert.deepEqual({ width: dims.width, height: dims.height }, { width: w, height: h });
    });
  }
  test('total shipped office art is under 1.5 MB (aim < 400 KB)', () => {
    const total = Object.keys(SPRITES).reduce((n, f) => n + statSync(new URL(f, OFFICE_DIR)).size, 0);
    assert.ok(total < 1.5 * 1024 * 1024, `total ${total}`);
    assert.ok(total < 400 * 1024, `total ${total} (aim)`);
  });
  test('LICENSE and NOTICE.md ship with the art', () => {
    assert.ok(existsSync(new URL('LICENSE', OFFICE_DIR)));
    const notice = readFileSync(new URL('NOTICE.md', OFFICE_DIR), 'utf8');
    assert.match(notice, /W17ant\/Claude-Office/i);
    assert.match(notice, /MIT/);
    assert.match(notice, /office\//);   // the excluded Dunder Mifflin folder is named
  });
});

describe('hexToRgb and colour fallback', () => {
  test('six-digit hex becomes r,g,b', () => {
    assert.equal(hexToRgb('#6E9BFF'), '110,155,255');
    assert.equal(hexToRgb('#8b5cf6'), '139,92,246');
  });
  test('three-digit and bare hex are accepted', () => {
    assert.equal(hexToRgb('#fff'), '255,255,255');
    assert.equal(hexToRgb('#4FD983'), '79,217,131');
    assert.equal(hexToRgb('4FD983', 'zed'), '255,138,92');   // no '#': not a colour, so the fallback
  });
  test('invalid colour falls back to the hashed palette colour for the id (deterministic)', () => {
    // crc32('zed') % 8 == 7 -> #FF8A5C (same hash as collect.py accent())
    assert.equal(hexToRgb('nope', 'zed'), '255,138,92');
    assert.equal(hexToRgb(undefined, 'zed'), '255,138,92');
    assert.equal(hexToRgb('#12', 'zed'), '255,138,92');
    assert.equal(hexToRgb('nope', 'zed'), hexToRgb('nope', 'zed'));
  });
  test('empty id hashes to the first palette colour (crc32 0)', () => {
    assert.equal(hexToRgb('', ''), '126,168,255');
  });
  test('colourOf prefers a valid agent.color and never hardcodes accents', () => {
    assert.equal(colourOf({ id: 'dev', color: '#4fd983' }), '#4FD983');
    assert.equal(colourOf({ id: 'ash', color: 'bogus' }), '#FFB347');   // crc32('ash') % 8 == 2
    assert.equal(colourOf({ id: 'ash' }), '#FFB347');
    assert.equal(colourOf(null), '#7EA8FF');
  });
});

describe('layout', () => {
  test('seven agents: four in the top row, three in the second, in stable order', () => {
    const pts = layout(['prism', 'pixel', 'sentinel', 'ash', 'dev', 'red', 'nova']);
    assert.deepEqual(pts.map(p => p.id), ['ash', 'dev', 'red', 'nova', 'pixel', 'sentinel', 'prism']);
    const ys = [...new Set(pts.map(p => p.y))].sort((a, b) => a - b);
    assert.equal(ys.length, 2);
    assert.equal(pts.filter(p => p.y === ys[0]).length, 4);
    assert.equal(pts.filter(p => p.y === ys[1]).length, 3);
  });
  test('each point has numeric x and y percentages', () => {
    for (const p of layout(['ash'])) {
      assert.equal(typeof p.x, 'number');
      assert.equal(typeof p.y, 'number');
    }
  });
  test('unknown ids come after the known ones, alphabetically', () => {
    assert.deepEqual(layout(['zed', 'prism', 'abe', 'ash']).map(p => p.id), ['ash', 'prism', 'abe', 'zed']);
  });
  test('duplicate ids and empty ids are dropped', () => {
    assert.deepEqual(layout(['dev', 'dev', '', null]).map(p => p.id), ['dev']);
  });
  test('zero agents gives an empty layout; a missing list is safe', () => {
    assert.deepEqual(layout([]), []);
    assert.deepEqual(layout(undefined), []);
  });
  test('keeps the door (left 10%) and coffee corner (right 88%) clear, including hit boxes', () => {
    const halfW = (HIT / 2) / ROOM_W * 100;
    for (let n = 1; n <= 12; n++) {
      const ids = Array.from({ length: n }, (_, i) => `a${String(i).padStart(2, '0')}`);
      for (const p of layout(ids)) {
        assert.ok(p.x - halfW >= 10, `n=${n} x=${p.x} clips the door`);
        assert.ok(p.x + halfW <= 88, `n=${n} x=${p.x} clips the coffee corner`);
        assert.ok(p.y - (HIT / 2) / ROOM_H * 100 >= 0 && p.y + (HIT / 2) / ROOM_H * 100 <= 100, `n=${n} y=${p.y} off room`);
      }
    }
  });
  test('desks in one row are at least 44px apart (12.9% of 342px), rows at least 44px apart (25.8% of 171px)', () => {
    const minX = HIT / ROOM_W * 100;
    const minY = HIT / ROOM_H * 100;
    for (let n = 0; n <= 12; n++) {
      const ids = Array.from({ length: n }, (_, i) => `a${String(i).padStart(2, '0')}`);
      const pts = layout(ids);
      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
          const a = pts[i], b = pts[j];
          if (a.y === b.y) {
            assert.ok(Math.abs(a.x - b.x) >= minX, `n=${n} same row ${a.id}/${b.id} too close`);
          } else {
            assert.ok(Math.abs(a.y - b.y) >= minY, `n=${n} rows ${a.id}/${b.id} too close`);
          }
        }
      }
    }
  });
  test('zero to twelve agents all lay out with unique positions', () => {
    for (let n = 0; n <= 12; n++) {
      const ids = Array.from({ length: n }, (_, i) => `a${i}`);
      const pts = layout(ids);
      assert.equal(pts.length, n);
      assert.equal(new Set(pts.map(p => `${p.x},${p.y}`)).size, n, `n=${n}`);
    }
  });
  test('twelve agents fill three rows of four', () => {
    const pts = layout(['ash', 'dev', 'red', 'nova', 'pixel', 'sentinel', 'prism', 'a1', 'a2', 'a3', 'a4', 'a5']);
    assert.equal(new Set(pts.map(p => p.y)).size, 3);
  });
});

describe('sceneFor', () => {
  test('running: sits, lit screen, full glow, label with the activity', () => {
    const s = sceneFor(ag('nova', 'working', { activity: 'editing code' }));
    assert.equal(s.status, 'running');
    assert.equal(s.present, true);
    assert.equal(s.pose, 'sit');
    assert.equal(s.screen, 'lit');
    assert.equal(s.glow, 1);
    assert.equal(s.ring, false);
    assert.equal(s.bang, false);
    assert.equal(s.label, 'Nova, running: editing code');
  });
  test('idle: sits, dim screen, glow .45, label is just the status word', () => {
    const s = sceneFor(ag('dev', 'idle', { activity: 'idle' }));
    assert.equal(s.status, 'idle');
    assert.equal(s.present, true);
    assert.equal(s.pose, 'sit');
    assert.equal(s.screen, 'dim');
    assert.equal(s.glow, 0.45);
    assert.equal(s.label, 'Dev, idle');
  });
  test('waiting: stands, gold ring and bang, glow 1, label carries the reason', () => {
    const s = sceneFor(ag('nova', 'waiting', { activity: 'waiting for approval' }));
    assert.equal(s.status, 'waiting');
    assert.equal(s.pose, 'stand');
    assert.equal(s.ring, true);
    assert.equal(s.bang, true);
    assert.equal(s.glow, 1);
    assert.equal(s.present, true);
    assert.equal(s.label, 'Nova, waiting: waiting for approval');
  });
  test('error status: seated, error screen, glow .3, no ring', () => {
    const s = sceneFor(ag('red', 'failed', { activity: 'tool crashed' }));
    assert.equal(s.status, 'error');
    assert.equal(s.present, true);
    assert.equal(s.pose, 'sit');
    assert.equal(s.screen, 'error');
    assert.equal(s.glow, 0.3);
    assert.equal(s.ring, false);
    assert.equal(s.label, 'Red, error: tool crashed');
  });
  test('offline (no data): not present, no glow, screen off, label "no data"', () => {
    const s = sceneFor(ag('pixel', 'offline', { activity: 'no data' }));
    assert.equal(s.present, false);
    assert.equal(s.glow, 0);
    assert.equal(s.screen, 'off');
    assert.equal(s.ring, false);
    assert.equal(s.bang, false);
    assert.equal(s.label, 'Pixel, no data');
  });
  test('offline with an error (data unavailable): status still matches statusOf, but not present', () => {
    const a = ag('sentinel', 'offline', { activity: 'data unavailable', error: 'OperationalError' });
    const s = sceneFor(a);
    assert.equal(s.status, 'error');
    assert.equal(s.present, false);
    assert.equal(s.glow, 0);
    assert.equal(s.label, 'Sentinel, no data');
  });
  test('missing agent: not present, status idle, label names no one', () => {
    const s = sceneFor(null);
    assert.equal(s.present, false);
    assert.equal(s.status, 'idle');
    assert.equal(s.label, 'Agent, no data');
  });
  test('name falls back to the id when name is missing', () => {
    assert.equal(sceneFor({ id: 'zed', status: 'working', activity: 'x' }).label, 'zed, running: x');
  });
  test('parity: sceneFor(a).status === statusOf(a) for every fixture', () => {
    const fixtures = [
      ag('a', 'working'), ag('b', 'waiting'), ag('c', 'idle'), ag('d', 'error'),
      ag('e', 'failed'), ag('f', 'offline', { activity: 'no data' }),
      ag('g', 'offline', { error: 'OSError', activity: 'data unavailable' }),
      ag('h', 'working', { error: 'x' }), { id: 'i' }, null,
    ];
    for (const a of fixtures) {
      assert.equal(sceneFor(a).status, statusOf(a), JSON.stringify(a));
    }
  });
});

describe('sceneModel', () => {
  test('one entry per unique agent, in layout order, combining position, sprite, colour and scene', () => {
    const agents = [
      ag('prism', 'idle', { color: '#facc15' }),
      { ...ag('nova', 'working', { activity: 'editing code' }), color: '#8b5cf6' },
      ag('pixel', 'offline', { activity: 'no data', color: '#ec4899' }),
    ];
    const m = sceneModel(agents);
    assert.deepEqual(m.map(e => e.id), ['nova', 'pixel', 'prism']);
    const nova = m[0];
    assert.equal(nova.sprite, 'char-frontend.webp');
    assert.equal(nova.color, '#8B5CF6');
    assert.equal(nova.rgb, '139,92,246');
    assert.equal(nova.status, 'running');
    assert.equal(nova.present, true);
    assert.equal(typeof nova.x, 'number');
    assert.equal(typeof nova.y, 'number');
    const pixel = m[1];
    assert.equal(pixel.present, false);
    assert.equal(pixel.label, 'Pixel, no data');
  });
  test('zero agents is an empty model', () => {
    assert.deepEqual(sceneModel([]), []);
    assert.deepEqual(sceneModel(undefined), []);
  });
});
