// Read-only Wiki pane: the agents' markdown pages as a browsable index, a log, search, and in-pane page
// navigation. Self-contained (own fetches and state). It fetches on first show and on user action only;
// there is no polling. Page bodies go through wiki-md.js and render as React elements, never as HTML.
import { React, useState, useEffect, useRef, useMemo, fetchJSON, WIKI_API } from './sdk.js';
import { parseMarkdown } from './wiki-md.js';
import {
  WIKI_DIRS, WIKI_ALL, WIKI_SEARCH_DEBOUNCE_MS, searchCheck, listUrl, pageUrl, searchUrl, logUrl,
  groupIndex, summaryText, dateText, pageMeta, linkResolver, historyPush, historyPop, backLabel,
  logActions, filterLog, errorKind,
} from './wiki-model.js';

const SEGMENTS = [['index', 'Index'], ['log', 'Log']];

function Skeleton({ label, rows = [0, 1, 2, 3, 4] }) {
  return (
    <div className="dk-wk-skel" aria-busy="true" aria-label={label}>
      {rows.map(i => <div key={i} className="dk-wk-skel-row" />)}
    </div>
  );
}

function Failed({ text, onRetry }) {
  return (
    <div className="dk-wk-msg" role="alert">
      <span>{text}</span>
      <button type="button" className="dk-wk-btn" onClick={onRetry}>Retry</button>
    </div>
  );
}

function IndexBody({ index, onOpen, onRetry }) {
  if (index.status === 'error') return <Failed text="Index unavailable." onRetry={onRetry} />;
  if (index.status !== 'ok') return <Skeleton label="Loading index" />;
  if (index.groups.length === 0) return <p className="dk-wk-empty">No pages yet. Add one in Ingest.</p>;
  return index.groups.map(g => (
    <section key={g.dir} className="dk-wk-sec" aria-labelledby={'dk-wk-g-' + g.dir}>
      <h3 id={'dk-wk-g-' + g.dir} className="dk-wk-grp">{g.label}</h3>
      <ul className="dk-wk-list">
        {g.items.map(it => (
          <li key={it.path}>
            <button type="button" className="dk-wk-row" onClick={() => onOpen(it.path)}>
              <span className="dk-wk-rt">{String(it.title || it.path)}</span>
              <span className="dk-wk-rs">{summaryText(it, g)}</span>
              <span className="dk-wk-rd">{dateText(it.updated)}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  ));
}

function LogBody({ log, filter, setFilter, onRetry }) {
  if (log.status === 'error') return <Failed text="Log unavailable." onRetry={onRetry} />;
  if (log.status !== 'ok') return <Skeleton label="Loading log" rows={[0, 1, 2]} />;
  if (log.entries.length === 0) return <p className="dk-wk-empty">No log entries yet.</p>;
  const rows = filterLog(log.entries, filter);
  return (
    <>
      <div className="dk-wk-chips" role="group" aria-label="Filter log by action">
        {logActions(log.entries).map(a => (
          <button key={a} type="button" className="dk-wk-chip" aria-pressed={a === filter}
            onClick={() => setFilter(a)}>{a}</button>
        ))}
      </div>
      {rows.length === 0
        ? <p className="dk-wk-empty">No entries for this action.</p>
        : (
          <ul className="dk-wk-log" aria-label="Log entries">
            {rows.map((e, i) => (
              <li key={i} className="dk-wk-logi">
                <div className="dk-wk-logh">
                  <time className="dk-wk-date">{dateText(e.date)}</time>
                  <span className="dk-wk-act">{String(e.action || '')}</span>
                </div>
                {e.subject ? <div className="dk-wk-logs">{String(e.subject)}</div> : null}
                {e.body ? <div className="dk-wk-logb">{String(e.body)}</div> : null}
              </li>
            ))}
          </ul>
        )}
    </>
  );
}

function SearchBody({ search, check, onOpen, onRetry }) {
  if (search.status === 'error' && search.q === check.q) return <Failed text="Search unavailable." onRetry={onRetry} />;
  if (search.q !== check.q || search.status !== 'ok') return <Skeleton label="Searching memory" rows={[0, 1, 2]} />;
  if (search.results.length === 0) return <p className="dk-wk-empty">No matches.</p>;
  return (
    <ul className="dk-wk-list">
      {search.results.map((r, i) => (
        <li key={i}>
          <button type="button" className="dk-wk-row dk-wk-row-hit" onClick={() => onOpen(r.path)}>
            <span className="dk-wk-rt">{String(r.title || r.path)}</span>
            <span className="dk-wk-rs dk-wk-snip">{String(r.snippet || '')}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

// Inline tokens -> React. Text is always a React text child (escaped). Links carry only http(s) hrefs (see wiki-md).
function inl(nodes, ctx, prefix) {
  return nodes.map((n, i) => {
    const k = prefix + i;
    switch (n.type) {
      case 'text': return <React.Fragment key={k}>{n.text}</React.Fragment>;
      case 'code': return <code key={k} className="dk-wk-code-i">{n.text}</code>;
      case 'strong': return <strong key={k}>{inl(n.children, ctx, k + '.')}</strong>;
      case 'em': return <em key={k}>{inl(n.children, ctx, k + '.')}</em>;
      case 'link': return (
        <a key={k} href={n.href} target="_blank" rel="noopener noreferrer" className="dk-wk-ext">
          {inl(n.children, ctx, k + '.')}
        </a>
      );
      case 'wiki': return n.path
        ? <button key={k} type="button" className="dk-wk-wl" onClick={() => ctx.open(n.path)}>{n.label}</button>
        : <span key={k} className="dk-wk-unres">{n.label}</span>;
      default: return null;
    }
  });
}

function renderBlock(b, key, ctx) {
  switch (b.type) {
    case 'heading': {
      const H = 'h' + Math.min(b.level + 2, 6); // body # is h3: the page title is the h2
      return <H key={key} className="dk-wk-h">{inl(b.children, ctx, key + '.')}</H>;
    }
    case 'paragraph': return <p key={key}>{inl(b.children, ctx, key + '.')}</p>;
    case 'ul': return (
      <ul key={key}>{b.items.map((it, j) => <li key={j}>{inl(it, ctx, key + '.' + j + '.')}</li>)}</ul>
    );
    case 'ol': return (
      <ol key={key}>{b.items.map((it, j) => <li key={j}>{inl(it, ctx, key + '.' + j + '.')}</li>)}</ol>
    );
    case 'quote': return <blockquote key={key}>{b.blocks.map((x, j) => renderBlock(x, j, ctx))}</blockquote>;
    case 'codeblock': return <pre key={key} className="dk-wk-pre"><code>{b.text}</code></pre>;
    case 'hr': return <hr key={key} className="dk-wk-hr" />;
    case 'table': return (
      <div key={key} className="dk-wk-tw" role="region" aria-label="Table" tabIndex={0}>
        <table>
          <thead><tr>{b.head.map((c, j) => <th key={j} scope="col">{inl(c, ctx, key + '.h' + j + '.')}</th>)}</tr></thead>
          <tbody>
            {b.rows.map((r, j) => (
              <tr key={j}>{r.map((c, x) => <td key={x}>{inl(c, ctx, key + '.' + j + '.' + x + '.')}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    );
    default: return null;
  }
}

function PageView({ page, label, onBack, onOpen, onRetry, onBackToIndex }) {
  const headRef = useRef(null);
  const data = page.data;
  const blocks = useMemo(() => (data ? parseMarkdown(data.body, linkResolver(data.links)) : []), [data]);
  useEffect(() => { if (page.status === 'ok' && headRef.current) headRef.current.focus(); }, [page]);
  const ctx = { open: onOpen };
  return (
    <div className="dk-wk-page">
      <div className="dk-wk-bar">
        <button type="button" className="dk-wk-back" onClick={onBack}>‹ {label}</button>
      </div>
      {page.status === 'loading' && <Skeleton label="Loading page" rows={[0, 1, 2]} />}
      {page.status === 'missing' && (
        <div className="dk-wk-msg" role="alert">
          <span>Page not found.</span>
          <button type="button" className="dk-wk-btn" onClick={onBackToIndex}>Back to Index</button>
        </div>
      )}
      {page.status === 'error' && <Failed text="Couldn't load page." onRetry={onRetry} />}
      {page.status === 'ok' && (
        <article className="dk-wk-art" aria-labelledby="dk-wk-title">
          <h2 id="dk-wk-title" ref={headRef} tabIndex={-1} className="dk-wk-title">{String(data.title || page.path)}</h2>
          <p className="dk-wk-meta">
            Updated <span className="dk-wk-num">{pageMeta(data.frontmatter).updated}</span>
            {' · '}Confidence <span className="dk-wk-num">{pageMeta(data.frontmatter).confidence}</span>
          </p>
          {data.truncated && <p className="dk-wk-note">Page truncated.</p>}
          <div className="dk-wk-body">{blocks.map((b, i) => renderBlock(b, i, ctx))}</div>
          <section className="dk-wk-sec" aria-labelledby="dk-wk-linked">
            <h3 id="dk-wk-linked" className="dk-wk-grp">Linked from</h3>
            {Array.isArray(data.backlinks) && data.backlinks.length > 0
              ? (
                <ul className="dk-wk-list">
                  {data.backlinks.map((b, i) => (
                    <li key={i}>
                      <button type="button" className="dk-wk-row dk-wk-row-hit" onClick={() => onOpen(b.path)}>
                        <span className="dk-wk-rt">{String(b.title || b.path)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )
              : <p className="dk-wk-empty">No pages link here.</p>}
          </section>
        </article>
      )}
    </div>
  );
}

export function WikiPane({ hidden }) {
  const [seg, setSeg] = useState('index');
  const [text, setText] = useState('');
  const [index, setIndex] = useState({ status: 'idle', groups: [] });
  const [log, setLog] = useState({ status: 'idle', entries: [] });
  const [filter, setFilter] = useState(WIKI_ALL);
  const [search, setSearch] = useState({ status: 'idle', q: '', results: [] });
  const [page, setPage] = useState(null);     // {path, status: loading|ok|missing|error, data}
  const [stack, setStack] = useState([]);     // views to return to: {path: null} for the list, or a page snapshot
  const gen = useRef({ index: 0, log: 0, page: 0, search: 0 }); // stale-response guards
  const searchCtrl = useRef(null);
  const check = searchCheck(text);
  const searching = check.ok;

  const loadIndex = () => {
    const g = ++gen.current.index;
    setIndex(s => ({ ...s, status: 'loading' }));
    Promise.all(WIKI_DIRS.map(d => fetchJSON(listUrl(WIKI_API, d.dir))))
      .then(res => {
        if (g !== gen.current.index) return;
        if (res.some(r => !r || !Array.isArray(r.items))) throw new Error('bad list');
        const lists = {};
        WIKI_DIRS.forEach((d, k) => { lists[d.dir] = res[k].items; });
        setIndex({ status: 'ok', groups: groupIndex(lists) });
      })
      .catch(() => { if (g === gen.current.index) setIndex({ status: 'error', groups: [] }); });
  };

  const loadLog = () => {
    const g = ++gen.current.log;
    setLog(s => ({ ...s, status: 'loading' }));
    fetchJSON(logUrl(WIKI_API))
      .then(d => {
        if (g !== gen.current.log) return;
        if (!d || !Array.isArray(d.entries)) throw new Error('bad log');
        setLog({ status: 'ok', entries: d.entries });
      })
      .catch(() => { if (g === gen.current.log) setLog({ status: 'error', entries: [] }); });
  };

  const runSearch = q => {
    const g = ++gen.current.search;
    if (searchCtrl.current) searchCtrl.current.abort();
    const ctrl = new AbortController();
    searchCtrl.current = ctrl;
    setSearch({ status: 'loading', q, results: [] });
    fetchJSON(searchUrl(WIKI_API, q), { signal: ctrl.signal })
      .then(d => {
        if (g !== gen.current.search) return;
        if (!d || !Array.isArray(d.results)) throw new Error('bad search');
        setSearch({ status: 'ok', q, results: d.results });
      })
      .catch(() => { if (g === gen.current.search) setSearch({ status: 'error', q, results: [] }); });
  };

  const loadPage = (path, g) => {
    fetchJSON(pageUrl(WIKI_API, path))
      .then(d => {
        if (g !== gen.current.page) return;
        if (!d || typeof d.body !== 'string') throw new Error('bad page');
        setPage({ path, status: 'ok', data: d });
      })
      .catch(e => { if (g === gen.current.page) setPage({ path, status: errorKind(e), data: null }); });
  };

  const openPage = path => {
    const prev = page && page.status === 'ok'
      ? { path: page.path, title: String(page.data.title || page.path), data: page.data }
      : { path: null };
    setStack(st => historyPush(st, prev));
    const g = ++gen.current.page;
    setPage({ path, status: 'loading', data: null });
    loadPage(path, g);
  };

  const retryPage = () => {
    if (!page) return;
    const g = ++gen.current.page;
    setPage({ path: page.path, status: 'loading', data: null });
    loadPage(page.path, g);
  };

  const goBack = () => {
    const r = historyPop(stack);
    setStack(r.stack);
    ++gen.current.page;
    if (r.top && r.top.path) setPage({ path: r.top.path, status: 'ok', data: r.top.data });
    else setPage(null);
  };

  const backToIndex = () => {
    setStack([]);
    ++gen.current.page;
    setPage(null);
  };

  // First show only (no polling): the index loads when the pane becomes visible; the log loads when its tab is picked.
  useEffect(() => { if (!hidden && index.status === 'idle') loadIndex(); }, [hidden]);
  useEffect(() => { if (!hidden && seg === 'log' && log.status === 'idle') loadLog(); }, [seg, hidden]);

  // Debounced search: only a valid trimmed query (2 to 100 characters) is sent. Clearing returns to the segments.
  useEffect(() => {
    if (!check.ok) {
      gen.current.search++;
      if (searchCtrl.current) searchCtrl.current.abort();
      setSearch(s => (s.status === 'idle' ? s : { status: 'idle', q: '', results: [] }));
      return undefined;
    }
    const t = setTimeout(() => runSearch(check.q), WIKI_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [check.ok, check.q]);

  useEffect(() => () => { if (searchCtrl.current) searchCtrl.current.abort(); }, []);

  const top = stack.length ? stack[stack.length - 1] : undefined;
  const statusText = !searching ? ''
    : (search.q !== check.q || search.status !== 'ok')
      ? (search.status === 'error' && search.q === check.q ? '' : 'Searching…')
      : `${search.results.length} result${search.results.length === 1 ? '' : 's'}`;

  return (
    <section id="dk-pane-wiki" aria-labelledby="dk-wiki-h" className="dk-pane dk-pane-wiki" hidden={!!hidden}>
      <h2 id="dk-wiki-h" className="dk-pane-h">Wiki</h2>
      <div className="dk-wk-main">
        {page ? (
          <PageView page={page} label={backLabel(top, searching)} onBack={goBack} onOpen={openPage}
            onRetry={retryPage} onBackToIndex={backToIndex} />
        ) : (
          <>
            <div role="search">
              <input type="search" className="dk-wk-q" aria-label="Search memory" placeholder="Search memory"
                value={text} maxLength={100} onChange={e => setText(e.target.value)} enterKeyHint="search"
                autoComplete="off" autoCapitalize="off" spellCheck={false} />
            </div>
            <p className="dk-wk-status" role="status" aria-live="polite">{statusText}</p>
            {searching ? (
              <SearchBody search={search} check={check} onOpen={openPage} onRetry={() => runSearch(check.q)} />
            ) : (
              <>
                <div className="dk-wk-seg" role="group" aria-label="Wiki view">
                  {SEGMENTS.map(([id, lab]) => (
                    <button key={id} type="button" className="dk-wk-segbtn" aria-pressed={seg === id}
                      onClick={() => setSeg(id)}>{lab}</button>
                  ))}
                </div>
                {seg === 'index'
                  ? <IndexBody index={index} onOpen={openPage} onRetry={loadIndex} />
                  : <LogBody log={log} filter={filter} setFilter={setFilter} onRetry={loadLog} />}
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}
