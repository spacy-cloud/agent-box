// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SandboxesView } from '../../src/renderer/views/Sandboxes';
import { formatClock } from '../../src/shared/format';
import { sb } from './fixtures';
import { installBridge, renderApp } from './harness';

afterEach(cleanup);

describe('Sandboxes view: freshness and shell', () => {
  it('shows when the list was fetched, and the last sighting of a stale sandbox', async () => {
    const seen = Date.now() - 90_000;
    installBridge(() => ({
      sandboxes: [
        sb({ name: 'fresh' }),
        sb({
          id: 'local/stale1',
          name: 'gone',
          state: 'running',
          stale: true,
          hostReachable: false,
          lastSeenAt: seen,
        }),
        sb({ id: 'local/stale2', name: 'never', stale: true, lastSeenAt: null }),
      ],
      orphans: [],
      unreachableHosts: [],
    }));
    renderApp(<SandboxesView />);
    await screen.findByText('fresh');
    const asOf = screen.getByTestId('as-of');
    expect(asOf.textContent).toMatch(/^Stand: \d\d:\d\d:\d\d/);
    expect(within(asOf).queryByText('veraltet')).toBeNull();
    const gone = screen.getByText('gone').closest('tr')!;
    expect(within(gone).getByText('veraltet')).toBeTruthy();
    const note = within(gone).getByTestId('stale-note').textContent;
    expect(note).toContain('Host nicht erreichbar');
    expect(note).toContain(`zuletzt gesehen ${formatClock(seen)}`);
    expect(
      within(screen.getByText('never').closest('tr')!).getByTestId('stale-note').textContent,
    ).toContain('noch nie gesehen');
    // a healthy row has no stale note
    expect(within(screen.getByText('fresh').closest('tr')!).queryByTestId('stale-note')).toBeNull();
  });

  it('marks the list as outdated when it could not be refreshed', async () => {
    let fail = false;
    installBridge((channel) => {
      if (channel !== 'sandboxes:list') return undefined;
      if (fail) throw new Error('manager unavailable');
      return { sandboxes: [sb()], orphans: [], unreachableHosts: [] };
    });
    renderApp(<SandboxesView />);
    await screen.findByText('alpha');
    expect(within(screen.getByTestId('as-of')).queryByText('veraltet')).toBeNull();
    fail = true;
    fireEvent.click(screen.getByRole('button', { name: 'Aktualisieren' }));
    await waitFor(() =>
      expect(within(screen.getByTestId('as-of')).getByText('veraltet')).toBeTruthy(),
    );
    // the table keeps the last known data
    expect(screen.getByText('alpha')).toBeTruthy();
  });

  it('has a Shell action per row that opens the terminal tab of that sandbox; it is off when the sandbox does not run', async () => {
    installBridge(() => ({
      sandboxes: [
        sb(),
        sb({ id: 'local/bbbb2222', name: 'beta', state: 'stopped' }),
        sb({ id: 'local/cccc3333', name: 'gamma', stale: true }),
      ],
      orphans: [],
      unreachableHosts: [],
    }));
    const navigate = vi.fn();
    renderApp(<SandboxesView />, { navigate });
    await screen.findByText('alpha');
    fireEvent.click(screen.getByRole('button', { name: 'Shell öffnen: alpha' }));
    expect(navigate).toHaveBeenCalledWith({
      view: 'detail',
      sandboxId: 'local/aaaa1111',
      tab: 'terminal',
    });
    for (const name of ['beta', 'gamma']) {
      const b = screen.getByRole('button', { name: `Shell öffnen: ${name}` }) as HTMLButtonElement;
      expect(b.disabled).toBe(true);
      expect(b.title).toBe('Die Sandbox läuft nicht oder ist nicht erreichbar.');
    }
  });
});
