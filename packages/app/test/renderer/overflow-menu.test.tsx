// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OverflowMenu, nextMenuIndex } from '../../src/renderer/components/OverflowMenu';
import type { MenuAction } from '../../src/renderer/components/OverflowMenu';

afterEach(cleanup);

function setup(over: Partial<Record<'open' | 'remove' | 'locked', () => void>> = {}) {
  const open = over.open ?? vi.fn();
  const remove = over.remove ?? vi.fn();
  const locked = over.locked ?? vi.fn();
  const items: MenuAction[] = [
    { id: 'open', label: 'Open', onSelect: open },
    { id: 'locked', label: 'Locked', disabled: true, title: 'not now', onSelect: locked },
    { id: 'remove', label: 'Delete', danger: true, onSelect: remove },
  ];
  render(
    <div>
      <button type="button">before</button>
      <OverflowMenu label="More actions: alpha" items={items} />
      <button type="button">after</button>
    </div>,
  );
  const trigger = screen.getByRole('button', { name: 'More actions: alpha' });
  return { trigger, open, remove, locked };
}

const itemsOf = () => screen.getAllByRole('menuitem');

describe('nextMenuIndex', () => {
  it('wraps around and handles an empty menu', () => {
    expect(nextMenuIndex(3, 0, 1)).toBe(1);
    expect(nextMenuIndex(3, 2, 1)).toBe(0);
    expect(nextMenuIndex(3, 0, -1)).toBe(2);
    expect(nextMenuIndex(3, -1, 1)).toBe(0);
    expect(nextMenuIndex(3, -1, -1)).toBe(2);
    expect(nextMenuIndex(0, -1, 1)).toBe(-1);
  });
});

describe('OverflowMenu', () => {
  it('is a menu button: closed it has no menu, open it announces the state', () => {
    const { trigger } = setup();
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const menu = screen.getByRole('menu', { name: 'More actions: alpha' });
    expect(trigger.getAttribute('aria-controls')).toBe(menu.id);
    expect(itemsOf().map((x) => x.textContent)).toEqual(['Open', 'Locked', 'Delete']);
  });

  it('focuses the first entry on open; arrow keys, Home and End move and wrap', () => {
    const { trigger } = setup();
    fireEvent.click(trigger);
    const [a, b, c] = itemsOf() as [HTMLElement, HTMLElement, HTMLElement];
    expect(document.activeElement).toBe(a);
    const menu = screen.getByRole('menu');
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(b);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(c);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(a);
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(c);
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(document.activeElement).toBe(a);
    fireEvent.keyDown(menu, { key: 'End' });
    expect(document.activeElement).toBe(c);
  });

  it('opens with Arrow down (first entry) and Arrow up (last entry) on the button', () => {
    const { trigger } = setup();
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(itemsOf()[0]);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.keyDown(trigger, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(itemsOf()[2]);
  });

  it('Escape closes the menu and returns the focus to the button', () => {
    const { trigger } = setup();
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('a click outside closes it (focus stays where the click put it), a click on the button toggles', () => {
    const { trigger } = setup();
    fireEvent.click(trigger);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'after' }));
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(trigger);
    fireEvent.pointerDown(screen.getByRole('menu'));
    expect(screen.queryByRole('menu')).not.toBeNull();
    fireEvent.click(trigger);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('Tab closes it and continues from the button', () => {
    const { trigger } = setup();
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Tab' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('choosing an entry closes the menu, returns the focus and runs the action once', () => {
    const { trigger, open, remove } = setup();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open' }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('a destructive entry is drawn as danger; a disabled one does nothing and keeps the menu open', () => {
    const { trigger, locked } = setup();
    fireEvent.click(trigger);
    expect(screen.getByRole('menuitem', { name: 'Delete' }).className).toContain('danger');
    const lockedItem = screen.getByRole('menuitem', { name: 'Locked' });
    expect(lockedItem.getAttribute('aria-disabled')).toBe('true');
    expect(lockedItem.title).toBe('not now');
    fireEvent.click(lockedItem);
    expect(locked).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).not.toBeNull();
  });
});
