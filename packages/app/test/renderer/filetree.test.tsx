// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DirEntry } from '@abox/core';
import { FileTree } from '../../src/renderer/components/FileTree';
import type { TreeSelection } from '../../src/renderer/components/FileTree';
import { HIDDEN_CHARS, RLO } from './fixtures';
import { installBridge, renderApp } from './harness';

afterEach(cleanup);

const e = (name: string, type: DirEntry['type'] = 'file', size = 10): DirEntry => ({
  name,
  type,
  size,
  mode: 0o644,
  mtimeMs: Date.UTC(2026, 0, 2, 3, 4, 5),
});

const TREE: Record<string, DirEntry[]> = {
  '': [e('README.md'), e('src', 'dir'), e('empty', 'dir'), e('broken', 'dir'), e(`ev${RLO}il.sh`)],
  src: [e('main.ts'), e('lib', 'dir'), e('link', 'symlink')],
  'src/lib': [e('util.ts')],
  empty: [],
};

function mount(
  over: { load?: (p: string) => Promise<DirEntry[]>; onSelect?: (s: TreeSelection) => void } = {},
) {
  installBridge(() => undefined);
  const load = vi.fn(
    over.load ??
      ((p: string) => {
        if (p === 'broken') return Promise.reject(new Error('permission denied'));
        return Promise.resolve(TREE[p] ?? []);
      }),
  );
  const onSelect = over.onSelect ?? vi.fn();
  renderApp(
    <FileTree
      load={load}
      reloadKey={0}
      rootLabel="Workspace"
      label="Verzeichnis"
      onSelect={onSelect}
    />,
  );
  return { load, onSelect: onSelect as ReturnType<typeof vi.fn> };
}

const item = (name: RegExp | string) => screen.getByRole('treeitem', { name });

describe('FileTree', () => {
  it('loads only the root at first, folders on demand and each folder once', async () => {
    const { load } = mount();
    await screen.findByRole('treeitem', { name: /README.md/ });
    expect(load.mock.calls.map((c) => c[0])).toEqual(['']);
    fireEvent.click(item(/^src\//));
    await screen.findByRole('treeitem', { name: /main.ts/ });
    expect(load.mock.calls.map((c) => c[0])).toEqual(['', 'src']);
    // close and open again: no second fetch
    fireEvent.click(item(/^src\//));
    expect(screen.queryByRole('treeitem', { name: /main.ts/ })).toBeNull();
    fireEvent.click(item(/^src\//));
    await screen.findByRole('treeitem', { name: /main.ts/ });
    expect(load.mock.calls.filter((c) => c[0] === 'src')).toHaveLength(1);
  });

  it('has tree semantics: levels, set sizes, expanded state and one tab stop', async () => {
    mount();
    await screen.findByRole('treeitem', { name: /README.md/ });
    const tree = screen.getByRole('tree', { name: 'Verzeichnis' });
    const root = within(tree).getByRole('treeitem', { name: /Workspace/ });
    expect(root.getAttribute('aria-level')).toBe('1');
    expect(root.getAttribute('aria-expanded')).toBe('true');
    const src = item(/^src\//);
    expect(src.getAttribute('aria-level')).toBe('2');
    expect(src.getAttribute('aria-expanded')).toBe('false');
    expect(src.getAttribute('aria-setsize')).toBe('5');
    // folders first, then files
    const names = within(tree)
      .getAllByRole('treeitem')
      .map((n) => n.querySelector('.tree-name')?.textContent);
    expect(names.slice(1, 4)).toEqual(['broken/', 'empty/', 'src/']);
    // exactly one item is in the tab order
    const stops = within(tree)
      .getAllByRole('treeitem')
      .filter((n) => n.getAttribute('tabindex') === '0');
    expect(stops).toHaveLength(1);
  });

  it('a key pressed the moment a folder listing is drawn still moves the focus', async () => {
    // The listing is committed first and its passive effects run a task later. A key that arrives in between
    // (a fast typist, a slow machine) used to have its focus request taken by that stale effect, which focused
    // the old row: the new one was selected (aria-selected, tab stop) but not focused.
    mount();
    await screen.findByRole('treeitem', { name: /README.md/ });
    const tree = screen.getByRole('tree');
    let pressed = false;
    const observer = new MutationObserver(() => {
      if (pressed || !screen.queryByRole('treeitem', { name: /main.ts/ })) return;
      pressed = true;
      observer.disconnect();
      fireEvent.keyDown(tree, { key: 'ArrowRight' }); // into the folder that has just been listed
    });
    observer.observe(tree, { childList: true, subtree: true });
    fireEvent.click(item(/^src\//));
    await waitFor(() => expect(pressed).toBe(true));
    await waitFor(() => expect(item(/^lib\//).getAttribute('aria-selected')).toBe('true'));
    await waitFor(() => expect(document.activeElement).toBe(item(/^lib\//)));
  });

  it('works with the keyboard: arrows move, Right opens and enters, Left leaves and closes, Home/End jump', async () => {
    const { onSelect } = mount();
    await screen.findByRole('treeitem', { name: /README.md/ });
    const tree = screen.getByRole('tree');
    const root = item(/Workspace/);
    root.focus();
    fireEvent.keyDown(root, { key: 'ArrowDown' });
    await waitFor(() =>
      expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ path: 'broken' })),
    );
    fireEvent.keyDown(tree, { key: 'ArrowDown' }); // empty
    fireEvent.keyDown(tree, { key: 'ArrowDown' }); // src
    await waitFor(() =>
      expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ path: 'src' })),
    );
    expect(document.activeElement).toBe(item(/^src\//));
    fireEvent.keyDown(tree, { key: 'ArrowRight' }); // open
    await screen.findByRole('treeitem', { name: /main.ts/ });
    expect(item(/^src\//).getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(tree, { key: 'ArrowRight' }); // into the folder
    await waitFor(() =>
      expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ path: 'src/lib' })),
    );
    fireEvent.keyDown(tree, { key: 'ArrowLeft' }); // back to the parent
    await waitFor(() =>
      expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ path: 'src' })),
    );
    fireEvent.keyDown(tree, { key: 'ArrowLeft' }); // close it
    expect(screen.queryByRole('treeitem', { name: /main.ts/ })).toBeNull();
    fireEvent.keyDown(tree, { key: 'End' });
    await waitFor(() =>
      expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ path: 'README.md' })),
    );
    fireEvent.keyDown(tree, { key: 'Home' });
    await waitFor(() => expect(onSelect).toHaveBeenLastCalledWith({ path: '', entry: null }));
    // Enter toggles a folder
    fireEvent.keyDown(tree, { key: 'ArrowDown' });
    fireEvent.keyDown(tree, { key: 'ArrowDown' });
    fireEvent.keyDown(tree, { key: 'ArrowDown' });
    fireEvent.keyDown(tree, { key: 'Enter' });
    await screen.findByRole('treeitem', { name: /main.ts/ });
  });

  it('shows an empty folder, a folder that could not be read and symlinks as such', async () => {
    mount();
    await screen.findByRole('treeitem', { name: /README.md/ });
    fireEvent.click(item(/^empty\//));
    await screen.findByRole('treeitem', { name: 'leer' });
    fireEvent.click(item(/^broken\//));
    await screen.findByRole('treeitem', { name: /Konnte nicht geladen werden: permission denied/ });
    fireEvent.click(item(/^src\//));
    expect((await screen.findByRole('treeitem', { name: /link/ })).textContent).toContain(
      'Symlink',
    );
  });

  it('shows names that come from the sandbox without raw bidi or control characters', async () => {
    mount();
    await screen.findByRole('treeitem', { name: /README.md/ });
    expect(screen.getByRole('tree').textContent).not.toMatch(HIDDEN_CHARS);
    expect(screen.getByRole('tree').textContent).toContain('ev\\u202eil.sh');
  });

  it('fetches again when the reload key changes', async () => {
    installBridge(() => undefined);
    const load = vi.fn(() => Promise.resolve(TREE['']!));
    function Host() {
      const [key, setKey] = useState(0);
      return (
        <>
          <button type="button" onClick={() => setKey((k) => k + 1)}>
            reload
          </button>
          <FileTree load={load} reloadKey={key} rootLabel="W" label="L" onSelect={() => {}} />
        </>
      );
    }
    renderApp(<Host />);
    await screen.findByRole('treeitem', { name: /README.md/ });
    fireEvent.click(screen.getByRole('button', { name: 'reload' }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  });
});
