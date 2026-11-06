import { React, useState } from './sdk.js';
import { ago } from './format.js';
import { sortProjects, projectStatusLabel, sourceLabel, visibleBriefs, registryHint, BRIEFS_SHOWN } from './mc-model.js';
import { useProjects } from './mission-poll.js';

/**
 * Projects panel: one card per folder under /opt/data/projects, from GET /projects (read-only). Mounted only
 * while this sub-tab is open, so the 60s poll runs only then and only while the document is visible.
 */
export default function MissionProjects() {
  const { data, err } = useProjects();
  const now = Date.now() / 1000;
  const list = data ? sortProjects(data.projects) : null;
  const hint = registryHint(data);
  return (
    <>
      {err && <div className="dk-mc-err" role="alert">Projects unavailable: {err}</div>}
      {data == null && !err && <div className="dk-mc-note" role="status">loading…</div>}
      {hint && <p className="dk-mc-note">{hint}</p>}
      {data && data.error && <p className="dk-mc-note">{data.error}</p>}
      {list && !list.length && <div className="dk-mc-note" role="status">No project folders found.</div>}
      {list && list.length > 0 && (
        <ul className="dk-mc-projects" aria-label="Projects">
          {list.map(p => <ProjectCard key={p.name} p={p} now={now} />)}
        </ul>
      )}
    </>
  );
}

function ProjectCard({ p, now }) {
  const [open, setOpen] = useState(false);
  const briefs = p.briefs || [];
  const c = p.last_commit;
  return (
    <li className="dk-mc-proj">
      <div className="dk-mc-proj-head">
        <h3 className="dk-mc-proj-name" title={p.name}>{p.name}</h3>
        <span className={'dk-mc-status is-' + p.status}>{projectStatusLabel(p.status)}</span>
      </div>
      <p className="dk-mc-proj-act">
        <time dateTime={p.last_activity ? new Date(p.last_activity * 1000).toISOString() : undefined}>{ago(p.last_activity, now)}</time>
        {' · '}{sourceLabel(p.last_source)}
      </p>
      {c
        ? <p className="dk-mc-proj-commit" title={c.subject}>{c.subject}{c.branch && <span className="dk-mc-proj-branch"> · {c.branch}</span>}</p>
        : <p className="dk-mc-proj-commit is-none">{p.git ? 'no commits yet' : 'not a git repo'}</p>}
      <dl className="dk-mc-proj-reg">
        <dt>Owner</dt>
        <dd>{p.owner || <span className="dk-mc-unset">not set</span>}</dd>
        <dt>Next</dt>
        <dd>{p.next || <span className="dk-mc-unset">not set</span>}</dd>
      </dl>
      {briefs.length > 0 && (
        <div className="dk-mc-briefs">
          <p className="dk-mc-briefs-l">Briefs</p>
          <ul aria-label={`Briefs for ${p.name}`}>
            {visibleBriefs(briefs, open).map(b => (
              <li key={b.name}>
                <span className="dk-mc-brief-name" title={b.name}>{b.name}</span>
                <time>{ago(b.mtime, now)}</time>
              </li>
            ))}
          </ul>
          {briefs.length > BRIEFS_SHOWN && (
            <button type="button" className="dk-mc-more" aria-expanded={open} onClick={() => setOpen(o => !o)}>
              {open ? 'Show fewer' : `Show all ${briefs.length} briefs`}
            </button>
          )}
        </div>
      )}
    </li>
  );
}
