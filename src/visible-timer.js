// Interval that does not run while the document is hidden (design direction: no polling in a background tab).
// The timer stops on visibilitychange to hidden and restarts (running fn once) when the tab is shown again.
// Returns a stop function that also removes the listener.
export function visibleInterval(fn, ms) {
  let id = null;
  const start = () => { if (id == null) id = setInterval(fn, ms); };
  const stop = () => { if (id != null) { clearInterval(id); id = null; } };
  const onVis = () => {
    if (document.hidden) stop();
    else { fn(); start(); }
  };
  if (!document.hidden) start();
  document.addEventListener('visibilitychange', onVis);
  return () => { stop(); document.removeEventListener('visibilitychange', onVis); };
}
