import { React, useState, useEffect, useRef, fetchJSON } from './sdk.js';
import { brainUrl, brainAgents } from './brain-model.js';
import {
  countChars, counterState, isDirty, lineDiff, diffSummaryText, needsExtraConfirm, confirmLabel, parseFailure,
  errorInfo, undoable, saveRequest, restoreRequest, versionsUrl, versionUrl, versionLabel, restoreState, editState,
  FILE_TITLES, TOAST_MS, NO_VERSIONS, saveBlockedReason,
} from './brain-edit-model.js';
import { BrainBlock } from './Brain.jsx';
import { Counter, DiffList, UnsavedPrompt, Alert, Toast } from './BrainEdit.jsx';

/*
 * Brain tab in the agent sheet: one agent's three blocks (Soul, Memory, User profile) with an editor per block.
 * Writes go to the server API in plugin/agent-office/dashboard/brain_edit.py through the pure helpers in
 * brain-edit-model.js. Only one block is in edit mode. A dirty editor blocks closing the sheet, switching tabs and
 * opening another block until the user saves, discards or keeps editing (the `guard` ref is read by Deck.jsx).
 * No polling. Text is rendered as text nodes only.
 */

const nowSec = () => Date.now() / 1000;
const FILE_KEYS = ['soul', 'memory', 'user'];
const FALLBACK_LIMIT = { soul: 20000, memory: 2200, user: 1375 };

/** New payload with one file replaced for one agent (the server's returned file object). */
function patchFile(data, agentId, key, file) {
  if (!data || !Array.isArray(data.agents) || !file) return data;
  return { ...data, agents: data.agents.map(a => (String(a.id) === agentId ? { ...a, [key]: file } : a)) };
}

export function BrainDetail({ agentId, guard }) {
  const [attempt, setAttempt] = useState(0);
  const [st, setSt] = useState({ status: 'loading', data: null, error: '' });
  const [ed, setEd] = useState(null);         // open editor: {key, draft, stored, sha, limit}
  const [review, setReview] = useState(null); // diff sheet: {kind:'save'|'restore', key, text, base_sha, ops, armed, then, id, version}
  const [vers, setVers] = useState(null);     // versions list: {key, list, error}
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);       // {kind, message, key}
  const [pending, setPending] = useState(null); // {run}: what to do after the unsaved prompt
  const [toast, setToast] = useState(null);   // {msg, undo, backup, key, sha}
  // Set synchronously before a request and cleared when it settles: a second tap in the same render cannot send again.
  const flight = useRef(false);

  useEffect(() => {
    const c = new AbortController();
    setSt({ status: 'loading', data: null, error: '' });
    fetchJSON(brainUrl(agentId), { signal: c.signal })
      .then(d => { if (!c.signal.aborted) setSt({ status: 'ok', data: d, error: '' }); })
      .catch(e => { if (!c.signal.aborted) setSt({ status: 'error', data: null, error: String((e && e.message) || e || 'error') }); });
    return () => c.abort();
  }, [agentId, attempt]);

  const rows = st.status === 'ok' ? brainAgents(st.data, nowSec()) : [];
  const r = rows.find(x => x.id === agentId) || rows[0];
  const rawAgent = (st.data && Array.isArray(st.data.agents) ? st.data.agents : []).find(a => r && String(a.id) === r.id) || {};
  const dirty = !!ed && isDirty(ed.draft, ed.stored);
  const name = r ? r.name : agentId;

  // Unsaved-changes guard: run `next` now if clean; otherwise show the prompt and run it after Save/Discard.
  const ask = next => { if (!dirty) return next(); setPending({ run: next }); };
  useEffect(() => { if (guard) guard.current = { dirty, ask }; });
  useEffect(() => () => { if (guard) guard.current = null; }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!dirty) return undefined;
    const h = e => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);
  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(t);
  }, [toast]);

  const limitOf = key => {
    const n = Number(rawAgent[key] && rawAgent[key].edit_limit);
    return Number.isFinite(n) && n > 0 ? n : FALLBACK_LIMIT[key];
  };

  const send = (req, key, onOk) => {
    if (flight.current) return undefined;
    flight.current = true;
    setBusy(true);
    setErr(null);
    return fetchJSON(req.url, { method: req.method, headers: req.headers, body: req.body, credentials: 'same-origin' })
      .then(res => {
        flight.current = false;
        setBusy(false);
        if (res && res.file) setSt(s => ({ ...s, data: patchFile(s.data, agentId, key, res.file) }));
        onOk(res || {});
      })
      .catch(e => {
        flight.current = false;
        setBusy(false);
        const info = errorInfo(parseFailure(e));
        setErr({ kind: info.kind, message: info.message, key });
      });
  };

  const startEdit = key => {
    const f = rawAgent[key];
    if (!f || !editState(f).editable) return;
    const text = typeof f.text === 'string' ? f.text : '';
    setErr(null); setReview(null); setVers(null);
    setEd({ key, draft: text, stored: text, sha: f.sha || '', limit: limitOf(key) });
  };
  const openEdit = key => ask(() => startEdit(key));
  const discardEditor = () => { if (!dirty) return closeEditor(); setPending({ run: closeEditor }); };
  const closeEditor = () => { setEd(null); setReview(null); setErr(null); };

  const openSave = then => {
    if (!ed || !dirty) return;
    if (counterState(countChars(ed.draft), ed.limit).blocked) return;
    setErr(null);
    setReview({ kind: 'save', key: ed.key, text: ed.draft, base_sha: ed.sha, armed: false, then: then || null,
      ops: lineDiff(ed.stored, ed.draft) });
  };

  const confirmSave = () => {
    if (!review || busy) return;
    const extra = needsExtraConfirm(agentId, review.key);
    if (extra && !review.armed) { setReview({ ...review, armed: true }); return; }
    const { key, then, text, base_sha } = review;
    const req = saveRequest({ agent: agentId, file: key, text, base_sha, confirm: extra ? true : undefined });
    // Failures are reported by send(): the review stays open (a 409 'changed' offers Reload; the draft is kept).
    send(req, key, res => {
      setEd(null); setReview(null);
      if (res.saved) setToast({ msg: 'Saved', undo: undoable(res.backup), backup: res.backup, key, sha: res.file && res.file.sha });
      if (then) then();
    });
  };

  const openVersions = key => {
    setErr(null); setReview(null); setVers({ key, list: null, error: '' });
    fetchJSON(versionsUrl(agentId, key))
      .then(d => setVers({ key, list: Array.isArray(d && d.versions) ? d.versions : [], error: '' }))
      .catch(e => setVers({ key, list: [], error: errorInfo(parseFailure(e)).message }));
  };
  const openVersionsGuarded = key => ask(() => openVersions(key));

  const pickVersion = id => {
    if (!vers || flight.current) return;
    const key = vers.key;
    flight.current = true;
    setBusy(true); setErr(null);
    fetchJSON(versionUrl(agentId, key, id))
      .then(v => {
        flight.current = false;
        setBusy(false);
        const f = rawAgent[key] || {};
        setVers(null);
        setReview({ kind: 'restore', key, id: v.id, version: v, text: v.text || '', base_sha: f.sha || '', armed: false,
          then: null, ops: lineDiff(typeof f.text === 'string' ? f.text : '', v.text || '') });
      })
      .catch(e => { flight.current = false; setBusy(false); setErr({ kind: 'load', message: errorInfo(parseFailure(e)).message, key }); });
  };

  const confirmRestore = () => {
    if (!review || busy || review.kind !== 'restore' || !restoreState(review.version).restorable) return;
    const extra = needsExtraConfirm(agentId, review.key);
    if (extra && !review.armed) { setReview({ ...review, armed: true }); return; }
    const { key, id, base_sha } = review;
    const req = restoreRequest({ agent: agentId, file: key, id, base_sha, confirm: extra ? true : undefined });
    send(req, key, res => {
      setEd(null); setReview(null);
      if (res.saved) setToast({ msg: 'Restored', undo: false, backup: null, key });
    });
  };

  const undo = () => {
    if (!toast || busy || !undoable(toast.backup)) return;
    const { key, backup, sha } = toast;
    const req = restoreRequest({ agent: agentId, file: key, id: backup, base_sha: sha, confirm: true });
    send(req, key, res => { if (res.saved) setToast({ msg: 'Restored', undo: false, backup: null, key }); });
  };

  // 409 'changed since loaded': reload the file, keep the draft in the editor (copyable), and ask to save again.
  const reloadKeepDraft = () => {
    if (!err || !err.key || flight.current) return;
    const key = err.key;
    flight.current = true;
    setBusy(true);
    fetchJSON(brainUrl(agentId))
      .then(d => {
        flight.current = false;
        setBusy(false);
        setSt({ status: 'ok', data: d, error: '' });
        const agent = (Array.isArray(d && d.agents) ? d.agents : []).find(a => String(a.id) === agentId) || {};
        const nf = agent[key] || {};
        setEd(e => (e && e.key === key ? { ...e, stored: typeof nf.text === 'string' ? nf.text : '', sha: nf.sha || '', limit: limitOf(key) } : e));
        setReview(null);
        setErr({ kind: 'info', message: "Reloaded the current text. Your draft is still in the editor: compare it, then save again.", key });
      })
      .catch(e => { flight.current = false; setBusy(false); setErr({ kind: 'load', message: errorInfo(parseFailure(e)).message, key }); });
  };

  // ---- render ----
  if (st.status === 'loading') return <p className="dk-bv-detail dk-mem-hint-t" role="status" aria-busy="true">Loading brain…</p>;
  if (st.status === 'error') {
    return (
      <div className="dk-bv dk-bv-detail">
        <div className="dk-err" role="alert">Can't read this brain ({st.error}). <button type="button" className="dk-bv-refresh" onClick={() => setAttempt(n => n + 1)}>Retry</button></div>
      </div>
    );
  }
  if (!r) return <p className="dk-note">Not in the brain list.</p>;

  const overReason = ed ? saveBlockedReason(countChars(ed.draft), ed.limit) : '';
  const prompt = pending && (
    <UnsavedPrompt title={(ed ? FILE_TITLES[ed.key] : 'this file') + ' (' + name + ')'} busy={busy}
      saveBlocked={overReason}
      onSave={() => { if (overReason) return; const run = pending.run; setPending(null); openSave(run); }}
      onDiscard={() => { const run = pending.run; setPending(null); setEd(null); setReview(null); setErr(null); run(); }}
      onKeep={() => setPending(null)} />
  );
  const alert = <Alert err={err} busy={busy} onReload={err && err.kind === 'changed' ? reloadKeepDraft : null} />;
  const toastEl = <Toast toast={toast} busy={busy} onUndo={undo} />;

  if (review) {
    const restore = review.kind === 'restore';
    const rs = restore ? restoreState(review.version) : { restorable: true, reason: '' };
    const label = confirmLabel({ verb: restore ? 'restore' : 'save', name, file: review.key, armed: review.armed });
    return (
      <div className="dk-bv dk-bv-detail dk-be">
        {alert}
        <h4 className="dk-be-h">{(restore ? 'Restore ' : 'Review ') + FILE_TITLES[review.key]}</h4>
        <p className="dk-be-note">{restore ? 'Version from ' + versionLabel(review.version) + '. Current text is the left side.' : "Applies from the agent's next session."}</p>
        <p className="dk-be-sum">{diffSummaryText(review.ops)}</p>
        <DiffList ops={review.ops} />
        {!rs.restorable && <p className="dk-note">{rs.reason}</p>}
        {review.armed && <p className="dk-be-warn" role="note">{'This changes ' + name + "'s " + (review.key === 'user' ? 'profile' : review.key) + '. Tap the button again to confirm.'}</p>}
        <div className="dk-be-acts">
          <button type="button" className="dk-be-btn is-primary" disabled={busy || !rs.restorable}
            onClick={restore ? confirmRestore : confirmSave}>{label}</button>
          <button type="button" className="dk-be-btn" disabled={busy} onClick={() => setReview(null)}>Back to editing</button>
        </div>
        {prompt}{toastEl}
      </div>
    );
  }

  if (vers) {
    return (
      <div className="dk-bv dk-bv-detail dk-be">
        {alert}
        <h4 className="dk-be-h">{'Restore a previous ' + FILE_TITLES[vers.key] + ' version'}</h4>
        {vers.error && <p className="dk-note" role="alert">{vers.error}</p>}
        {vers.list === null && <p className="dk-note" role="status">Loading versions…</p>}
        {vers.list && vers.list.length === 0 && <p className="dk-note">{NO_VERSIONS}</p>}
        {vers.list && vers.list.length > 0 && (
          <ul className="dk-be-vlist">
            {vers.list.map(v => (
              <li key={v.id}>
                <button type="button" className="dk-be-row" disabled={busy} onClick={() => pickVersion(v.id)}>{versionLabel(v)}</button>
              </li>
            ))}
          </ul>
        )}
        <div className="dk-be-acts"><button type="button" className="dk-be-btn" onClick={() => setVers(null)}>Back</button></div>
        {prompt}{toastEl}
      </div>
    );
  }

  const blocks = [['soul', 'Soul', r.soul], ['memory', 'Memory', r.memory], ['user', 'User profile', r.user]];
  return (
    <div className="dk-bv dk-bv-detail dk-be-root">
      {alert}
      {prompt}
      {blocks.map(([key, title, f]) => {
        const raw = rawAgent[key] || {};
        const es = editState(raw);
        const id = 'dk-bv-sheet-' + r.id + '-' + key;
        const editing = !!ed && ed.key === key;
        const control = es.editable ? (
          <div className="dk-be-ctl">
            {!editing && <button type="button" className="dk-be-btn is-primary" aria-label={'Edit ' + title} disabled={busy} onClick={() => openEdit(key)}>Edit</button>}
            {!editing && <button type="button" className="dk-be-link" disabled={busy} onClick={() => openVersionsGuarded(key)}>Restore previous version</button>}
          </div>
        ) : <p className="dk-note">{es.reason}</p>;
        let editor = null;
        if (editing) {
          const c = counterState(countChars(ed.draft), ed.limit);
          editor = (
            <div className="dk-be-ed">
              <p className="dk-be-banner" role="note">Applies from the agent's next session.</p>
              <label className="dk-be-lbl" htmlFor={id + '-ta'}>{title + ' text'}</label>
              <textarea id={id + '-ta'} className={'dk-be-ta' + (c.blocked ? ' is-over' : '')} value={ed.draft} rows={10}
                spellCheck={false} disabled={busy} onChange={e => { const v = e.target.value; setEd(x => ({ ...x, draft: v })); }} />
              <Counter chars={countChars(ed.draft)} limit={ed.limit} />
              <div className="dk-be-acts">
                <button type="button" className="dk-be-btn is-primary" disabled={!dirty || busy || c.blocked} onClick={() => openSave(null)}>Save</button>
                <button type="button" className="dk-be-btn" disabled={busy} onClick={discardEditor}>Discard</button>
              </div>
            </div>
          );
        }
        return <BrainBlock key={key} title={title} f={f} bar={key !== 'soul'} id={id} control={control} editor={editor} />;
      })}
      {toastEl}
    </div>
  );
}
