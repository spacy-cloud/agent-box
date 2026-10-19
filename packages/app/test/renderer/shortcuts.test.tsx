// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  focusSearch,
  shortcutFor,
  shortcutsSuppressed,
  useShortcuts,
} from '../../src/renderer/shortcuts';

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

function Host(props: { onNew(): void; onHelp(): void; children?: React.ReactNode }) {
  useShortcuts({ onNew: props.onNew, onHelp: props.onHelp });
  return <main>{props.children}</main>;
}

function mount(children?: React.ReactNode) {
  const onNew = vi.fn();
  const onHelp = vi.fn();
  const r = render(
    <Host onNew={onNew} onHelp={onHelp}>
      {children}
    </Host>,
  );
  return { onNew, onHelp, ...r };
}

const press = (target: Element | Window, key: string, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(target, { key, ...init });

describe('shortcutFor', () => {
  const ev = (key: string, init: KeyboardEventInit = {}) =>
    new KeyboardEvent('keydown', { key, ...init });
  it('maps n, / and ?; capital N is not n', () => {
    expect(shortcutFor(ev('n'))).toBe('new');
    expect(shortcutFor(ev('N', { shiftKey: true }))).toBeNull();
    expect(shortcutFor(ev('/'))).toBe('search');
    expect(shortcutFor(ev('/', { shiftKey: true }))).toBe('search'); // Shift+7 on a German layout
    expect(shortcutFor(ev('?', { shiftKey: true }))).toBe('help');
    expect(shortcutFor(ev('x'))).toBeNull();
  });
});

describe('shortcuts', () => {
  it('n opens "New sandbox", ? opens the help', () => {
    const { onNew, onHelp } = mount();
    press(document.body, 'n');
    expect(onNew).toHaveBeenCalledTimes(1);
    press(document.body, '?', { shiftKey: true });
    expect(onHelp).toHaveBeenCalledTimes(1);
  });

  it('/ focuses (and selects) the search field of the view and swallows the character', () => {
    const { container } = mount(<input type="search" data-shortcut-search="" defaultValue="abc" />);
    const input = container.querySelector('input')!;
    const ok = fireEvent.keyDown(document.body, { key: '/' });
    expect(document.activeElement).toBe(input);
    expect(ok).toBe(false); // preventDefault: no "/" typed into the field
  });

  it('/ in a view without a search field does nothing (the key stays untouched)', () => {
    const { onNew, onHelp } = mount();
    const ok = fireEvent.keyDown(document.body, { key: '/' });
    expect(ok).toBe(true);
    expect(onNew).not.toHaveBeenCalled();
    expect(onHelp).not.toHaveBeenCalled();
  });

  /** An element to put the focus target in, and the target itself. */
  const el = (tag: string, attrs: Record<string, string> = {}) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
  };
  const inside = (wrapper: HTMLElement, tag: string) => {
    const e = document.createElement(tag);
    wrapper.appendChild(e);
    return { root: wrapper, target: e };
  };
  it.each([
    ['input', () => ({ root: el('input'), target: el('input') })],
    ['textarea', () => ({ root: el('textarea'), target: el('textarea') })],
    ['select', () => ({ root: el('select'), target: el('select') })],
    ['contenteditable', () => ({ root: el('div', { contenteditable: 'true' }), target: null })],
    ['role textbox', () => ({ root: el('div', { role: 'textbox' }), target: null })],
    ['terminal (xterm)', () => inside(el('div', { class: 'xterm' }), 'textarea')],
    ['code editor', () => inside(el('div', { class: 'cm-editor' }), 'div')],
  ])('does not fire while typing in a %s', (_name, make) => {
    const { onNew, onHelp, container } = mount();
    const { root, target } = make();
    container.appendChild(root);
    const el0 = target ?? root;
    el0.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true }));
    el0.dispatchEvent(new KeyboardEvent('keydown', { key: '?', shiftKey: true, bubbles: true }));
    expect(onNew).not.toHaveBeenCalled();
    expect(onHelp).not.toHaveBeenCalled();
  });

  it('does not fire while a dialog or a menu is open', () => {
    const { onNew } = mount();
    const dlg = document.createElement('dialog');
    dlg.setAttribute('open', '');
    document.body.appendChild(dlg);
    press(document.body, 'n');
    expect(onNew).not.toHaveBeenCalled();
    dlg.remove();
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    document.body.appendChild(menu);
    press(document.body, 'n');
    expect(onNew).not.toHaveBeenCalled();
    menu.remove();
    press(document.body, 'n');
    expect(onNew).toHaveBeenCalledTimes(1);
  });

  it('leaves browser and Electron accelerators alone (Ctrl, Meta, Alt)', () => {
    const { onNew, onHelp } = mount();
    press(document.body, 'n', { ctrlKey: true });
    press(document.body, 'n', { metaKey: true });
    press(document.body, 'n', { altKey: true });
    press(document.body, '?', { ctrlKey: true, shiftKey: true });
    expect(onNew).not.toHaveBeenCalled();
    expect(onHelp).not.toHaveBeenCalled();
  });

  it('ignores key repeat, composition and keys that something already handled', () => {
    const { onNew } = mount();
    press(document.body, 'n', { repeat: true });
    press(document.body, 'n', { isComposing: true });
    expect(onNew).not.toHaveBeenCalled();
    const e = new KeyboardEvent('keydown', { key: 'n', bubbles: true, cancelable: true });
    e.preventDefault();
    expect(shortcutsSuppressed(e)).toBe(true);
  });

  it('works from a focused button (a normal page, not a text field)', () => {
    const { onNew, container } = mount(<button type="button">x</button>);
    const b = container.querySelector('button')!;
    b.focus();
    press(b, 'n');
    expect(onNew).toHaveBeenCalledTimes(1);
  });
});

describe('focusSearch', () => {
  it('skips a search field in a hidden panel', () => {
    document.body.innerHTML = '<main><section hidden><input data-shortcut-search></section></main>';
    expect(focusSearch()).toBe(false);
  });
});
