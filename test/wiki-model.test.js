// Unit tests for src/wiki-model.js (run by `node --test`).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  WIKI_DIRS, WIKI_SEARCH_MIN, WIKI_SEARCH_MAX, WIKI_SEARCH_DEBOUNCE_MS, WIKI_LOG_TAIL, WIKI_ALL,
  searchCheck, listUrl, pageUrl, searchUrl, logUrl, groupIndex, summaryText, dateText, pageMeta,
  linkResolver, historyPush, historyPop, backLabel, logActions, filterLog, errorKind,
} from '../src/wiki-model.js';

const BASE = '/api/plugins/agent-office/wiki';

describe('searchCheck', () => {
  test('constants match the API contract', () => {
    assert.equal(WIKI_SEARCH_MIN, 2);
    assert.equal(WIKI_SEARCH_MAX, 100);
    assert.equal(WIKI_SEARCH_DEBOUNCE_MS, 300);
    assert.equal(WIKI_LOG_TAIL, 50);
  });
  test('needs two characters after trimming', () => {
    assert.deepEqual(searchCheck(''), { ok: false, q: '', reason: 'short' });
    assert.equal(searchCheck('a').ok, false);
    assert.equal(searchCheck('   a   ').ok, false, 'one character after trim');
    assert.deepEqual(searchCheck('  ab  '), { ok: true, q: 'ab', reason: '' });
    assert.equal(searchCheck(null).ok, false);
  });
  test('100 characters is the limit; 101 is too long', () => {
    assert.equal(searchCheck('x'.repeat(100)).ok, true);
    assert.equal(searchCheck('x'.repeat(101)).ok, false);
    assert.equal(searchCheck('x'.repeat(101)).reason, 'long');
  });
});

describe('url builders', () => {
  test('encode their parameters', () => {
    assert.equal(listUrl(BASE, 'entities'), BASE + '/list?dir=entities');
    assert.equal(pageUrl(BASE, 'entities/a b.md'), BASE + '/page?path=entities%2Fa%20b.md');
    assert.equal(searchUrl(BASE, 'x&y=1'), BASE + '/search?q=x%26y%3D1');
    assert.equal(logUrl(BASE), BASE + '/log?tail=50');
    assert.equal(logUrl(BASE, 10), BASE + '/log?tail=10');
  });
});

describe('groupIndex', () => {
  test('dir order is fixed; empty dirs are dropped; items sorted by title', () => {
    const groups = groupIndex({
      queries: [{ path: 'queries/q.md', title: 'Why' }],
      entities: [
        { path: 'entities/b.md', title: 'Bravo' },
        { path: 'entities/a.md', title: 'alpha' },
      ],
      concepts: [],
      comparisons: undefined,
    });
    assert.deepEqual(groups.map(g => g.dir), ['entities', 'queries']);
    assert.deepEqual(groups[0].items.map(i => i.title), ['alpha', 'Bravo']);
    assert.equal(groups[0].label, 'Entities');
    assert.equal(groups[1].kind, 'query');
  });
  test('no lists at all gives no groups', () => {
    assert.deepEqual(groupIndex({}), []);
    assert.deepEqual(groupIndex(null), []);
  });
  test('items without a path are ignored', () => {
    const g = groupIndex({ entities: [{ title: 'no path' }, { path: 'entities/x.md', title: 'x' }] });
    assert.equal(g[0].items.length, 1);
  });
  test('WIKI_DIRS lists the four directories', () => {
    assert.deepEqual(WIKI_DIRS.map(d => d.dir), ['entities', 'concepts', 'comparisons', 'queries']);
  });
});

describe('summaryText and dates', () => {
  const group = { dir: 'entities', kind: 'entity' };
  test('summary uses the item type, else the group kind, plus the dir', () => {
    assert.equal(summaryText({ type: 'entity' }, group), 'entity · entities');
    assert.equal(summaryText({}, group), 'entity · entities');
    assert.equal(summaryText({}, null), 'page');
  });
  test('dateText keeps the ISO date part, else the raw string, else a dash', () => {
    assert.equal(dateText('2026-11-09T10:00:00Z'), '2026-11-09');
    assert.equal(dateText('2026-11-09'), '2026-11-09');
    assert.equal(dateText('last week'), 'last week');
    assert.equal(dateText(''), '—');
    assert.equal(dateText(null), '—');
    assert.equal(dateText(1234), '—');
  });
  test('pageMeta reads updated and confidence from frontmatter with dash defaults', () => {
    assert.deepEqual(pageMeta({ updated: '2026-11-01T00:00:00Z', confidence: ' high ' }),
      { updated: '2026-11-01', confidence: 'high' });
    assert.deepEqual(pageMeta(undefined), { updated: '—', confidence: '—' });
  });
});

describe('linkResolver', () => {
  test('maps slug to path for resolved links, null for everything else', () => {
    const resolve = linkResolver([
      { slug: 'ash', path: 'entities/ash.md' },
      { slug: 'gone', path: null },
      null,
    ]);
    assert.equal(resolve('ash'), 'entities/ash.md');
    assert.equal(resolve('gone'), null);
    assert.equal(resolve('nope'), null);
    assert.equal(linkResolver(undefined)('x'), null);
  });
});

describe('history stack', () => {
  test('push adds to the top; pop returns the newest entry first', () => {
    let s = [];
    s = historyPush(s, { path: null });
    s = historyPush(s, { path: 'entities/a.md', title: 'A' });
    s = historyPush(s, { path: 'entities/b.md', title: 'B' });
    const p1 = historyPop(s);
    assert.equal(p1.top.path, 'entities/b.md');
    assert.equal(p1.stack.length, 2);
    const p2 = historyPop(p1.stack);
    assert.equal(p2.top.path, 'entities/a.md');
    const p3 = historyPop(p2.stack);
    assert.equal(p3.top.path, null, 'the list entry comes back as path null');
    const p4 = historyPop(p3.stack);
    assert.equal(p4.top, undefined);
    assert.deepEqual(p4.stack, []);
  });
  test('push does not mutate the stack it was given', () => {
    const s = [{ path: null }];
    historyPush(s, { path: 'x' });
    assert.equal(s.length, 1);
  });
  test('popping a non-array gives an empty stack', () => {
    assert.deepEqual(historyPop(undefined), { stack: [], top: undefined });
  });
  test('back label: the page title, else Search or Index', () => {
    assert.equal(backLabel({ path: 'entities/a.md', title: 'Ash' }, false), 'Ash');
    assert.equal(backLabel({ path: null }, true), 'Search');
    assert.equal(backLabel({ path: null }, false), 'Index');
    assert.equal(backLabel(undefined, false), 'Index');
  });
});

describe('log actions and filter', () => {
  const entries = [
    { date: '2026-11-09', action: 'ingest', subject: 'a', body: 'x' },
    { date: '2026-11-08', action: 'query', subject: 'b', body: 'y' },
    { date: '2026-11-07', action: 'ingest', subject: 'c', body: 'z' },
    { date: '2026-11-06', action: 'lint', subject: 'd' },
  ];
  test('actions: All first, then the distinct actions sorted', () => {
    assert.deepEqual(logActions(entries), [WIKI_ALL, 'ingest', 'lint', 'query']);
    assert.deepEqual(logActions([]), [WIKI_ALL]);
    assert.deepEqual(logActions([{ action: '' }, null]), [WIKI_ALL]);
  });
  test('filter: All or empty keeps every entry, an action keeps its own, unknown gives none', () => {
    assert.equal(filterLog(entries, WIKI_ALL).length, 4);
    assert.equal(filterLog(entries, '').length, 4);
    assert.deepEqual(filterLog(entries, 'ingest').map(e => e.subject), ['a', 'c']);
    assert.deepEqual(filterLog(entries, 'nope'), []);
    assert.deepEqual(filterLog(undefined, 'ingest'), []);
  });
});

describe('errorKind', () => {
  test('404 is missing; anything else is an error', () => {
    assert.equal(errorKind({ status: 404 }), 'missing');
    assert.equal(errorKind({ status: 500 }), 'error');
    assert.equal(errorKind({ status: 0 }), 'error');
    assert.equal(errorKind(new Error('network')), 'error');
    assert.equal(errorKind(undefined), 'error');
  });
});
