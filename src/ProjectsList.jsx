import { React, useState, useEffect, fetchJSON } from './sdk.js';
import { ago } from './format.js';
import { projectRows } from './projects-model.js';

const { useCallback } = React;

export const PROJECTS_API = '/api/plugins/agent-office/projects';

/**
 * Projects list (design 3.8). One 48px row per project from GET /projects: status dot and word, name, last touched,
 * last commit subject (one line). No timer: it fetches on mount, and again when the tab becomes visible after being
 * hidden. The backend caches for 30s, so this adds no polling. Error shows a notice, not stale data as fresh.
 */
export function ProjectsList({ now }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const pull = useCallback(() => {
    fetchJSON(PROJECTS_API)
      .then(d => { setData(d); setErr(null); })
      .catch(e => setErr(String((e && e.message) || e || 'error')));
  }, []);
  useEffect(() => {
    pull();
    const onVis = () => { if (!document.hidden) pull(); };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [pull]);

  const rows = projectRows(data);
  const registryNote = data && data.error ? data.error : null;
  return (
    <section className="dk-projects" aria-label="Projects">
      <h3 className="dk-projects-h">Projects <span className="dk-projects-n">{rows.length || ''}</span></h3>
      {err && <div className="dk-err">Can't load projects ({err}).</div>}
      {registryNote && <div className="dk-note">{registryNote}</div>}
      {!err && data && rows.length === 0 && <div className="dk-note">No projects found.</div>}
      <ul className="dk-prows">
        {rows.map(r => (
          <li key={r.name} className="dk-prow">
            <span className={'dk-pdot is-' + r.tone} aria-hidden="true" />
            <span className="dk-pstate">{r.word}</span>
            <span className="dk-pname" title={r.name}>{r.name}</span>
            <time className="dk-ptime">{r.lastActivity ? ago(r.lastActivity, now) : '—'}</time>
            <span className="dk-psubj" title={r.subject || ''}>{r.subject || 'no commits'}</span>
          </li>))}
      </ul>
    </section>);
}
