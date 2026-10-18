// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostCapacity, HostProfile } from '@abox/core';
import type { HostRow } from '../../src/shared/types';
import { HostsView } from '../../src/renderer/views/Hosts';
import { SshTabsProvider } from '../../src/renderer/views/ssh-tabs';
import { useHostCapacity } from '../../src/renderer/hooks';
import { installBridge, renderApp } from './harness';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const GIB = 2 ** 30;

function profile(over: Partial<HostProfile> & { id: string }): HostProfile {
  return {
    kind: 'ssh',
    hostname: `${over.id}.example.org`,
    user: 'abox',
    zone: 'lab',
    backends: ['docker'],
    tags: [],
    favorite: false,
    portForwards: [],
    ...over,
  } as HostProfile;
}
function row(p: HostProfile): HostRow {
  return {
    profile: p,
    minIsolation: 'none',
    requiresApproval: false,
    status: {
      state: p.kind === 'local' ? 'local' : 'unknown',
      checkedAt: null,
      lastOkAt: null,
      latencyMs: null,
      stale: false,
      error: null,
      hostKey: null,
      authOk: null,
      remoteUser: null,
      backends: [],
      engine: null,
      runtimes: [],
      warnings: [],
    },
    forwardsRunning: 0,
  };
}

function cap(
  host: string,
  live: Partial<HostCapacity['live']> | 'unavailable',
  reserved = { cpus: 4, memoryBytes: 4 * GIB },
): HostCapacity {
  const unavailable = live === 'unavailable';
  return {
    host,
    ts: 1,
    capacity: { cpus: 8, memoryBytes: 16 * GIB, source: 'engine' },
    live: unavailable
      ? {
          available: false,
          reason: 'login failed',
          cpuPercent: null,
          load: null,
          memoryTotalBytes: null,
          memoryAvailableBytes: null,
          memoryUsedBytes: null,
          source: null,
        }
      : {
          available: true,
          cpuPercent: 35,
          load: null,
          memoryTotalBytes: 16 * GIB,
          memoryAvailableBytes: 6.4 * GIB,
          memoryUsedBytes: 9.6 * GIB,
          source: 'ssh',
          ...live,
        },
    abox: { sandboxes: 2, running: 1, reserved, usage: null },
    limits: {},
  };
}

const LOCAL = profile({ id: 'local', kind: 'local', backends: ['docker'] });
const HOME = profile({ id: 'home-server', limits: { sandboxes: 3, cpus: 6, memory: '12g' } });

function mount(
  capacity: (id: string) => HostCapacity | Error,
  hosts: HostProfile[] = [LOCAL, HOME],
  locale: 'de' | 'en' = 'de',
) {
  const calls = installBridge((channel, input) => {
    switch (channel) {
      case 'hosts:list':
        return hosts.map(row);
      case 'hosts:forwards':
        return [];
      case 'sandboxes:list':
        return { sandboxes: [], orphans: [], unreachableHosts: [] };
      case 'capacity:host': {
        const r = capacity((input as { id: string }).id);
        if (r instanceof Error) throw r;
        return r;
      }
      default:
        throw new Error(`unexpected ${channel}`);
    }
  });
  renderApp(
    <SshTabsProvider>
      <HostsView />
    </SshTabsProvider>,
    { locale },
  );
  return calls;
}

describe('Hosts view: live utilisation of the machine', () => {
  it('shows cpu and ram as label, used / total and a bar, plus what abox reserved of the machine', async () => {
    mount((id) => cap(id, {}));
    const cell = await screen.findByTestId('live-home-server');
    await waitFor(() => expect(within(cell).getByTestId('live-cpu-home-server')).toBeTruthy());
    const cpu = within(cell).getByTestId('live-cpu-home-server');
    expect(cpu.textContent).toContain('CPU');
    expect(cpu.textContent).toContain('35 % · 2,8 / 8 CPUs');
    expect(cpu.getAttribute('data-tone')).toBe('ok');
    const ram = within(cell).getByTestId('live-ram-home-server');
    expect(ram.textContent).toContain('RAM');
    expect(ram.textContent).toContain('9,6 GiB / 16 GiB (60 %)');
    // the bar repeats the numbers: hidden from assistive technology
    expect(ram.querySelector('.live-bar')!.getAttribute('aria-hidden')).toBe('true');
    expect((ram.querySelector('.live-fill') as HTMLElement).style.width).toBe('60%');
    // reserved by abox: limits of its sandboxes, not use; share of the machine
    expect(cell.textContent).toContain('abox reserviert: 4 CPU (50 %), 4,0 GiB (25 %)');
    // and the limits of the profile stay below
    const util = screen.getByTestId('util-home-server');
    expect(util.textContent).toContain('0 von 3 Sandboxes');
    expect(util.textContent).toContain('CPU: 0 von 6 reserviert');
  });

  it('local is measured too', async () => {
    mount((id) => cap(id, { cpuPercent: 10 }));
    await screen.findByTestId('live-cpu-local');
    expect(screen.getByTestId('live-cpu-local').textContent).toContain('10 %');
  });

  it('amber above 80 %, red above 95 %, and says so in words too', async () => {
    mount(
      (id) =>
        id === 'local'
          ? cap(id, { cpuPercent: 80, memoryUsedBytes: 14.4 * GIB }) // cpu exactly 80: ok; ram 90 %: amber
          : cap(id, { cpuPercent: 97, memoryUsedBytes: 15.5 * GIB }), // 97 %: red; ram 97 %: red
    );
    await screen.findByTestId('live-cpu-home-server');
    expect(screen.getByTestId('live-cpu-local').getAttribute('data-tone')).toBe('ok');
    expect(screen.getByTestId('live-ram-local').getAttribute('data-tone')).toBe('warn');
    expect(screen.getByTestId('live-ram-local').textContent).toContain('hoch');
    expect(screen.getByTestId('live-cpu-home-server').getAttribute('data-tone')).toBe('danger');
    expect(screen.getByTestId('live-cpu-home-server').textContent).toContain('kritisch');
    expect(
      screen.getByTestId('live-cpu-home-server').querySelector('.live-fill')!.className,
    ).toContain('live-fill-danger');
  });

  it('says "unbekannt" where the numbers are not available, never a bar', async () => {
    mount((id) => (id === 'home-server' ? cap(id, 'unavailable') : cap(id, {})));
    await screen.findByTestId('live-cpu-local');
    const cell = screen.getByTestId('live-home-server');
    await waitFor(() => expect(cell.textContent).toContain('Live-Auslastung unbekannt'));
    expect(cell.textContent).toContain('login failed');
    expect(within(cell).queryByTestId('live-cpu-home-server')).toBeNull();
    expect(cell.querySelector('.live-bar')).toBeNull();
  });

  it('says "unbekannt" when the host cannot be asked at all', async () => {
    mount((id) => (id === 'home-server' ? new Error('host is not reachable') : cap(id, {})));
    await screen.findByTestId('live-cpu-local');
    await waitFor(() =>
      expect(screen.getByTestId('live-home-server').textContent).toContain(
        'Live-Auslastung unbekannt',
      ),
    );
    expect(screen.getByTestId('live-home-server').getAttribute('title')).toContain('not reachable');
  });

  it('speaks English with a decimal point', async () => {
    mount((id) => cap(id, {}), [LOCAL, HOME], 'en');
    const ram = await screen.findByTestId('live-ram-home-server');
    expect(ram.textContent).toContain('9.6 GiB / 16 GiB (60 %)');
  });
});

describe('useHostCapacity', () => {
  function Probe(props: { ids: string[]; ms: number }) {
    const s = useHostCapacity(props.ids, props.ms);
    return (
      <ul>
        {props.ids.map((id) => (
          <li key={id} data-testid={id}>
            {s[id]?.data
              ? `ok:${s[id]!.data!.live.cpuPercent}`
              : s[id]?.error
                ? `err:${s[id]!.error}`
                : 'loading'}
          </li>
        ))}
      </ul>
    );
  }
  const mountProbe = (ids: string[], ms: number) =>
    render(
      <AppShell>
        <Probe ids={ids} ms={ms} />
      </AppShell>,
    );
  // renderApp provides the context `call` needs
  function AppShell(props: { children: React.ReactNode }) {
    return <>{props.children}</>;
  }

  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));

  it('asks every host on its own, refreshes about every 10 s and not while the window is hidden', async () => {
    let cpu = 10;
    const calls = installBridge((channel, input) => {
      if (channel !== 'capacity:host') throw new Error('unexpected');
      return cap((input as { id: string }).id, { cpuPercent: cpu });
    });
    mountProbe(['a', 'b'], 10_000);
    await waitFor(() => expect(screen.getByTestId('a').textContent).toBe('ok:10'));
    expect(calls.filter((c) => c.channel === 'capacity:host')).toHaveLength(2);
    cpu = 20;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    await waitFor(() => expect(screen.getByTestId('a').textContent).toBe('ok:20'));
    expect(calls.filter((c) => c.channel === 'capacity:host')).toHaveLength(4);
    // hidden window: no calls
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(calls.filter((c) => c.channel === 'capacity:host')).toHaveLength(4);
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(calls.filter((c) => c.channel === 'capacity:host')).toHaveLength(6));
  });

  it('a host that fails is asked less and less often; the others are not held up', async () => {
    const calls = installBridge((channel, input) => {
      if ((input as { id: string }).id === 'bad') throw new Error('unreachable');
      return cap((input as { id: string }).id, {});
    });
    mountProbe(['good', 'bad'], 10_000);
    await waitFor(() => expect(screen.getByTestId('bad').textContent).toBe('err:unreachable'));
    expect(screen.getByTestId('good').textContent).toBe('ok:35');
    const count = (id: string) => calls.filter((c) => (c.input as { id: string }).id === id).length;
    for (let i = 0; i < 12; i++)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
    // 12 ticks of 10 s: the good host is asked on each, the failing one far less
    expect(count('good')).toBe(13);
    expect(count('bad')).toBeLessThan(7);
    expect(count('bad')).toBeGreaterThan(2);
  });
});
