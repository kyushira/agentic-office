// Markdown -> plain token tree for the Wiki pane (src/Wiki.jsx). Pure data: every node is a plain
// object and every string is text. No HTML strings and no dangerouslySetInnerHTML anywhere: raw HTML in a
// page is not interpreted, so "<script>" stays literal text.
//
// Block nodes:
//   heading {level, children} | paragraph {children} | ul / ol {items: children[][]} | quote {blocks}
//   codeblock {text} | hr | table {head: children[][], rows: children[][][]}
// Inline nodes:
//   text {text} | code {text} | strong {children} | em {children}
//   link {href, children}  (http and https only; any other scheme renders as its label text)
//   wiki {slug, label, path}  ([[slug]] or [[slug|label]]; path is null when unresolved)

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const ATX = /^ {0,3}(#{1,4})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const HR = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const QUOTE = /^ {0,3}>[ ]?(.*)$/;
const UL = /^[ \t]*[-*+][ \t]+(.*)$/;
const OL = /^[ \t]*\d{1,9}[.)][ \t]+(.*)$/;
const TABLE_SEP = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const PUNCT = /[!-\/:-@\[-`{-~]/;
const WORD = /[A-Za-z0-9]/;

/** True only for absolute http:// or https:// URLs without whitespace. Everything else is not a link. */
export function isSafeHref(url) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url) || /\s/.test(url)) return false;
  try {
    const u = new URL(url);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname !== '';
  } catch (e) {
    return false;
  }
}

/**
 * Parse a page body. `resolve(slug)` returns the page path for a wiki slug, or null/undefined when the page
 * does not exist. Wiki nodes carry that result as `path`.
 */
export function parseMarkdown(text, resolve) {
  const res = typeof resolve === 'function' ? resolve : () => null;
  const src = String(text == null ? '' : text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  return parseBlocks(stripFrontmatter(src).split('\n'), res);
}

/** Inline-only parse (used for one-line strings). Same node shapes as parseMarkdown's inline children. */
export function parseInline(src, resolve) {
  const res = typeof resolve === 'function' ? resolve : () => null;
  return inline(String(src == null ? '' : src), res);
}

function stripFrontmatter(src) {
  if (!/^---[ \t]*\n/.test(src)) return src;
  const lines = src.split('\n');
  for (let i = 1; i < lines.length; i++) {
    if (/^---[ \t]*$/.test(lines[i])) return lines.slice(i + 1).join('\n');
  }
  return src;
}

function startsBlock(lines, i) {
  const line = lines[i];
  if (line.trim() === '') return true;
  return FENCE.test(line) || ATX.test(line) || HR.test(line) || QUOTE.test(line)
    || UL.test(line) || OL.test(line) || isTableStart(lines, i);
}

function isTableStart(lines, i) {
  if (i + 1 >= lines.length) return false;
  const head = lines[i];
  const sep = lines[i + 1];
  if (!head.includes('|') || !sep.includes('-') || !TABLE_SEP.test(sep)) return false;
  return splitRow(sep).length === splitRow(head).length;
}

/** Split a pipe row into trimmed cells. A backslash keeps the next character (so \| stays inside a cell). */
function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (ch === '\\' && k + 1 < s.length) { cur += ch + s[k + 1]; k++; continue; }
    if (ch === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function parseBlocks(lines, res) {
  const out = [];
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (line.trim() === '') { i++; continue; }

    let m = FENCE.exec(line);
    if (m) {
      const fence = m[1];
      const body = [];
      i++;
      while (i < n) {
        const c = FENCE_CLOSE.exec(lines[i]);
        if (c && c[1][0] === fence[0] && c[1].length >= fence.length) break;
        body.push(lines[i]);
        i++;
      }
      i++; // the closing fence (or past the end when unclosed)
      out.push({ type: 'codeblock', text: body.join('\n') });
      continue;
    }

    m = ATX.exec(line);
    if (m) {
      out.push({ type: 'heading', level: m[1].length, children: inline(m[2], res) });
      i++;
      continue;
    }

    if (HR.test(line)) { out.push({ type: 'hr' }); i++; continue; }

    if (QUOTE.test(line)) {
      const inner = [];
      while (i < n && QUOTE.test(lines[i])) { inner.push(QUOTE.exec(lines[i])[1]); i++; }
      out.push({ type: 'quote', blocks: parseBlocks(inner, res) });
      continue;
    }

    if (UL.test(line) || OL.test(line)) {
      const r = parseList(lines, i, UL.test(line) ? 'ul' : 'ol', res);
      out.push(r.block);
      i = r.next;
      continue;
    }

    if (isTableStart(lines, i)) {
      const head = splitRow(line);
      const w = head.length;
      const rows = [];
      i += 2;
      while (i < n && lines[i].trim() !== '' && lines[i].includes('|')) {
        const cells = splitRow(lines[i]).slice(0, w);
        while (cells.length < w) cells.push('');
        rows.push(cells.map(c => inline(c, res)));
        i++;
      }
      out.push({ type: 'table', head: head.map(c => inline(c, res)), rows });
      continue;
    }

    // Paragraph: consecutive lines until a blank line or another block start. Lines join with a space.
    const buf = [line.trim()];
    i++;
    while (i < n && !startsBlock(lines, i)) { buf.push(lines[i].trim()); i++; }
    out.push({ type: 'paragraph', children: inline(buf.join(' '), res) });
  }
  return out;
}

/** One level of list. Nested markers are flattened into items; continuation lines join the item above. */
function parseList(lines, start, kind, res) {
  const re = kind === 'ul' ? UL : OL;
  const items = [];
  const n = lines.length;
  let i = start;
  while (i < n) {
    const line = lines[i];
    if (line.trim() === '') {
      let j = i;
      while (j < n && lines[j].trim() === '') j++;
      if (j < n && re.test(lines[j]) && !HR.test(lines[j])) { i = j; continue; }
      break;
    }
    if (HR.test(line)) break;
    const m = re.exec(line);
    if (m) { items.push(m[1]); i++; continue; }
    if (startsBlock(lines, i)) break;
    items[items.length - 1] += ' ' + line.trim();
    i++;
  }
  return { block: { type: kind, items: items.map(t => inline(t, res)) }, next: i };
}

function inline(s, res) {
  const out = [];
  let buf = '';
  let i = 0;
  const flush = () => { if (buf) { out.push({ type: 'text', text: buf }); buf = ''; } };
  while (i < s.length) {
    const c = s[i];

    if (c === '\\' && i + 1 < s.length && PUNCT.test(s[i + 1])) { buf += s[i + 1]; i += 2; continue; }

    if (c === '`') {
      const run = runLen(s, i, '`');
      const close = findTicks(s, i + run, run);
      if (close < 0) { buf += '`'.repeat(run); i += run; continue; }
      flush();
      let code = s.slice(i + run, close);
      if (code.length > 2 && code[0] === ' ' && code[code.length - 1] === ' ') code = code.slice(1, -1);
      out.push({ type: 'code', text: code });
      i = close + run;
      continue;
    }

    if (c === '[' && s[i + 1] === '[') {
      const w = wikiAt(s, i, res);
      if (w) { flush(); out.push(w.node); i = w.next; continue; }
    }

    if (c === '[') {
      const l = linkAt(s, i, res);
      if (l) { flush(); out.push(...l.nodes); i = l.next; continue; }
    }

    if (c === '*' || c === '_') {
      const e = emphasisAt(s, i, res);
      if (e) { flush(); out.push(e.node); i = e.next; continue; }
    }

    buf += c;
    i++;
  }
  flush();
  return out;
}

function wikiAt(s, i, res) {
  const end = s.indexOf(']]', i + 2);
  if (end < 0) return null;
  const inner = s.slice(i + 2, end);
  if (/[\n\[\]]/.test(inner)) return null;
  const bar = inner.indexOf('|');
  const slug = (bar < 0 ? inner : inner.slice(0, bar)).trim();
  const label = bar < 0 ? slug : inner.slice(bar + 1).trim();
  if (!slug || !label) return null;
  return { node: { type: 'wiki', slug, label, path: res(slug) || null }, next: end + 2 };
}

function linkAt(s, i, res) {
  const close = s.indexOf(']', i + 1);
  if (close < 0 || s[close + 1] !== '(') return null;
  const label = s.slice(i + 1, close);
  if (label.includes('[') || label.includes('\n')) return null;
  // The url ends at the ')' that closes the link, so balanced parens inside the url (wiki/Foo_(bar)) survive.
  let depth = 1;
  let end = -1;
  for (let j = close + 2; j < s.length && end < 0; j++) {
    if (s[j] === '(') depth++;
    else if (s[j] === ')' && --depth === 0) end = j;
  }
  if (end < 0) return null;
  const url = s.slice(close + 2, end);
  if (/\s/.test(url)) return null;
  const nodes = isSafeHref(url)
    ? [{ type: 'link', href: url, children: inline(label.trim() ? label : url, res) }]
    : inline(label, res); // unsafe scheme (javascript:, data:, ...) or non-URL: plain label text only
  return { nodes, next: end + 1 };
}

function emphasisAt(s, i, res) {
  const c = s[i];
  if (s[i + 1] === c && canOpen(s, i, 2)) {
    const j = findClose(s, i + 2, c, 2);
    if (j >= 0) return { node: { type: 'strong', children: inline(s.slice(i + 2, j), res) }, next: j + 2 };
  }
  if (canOpen(s, i, 1)) {
    const j = findClose(s, i + 1, c, 1);
    if (j >= 0) return { node: { type: 'em', children: inline(s.slice(i + 1, j), res) }, next: j + 1 };
  }
  return null;
}

function isSpace(ch) {
  return ch === undefined || /\s/.test(ch);
}

function canOpen(s, i, len) {
  const next = s[i + len];
  if (next === undefined || isSpace(next)) return false;
  if (s[i] === '_' && WORD.test(s[i - 1] || '')) return false; // snake_case stays literal
  return true;
}

function findClose(s, from, c, len) {
  for (let j = from + 1; j < s.length; j++) {
    if (s[j] !== c) continue;
    if (len === 2) {
      if (s[j + 1] !== c || s[j + 2] === c) continue;
    } else if (s[j + 1] === c || s[j - 1] === c) {
      continue;
    }
    if (isSpace(s[j - 1])) continue;
    if (c === '_' && WORD.test(s[j + len] || '')) continue;
    return j;
  }
  return -1;
}

function runLen(s, i, ch) {
  let k = i;
  while (k < s.length && s[k] === ch) k++;
  return k - i;
}

function findTicks(s, from, n) {
  let j = from;
  while (j < s.length) {
    if (s[j] === '`') {
      const len = runLen(s, j, '`');
      if (len === n) return j;
      j += len;
    } else {
      j++;
    }
  }
  return -1;
}
