import { useEffect, useRef } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Keeps Tab cycling inside a modal and restores focus on close.
 * Dialogs here are plain fixed-position divs, so without this a keyboard user
 * tabs straight out of the dialog into the page behind it.
 */
/** Open traps, innermost last: only the top one handles Tab. */
const openTraps: HTMLElement[] = [];

export function useFocusTrap<T extends HTMLElement>(active = true) {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    if (!active) return;
    const node = ref.current;
    if (!node) return;
    const previous = document.activeElement as HTMLElement | null;

    const focusables = (): HTMLElement[] =>
      Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (element) => element.getClientRects().length > 0,
      );

    if (!node.contains(document.activeElement)) {
      focusables()[0]?.focus();
    }

    // On the document, not the dialog: after a click on the backdrop or a
    // removed element, focus sits on <body> and Tab would leave the dialog.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || openTraps[openTraps.length - 1] !== node) return;
      const list = focusables();
      if (list.length === 0) return;
      const index = list.indexOf(document.activeElement as HTMLElement);
      if (index === -1) {
        event.preventDefault();
        (event.shiftKey ? list[list.length - 1] : list[0])?.focus();
      } else if (event.shiftKey && index === 0) {
        event.preventDefault();
        list[list.length - 1]?.focus();
      } else if (!event.shiftKey && index === list.length - 1) {
        event.preventDefault();
        list[0]?.focus();
      }
    };

    openTraps.push(node);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      openTraps.splice(openTraps.lastIndexOf(node), 1);
      previous?.focus();
    };
  }, [active]);

  return ref;
}
