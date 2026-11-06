// Polling for the Mission Control panels. Mounted only while that panel is on screen, so unmounting
// (tab or view change) stops the timer. No timers run while the document is hidden.
import { useState, useEffect, useRef, fetchJSON } from './sdk.js';
import { mergeRows, newIds, mergeThinking, feedQuery, commsQuery, PROJECTS_API, MC_CAP } from './mc-model.js';

export const MC_POLL_MS = 5000;
export const PROJECTS_POLL_MS = 60000;

export function reducedMotion() {
  return !!(typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

/**
 * Polls 'feed' (per agent, or all when key is '') or 'comms' (always all; the panel filters). Rows are
 * newest first and merged by id; `since` is the newest ts seen, so each poll is incremental. A changed
 * key starts over. Returns {rows, fresh, thinking, err} for the current key: rows is null until the
 * first answer, fresh holds ids that arrived in the latest poll (never on first load).
 */
export function usePoll(kind, agentKey, ms = MC_POLL_MS) {
  const k = agentKey || '';
  const [d, setD] = useState({ key: null, rows: null, fresh: new Set(), thinking: [], err: '' });
  const cache = useRef({ key: null, rows: null, thinking: [] });
  useEffect(() => {
    let live = true, timer = 0, busy = false;
    const stop = () => { clearTimeout(timer); timer = 0; };
    const pull = () => {
      stop();
      if (!live || busy || document.hidden) return;
      busy = true;
      const sameKey = cache.current.key === k;
      const same = sameKey ? cache.current.rows : null;
      const since = same && same.length ? same[0].ts : 0;
      const url = kind === 'feed' ? feedQuery(k, since) : commsQuery(since);
      fetchJSON(url)
        .then(res => {
          if (!live) return;
          const incoming = (res && res.rows) || [];
          const merged = mergeRows(same, incoming, MC_CAP);
          // Thinking agents are sticky for the key: an incremental poll with no new rows must not clear them.
          const thinking = mergeThinking(sameKey ? cache.current.thinking : [], (res && res.thinking_agents) || []);
          cache.current = { key: k, rows: merged, thinking };
          setD({ key: k, rows: merged, fresh: new Set(newIds(same, incoming)), thinking, err: '' });
        })
        .catch(e => {
          if (live) setD(x => ({ ...x, key: k, rows: x.key === k ? x.rows : null, err: String((e && e.message) || e) }));
        })
        .finally(() => {
          busy = false;
          if (live && !document.hidden) timer = setTimeout(pull, ms);
        });
    };
    const onVis = () => { if (document.hidden) stop(); else pull(); };
    document.addEventListener('visibilitychange', onVis);
    pull();
    return () => {
      live = false;
      stop();
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [kind, k, ms]);
  const mine = d.key === k;
  return {
    rows: mine ? d.rows : null,
    fresh: mine ? d.fresh : new Set(),
    thinking: mine ? d.thinking : [],
    err: mine ? d.err : '',
  };
}

/**
 * Polls /projects every PROJECTS_POLL_MS while the Projects panel is mounted and the document is visible.
 * Returns {data, err}: data is null until the first answer; after a failed poll the last good data stays.
 */
export function useProjects() {
  const [d, setD] = useState({ data: null, err: '' });
  useEffect(() => {
    let live = true, timer = 0, busy = false;
    const stop = () => { clearTimeout(timer); timer = 0; };
    const pull = () => {
      stop();
      if (!live || busy || document.hidden) return;
      busy = true;
      fetchJSON(PROJECTS_API)
        .then(res => { if (live) setD({ data: res || null, err: '' }); })
        .catch(e => { if (live) setD(x => ({ data: x.data, err: String((e && e.message) || e) })); })
        .finally(() => {
          busy = false;
          if (live && !document.hidden) timer = setTimeout(pull, PROJECTS_POLL_MS);
        });
    };
    const onVis = () => { if (document.hidden) stop(); else pull(); };
    document.addEventListener('visibilitychange', onVis);
    pull();
    return () => {
      live = false;
      stop();
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);
  return d;
}
