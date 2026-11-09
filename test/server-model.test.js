// Unit tests for src/server-model.js (run by `node --test test/*.test.js`).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ramLevel, fmtGB, fmtMB, fmtTime, diskWarn, diskFreeText, loadLine, topRows, validServer, view } from '../src/server-model.js';

const mem = { total_mb: 3900, available_mb: 629, used_mb: 3300, used_pct: 84.6 };
const disk = { path: '/', total_gb: 100, free_gb: 41, free_pct: 41 };
const load = { one: 1.42, five: 1.1, fifteen: 0.9, cores: 4 };
const top = [{ name: 'node', rss_mb: 512 }, { name: 'python3', rss_mb: 300 }, { name: 'sshd', rss_mb: 20 }, { name: 'extra', rss_mb: 5 }];
const full = { ts: 1_800_000_000, mem, disk, load, top };

describe('ramLevel thresholds', () => {
  test('1024 and above is OK', () => {
    assert.deepEqual(ramLevel(1024), { level: 'ok', word: 'OK' });
    assert.deepEqual(ramLevel(4096), { level: 'ok', word: 'OK' });
  });
  test('1023 is Low, and so is 500', () => {
    assert.deepEqual(ramLevel(1023), { level: 'low', word: 'Low' });
    assert.deepEqual(ramLevel(500), { level: 'low', word: 'Low' });
  });
  test('499 and below is Critical', () => {
    assert.deepEqual(ramLevel(499), { level: 'critical', word: 'Critical' });
    assert.deepEqual(ramLevel(0), { level: 'critical', word: 'Critical' });
  });
  test('not a number gives null', () => {
    assert.equal(ramLevel(null), null);
    assert.equal(ramLevel(undefined), null);
    assert.equal(ramLevel(NaN), null);
    assert.equal(ramLevel('629'), null);
  });
});

describe('formatting', () => {
  test('fmtGB rounds to one decimal and gives an em dash when missing', () => {
    assert.equal(fmtGB(3300), '3.2');   // 3.22 GB
    assert.equal(fmtGB(3379), '3.3');   // 3.30 GB
    assert.equal(fmtGB(3900), '3.8');   // 3.81 GB
    assert.equal(fmtGB(1024), '1.0');
    assert.equal(fmtGB(null), '—');
    assert.equal(fmtGB('x'), '—');
  });
  test('fmtMB rounds to whole MB', () => {
    assert.equal(fmtMB(629.4), '629 MB');
    assert.equal(fmtMB(629.6), '630 MB');
    assert.equal(fmtMB(null), '—');
  });
  test('fmtTime is HH:MM 24h local time from unix seconds', () => {
    const ts = d => new Date(...d).getTime() / 1000;   // local clock, so the test holds in any TZ
    assert.equal(fmtTime(ts([2026, 10, 9, 14, 2])), '14:02');
    assert.equal(fmtTime(ts([2026, 10, 9, 0, 5])), '00:05');
    assert.equal(fmtTime(ts([2026, 10, 9, 23, 59])), '23:59');
    assert.equal(fmtTime(null), '—');
    assert.equal(fmtTime(undefined), '—');
  });
});

describe('disk', () => {
  test('warn only strictly below 10 percent free', () => {
    assert.equal(diskWarn({ free_pct: 9.99 }), true);
    assert.equal(diskWarn({ free_pct: 10 }), false);
    assert.equal(diskWarn({ free_pct: 41 }), false);
    assert.equal(diskWarn(null), false);
    assert.equal(diskWarn({}), false);
  });
  test('free text: whole GB, one decimal under 10 GB', () => {
    assert.equal(diskFreeText(41), '41 GB free');
    assert.equal(diskFreeText(41.6), '42 GB free');
    assert.equal(diskFreeText(9.44), '9.4 GB free');
    assert.equal(diskFreeText(0.4), '0.4 GB free');
    assert.equal(diskFreeText(null), '—');
  });
});

describe('load and top', () => {
  test('load line: 2dp and cores', () => {
    assert.equal(loadLine(load), 'Load 1.42 · 4 cores');
    assert.equal(loadLine({ one: 0.5, cores: 1 }), 'Load 0.50 · 1 core');
    assert.equal(loadLine({ one: 2, cores: null }), 'Load 2.00');
    assert.equal(loadLine(null), null);
  });
  test('top: at most three rows, null stays null', () => {
    const rows = topRows(top);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows[0], { name: 'node', mbText: '512 MB' });
    assert.equal(topRows([]).length, 0);
    assert.equal(topRows(null), null);
  });
});

describe('validServer', () => {
  test('needs numeric mem totals', () => {
    assert.equal(validServer(full), true);
    assert.equal(validServer({ mem: { total_mb: 1, available_mb: 1 } }), false);
    assert.equal(validServer({}), false);
    assert.equal(validServer(null), false);
  });
});

describe('view', () => {
  test('loading: nothing to show, refresh disabled while pending', () => {
    const v = view({ pending: true });
    assert.equal(v.mode, 'loading');
    assert.equal(v.ram, null);
    assert.equal(v.refreshDisabled, true);
  });

  test('ok: ram, disk, load, top from the payload', () => {
    const v = view({ data: full, pending: false });
    assert.equal(v.mode, 'ok');
    assert.equal(v.updated, fmtTime(full.ts));
    assert.equal(v.stale, false);
    assert.equal(v.refreshDisabled, false);
    assert.equal(v.ram.centre, '3.2 / 3.8 GB');
    assert.equal(v.ram.free, 'Free 629 MB');
    assert.equal(v.ram.level, 'low');
    assert.equal(v.ram.word, 'Low');
    assert.equal(v.ram.pulse, false);
    assert.equal(v.ram.pct, 84.6);
    assert.equal(v.ram.aria, 'RAM 3.2 of 3.8 GB used, free 629 MB, Low');
    assert.equal(v.disk.label, 'Disk /');
    assert.equal(v.disk.free, '41 GB free');
    assert.equal(v.disk.fillPct, 59);
    assert.equal(v.disk.warn, false);
    assert.equal(v.disk.demo, false);
    assert.equal(v.load.text, 'Load 1.42 · 4 cores');
    assert.equal(v.load.demo, false);
    assert.equal(v.top.rows.length, 3);
    assert.equal(v.top.demo, false);
  });

  test('ram critical pulses; ram ok does not', () => {
    const crit = view({ data: { ...full, mem: { ...mem, available_mb: 499 } } });
    assert.equal(crit.ram.level, 'critical');
    assert.equal(crit.ram.pulse, true);
    assert.equal(crit.ram.aria.endsWith('Critical'), true);
    const ok = view({ data: { ...full, mem: { ...mem, available_mb: 1024 } } });
    assert.equal(ok.ram.word, 'OK');
    assert.equal(ok.ram.pulse, false);
  });

  test('disk warn flag follows free_pct', () => {
    const v = view({ data: { ...full, disk: { path: '/', free_gb: 3, free_pct: 9.5 } } });
    assert.equal(v.disk.warn, true);
    assert.equal(v.disk.fillPct, 90.5);
  });

  test('null sections show as demo, not as zeros', () => {
    const v = view({ data: { ...full, disk: null, load: null, top: null } });
    assert.deepEqual(v.disk, { demo: true });
    assert.deepEqual(v.load, { text: '—', demo: true });
    assert.deepEqual(v.top, { rows: [], demo: true });
  });

  test('error with no last good values: no numbers at all', () => {
    const v = view({ error: true });
    assert.equal(v.mode, 'error');
    assert.equal(v.stale, false);
    assert.equal(v.ram, null);
    assert.equal(v.lastGood, null);
  });

  test('error after a good read: last good values shown and stale', () => {
    const v = view({ data: null, lastGood: full, error: true });
    assert.equal(v.mode, 'error');
    assert.equal(v.stale, true);
    assert.equal(v.lastGood, fmtTime(full.ts));
    assert.equal(v.ram.centre, '3.2 / 3.8 GB');
    assert.equal(v.updated, '—');
  });

  test('a refresh in flight after an error keeps the error view and disables refresh', () => {
    const v = view({ lastGood: full, error: true, pending: true });
    assert.equal(v.mode, 'error');
    assert.equal(v.refreshDisabled, true);
  });

  test('a malformed payload is not drawn as ok', () => {
    const v = view({ data: { ts: 1, mem: { total_mb: 'x' } }, error: true });
    assert.equal(v.mode, 'error');
    assert.equal(v.ram, null);
  });
});
