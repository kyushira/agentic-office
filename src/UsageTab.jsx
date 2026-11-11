// Usage tab (batch 1 / P1): plan rings, a 1d | 7d | 30d window, per-agent bars, and a daily trend.
// Pure logic lives in usage-model.js. Polls /usage and /usage/breakdown every 60s, only while this tab is mounted
// and the page is visible (visibleInterval). A failed poll keeps the last good data and shows a stale badge.
import { React, fetchJSON, USAGE_API, USAGE_BREAKDOWN_API } from './sdk.js';
import { UsageRings } from './UsageRings.jsx';
import { visibleInterval } from './visible-timer.js';
import {
  USAGE_POLL_MS, DEFAULT_DAYS, validDays, windowChips, agentBars, totalsView, hasAnyCost, hasAgents, trendStack,
  errorLines, compactTokens,
} from './usage-model.js';

const { useState, useEffect, useRef } = React;

/** Window chips as a radiogroup with roving tabindex; arrow keys move and select (same pattern as the Deck pane tabs). */
function WindowChips({ selected, onPick }) {
  const chips = windowChips(selected);
  const onKey = (e, i) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const next = (i + step + chips.length) % chips.length;
    onPick(chips[next].id);
    e.currentTarget.parentElement.querySelectorAll('[role="radio"]')[next].focus();
  };
  return (
    <div className="dk-seg dk-ut-chips" role="radiogroup" aria-label="Window">
      {chips.map((c, i) => (
        <button key={c.id} type="button" role="radio" aria-checked={c.selected} tabIndex={c.selected ? 0 : -1}
          className={'dk-seg-btn' + (c.selected ? ' is-on' : '')} onClick={() => onPick(c.id)}
          onKeyDown={e => onKey(e, i)}>{c.label}</button>
      ))}
    </div>
  );
}

/** One agent: a button (aria-expanded) with name, tokens, share bar and cost; the detail holds the provider split. */
function AgentRow({ r, open, onToggle, showCost }) {
  const id = 'dk-ua-' + r.agent.replace(/[^A-Za-z0-9_-]/g, '_');
  return (
    <li className="dk-ut-row">
      <button type="button" className="dk-ut-rowbtn" aria-expanded={open} aria-controls={id} onClick={onToggle}>
        <span className="dk-ut-name"><i className="dk-ut-sw" style={{ background: r.colour }} aria-hidden="true" />{r.label}</span>
        <span className="dk-ut-tok">{compactTokens(r.tokens)} tok <small>{r.sharePct}%</small></span>
        <span className="dk-ut-track" aria-hidden="true"><i style={{ width: `${r.share * 100}%`, background: r.colour }} /></span>
        <span className="dk-ut-meta">
          {showCost && <span className="dk-ut-cost">{r.costText}
            {r.costBadge && <span className={'dk-ut-badge ' + r.costBadge.cls}>{r.costBadge.label}</span>}</span>}
          <span>{r.sessions} sess</span>
        </span>
      </button>
      <div id={id} className="dk-ut-detail" hidden={!open}>
        <p className="dk-ut-sub">Providers</p>
        {r.providers.length
          ? <ul className="dk-ut-prov">{r.providers.map(p => (
              <li key={p.key}><span>{p.label}</span><b>{compactTokens(p.tokens)} · {Math.round(p.share * 100)}%</b></li>))}</ul>
          : <p className="dk-note">no provider data</p>}
        <dl className="dk-ut-dl">
          <dt>Input</dt><dd>{compactTokens(r.input)}</dd>
          <dt>Output</dt><dd>{compactTokens(r.output)}</dd>
          <dt>Cache read</dt><dd>{compactTokens(r.cache_read)}</dd>
          <dt>Cache write</dt><dd>{compactTokens(r.cache_write)}</dd>
          <dt>Reasoning</dt><dd>{compactTokens(r.reasoning)}</dd>
        </dl>
        <p className="dk-note">Tokens are input + output. Cache and reasoning are shown apart.</p>
      </div>
    </li>
  );
}

/** Daily trend: one column per UTC day, stacked by agent. Heights are relative to the largest day; empty days stay as flat tracks. */
function Trend({ trend, dayPick, setDayPick }) {
  const days = trend.days;
  const picked = days.find(d => d.day === dayPick) || null;
  const first = days[0], last = days[days.length - 1];
  return (
    <div className="dk-ut-trend">
      <div className="dk-ut-cols" role="group" aria-label="Daily tokens, tap a day for details">
        {days.map(d => {
          const on = dayPick === d.day;
          return (
            <button key={d.day} type="button" className={'dk-ut-col' + (d.empty ? ' is-empty' : '') + (on ? ' is-on' : '')}
              aria-pressed={on} aria-label={d.aria} title={d.aria} onClick={() => setDayPick(on ? null : d.day)}>
              <span className="dk-ut-fill" style={{ height: `${d.heightPct}%` }} aria-hidden="true">
                {d.segments.map(s => (
                  <i key={s.agent} style={{ flexGrow: s.tokens, background: s.colour }} title={`${s.agent}: ${compactTokens(s.tokens)}`} />
                ))}
              </span>
            </button>);
        })}
      </div>
      <div className="dk-ut-axis" aria-hidden="true"><span>{first ? first.label : ''}</span><span>{last ? last.label : ''}</span></div>
      <p className="dk-ut-dayline" aria-live="polite">
        {picked ? `${picked.day}: ${compactTokens(picked.tokens)} tok · ${picked.costText}` : 'Tap a day for tokens and cost.'}
      </p>
    </div>);
}

export default function UsageTab({ usage, agents, now }) {
  const [days, setDays] = useState(DEFAULT_DAYS);
  const [own, setOwn] = useState(null);             // last good GET /usage
  const [ownStale, setOwnStale] = useState(false);
  const [bd, setBd] = useState(null);               // {days, data}: last good GET /usage/breakdown and its window
  const [bdStale, setBdStale] = useState(false);
  const [openAgent, setOpenAgent] = useState(null);
  const [dayPick, setDayPick] = useState(null);
  const seqUsage = useRef(0), seqBd = useRef(0);    // a response is applied only if it is the newest request

  // Plan usage: 60s while mounted and visible. Starts at once when the page is already visible.
  useEffect(() => {
    let live = true;
    const pull = () => {
      const mine = ++seqUsage.current;
      fetchJSON(USAGE_API)
        .then(u => { if (live && mine === seqUsage.current) { setOwn(u); setOwnStale(false); } })
        .catch(() => { if (live && mine === seqUsage.current) setOwnStale(true); });
    };
    if (!document.hidden) pull();
    const stop = visibleInterval(pull, USAGE_POLL_MS);
    return () => { live = false; stop(); };
  }, []);

  // Breakdown: refetched at once when the window changes (the effect re-runs), then every 60s while visible.
  useEffect(() => {
    let live = true;
    const pull = () => {
      const mine = ++seqBd.current;
      fetchJSON(`${USAGE_BREAKDOWN_API}?days=${days}`)
        .then(d => { if (live && mine === seqBd.current) { setBd({ days, data: d }); setBdStale(false); } })
        .catch(() => { if (live && mine === seqBd.current) setBdStale(true); });
    };
    if (!document.hidden) pull();
    const stop = visibleInterval(pull, USAGE_POLL_MS);
    return () => { live = false; stop(); };
  }, [days]);

  const pick = id => {
    const next = validDays(id);
    if (next === days) return;
    setDays(next);
    setOpenAgent(null);
    setDayPick(null);
  };

  const cur = bd && bd.days === days ? bd.data : null;      // never show one window's numbers under another's chip
  const stale = (ownStale && !!own) || (bdStale && !!cur);
  const liveUsage = own || usage || null;
  const bars = cur ? agentBars(cur, agents) : [];
  const totals = totalsView(cur);
  const showCost = hasAnyCost(cur);
  const trend = trendStack(cur && cur.trend, bars.map(b => b.agent), agents);
  const errs = errorLines(cur);

  let body;
  if (!cur) {
    body = bdStale
      ? <p className="dk-note dk-ut-msg" role="status">Usage breakdown unavailable. Retrying every 60s.</p>
      : <div className="dk-ut-skel" aria-busy="true" aria-label="Loading usage"><span /><span /><span /></div>;
  } else if (!hasAgents(cur)) {
    body = <p className="dk-note dk-ut-msg" role="status">No agent usage in the last {days} {days === 1 ? 'day' : 'days'}.</p>;
  } else {
    body = (<>
      <dl className="dk-ut-totals">
        <div><dt>Tokens</dt><dd>{totals.tokensText}</dd></div>
        <div><dt>Cost</dt><dd className={totals.hasCost ? '' : 'is-none'}>{totals.costText}</dd></div>
        <div><dt>API calls</dt><dd>{totals.apiCallsText}</dd></div>
      </dl>
      <ul className="dk-ut-bars">
        {bars.map(r => <AgentRow key={r.agent} r={r} showCost={showCost}
          open={openAgent === r.agent} onToggle={() => setOpenAgent(openAgent === r.agent ? null : r.agent)} />)}
      </ul>
      <section className="dk-ut-card dk-ut-trendcard" aria-labelledby="dk-ut-trend-h">
        <h3 id="dk-ut-trend-h" className="dk-ut-h">Daily tokens</h3>
        <Trend trend={trend} dayPick={dayPick} setDayPick={setDayPick} />
      </section>
    </>);
  }

  return (
    <div className="dk-usage-tab">
      <section id="dk-usage-rings" className="dk-uplan" aria-label="Plan usage">
        <UsageRings usage={liveUsage} now={now} />
      </section>
      <section className="dk-ut-card" aria-labelledby="dk-ut-agents-h">
        <div className="dk-ut-head">
          <h2 id="dk-ut-agents-h" className="dk-ut-h">Agents</h2>
          {stale && <span className="dk-ut-stale" role="status" title="The last refresh failed. Showing the last good data.">stale</span>}
        </div>
        <WindowChips selected={days} onPick={pick} />
        {body}
      </section>
      <footer className="dk-ut-foot">
        {errs.map(line => <p key={line} className="dk-note dk-ut-err" role="status">{line}</p>)}
        <p className="dk-note">Claude % estimated, account-wide.</p>
      </footer>
    </div>);
}
