// Pure display helpers (unit-tested in test/format.test.js).
export function ago(ts, now = Date.now() / 1000) {
  if (!ts) return '—';
  const s = Math.max(0, Math.round(now - ts));
  if (s < 45) return 'now';
  if (Math.round(s / 60) < 60) return Math.round(s / 60) + 'm ago';
  if (Math.round(s / 3600) < 24) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
}
export function compact(n) {
  n = +n || 0;
  if (n >= 999950) n = Math.max(n, 1e6);         // would otherwise round to "1000k"
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k';
  return String(n);
}
/** SVG path for a sparkline in a w×h box. */
export function sparkPath(series, w = 120, h = 28) {
  const s = series && series.length ? series : [0, 0];
  const max = Math.max(1, ...s), step = w / Math.max(1, s.length - 1);
  return s.map((v, i) => `${i ? 'L' : 'M'}${(i * step).toFixed(1)},${(h - 2 - (v / max) * (h - 4)).toFixed(1)}`).join(' ');
}
export function statusLabel(a) {
  return { working: 'working', waiting: 'waiting', idle: 'idle', offline: 'offline' }[a.status] || a.status;
}
export function headline(state) {
  const c = (state && state.counts) || { agents: 0, running: 0 };
  return `${c.agents} agent${c.agents === 1 ? '' : 's'} · ${c.running} running`;
}
