import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';

export interface MenuAction {
  id: string;
  label: string;
  onSelect(): void;
  /** Destructive entry: drawn in the danger colour. The action itself still asks for its confirmation. */
  danger?: boolean;
  /** Shown but not usable (`aria-disabled`; stays reachable with the arrow keys so it can be read out). */
  disabled?: boolean;
  /** Tooltip, e.g. why an entry is disabled. */
  title?: string;
}

/** Index of the next entry in `dir` (wrapping), starting from `from`; -1 when there are no entries. */
export function nextMenuIndex(count: number, from: number, dir: 1 | -1): number {
  if (count <= 0) return -1;
  if (from < 0) return dir === 1 ? 0 : count - 1;
  return (from + dir + count) % count;
}

/**
 * The "⋯" button of a table row (or a toolbar) with a menu of the less used actions
 * (WAI-ARIA menu button pattern): the button has `aria-haspopup="menu"` and `aria-expanded`; Enter, Space and
 * the arrow keys open the menu and put the focus on its first (Arrow up: last) entry; the arrow keys, Home
 * and End move through the entries, Escape closes the menu and gives the focus back to the button, a click
 * outside or Tab closes it. The menu is drawn in a layer of its own (`position: fixed`), so a scrolling
 * table wrapper cannot clip it. Choosing an entry closes the menu first and then runs the action; an action
 * that is irreversible keeps asking for its confirmation in a dialog of its own.
 */
export function OverflowMenu(props: {
  /** Accessible name of the button, naming the row ("More actions: alpha"). */
  label: string;
  items: readonly MenuAction[];
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [start, setStart] = useState<'first' | 'last'>('first');
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  }, []);

  // Place the menu below the button, right-aligned; above it when the space below is too small.
  useLayoutEffect(() => {
    const el = menu.current;
    const btn = trigger.current;
    if (!open || !el || !btn) return;
    const r = btn.getBoundingClientRect();
    const m = el.getBoundingClientRect();
    const below = r.bottom + 4;
    const top =
      below + m.height > window.innerHeight - 8 ? Math.max(8, r.top - 4 - m.height) : below;
    const left = Math.min(
      Math.max(8, r.right - m.width),
      Math.max(8, window.innerWidth - m.width - 8),
    );
    el.style.top = `${top}px`;
    el.style.left = `${left}px`;
  }, [open]);

  // Focus an entry when the menu opens (the menu itself when it has none).
  useEffect(() => {
    if (!open) return;
    const entries = menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]');
    const target =
      entries && entries.length > 0 ? entries[start === 'first' ? 0 : entries.length - 1] : null;
    (target ?? menu.current)?.focus();
  }, [open, start]);

  // Close on a click outside, on resize and when something scrolls (the menu does not follow the button).
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: Event) => {
      const t = e.target as Node | null;
      if (t && (menu.current?.contains(t) || trigger.current?.contains(t))) return;
      setOpen(false);
    };
    const onScroll = (e: Event) => {
      if (e.target instanceof Node && menu.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onResize = () => setOpen(false);
    document.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);

  function onTriggerKey(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setStart(e.key === 'ArrowDown' ? 'first' : 'last');
      setOpen(true);
    }
  }

  function onMenuKey(e: KeyboardEvent<HTMLDivElement>) {
    const entries = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = entries.findIndex((x) => x === document.activeElement);
    const move = (i: number) => {
      e.preventDefault();
      entries[i]?.focus();
    };
    switch (e.key) {
      case 'ArrowDown':
        return move(nextMenuIndex(entries.length, at, 1));
      case 'ArrowUp':
        return move(nextMenuIndex(entries.length, at, -1));
      case 'Home':
        return move(0);
      case 'End':
        return move(entries.length - 1);
      case 'Escape':
        // Only the menu closes (not a dialog or a decision handler around the row).
        e.preventDefault();
        e.stopPropagation();
        return close(true);
      case 'Tab':
        // Focus continues from the button: the menu is not part of the tab order.
        trigger.current?.focus();
        return setOpen(false);
      default:
    }
  }

  function choose(item: MenuAction) {
    if (item.disabled) return;
    // The button gets the focus back first: a dialog opened by the action returns to it when it closes.
    close(true);
    item.onSelect();
  }

  const host = open ? (trigger.current?.closest('dialog, main') ?? document.body) : null;
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`menu-trigger${props.className ? ` ${props.className}` : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={props.label}
        title={props.label}
        onClick={() => {
          if (open) return close(false);
          setStart('first');
          setOpen(true);
        }}
        onKeyDown={onTriggerKey}
      >
        <span aria-hidden="true">⋯</span>
      </button>
      {host
        ? createPortal(
            <div
              ref={menu}
              id={menuId}
              role="menu"
              aria-label={props.label}
              tabIndex={-1}
              className="menu"
              onKeyDown={onMenuKey}
            >
              {props.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  className={`menu-item${item.danger ? ' danger' : ''}`}
                  aria-disabled={item.disabled ? true : undefined}
                  title={item.title}
                  onClick={() => choose(item)}
                >
                  {item.label}
                </button>
              ))}
            </div>,
            host,
          )
        : null}
    </>
  );
}
