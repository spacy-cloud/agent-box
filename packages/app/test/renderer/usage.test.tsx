// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InspectResult, ResourceUsage, SandboxView } from '@abox/core';
import { DetailView } from '../../src/renderer/views/Detail';
import { SandboxesView } from '../../src/renderer/views/Sandboxes';
import { useSandboxUsage } from '../../src/renderer/hooks';
import { installBridge, renderApp } from './harness';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  setVisibility('visible');
});

const MiB = 1024 * 1024;

function sb(over: Partial<SandboxView>): SandboxView {
  return {
    id: 'local/aaaa1111',
    name: 'alpha',
    host: 'local',
    owner: 'human',
    template: 'node-dev',
    templateHash: 'h',
    backend: 'docker',
    isolation: 'container',
    state: 'running',
    createdAt: Date.now(),
    expiresAt: Date.now() + 3_600_000,
    ttlRemainingMs: 3_600_000,
    expired: false,
    stale: false,
    missingInBackend: false,
    hostReachable: true,
    lastSeenAt: null,
    error: null,
    workspace: null,
    network: { mode: 'none', allow: [] },
    mounts: [],
    resources: { cpus: 2, memoryBytes: 512 * MiB, ttlMs: 3_600_000 },
    secretRefs: [],
    effective: null,
    requestId: null,
    ...over,
  };
}

const USAGE: ResourceUsage = {
  ts: 1,
  cpuPercent: 37.4,
  memoryBytes: 128 * MiB,
  memoryLimitBytes: 512 * MiB,
  pids: 6,
};

function setVisibility(v: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { value: v, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('live usage in the sandbox table', () => {
  it('asks only for running, non-stale sandboxes and shows usage next to the configured limit; others keep the configured values', async () => {
    const calls = installBridge((c) => {
      if (c === 'sandboxes:list') {
        return {
          sandboxes: [
            sb({}),
            sb({ id: 'local/bbbb2222', name: 'beta', state: 'stopped' }),
            sb({ id: 'local/cccc3333', name: 'gamma', stale: true }),
          ],
          orphans: [],
          unreachableHosts: [],
        };
      }
      if (c === 'sandboxes:stats') return { usage: { 'local/aaaa1111': USAGE } };
      return undefined;
    });
    renderApp(<SandboxesView />, { locale: 'en' });
    await screen.findByText('alpha');
    await waitFor(() => expect(screen.getAllByTestId('usage')).toHaveLength(1));
    const stats = calls.filter((c) => c.channel === 'sandboxes:stats');
    expect(stats.at(-1)!.input).toEqual({ ids: ['local/aaaa1111'] });
    const box = screen.getByTestId('usage');
    expect(box.textContent).toContain('37 %');
    expect(box.textContent).toContain('128 MiB / 512 MiB');
    expect(box.textContent).toContain('6');
    // the configured limit stays visible; the stopped one shows it alone
    expect(screen.getAllByText(/2 CPU, 512 MiB/)).toHaveLength(3);
  });

  it('a backend without live usage leaves the table as before', async () => {
    installBridge((c) => {
      if (c === 'sandboxes:list') return { sandboxes: [sb({})], orphans: [], unreachableHosts: [] };
      if (c === 'sandboxes:stats') return { usage: {} };
      return undefined;
    });
    renderApp(<SandboxesView />, { locale: 'en' });
    await screen.findByText('alpha');
    await waitFor(() => expect(screen.getByText('2 CPU, 512 MiB')).toBeTruthy());
    expect(screen.queryByTestId('usage')).toBeNull();
  });

  it('marks a sandbox a human is working in', async () => {
    installBridge((c) => {
      if (c === 'sandboxes:list')
        return {
          sandboxes: [
            sb({
              owner: 'agent:claude',
              humanAttached: { sessions: 1, since: Date.now(), actor: 'human' },
            }),
          ],
          orphans: [],
          unreachableHosts: [],
        };
      return { usage: {} };
    });
    renderApp(<SandboxesView />, { locale: 'en' });
    expect(await screen.findByText('Human attached')).toBeTruthy();
  });
});

describe('useSandboxUsage', () => {
  function Probe(props: { ids: string[] }) {
    const u = useSandboxUsage(props.ids, 1000);
    return <output data-testid="probe">{Object.keys(u).join(',')}</output>;
  }

  it('polls while the window is visible, pauses while it is hidden and refreshes once on return', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const calls = installBridge((c) =>
      c === 'sandboxes:stats' ? { usage: { 'local/aaaa1111': USAGE } } : undefined,
    );
    const n = () => calls.filter((c) => c.channel === 'sandboxes:stats').length;
    render(<Probe ids={['local/aaaa1111']} />);
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('local/aaaa1111'));
    expect(n()).toBe(1);
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
    }
    expect(n()).toBe(4);

    setVisibility('hidden');
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(n()).toBe(4);

    setVisibility('visible');
    await waitFor(() => expect(n()).toBe(5));
  });

  it('asks for nothing when there is nothing running, and again when the set changes', async () => {
    const calls = installBridge(() => ({ usage: {} }));
    const { rerender } = render(<Probe ids={[]} />);
    expect(calls).toHaveLength(0);
    rerender(<Probe ids={['local/aaaa1111']} />);
    await waitFor(() => expect(calls).toHaveLength(1));
    rerender(<Probe ids={[]} />);
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe(''));
  });
});

describe('sandbox detail', () => {
  function inspect(over: Partial<InspectResult>): InspectResult {
    return { ...sb({}), processes: [], pendingApprovals: 0, ...over } as InspectResult;
  }

  it('shows a banner while a human works in an agent sandbox, and the live usage in the overview', async () => {
    installBridge((c) => {
      if (c === 'sandboxes:inspect')
        return inspect({
          owner: 'agent:claude',
          humanAttached: { sessions: 1, since: Date.now(), actor: 'human' },
        });
      if (c === 'sandboxes:stats') return { usage: { 'local/aaaa1111': USAGE } };
      return {};
    });
    renderApp(<DetailView id="local/aaaa1111" />, { locale: 'en' });
    expect(await screen.findByText('A person is working in this sandbox.')).toBeTruthy();
    expect(screen.getByText(/agent:claude is paused/)).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('usage')).toBeTruthy());
    expect(screen.getByText('Live usage')).toBeTruthy();
  });

  it('shows neither banner nor usage for a sandbox that is stopped and unattended', async () => {
    const calls = installBridge((c) =>
      c === 'sandboxes:inspect' ? inspect({ state: 'stopped' }) : {},
    );
    renderApp(<DetailView id="local/aaaa1111" />, { locale: 'en' });
    await screen.findByText('alpha');
    expect(screen.queryByText('A person is working in this sandbox.')).toBeNull();
    expect(calls.some((c) => c.channel === 'sandboxes:stats')).toBe(false);
  });
});
