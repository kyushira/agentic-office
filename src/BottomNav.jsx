import { React } from './sdk.js';
import { TABS, tabStep } from './tabs-model.js';

/**
 * Five-tab navigation. Phone (<900px): a fixed 64px bar at the bottom, five equal buttons, active tab has a
 * 2px accent bar on top. Desktop (>=900px): the same tablist as a vertical left rail, reusing the rail's
 * classes (dk-rail, dk-rail-btn, dk-rail-tip). The Inbox badge is the count of items that need the user.
 */

const svg = children => (
  <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false" fill="none"
    stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{children}</svg>
);

const ICONS = {
  home: svg(<path d="M4 11l8-6.5 8 6.5V20h-5.5v-5h-5v5H4z" />),
  agents: svg(<><circle cx="9" cy="8.5" r="3.2" /><path d="M3.5 19.5c.6-3 2.8-4.8 5.5-4.8s4.9 1.8 5.5 4.8" />
    <circle cx="16.5" cy="9.5" r="2.5" /><path d="M16 14.8c2.3.2 4 1.8 4.5 4.2" /></>),
  inbox: svg(<><path d="M4 13l2.5-7.5h11L20 13v5.5H4z" /><path d="M4 13h4.5l1 2h5l1-2H20" /></>),
  usage: svg(<><path d="M4.5 16a7.5 7.5 0 1 1 15 0" /><path d="M12 16l3.5-4" /></>),
  wiki: svg(<><path d="M5 4.5h10.5a2.5 2.5 0 0 1 2.5 2.5V19.5H7.5A2.5 2.5 0 0 1 5 17z" /><path d="M5 17a2.5 2.5 0 0 1 2.5-2.5H18" /></>),
  menu: svg(<path d="M4 7h16M4 12h16M4 17h16" />),
};

const LOGO = (
  <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true" focusable="false">
    <rect x="2.5" y="2.5" width="19" height="19" rx="6" fill="none" stroke="var(--dk-hot)" strokeWidth="1.6" />
    <circle cx="12" cy="12" r="3.2" fill="var(--dk-hot)" />
  </svg>
);

const inboxLabel = n => (n ? `Inbox, ${n} need${n === 1 ? 's' : ''} you` : 'Inbox');

export default function BottomNav({ tab, onTab, needsCount = 0, desktop = false }) {
  const onKey = (e, i) => {
    const next = tabStep(i, e.key, TABS.length);
    if (next < 0) return;
    e.preventDefault();
    onTab(TABS[next].id);
    e.currentTarget.parentElement.querySelectorAll('[role="tab"]')[next].focus();
  };
  return (
    <nav className={'dk-tabnav' + (desktop ? ' dk-rail' : '')} aria-label="Sections">
      {desktop && <span className="dk-rail-logo" aria-hidden="true">{LOGO}</span>}
      <div className={'dk-tabnav-list' + (desktop ? ' dk-rail-list' : '')} role="tablist" aria-label="Office"
        aria-orientation={desktop ? 'vertical' : 'horizontal'}>
        {TABS.map(({ id, label }, i) => {
          const on = tab === id;
          const isInbox = id === 'inbox';
          const aria = isInbox ? inboxLabel(needsCount) : label;
          return (
            <button key={id} id={'dk-tab-' + id} type="button" role="tab" aria-selected={on} aria-label={aria}
              aria-controls="dk-tabpanel" tabIndex={on ? 0 : -1} title={desktop ? aria : undefined}
              className={(desktop ? 'dk-rail-btn' : 'dk-tabnav-btn') + (on ? ' is-on' : '')}
              onClick={() => onTab(id)} onKeyDown={e => onKey(e, i)}>
              {ICONS[id]}
              {!desktop && <span className="dk-tabnav-lbl" aria-hidden="true">{label}</span>}
              {desktop && <span className="dk-rail-tip" aria-hidden="true">{label}</span>}
              {isInbox && needsCount > 0 && <b className="dk-tabnav-badge" aria-hidden="true">{needsCount}</b>}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
