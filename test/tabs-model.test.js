// Unit tests for src/tabs-model.js (run by `node --test test/*.test.js`).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { TABS, DEFAULT_TAB, isTab, parseHash, hashFor, tabStep, ASH_ID, ashView } from '../src/tabs-model.js';

describe('TABS', () => {
  test('five tabs in nav order with unique ids and labels', () => {
    assert.deepEqual(TABS.map(t => t.id), ['home', 'agents', 'inbox', 'wiki', 'menu']);
    assert.deepEqual(TABS.map(t => t.label), ['Home', 'Agents', 'Inbox', 'Wiki', 'Menu']);
    assert.equal(new Set(TABS.map(t => t.id)).size, TABS.length);
  });
  test('default tab is home', () => {
    assert.equal(DEFAULT_TAB, 'home');
    assert.equal(isTab('home'), true);
    assert.equal(isTab('chat'), false);
  });
});

describe('parseHash', () => {
  test('a valid hash selects its tab, with or without the #', () => {
    assert.equal(parseHash('#agents'), 'agents');
    assert.equal(parseHash('inbox'), 'inbox');
    assert.equal(parseHash('#menu'), 'menu');
  });
  test('empty, unknown or nested hashes fall back to home', () => {
    assert.equal(parseHash(''), 'home');
    assert.equal(parseHash('#'), 'home');
    assert.equal(parseHash(undefined), 'home');
    assert.equal(parseHash('#nope'), 'home');
    assert.equal(parseHash('#/agents'), 'home');
    assert.equal(parseHash('#chat'), 'home');
  });
  test('is case sensitive: #Agents is not a tab', () => {
    assert.equal(parseHash('#Agents'), 'home');
  });
});

describe('hashFor', () => {
  test('round-trips every tab through parseHash', () => {
    for (const t of TABS) assert.equal(parseHash(hashFor(t.id)), t.id);
  });
  test('unknown ids map to the home hash', () => {
    assert.equal(hashFor('bogus'), '#home');
    assert.equal(hashFor('wiki'), '#wiki');
  });
});

describe('tabStep (WAI-ARIA tablist keys)', () => {
  const n = 5;
  test('right and down advance and wrap', () => {
    assert.equal(tabStep(0, 'ArrowRight', n), 1);
    assert.equal(tabStep(0, 'ArrowDown', n), 1);
    assert.equal(tabStep(4, 'ArrowRight', n), 0);
  });
  test('left and up go back and wrap', () => {
    assert.equal(tabStep(2, 'ArrowLeft', n), 1);
    assert.equal(tabStep(2, 'ArrowUp', n), 1);
    assert.equal(tabStep(0, 'ArrowLeft', n), 4);
  });
  test('Home and End jump to the ends', () => {
    assert.equal(tabStep(3, 'Home', n), 0);
    assert.equal(tabStep(1, 'End', n), 4);
  });
  test('other keys and an empty list do not move', () => {
    assert.equal(tabStep(1, 'Enter', n), -1);
    assert.equal(tabStep(1, 'a', n), -1);
    assert.equal(tabStep(0, 'ArrowRight', 0), -1);
  });
});

describe('ashView', () => {
  const ash = (status, extra = {}) => ({ id: ASH_ID, name: 'Ash', status, ...extra });

  test('Ash is the default-profile agent', () => {
    assert.equal(ASH_ID, 'default');
  });
  test('no state yet -> Checking', () => {
    assert.equal(ashView({ loaded: false }).word, 'Checking');
  });
  test('a failed poll -> Offline, even if an old Ash record is present', () => {
    const v = ashView({ agents: [ash('idle')], error: true, loaded: true });
    assert.deepEqual([v.state, v.word], ['offline', 'Offline']);
  });
  test('Ash missing from state -> Offline', () => {
    const v = ashView({ agents: [{ id: 'writer', status: 'idle' }], loaded: true });
    assert.equal(v.word, 'Offline');
  });
  test('idle -> Ready, working or waiting -> Thinking', () => {
    assert.equal(ashView({ agents: [ash('idle')], loaded: true }).word, 'Ready');
    assert.equal(ashView({ agents: [ash('working')], loaded: true }).word, 'Thinking');
    assert.equal(ashView({ agents: [ash('waiting')], loaded: true }).word, 'Thinking');
  });
  test('line: current step while working, else newest session title, else —', () => {
    const sessions = { default: [
      { status: 'working', step: '  Drafting   the brief ', at: 5 },
      { status: 'idle', title: 'Older', at: 1 },
    ] };
    assert.equal(ashView({ agents: [ash('working')], sessions, loaded: true }).line, 'Drafting the brief');
    const idle = { default: [{ status: 'idle', title: 'Inbox sweep', at: 9 }, { status: 'idle', title: 'Old', at: 2 }] };
    assert.equal(ashView({ agents: [ash('idle')], sessions: idle, loaded: true }).line, 'Inbox sweep');
    assert.equal(ashView({ agents: [ash('idle')], sessions: {}, loaded: true }).line, '—');
    assert.equal(ashView({ agents: [ash('idle', { activity: 'idle' })], loaded: true }).line, '—');
  });
  test('never reports a reply or chat field', () => {
    const v = ashView({ agents: [ash('idle', { reply: 'hi', chat: [1] })], loaded: true });
    assert.deepEqual(Object.keys(v).sort(), ['line', 'state', 'word']);
  });
});
