// Unit tests for src/memory-model.js (run by `npm test` via node:test).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  MEMORY_API, MEMORY_MIN_CHARS, MEMORY_DEBOUNCE_MS, queryTerms, checkQuery, memoryUrl, highlightParts,
  searchMode, redactedNote, agentOptions, memoryView,
} from '../src/memory-model.js';

describe('checkQuery', () => {
  test('needs at least two characters after trimming', () => {
    assert.equal(MEMORY_MIN_CHARS, 2);
    assert.equal(checkQuery('').ok, false);
    assert.equal(checkQuery('a').reason, 'short');
    assert.equal(checkQuery('   a  ').ok, false);
    assert.deepEqual(checkQuery('  ab  '), { ok: true, reason: null, q: 'ab' });
  });
  test('punctuation-only text is not searchable', () => {
    assert.equal(checkQuery('"*()').reason, 'no-words');
    assert.equal(checkQuery('--').ok, false);
  });
  test('whitespace runs collapse and the text is capped at 200 characters', () => {
    assert.equal(checkQuery('deploy   the\tapp').q, 'deploy the app');
    assert.equal(checkQuery('x'.repeat(300)).q.length, 200);
  });
  test('non-string input is treated as empty', () => {
    assert.equal(checkQuery(undefined).ok, false);
    assert.equal(checkQuery(null).ok, false);
  });
});

describe('queryTerms', () => {
  test('lower-cased, unique, longest first; Unicode letters count', () => {
    assert.deepEqual(queryTerms('Deploy deploy FTS5 é-tool'), ['deploy', 'fts5', 'tool', 'é']);
    assert.deepEqual(queryTerms(null), []);
  });
});

describe('memoryUrl', () => {
  test('encodes q and limit; agent only when chosen', () => {
    assert.equal(MEMORY_API, '/api/plugins/agent-office/memory');
    assert.equal(memoryUrl('a&b c'), `${MEMORY_API}?q=a%26b+c&limit=20`);
    assert.equal(memoryUrl('ab', 'dev', 5), `${MEMORY_API}?q=ab&limit=5&agent=dev`);
    assert.equal(memoryUrl('ab', ''), `${MEMORY_API}?q=ab&limit=20`);
  });
  test('debounce is 400 ms', () => {
    assert.equal(MEMORY_DEBOUNCE_MS, 400);
  });
});

describe('highlightParts', () => {
  test('pieces concatenate back to the original text', () => {
    const s = 'Ran the deploy script, then deploy again.';
    const parts = highlightParts(s, 'deploy');
    assert.equal(parts.map(p => p.text).join(''), s);
    assert.deepEqual(parts.filter(p => p.hit).map(p => p.text), ['deploy', 'deploy']);
  });
  test('matching is case-insensitive and keeps the original casing', () => {
    assert.deepEqual(highlightParts('Deploy DONE', 'deploy done').filter(p => p.hit).map(p => p.text), ['Deploy', 'DONE']);
  });
  test('regex metacharacters in the query are not special', () => {
    const parts = highlightParts('a.b (x) [y]', '(x) .*');
    assert.equal(parts.map(p => p.text).join(''), 'a.b (x) [y]');
    // only word terms are highlighted; punctuation in the query is dropped
    assert.deepEqual(parts.filter(p => p.hit).map(p => p.text), ['x']);
  });
  test('HTML in the snippet stays text (no markup is produced)', () => {
    const parts = highlightParts('<img src=x onerror=alert(1)> hit', 'hit');
    assert.equal(parts[0].text, '<img src=x onerror=alert(1)> ');
    assert.equal(parts[0].hit, false);
    assert.equal(parts[1].text, 'hit');
  });
  test('empty text gives no pieces; no terms gives the text as one plain piece', () => {
    assert.deepEqual(highlightParts('', 'x'), []);
    assert.deepEqual(highlightParts(null, 'x'), []);
    assert.deepEqual(highlightParts('plain', '!!'), [{ text: 'plain', hit: false }]);
  });
});

describe('searchMode and redactedNote', () => {
  test('FTS5 says keyword search; anything else says basic search', () => {
    assert.equal(searchMode(true).label, 'keyword search');
    assert.equal(searchMode(false).label, 'basic search');
  });
  test('redacted count shows only when positive', () => {
    assert.equal(redactedNote(0), '');
    assert.equal(redactedNote(undefined), '');
    assert.equal(redactedNote(3), '3 redacted');
  });
});

describe('agentOptions', () => {
  test('All first, then each agent with name and colour', () => {
    assert.deepEqual(agentOptions([{ id: 'dev', name: 'Dev', color: '#2FD6C4' }, { id: 'ops' }]), [
      { value: '', label: 'All agents', color: '' },
      { value: 'dev', label: 'Dev', color: '#2FD6C4' },
      { value: 'ops', label: 'ops', color: '' },
    ]);
    assert.deepEqual(agentOptions(null), [{ value: '', label: 'All agents', color: '' }]);
  });
});

describe('memoryView', () => {
  const ok = { ok: true };
  test('invalid query is always the hint, never a request state', () => {
    assert.equal(memoryView({ check: { ok: false }, loading: true, data: null }), 'hint');
  });
  test('loading, error, idle come before the data states', () => {
    assert.equal(memoryView({ check: ok, loading: true }), 'loading');
    assert.equal(memoryView({ check: ok, error: 'timeout' }), 'error');
    assert.equal(memoryView({ check: ok }), 'idle');
  });
  test('results, empty, and error when no store could be searched', () => {
    const data = { results: [{ agent: 'dev' }], searched: ['dev'], errors: [] };
    assert.equal(memoryView({ check: ok, data }), 'results');
    assert.equal(memoryView({ check: ok, data: { ...data, results: [] } }), 'empty');
    assert.equal(memoryView({ check: ok, data: { results: [], searched: [], errors: ['dev: state.db missing'] } }), 'error');
    assert.equal(memoryView({ check: ok, data: { results: 'bad' } }), 'error');
  });
});
