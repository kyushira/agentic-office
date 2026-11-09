// Pure helpers for the Server card. Feeds from GET /api/plugins/agent-office/server only.
// No DOM, no fetch, no timers. Contract: {ts, mem:{total_mb,available_mb,used_mb,used_pct},
// disk:{path,total_gb,free_gb,free_pct}|null, load:{one,five,fifteen,cores}|null, top:[{name,rss_mb}]|null}.

export const RAM_OK_MB = 1024;       // available at or above this: OK
export const RAM_CRITICAL_MB = 500;  // available below this: Critical (the ring pulses)
export const DISK_WARN_PCT = 10;     // free below this percent: the disk bar warns

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const clamp = v => Math.max(0, Math.min(100, v));

/** RAM level from available MB: ok >= 1024, low 500..1023, critical < 500. null when not a number. */
export function ramLevel(availableMb) {
  if (!isNum(availableMb)) return null;
  if (availableMb < RAM_CRITICAL_MB) return { level: 'critical', word: 'Critical' };
  if (availableMb < RAM_OK_MB) return { level: 'low', word: 'Low' };
  return { level: 'ok', word: 'OK' };
}

/** MB to GB with one decimal, as a bare number string (the unit is added by the caller). Missing gives an em dash. */
export function fmtGB(mb) {
  if (!isNum(mb)) return '—';
  return (Math.round((mb / 1024) * 10) / 10).toFixed(1);
}

/** Whole MB with its unit: '629 MB'. Missing gives an em dash. */
export function fmtMB(mb) {
  if (!isNum(mb)) return '—';
  return `${Math.round(mb)} MB`;
}

/** Clock time HH:MM (24h, local time) from unix seconds. Missing gives an em dash. */
export function fmtTime(ts) {
  if (!isNum(ts)) return '—';
  const d = new Date(ts * 1000);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** True when free disk is under the warn threshold (strictly below 10%). */
export function diskWarn(disk) {
  return !!disk && isNum(disk.free_pct) && disk.free_pct < DISK_WARN_PCT;
}

/** '41 GB free'. Under 10 GB keeps one decimal so '0 GB free' never hides a real 0.4 GB. */
export function diskFreeText(freeGb) {
  if (!isNum(freeGb)) return '—';
  const v = freeGb < 10 ? (Math.round(freeGb * 10) / 10).toFixed(1) : String(Math.round(freeGb));
  return `${v} GB free`;
}

/** 'Load 1.42 · 4 cores' (one-minute load, 2dp). Null load gives null. */
export function loadLine(load) {
  if (!load || !isNum(load.one)) return null;
  const cores = isNum(load.cores) ? ` · ${load.cores} ${load.cores === 1 ? 'core' : 'cores'}` : '';
  return `Load ${load.one.toFixed(2)}${cores}`;
}

/** Up to three top-memory rows. Null top gives null (the card shows a DEMO tag). */
export function topRows(top) {
  if (!Array.isArray(top)) return null;
  return top.slice(0, 3).map(t => ({
    name: String((t && t.name) || 'unknown'),
    mbText: fmtMB(t && t.rss_mb),
  }));
}

/** A payload the card can draw: mem present with numeric totals. Anything else is treated as an error. */
export function validServer(p) {
  if (!p || typeof p !== 'object') return false;
  const m = p.mem;
  return !!m && typeof m === 'object' && isNum(m.total_mb) && isNum(m.available_mb) && isNum(m.used_mb);
}

/** Ring arc percent: used_pct when given, else used/total. Clamped 0..100. null when neither works. */
function memPct(m) {
  if (isNum(m.used_pct)) return clamp(m.used_pct);
  if (isNum(m.total_mb) && m.total_mb > 0 && isNum(m.used_mb)) return clamp((m.used_mb / m.total_mb) * 100);
  return null;
}

function buildRam(m) {
  const lvl = ramLevel(m.available_mb);
  const used = fmtGB(m.used_mb);
  const total = fmtGB(m.total_mb);
  return {
    pct: memPct(m),
    centre: `${used} / ${total} GB`,
    free: `Free ${fmtMB(m.available_mb)}`,
    level: lvl.level,
    word: lvl.word,
    pulse: lvl.level === 'critical',
    aria: `RAM ${used} of ${total} GB used, free ${fmtMB(m.available_mb)}, ${lvl.word}`,
  };
}

function buildDisk(d) {
  const warn = diskWarn(d);
  return {
    label: `Disk ${d.path || '/'}`,
    free: diskFreeText(d.free_gb),
    fillPct: isNum(d.free_pct) ? clamp(100 - d.free_pct) : null,   // the bar shows the used share
    warn,
  };
}

/**
 * The card's display model.
 * Inputs: data (the current good payload or null), lastGood (the last good payload ever seen),
 * error (last fetch failed), pending (a fetch is in flight).
 * mode: 'loading' (nothing to show yet) | 'ok' | 'error'. In 'error', `stale` means lastGood values are shown dimmed.
 * Sections that are null in the payload come back with demo: true (shown as an em dash plus a DEMO tag).
 */
export function view({ data = null, lastGood = null, error = false, pending = false } = {}) {
  const cur = validServer(data) ? data : null;
  const last = validServer(lastGood) ? lastGood : null;
  const mode = cur ? 'ok' : error ? 'error' : 'loading';
  const stale = mode === 'error' && !!last;
  const shown = cur || (stale ? last : null);

  const disk = shown && shown.disk ? buildDisk(shown.disk) : null;
  const load = shown ? loadLine(shown.load) : null;
  const top = shown ? topRows(shown.top) : null;

  return {
    mode,
    stale,
    pending,
    refreshDisabled: !!pending,
    updated: cur ? fmtTime(cur.ts) : '—',
    lastGood: last ? fmtTime(last.ts) : null,
    ram: shown ? buildRam(shown.mem) : null,
    disk: shown ? (disk ? { ...disk, demo: false } : { demo: true }) : null,
    load: shown ? { text: load || '—', demo: !load } : null,
    top: shown ? { rows: top || [], demo: top == null } : null,
  };
}
