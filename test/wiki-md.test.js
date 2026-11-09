// Unit tests for src/wiki-md.js (run by `node --test`). The parser must stay plain data: no HTML, no
// unsafe links, raw HTML as literal text.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdown, parseInline, isSafeHref } from '../src/wiki-md.js';

// Concatenate every text-bearing string in a token tree (inline or block), depth first.
function plain(nodes) {
  const out = [];
  const walk = n => {
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (!n || typeof n !== 'object') return;
    if (typeof n.text === 'string') out.push(n.text);
    if (typeof n.label === 'string' && n.type === 'wiki') out.push(n.label);
    for (const k of ['children', 'blocks', 'items', 'head', 'rows']) if (n[k]) walk(n[k]);
  };
  walk(nodes);
  return out.join('');
}

const types = nodes => nodes.map(n => n.type);
const allTypes = nodes => {
  const seen = new Set();
  const walk = n => {
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (!n || typeof n !== 'object') return;
    if (n.type) seen.add(n.type);
    for (const k of ['children', 'blocks', 'items', 'head', 'rows']) if (n[k]) walk(n[k]);
  };
  walk(nodes);
  return seen;
};

describe('isSafeHref', () => {
  test('accepts http and https only', () => {
    assert.equal(isSafeHref('https://example.com/a'), true);
    assert.equal(isSafeHref('http://example.com'), true);
    assert.equal(isSafeHref('HTTPS://example.com'), true);
  });
  test('rejects every other scheme, whitespace, and garbage', () => {
    for (const u of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<b>x</b>', 'ftp://x.com',
      'vbscript:msgbox', '//example.com', '/relative', 'https://', 'https://exa mple.com', '', null]) {
      assert.equal(isSafeHref(u), false, String(u));
    }
  });
});

describe('parseMarkdown blocks', () => {
  test('empty and null input give an empty tree', () => {
    assert.deepEqual(parseMarkdown(''), []);
    assert.deepEqual(parseMarkdown(null), []);
    assert.deepEqual(parseMarkdown('   \n\n  '), []);
  });

  test('ATX headings # to ####, and five hashes stays a paragraph', () => {
    const t = parseMarkdown('# One\n## Two\n### Three\n#### Four\n##### Five');
    assert.deepEqual(t.slice(0, 4).map(n => [n.type, n.level, plain(n.children)]), [
      ['heading', 1, 'One'], ['heading', 2, 'Two'], ['heading', 3, 'Three'], ['heading', 4, 'Four'],
    ]);
    assert.equal(t[4].type, 'paragraph');
    assert.equal(plain(t[4].children), '##### Five');
  });

  test('closing hashes are dropped, but C# keeps its hash', () => {
    const t = parseMarkdown('## Title ##\n# C#');
    assert.equal(plain(t[0].children), 'Title');
    assert.equal(plain(t[1].children), 'C#');
  });

  test('paragraphs split on blank lines and join soft line breaks with a space', () => {
    const t = parseMarkdown('one\ntwo\n\nthree');
    assert.deepEqual(t.map(n => plain(n.children)), ['one two', 'three']);
  });

  test('unordered and ordered lists, with inline markup in items', () => {
    const t = parseMarkdown('- **a**\n* b\n+ c\n\n1. first\n2) second');
    assert.equal(t[0].type, 'ul');
    assert.deepEqual(t[0].items.map(plain), ['a', 'b', 'c']);
    assert.equal(t[0].items[0][0].type, 'strong');
    assert.equal(t[1].type, 'ol');
    assert.deepEqual(t[1].items.map(plain), ['first', 'second']);
  });

  test('list continuation line joins the item above; a non-list line ends the list', () => {
    const t = parseMarkdown('- item\n  more text\n# After');
    assert.equal(t[0].type, 'ul');
    assert.equal(plain(t[0].items[0]), 'item more text');
    assert.equal(t[1].type, 'heading');
  });

  test('blockquote holds blocks of its own', () => {
    const t = parseMarkdown('> quoted **bold**\n> second\n>\n> - item');
    assert.equal(t[0].type, 'quote');
    assert.deepEqual(types(t[0].blocks), ['paragraph', 'ul']);
    assert.equal(plain(t[0].blocks[0].children), 'quoted bold second');
  });

  test('fenced code keeps its content literal, including markdown and HTML', () => {
    const t = parseMarkdown('```js\n**not bold** <script>alert(1)</script>\n[x](javascript:alert(1))\n```\nafter');
    assert.equal(t[0].type, 'codeblock');
    assert.equal(t[0].text, '**not bold** <script>alert(1)</script>\n[x](javascript:alert(1))');
    assert.equal(plain(t[1].children), 'after');
  });

  test('tilde fences and an unclosed fence (runs to the end)', () => {
    const t = parseMarkdown('~~~\ncode line\n~~~');
    assert.equal(t[0].text, 'code line');
    const u = parseMarkdown('```\nstill code\n# not a heading');
    assert.equal(u.length, 1);
    assert.equal(u[0].text, 'still code\n# not a heading');
  });

  test('horizontal rules: ---, ***, and - - -', () => {
    for (const src of ['---', '***', '- - -']) {
      const t = parseMarkdown(`para\n\n${src}\n\nafter`);
      assert.deepEqual(types(t), ['paragraph', 'hr', 'paragraph'], src);
    }
  });

  test('pipe table: header, separator, rows, cells padded to the header width', () => {
    const t = parseMarkdown('| Name | Role |\n| :--- | ---: |\n| Ash | **dev** |\n| Lone |');
    assert.equal(t[0].type, 'table');
    assert.deepEqual(t[0].head.map(plain), ['Name', 'Role']);
    assert.equal(t[0].rows.length, 2);
    assert.deepEqual(t[0].rows[0].map(plain), ['Ash', 'dev']);
    assert.equal(t[0].rows[0][1][0].type, 'strong');
    assert.deepEqual(t[0].rows[1].map(plain), ['Lone', '']);
  });

  test('a table needs a separator with the same column count', () => {
    const t = parseMarkdown('a | b\n--- ');
    assert.equal(t[0].type, 'paragraph');
  });

  test('escaped pipe stays inside its table cell', () => {
    const t = parseMarkdown('| a | b |\n|---|---|\n| x\\|y | z |');
    assert.deepEqual(t[0].rows[0].map(plain), ['x|y', 'z']);
  });

  test('YAML frontmatter is skipped', () => {
    const t = parseMarkdown('---\ntitle: Ash\nconfidence: high\n---\n# Body');
    assert.deepEqual(types(t), ['heading']);
    assert.equal(plain(t[0].children), 'Body');
  });

  test('a leading --- without a closing line is not frontmatter', () => {
    const t = parseMarkdown('---\nkeep me');
    assert.ok(plain(t).includes('keep me'));
  });

  test('CRLF line endings parse like LF', () => {
    const t = parseMarkdown('# A\r\n\r\ntext\r\n');
    assert.deepEqual(types(t), ['heading', 'paragraph']);
  });
});

describe('parseMarkdown inline', () => {
  test('<script> and other raw HTML stay literal text, never nodes', () => {
    const t = parseMarkdown('<script>alert(1)</script> and <img src=x onerror=alert(1)>');
    assert.equal(plain(t[0].children), '<script>alert(1)</script> and <img src=x onerror=alert(1)>');
    assert.deepEqual([...allTypes(t)].sort(), ['paragraph', 'text']);
  });

  test('inline code keeps HTML and markdown literal', () => {
    const t = parseMarkdown('use `<b>**x**</b>` here');
    const code = t[0].children.find(n => n.type === 'code');
    assert.equal(code.text, '<b>**x**</b>');
  });

  test('bold, italic with * and _, and nesting', () => {
    const t = parseMarkdown('**bold** *ital* _under_ ***both***');
    const kids = t[0].children;
    assert.equal(kids[0].type, 'strong');
    assert.equal(plain(kids[0].children), 'bold');
    assert.equal(kids[2].type, 'em');
    assert.equal(plain(kids[2].children), 'ital');
    assert.equal(kids[4].type, 'em');
    assert.equal(plain(kids[4].children), 'under');
  });

  test('snake_case words are not italicised', () => {
    const t = parseMarkdown('set snake_case_name now');
    assert.deepEqual(types(t[0].children), ['text']);
    assert.equal(plain(t[0].children), 'set snake_case_name now');
  });

  test('a lone asterisk and an unmatched ** stay literal', () => {
    assert.equal(plain(parseMarkdown('2 * 3 = 6')[0].children), '2 * 3 = 6');
    assert.equal(plain(parseMarkdown('**open only')[0].children), '**open only');
  });

  test('backslash escapes punctuation', () => {
    assert.equal(plain(parseMarkdown('\\*not italic\\*')[0].children), '*not italic*');
  });

  test('http and https links become link nodes with an href', () => {
    const t = parseMarkdown('see [docs](https://example.com/x?a=1)');
    const link = t[0].children.find(n => n.type === 'link');
    assert.equal(link.href, 'https://example.com/x?a=1');
    assert.equal(plain(link.children), 'docs');
  });

  test('javascript: link becomes plain label text, no link node', () => {
    const t = parseMarkdown('click [here](javascript:alert(1)) now');
    assert.equal(allTypes(t).has('link'), false);
    assert.equal(plain(t[0].children), 'click here now');
  });

  test('data:, ftp:, and uppercase JavaScript: links are text too', () => {
    for (const url of ['data:text/html,hi', 'ftp://x.example', 'JAVASCRIPT:alert(1)', 'vbscript:x']) {
      const t = parseMarkdown(`[label](${url})`);
      assert.equal(allTypes(t).has('link'), false, url);
      assert.equal(plain(t[0].children), 'label', url);
    }
  });

  test('a link with whitespace in the url is literal text', () => {
    assert.equal(plain(parseMarkdown('[a](not a url)')[0].children), '[a](not a url)');
  });

  test('wiki links: resolved to a path, unresolved carries path null', () => {
    const resolve = slug => (slug === 'ash' ? 'entities/ash.md' : null);
    const t = parseMarkdown('[[ash]] and [[unresolved]] and [[ash|the agent]]', resolve);
    const wiki = t[0].children.filter(n => n.type === 'wiki');
    assert.deepEqual(wiki.map(w => [w.slug, w.label, w.path]), [
      ['ash', 'ash', 'entities/ash.md'],
      ['unresolved', 'unresolved', null],
      ['ash', 'the agent', 'entities/ash.md'],
    ]);
  });

  test('wiki link without a resolver is unresolved', () => {
    const w = parseMarkdown('[[anything]]')[0].children[0];
    assert.equal(w.type, 'wiki');
    assert.equal(w.path, null);
  });

  test('malformed wiki links stay literal', () => {
    for (const src of ['[[]]', '[[ | x]]', '[[a]b]]', '[[open']) {
      const t = parseMarkdown(src);
      assert.equal(allTypes(t).has('wiki'), false, src);
      assert.equal(plain(t[0].children), src, src);
    }
  });

  test('a wiki link cannot span a newline at the inline level', () => {
    assert.equal(parseInline('[[a\nb]]').some(n => n.type === 'wiki'), false);
  });

  test('balanced parentheses inside a link url are kept', () => {
    const t = parseMarkdown('[Foo](https://en.wikipedia.org/wiki/Foo_(bar)) after');
    const link = t[0].children.find(n => n.type === 'link');
    assert.equal(link.href, 'https://en.wikipedia.org/wiki/Foo_(bar)');
    assert.equal(plain(t[0].children), 'Foo after');
  });

  test('parseInline works on a single line', () => {
    assert.deepEqual(parseInline('plain'), [{ type: 'text', text: 'plain' }]);
  });
});

describe('parseMarkdown output is plain data', () => {
  test('JSON round trip keeps the tree identical (no functions, no DOM objects)', () => {
    const src = '# T\n\n- [a](https://x.y) [[w]]\n\n| a | b |\n|-|-|\n| 1 | 2 |\n\n> q\n\n```\nc\n```';
    const tree = parseMarkdown(src, () => 'p.md');
    assert.deepEqual(JSON.parse(JSON.stringify(tree)), tree);
  });

  test('hostile input never throws', () => {
    const big = '*'.repeat(5000) + '[' .repeat(2000) + '`'.repeat(999) + '|'.repeat(300);
    assert.doesNotThrow(() => parseMarkdown(big));
    assert.doesNotThrow(() => parseMarkdown('> '.repeat(200) + 'x'));
  });
});
