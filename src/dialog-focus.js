// useDialogFocus(ref, onClose, getReturn): focus the dialog on mount, trap Tab inside it,
// Escape -> latest onClose, and on unmount restore focus to getReturn() (the element that
// opened the dialog, e.g. the agent tile), falling back to the element focused at open.
// The opener is captured at open, but on iOS Safari / JS clicks it can be <body>.
import { useEffect, useRef } from './sdk.js';

const FOCUSABLE = 'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function useDialogFocus(ref, onClose, getReturn) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const getReturnRef = useRef(getReturn);
  getReturnRef.current = getReturn;

  useEffect(() => {
    const opener = document.activeElement;
    const list = () => (ref.current ? Array.from(ref.current.querySelectorAll(FOCUSABLE)) : []);
    (list()[0] || ref.current)?.focus();

    const onKey = e => {
      if (e.key === 'Escape') return onCloseRef.current?.();
      if (e.key !== 'Tab') return;
      const items = list();
      if (!items.length) return e.preventDefault();
      const head = items[0], tail = items[items.length - 1];
      const active = document.activeElement;
      const inside = !!ref.current && active !== ref.current && ref.current.contains(active);
      if (e.shiftKey ? (active === head || !inside) : (active === tail || !inside)) {
        e.preventDefault();
        (e.shiftKey ? tail : head).focus();
      }
    };

    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      const target = (getReturnRef.current && getReturnRef.current()) || opener;
      if (target && document.contains(target) && target.focus) target.focus({ preventScroll: true });
    };
  }, []);
}
