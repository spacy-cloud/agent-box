import { useEffect, useRef } from 'react';

/** Marks the search / filter field of a view: the `/` shortcut moves the focus to the first one on the page. */
export const SEARCH_ATTR = 'data-shortcut-search';

/** Elements that take typed characters (or use letter keys themselves): a shortcut must never fire from them. */
const TYPING =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], [role="combobox"], [role="spinbutton"], .xterm, .cm-editor';

/** Open modal dialogs and menus: a single key belongs to them while they are open. */
const MODAL = 'dialog[open], [aria-modal="true"], [role="menu"]';

/**
 * True when a key press must not trigger a single-key shortcut: modified keys (these belong to the browser, the
 * window and the platform), key repeat, text composition, typing in an input / text area / select / editor /
 * terminal, and any open dialog or menu. A key press that something already handled is left alone.
 */
export function shortcutsSuppressed(e: KeyboardEvent, doc: Document = document): boolean {
  if (e.defaultPrevented || e.repeat || e.isComposing) return true;
  if (e.ctrlKey || e.metaKey || e.altKey) return true;
  const target = e.target instanceof Element ? e.target : doc.activeElement;
  if (target?.closest(TYPING)) return true;
  if (doc.querySelector(MODAL)) return true;
  return false;
}

export type ShortcutName = 'new' | 'search' | 'help';

/** The shortcut a key press stands for (`n`, `/`, `?`), or null. Shift is allowed: `/` and `?` need it on many layouts. */
export function shortcutFor(e: KeyboardEvent): ShortcutName | null {
  switch (e.key) {
    case 'n':
      return e.shiftKey ? null : 'new';
    case '/':
      return 'search';
    case '?':
      return 'help';
    default:
      return null;
  }
}

/** Moves the focus to the search field of the current view; false when the view has none. */
export function focusSearch(doc: Document = document): boolean {
  const el = doc.querySelector<HTMLElement>(`main [${SEARCH_ATTR}]`);
  if (!el || el.closest('[hidden]')) return false;
  el.focus();
  if (el instanceof HTMLInputElement) el.select();
  return true;
}

/** Installs the window-wide key handler for the shortcuts. */
export function useShortcuts(handlers: { onNew(): void; onHelp(): void }): void {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (shortcutsSuppressed(e)) return;
      const which = shortcutFor(e);
      if (which === null) return;
      if (which === 'new') ref.current.onNew();
      else if (which === 'help') ref.current.onHelp();
      else if (!focusSearch()) return;
      // Handled: the character must not end up in the field that just got the focus.
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
