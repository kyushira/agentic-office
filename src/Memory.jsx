import { React, useState, useEffect, useRef, fetchJSON } from './sdk.js';
import { ago } from './format.js';
import {
  checkQuery, memoryUrl, highlightParts, searchMode, redactedNote, agentOptions, memoryView, cleanSnippet, MEMORY_DEBOUNCE_MS,
} from './memory-model.js';

const HINT = {
  idle: 'Search past assistant and tool output across every agent. Your own messages are never searched.',
  short: 'Type at least 2 characters to search.',
  words: 'Use at least one letter or number.',
};

/**
 * Memory search pane (phone: the fourth tab; desktop: a full-width section below Office and Live/Comms).
 * Fetches only on submit or 400 ms after typing or an agent change, with at least 2 characters. There is no
 * polling. A new request aborts the one in flight. Results are text only; hits are wrapped in spans, never HTML.
 */
export function MemoryPane({ agents, hidden }) {
  const [text, setText] = useState('');
  const [agent, setAgent] = useState('');
  const [req, setReq] = useState({ status: 'idle', q: '', data: null, error: '' });
  const ctrlRef = useRef(null), timerRef = useRef(0), lastKey = useRef(null);

  const list = Array.isArray(agents) ? agents : [];
  const byId = Object.fromEntries(list.map(a => [a.id, a]));
  const options = agentOptions(list);
  const check = checkQuery(text);

  const search = (q, ag) => {
    clearTimeout(timerRef.current);
    if (ctrlRef.current) ctrlRef.current.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    lastKey.current = q + '|' + ag;
    setReq({ status: 'loading', q, data: null, error: '' });
    fetchJSON(memoryUrl(q, ag), { signal: ctrl.signal })
      .then(d => { if (!ctrl.signal.aborted) setReq({ status: 'done', q, data: d, error: '' }); })
      .catch(e => { if (!ctrl.signal.aborted) setReq({ status: 'error', q, data: null, error: String((e && e.message) || e || 'error') }); });
  };

  // Debounce typing and agent changes. Same query + agent as the last request: no new fetch.
  useEffect(() => {
    if (!check.ok) {
      if (ctrlRef.current) ctrlRef.current.abort();
      lastKey.current = null;
      return undefined;
    }
    if (check.q + '|' + agent === lastKey.current) return undefined;
    timerRef.current = setTimeout(() => search(check.q, agent), MEMORY_DEBOUNCE_MS);
    return () => clearTimeout(timerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [check.ok, check.q, agent]);

  useEffect(() => () => {
    clearTimeout(timerRef.current);
    if (ctrlRef.current) ctrlRef.current.abort();
  }, []);

  const onSubmit = e => {
    e.preventDefault();
    if (check.ok) search(check.q, agent);
  };

  const view = memoryView({
    check,
    loading: req.status === 'loading',
    error: req.status === 'error' ? req.error : '',
    data: req.status === 'done' ? req.data : null,
  });
  const data = req.data;
  const mode = data ? searchMode(data.fts5) : null;
  const redacted = data ? redactedNote(data.redacted_total) : '';
  const nameOf = id => (byId[id] && byId[id].name) || id;
  const colorOf = id => (byId[id] && byId[id].color) || undefined;
  const hint = !check.ok ? (check.reason === 'no-words' ? HINT.words : (check.q ? HINT.short : HINT.idle)) : '';

  return (
    <section id="dk-pane-memory" aria-labelledby="dk-mem-h" className="dk-pane dk-pane-memory" hidden={!!hidden}>
      <h2 id="dk-mem-h" className="dk-pane-h">Memory</h2>
      <form className="dk-mem-form" role="search" onSubmit={onSubmit}>
        <label className="dk-mem-lbl" htmlFor="dk-mem-q">Search memory</label>
        <div className="dk-mem-controls">
          <input id="dk-mem-q" type="search" className="dk-mem-q" value={text} maxLength={200}
            onChange={e => setText(e.target.value)} enterKeyHint="search" autoComplete="off"
            autoCapitalize="off" spellCheck={false} placeholder="Words from agent replies or tool output"
            aria-describedby="dk-mem-hint" />
          <label className="dk-mem-agent">
            <span>Agent</span>
            <select className="dk-mem-sel" value={agent} onChange={e => setAgent(e.target.value)}>
              {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
        </div>
      </form>

      <div id="dk-mem-hint" className="dk-mem-status" role="status" aria-live="polite">
        {mode && view !== 'loading' && view !== 'error' && <span className="dk-mem-mode" title={mode.title}>{mode.label}</span>}
        {redacted && view === 'results' && <span className="dk-mem-red">{redacted}</span>}
        {view === 'results' && <span className="dk-mem-count">{data.results.length} result{data.results.length === 1 ? '' : 's'}</span>}
        {view === 'hint' && <span className="dk-mem-hint-t">{hint}</span>}
        {view === 'idle' && <span className="dk-mem-hint-t">{HINT.idle}</span>}
        {view === 'loading' && <span className="dk-mem-hint-t">Searching…</span>}
        {view === 'empty' && <span className="dk-mem-hint-t">No matches for “{req.q}”.</span>}
      </div>

      {view === 'error' && <div className="dk-err" role="alert">Can't search memory ({req.error || 'no agent store could be read'}). Try again.</div>}

      {view === 'loading' && (
        <div className="dk-mem-skel" aria-busy="true" aria-label="Searching memory">
          {[0, 1, 2].map(i => <div key={i} className="dk-mem-skel-row" />)}
        </div>
      )}

      {view === 'results' && (
        <>
          <ul className="dk-mem-list" aria-label="Memory results">
            {data.results.map((r, i) => (
              <li key={`${r.agent}:${r.session_id}:${r.ts}:${i}`} className="dk-mem-row">
                <div className="dk-mem-meta">
                  <span className="dk-mem-who" style={{ color: colorOf(r.agent) }}>{nameOf(r.agent)}</span>
                  <time className="dk-mem-when" dateTime={new Date(r.ts * 1000).toISOString()}>{ago(r.ts)}</time>
                  <span className="dk-mem-role">{r.role}</span>
                </div>
                {r.session_title && <div className="dk-mem-title">{r.session_title}</div>}
                <p className="dk-mem-snip">
                  {highlightParts(cleanSnippet(r.snippet), req.q).map((p, j) => (
                    <span key={j} className={p.hit ? 'dk-mem-hit' : undefined}>{p.text}</span>
                  ))}
                </p>
              </li>
            ))}
          </ul>
          {data.errors && data.errors.length > 0 && (
            <p className="dk-note">Not searched: {data.errors.join('; ')}</p>
          )}
        </>
      )}
    </section>
  );
}
