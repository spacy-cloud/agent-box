// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { CacheList, CacheRemoveResult, CacheView } from '../../src/shared/types';
import { CachesSection } from '../../src/renderer/components/CachesSection';
import { SettingsView } from '../../src/renderer/views/Settings';
import { HIDDEN_CHARS, RLO } from './fixtures';
import { installBridge, renderApp } from './harness';

afterEach(cleanup);
// jsdom has no <dialog> behaviour
beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});

const MIB = 1024 ** 2;
const now = Date.now();

function cache(over: Partial<CacheView> = {}): CacheView {
  return {
    host: 'local',
    key: '0123456789abcdef',
    name: 'pnpm-store',
    project: '/home/u/shop',
    stack: 'node-dev',
    owner: 'human',
    sizeBytes: 300 * MIB,
    createdAt: now - 10 * 86_400_000,
    lastUsedAt: now - 3 * 86_400_000,
    inUse: false,
    ...over,
  };
}

const A = cache();
const B = cache({
  key: 'fedcba9876543210',
  name: 'cargo-registry',
  project: '/home/u/tool',
  stack: 'rust-dev',
  sizeBytes: 1024 * MIB,
  inUse: true,
});
const C = cache({ key: 'aaaaaaaaaaaaaaaa', name: 'npm-cache', sizeBytes: null });

function listOf(caches: CacheView[], unreachable: CacheList['unreachable'] = []): CacheList {
  return {
    caches,
    totalBytes: caches.reduce((s, c) => s + (c.sizeBytes ?? 0), 0),
    unreachable,
  };
}

/** A bridge holding a list that `caches:remove` shrinks the way the manager would. */
function mount(
  initial: CacheList,
  opts: {
    remove?: (input: unknown, current: CacheView[]) => CacheRemoveResult;
    failRemove?: string;
    failList?: string;
  } = {},
) {
  let current = initial.caches;
  const calls = installBridge((channel, input) => {
    switch (channel) {
      case 'caches:list':
        if (opts.failList) throw new Error(opts.failList);
        return listOf(current, initial.unreachable);
      case 'caches:remove': {
        if (opts.failRemove) throw new Error(opts.failRemove);
        const res = opts.remove
          ? opts.remove(input, current)
          : defaultRemove(input as { keys?: string[]; all?: true }, current);
        const gone = new Set(res.removed.map((r) => r.key));
        current = current.filter((c) => !gone.has(c.key));
        return res;
      }
      default:
        throw new Error(`unexpected ${channel}`);
    }
  });
  return calls;
}

function defaultRemove(
  input: { keys?: string[]; all?: true },
  current: CacheView[],
): CacheRemoveResult {
  const picked = input.all ? current : current.filter((c) => input.keys?.includes(c.key));
  return {
    removed: picked.filter((c) => !c.inUse),
    skipped: picked.filter((c) => c.inUse).map((c) => ({ cache: c, reason: 'used by a sandbox' })),
    errors: [],
  };
}

const row = (name: RegExp | string) =>
  screen.getByRole('row', { name: typeof name === 'string' ? new RegExp(name) : name });

describe('Settings: package caches', () => {
  it('lists project, template, cache, size, last use and whether a sandbox uses it', async () => {
    mount(listOf([A, B, C]));
    renderApp(<CachesSection />, { locale: 'en' });
    const table = await screen.findByRole('table', { name: 'Package caches' });
    const a = within(within(table).getByRole('row', { name: /pnpm-store/ }));
    expect(a.getByRole('rowheader').textContent).toBe('/home/u/shop');
    expect(a.getAllByRole('cell').map((c) => c.textContent)).toEqual([
      'node-dev',
      'pnpm-store',
      '300 MiB',
      '3d 0h ago',
      'free',
      'Remove',
    ]);
    const b = within(within(table).getByRole('row', { name: /cargo-registry/ }));
    expect(b.getByText('1.0 GiB')).toBeTruthy();
    expect(b.getByText('In use')).toBeTruthy();
    // an engine that cannot tell the size of a volume
    expect(within(within(table).getByRole('row', { name: /npm-cache/ })).getByText('unknown'));
    const summary = within(screen.getByTestId('caches-summary'));
    expect(summary.getByText('3')).toBeTruthy();
    expect(summary.getByText('1.3 GiB')).toBeTruthy();
  });

  it('explains what a cache is and that a sandbox can opt out', async () => {
    mount(listOf([A]));
    renderApp(<CachesSection />, { locale: 'en' });
    await screen.findByRole('table');
    expect(screen.getByText(/A package cache keeps downloaded packages/).textContent).toContain(
      'untick "Use package cache"',
    );
  });

  it('is written in German too', async () => {
    mount(listOf([A]));
    renderApp(<CachesSection />);
    expect(await screen.findByRole('heading', { name: 'Paket-Caches' })).toBeTruthy();
    const table = screen.getByRole('table', { name: 'Paket-Caches' });
    expect(within(table).getByText('vor 3d 0h')).toBeTruthy();
    expect(screen.getByText(/„Paket-Cache verwenden“ abwählen/)).toBeTruthy();
  });

  it('shows the empty state without a table or a summary', async () => {
    mount(listOf([]));
    renderApp(<CachesSection />, { locale: 'en' });
    expect(await screen.findByText(/No package caches yet/)).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByTestId('caches-summary')).toBeNull();
    expect((screen.getByRole('button', { name: 'Remove all' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('shows a loading state, then the list', async () => {
    mount(listOf([A]));
    renderApp(<CachesSection />, { locale: 'en' });
    expect(screen.getByRole('status').textContent).toBe('Loading …');
    await screen.findByRole('table');
    expect(screen.queryByText('Loading …')).toBeNull();
  });

  it('shows the error when the list cannot be read', async () => {
    mount(listOf([]), { failList: 'engine unreachable' });
    renderApp(<CachesSection />, { locale: 'en' });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('engine unreachable');
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('names the hosts that could not be asked, with the error', async () => {
    mount(listOf([A], [{ host: 'lab', error: 'ssh: connection refused' }]));
    renderApp(<CachesSection />, { locale: 'en' });
    await screen.findByRole('table');
    const banner = screen.getByText(/could not be asked/).closest('.banner') as HTMLElement;
    expect(banner.textContent).toContain('lab');
    expect(banner.textContent).toContain('ssh: connection refused');
  });

  it('shows host and owner only where they are not the usual local human', async () => {
    mount(listOf([cache({ host: 'lab', owner: 'agent:ci', key: 'bbbbbbbbbbbbbbbb' }), A]));
    renderApp(<CachesSection />, { locale: 'en' });
    await screen.findByRole('table');
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows[0]!.textContent).toContain('lab · agent:ci');
    expect(rows[1]!.textContent).not.toContain('·');
  });

  it('makes hostile project paths harmless', async () => {
    mount(listOf([cache({ project: `/home/u/${RLO}evil\u0007` })]));
    renderApp(<CachesSection />, { locale: 'en' });
    const table = await screen.findByRole('table');
    expect(HIDDEN_CHARS.test(table.textContent ?? '')).toBe(false);
  });

  it('cannot remove a cache a sandbox uses, and says why', async () => {
    mount(listOf([A, B]));
    renderApp(<CachesSection />, { locale: 'en' });
    await screen.findByRole('table');
    const used = screen.getByRole('button', {
      name: 'Remove cache cargo-registry of /home/u/tool',
    }) as HTMLButtonElement;
    expect(used.disabled).toBe(true);
    expect(used.title).toMatch(/A sandbox still uses this cache/);
    const free = screen.getByRole('button', {
      name: 'Remove cache pnpm-store of /home/u/shop',
    }) as HTMLButtonElement;
    expect(free.disabled).toBe(false);
  });

  it('asks before removing one cache, says what is lost, then removes exactly that key on that host', async () => {
    const calls = mount(listOf([A, C]));
    renderApp(<CachesSection />, { locale: 'en' });
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: /Remove cache pnpm-store/ }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('The cache "pnpm-store" of project /home/u/shop');
    expect(dialog.textContent).toContain('300 MiB');
    expect(dialog.textContent).toContain('Only download time is lost');
    // nothing happened yet
    expect(calls.some((c) => c.channel === 'caches:remove')).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(calls.some((c) => c.channel === 'caches:remove')).toBe(true));
    expect(calls.filter((c) => c.channel === 'caches:remove').map((c) => c.input)).toEqual([
      { keys: ['0123456789abcdef'], host: 'local' },
    ]);
    // the list is read again and the row is gone; the result is shown
    await waitFor(() => expect(screen.queryByRole('button', { name: /pnpm-store/ })).toBeNull());
    expect(calls.filter((c) => c.channel === 'caches:list').length).toBeGreaterThanOrEqual(2);
    expect(
      screen.getByText('1 cache removed (300 MiB freed)', { selector: 'strong' }),
    ).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('cancel leaves everything as it is', async () => {
    const calls = mount(listOf([A]));
    renderApp(<CachesSection />, { locale: 'en' });
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: /Remove cache pnpm-store/ }));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls.some((c) => c.channel === 'caches:remove')).toBe(false);
  });

  it('remove all counts only what can go, asks, and sends the "all" selector', async () => {
    const calls = mount(listOf([A, B, C]));
    renderApp(<CachesSection />, { locale: 'en' });
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Remove all' }));
    const dialog = await screen.findByRole('dialog');
    // A (300 MiB) and C (size unknown) are free, B is used by a sandbox and stays
    expect(dialog.textContent).toContain('2 caches (300 MiB) will be deleted');
    expect(dialog.textContent).toContain('Caches a sandbox still uses are kept');
    expect(dialog.textContent).toContain('Only download time is lost');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove all' }));
    await screen.findByText('2 caches removed (300 MiB freed)', { selector: 'strong' });
    expect(calls.filter((c) => c.channel === 'caches:remove').map((c) => c.input)).toEqual([
      { all: true },
    ]);
    // only the used cache is left
    expect(screen.getAllByRole('row')).toHaveLength(2);
    expect(screen.getByText('cargo-registry')).toBeTruthy();
  });

  it('disables "remove all" when every cache is used', async () => {
    mount(listOf([B]));
    renderApp(<CachesSection />, { locale: 'en' });
    await screen.findByRole('table');
    const all = screen.getByRole('button', { name: 'Remove all' }) as HTMLButtonElement;
    expect(all.disabled).toBe(true);
    expect(all.title).toBe('All caches are used by sandboxes.');
  });

  it('reports what the manager skipped or failed on', async () => {
    mount(listOf([A, C]), {
      remove: (_i, current) => ({
        removed: [current[0]!],
        skipped: [{ cache: current[1]!, reason: 'in use by sandbox local/abcd1234' }],
        errors: ['host lab: connection lost'],
      }),
    });
    renderApp(<CachesSection />, { locale: 'en' });
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Remove all' }));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove all' }),
    );
    const strong = await screen.findByText('1 cache removed (300 MiB freed)', {
      selector: 'strong',
    });
    const banner = strong.closest('.banner') as HTMLElement;
    expect(banner.className).toContain('banner-warn');
    expect(banner.textContent).toContain('Skipped:');
    expect(banner.textContent).toContain(
      'npm-cache (/home/u/shop): in use by sandbox local/abcd1234',
    );
    expect(banner.textContent).toContain('Errors:');
    expect(banner.textContent).toContain('host lab: connection lost');
  });

  it('shows the manager error when a removal is refused', async () => {
    const calls = mount(listOf([A]), { failRemove: 'cache 0123 is used by a sandbox' });
    renderApp(<CachesSection />, { locale: 'en' });
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: /Remove cache pnpm-store/ }));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }),
    );
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('cache 0123 is used by a sandbox');
    expect(screen.queryByRole('dialog')).toBeNull();
    // the row is still there
    expect(screen.getByRole('button', { name: /Remove cache pnpm-store/ })).toBeTruthy();
    expect(calls.filter((c) => c.channel === 'caches:remove')).toHaveLength(1);
  });

  it('the refresh button reads the list again', async () => {
    const calls = mount(listOf([A]));
    renderApp(<CachesSection />, { locale: 'en' });
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(calls.filter((c) => c.channel === 'caches:list')).toHaveLength(2));
  });

  it('is a section of the settings view', async () => {
    installBridge((channel) => {
      switch (channel) {
        case 'caches:list':
          return listOf([A]);
        case 'doctor:run':
          return { ok: true, checks: [], backends: [] };
        case 'mcp:status':
          return {
            contexts: [],
            tokens: { active: 0, revoked: 0, lastUsedAt: null },
            lastActivityAt: null,
          };
        case 'mcp:config':
          return { agent: 'a', claudeCommand: 'c', json: '{}', contexts: [] };
        case 'tokens:list':
          return [];
        default:
          throw new Error(`unexpected ${channel}`);
      }
    });
    renderApp(<SettingsView />, { locale: 'en' });
    expect(await screen.findByRole('heading', { level: 2, name: 'Package caches' })).toBeTruthy();
    expect(await screen.findByRole('table', { name: 'Package caches' })).toBeTruthy();
    expect(row(/pnpm-store/)).toBeTruthy();
  });
});
