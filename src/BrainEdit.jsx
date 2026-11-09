import { React } from './sdk.js';
import { fmtInt } from './brain-model.js';
import { counterState, diffView } from './brain-edit-model.js';

/*
 * Presentational pieces of the Brain editor (used by BrainDetail.jsx). Text only: every string here is a React text
 * node, never HTML. Colour is never the only signal: the counter and the diff carry words too.
 */

/** Live counter: '1,840 / 2,200' always; 'Near limit' from 90%; 'Over limit by N' past the limit. aria-live polite. */
export function Counter({ chars, limit }) {
  const c = counterState(chars, limit);
  return (
    <p className={'dk-be-count' + (c.level === 'ok' ? '' : ' is-' + c.level)} aria-live="polite">
      <span className="dk-be-num">{c.label}</span>
      {c.cue && <span className="dk-be-cue">{' · ' + c.cue}</span>}
    </p>
  );
}

/** Line diff rows: '+' added, '−' removed, unchanged lines (long runs collapsed to a count). */
export function DiffList({ ops }) {
  const view = diffView(ops || [], 2);
  const changed = (ops || []).some(o => o.type !== 'same');
  if (!changed) return <p className="dk-note">No changes.</p>;
  return (
    <div className="dk-be-diff" role="region" aria-label="Changes">
      {view.map((o, i) => {
        if (o.type === 'gap') return <p key={i} className="dk-be-gap">{'… ' + fmtInt(o.count) + ' unchanged lines'}</p>;
        const sign = o.type === 'add' ? '+' : o.type === 'del' ? '\u2212' : ' ';
        const word = o.type === 'add' ? 'Added: ' : o.type === 'del' ? 'Removed: ' : '';
        return (
          <div key={i} className={'dk-be-l is-' + o.type}>
            <span className="dk-be-sign" aria-hidden="true">{sign}</span>
            <span className="dk-sr">{word}</span>
            <span className="dk-be-txt">{o.text === '' ? ' ' : o.text}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Unsaved-changes prompt: Save (opens the diff sheet), Discard, Keep editing. */
export function UnsavedPrompt({ title, onSave, onDiscard, onKeep, busy, saveBlocked = '' }) {
  // Over the limit: Save is disabled and the reason is shown, so the pending action is never dropped silently.
  return (
    <div className="dk-be-prompt" role="group" aria-label="Unsaved changes">
      <p className="dk-be-prompt-t">{'Unsaved changes to ' + title + '.'}</p>
      {saveBlocked && <p className="dk-be-cue" role="note">{saveBlocked}</p>}
      <div className="dk-be-acts">
        <button type="button" className="dk-be-btn is-primary" onClick={onSave} disabled={busy || !!saveBlocked}>Save</button>
        <button type="button" className="dk-be-btn" onClick={onDiscard} disabled={busy}>Discard</button>
        <button type="button" className="dk-be-btn" onClick={onKeep} disabled={busy}>Keep editing</button>
      </div>
    </div>
  );
}

/** Error line. A 'changed' error carries a Reload action; the draft is never dropped by it. */
export function Alert({ err, onReload, busy }) {
  if (!err) return null;
  const info = err.kind === 'info';
  return (
    <div className={info ? 'dk-be-ok' : 'dk-err dk-be-err'} role={info ? 'status' : 'alert'}>
      <span>{err.message}</span>
      {err.kind === 'changed' && onReload && (
        <button type="button" className="dk-be-btn" onClick={onReload} disabled={busy}>Reload</button>
      )}
    </div>
  );
}

/** Saved / Restored toast. Undo only when the server gave a backup id. Inline, not fixed, so it never covers text. */
export function Toast({ toast, onUndo, busy }) {
  if (!toast) return null;
  return (
    <div className="dk-be-toast" role="status">
      <span>{toast.msg}</span>
      {toast.undo && (
        <>
          <span aria-hidden="true">{' · '}</span>
          <button type="button" className="dk-be-btn is-primary" onClick={onUndo} disabled={busy}>Undo</button>
        </>
      )}
    </div>
  );
}
