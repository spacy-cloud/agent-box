// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FitEstimate, HostCapacity } from '@abox/core';
import { NewSandboxDialog } from '../../src/renderer/views/NewSandbox';
import { installBridge, renderApp } from './harness';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
beforeAll(() => {
  Element.prototype.scrollTo = () => undefined;
});

const GIB = 1024 ** 3;
const NODE = {
  name: 'node-dev',
  description: 'node-dev description',
  backend: 'docker',
  isolation: 'container',
  networkMode: 'none',
  source: { kind: 'builtin', path: '/t/node-dev.yaml' },
  trusted: true,
  allowed: true,
  backendAvailable: true,
  contentHash: 'c',
  hash: 'h',
};
const HOME_SERVER = {
  profile: {
    id: 'home-server',
    kind: 'ssh',
    hostname: 'home',
    zone: 'lab',
    backends: ['docker'],
    tags: [],
    favorite: false,
    portForwards: [],
  },
  minIsolation: 'none',
  requiresApproval: false,
  status: { state: 'unknown' },
  forwardsRunning: 0,
};

function capacity(): HostCapacity {
  return {
    host: 'home-server',
    ts: 1,
    capacity: { cpus: 8, memoryBytes: 16 * GIB, source: 'engine' },
    live: {
      available: true,
      cpuPercent: 35,
      load: null,
      memoryTotalBytes: 16 * GIB,
      memoryAvailableBytes: 6 * GIB,
      memoryUsedBytes: 10 * GIB,
      source: 'ssh',
    },
    abox: { sandboxes: 0, running: 0, reserved: { cpus: 0, memoryBytes: 0 }, usage: null },
    limits: {},
  };
}

function estimate(over: Partial<FitEstimate> = {}): FitEstimate {
  return {
    host: 'home-server',
    ts: 1,
    request: { template: 'node-dev', cpus: 2, memoryBytes: 4 * GIB },
    fits: 3,
    limitedBy: { source: 'reservation', resource: 'memory', count: 3 },
    bounds: [],
    projection: {
      reservedPercent: { cpu: 80, memory: 95 },
      limitPercent: {},
      usedPercent: { cpu: 35, memory: 60 },
    },
    blocked: [],
    warnings: [],
    tone: 'info',
    capacity: capacity(),
    ...over,
  };
}

function mount(answer: (input: Record<string, unknown>) => FitEstimate | Error) {
  const calls = installBridge((channel, input) => {
    switch (channel) {
      case 'skills:list':
        return { skills: [], problems: [] };
      case 'templates:list':
        return { templates: [NODE], problems: [] };
      case 'templates:show':
        return {
          template: { resources: { cpus: 2, memoryBytes: 4 * GIB, ttlMs: 3_600_000 } },
          warnings: [],
          effectiveLimits: { exceedsProfile: [] },
        };
      case 'policy:get':
        return { view: { profile: null }, text: '', source: 'default', path: null };
      case 'hosts:list':
        return [HOME_SERVER];
      case 'projects:recent':
        return [];
      case 'capacity:estimate': {
        const r = answer(input as Record<string, unknown>);
        if (r instanceof Error) throw r;
        return r;
      }
      default:
        throw new Error(`unexpected ${channel}`);
    }
  });
  renderApp(<NewSandboxDialog host="home-server" onClose={vi.fn()} onCreated={vi.fn()} />, {
    locale: 'de',
  });
  return calls;
}

async function toOptions() {
  fireEvent.click(await screen.findByRole('radio', { name: /node-dev/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
  await screen.findByLabelText('Host');
}
const next = () => screen.getByRole('button', { name: 'Weiter' }) as HTMLButtonElement;
const estimates = (calls: ReturnType<typeof mount>) =>
  calls.filter((c) => c.channel === 'capacity:estimate');

describe('New sandbox: fit estimate banner', () => {
  it('info: "passt noch ~3×", what limits it, reserved with it and used now', async () => {
    const calls = mount(() => estimate());
    await toOptions();
    const note = await screen.findByTestId('fit-note');
    expect(note.getAttribute('data-tone')).toBe('info');
    expect(note.textContent).toContain(
      'Auf home-server passt diese Sandbox noch ~3× (begrenzt durch Arbeitsspeicher).',
    );
    expect(note.textContent).toContain(
      'Mit ihr: ~80 % CPU und ~95 % RAM reserviert; aktuell 35 % CPU, 60 % RAM belegt.',
    );
    // it says that this is a ceiling and that reserved is not used
    expect(note.textContent).toContain('keine Leistungsprognose');
    expect(next().disabled).toBe(false);
    expect(estimates(calls)[0]!.input).toEqual({ host: 'home-server', template: 'node-dev' });
  });

  it('names this computer in the dative for local', async () => {
    installBridge((channel) => {
      switch (channel) {
        case 'skills:list':
          return { skills: [], problems: [] };
        case 'templates:list':
          return { templates: [NODE], problems: [] };
        case 'templates:show':
          return { template: {}, warnings: [], effectiveLimits: { exceedsProfile: [] } };
        case 'policy:get':
          return { view: { profile: null }, text: '', source: 'default', path: null };
        case 'hosts:list':
          return [];
        case 'projects:recent':
          return [];
        case 'capacity:estimate':
          return estimate({ host: 'local' });
        default:
          throw new Error(channel);
      }
    });
    renderApp(<NewSandboxDialog onClose={vi.fn()} onCreated={vi.fn()} />, { locale: 'de' });
    await toOptions();
    expect((await screen.findByTestId('fit-note')).textContent).toContain(
      'Auf diesem Rechner passt diese Sandbox noch ~3×',
    );
  });

  it('warn tone for over-commit and for nearly full memory; "Next" stays possible', async () => {
    mount(() =>
      estimate({
        tone: 'warn',
        fits: 0,
        warnings: [
          { code: 'memory_overcommit', message: 'x' },
          { code: 'memory_high', message: 'y' },
        ],
        projection: {
          reservedPercent: { cpu: 80, memory: 113 },
          limitPercent: {},
          usedPercent: { cpu: null, memory: null },
        },
      }),
    );
    await toOptions();
    const note = await screen.findByTestId('fit-note');
    expect(note.getAttribute('data-tone')).toBe('warn');
    expect(note.querySelector('.banner-warn')).not.toBeNull();
    expect(screen.getByTestId('fit-warnings').textContent).toContain('überbucht');
    expect(next().disabled).toBe(false);
  });

  it('error tone blocks "Next" when a host or profile limit would be exceeded, and says why', async () => {
    mount(() =>
      estimate({
        tone: 'error',
        fits: 0,
        blocked: [
          {
            kind: 'host_limit',
            field: 'sandboxes',
            reason: 'host "home-server" already runs 3 sandbox(es); its limit is 3',
            hint: 'Delete a sandbox on that host or use another host.',
          },
        ],
      }),
    );
    await toOptions();
    const note = await screen.findByTestId('fit-note');
    expect(note.getAttribute('data-tone')).toBe('danger');
    expect(note.querySelector('.banner-danger')).not.toBeNull();
    expect(note.textContent).toContain('wird diese Sandbox abgelehnt');
    expect(screen.getByTestId('fit-blocked').textContent).toContain('its limit is 3');
    expect(next().disabled).toBe(true);
  });

  it('says it cannot tell instead of inventing a number', async () => {
    mount(() =>
      estimate({
        fits: null,
        limitedBy: null,
        projection: {
          reservedPercent: { cpu: null, memory: null },
          limitPercent: {},
          usedPercent: { cpu: null, memory: null },
        },
        warnings: [{ code: 'capacity_unknown', message: 'x' }],
      }),
    );
    await toOptions();
    expect((await screen.findByTestId('fit-note')).textContent).toContain(
      'lässt sich nicht berechnen',
    );
  });

  it('a failing estimate is a quiet note, never a blocker', async () => {
    mount(() => new Error('host is not reachable'));
    await toOptions();
    expect((await screen.findByTestId('fit-error')).textContent).toContain(
      'Schätzung nicht verfügbar',
    );
    expect(next().disabled).toBe(false);
  });
});

describe('New sandbox: the estimate follows host and resources (debounced)', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));

  it('asks once after typing stops, with the entered cpus and memory, and again for another host', async () => {
    const calls = mount((input) =>
      estimate({
        request: {
          template: 'node-dev',
          cpus: Number((input['overrides'] as { cpus?: number } | undefined)?.cpus ?? 2),
          memoryBytes: 4 * GIB,
        },
      }),
    );
    await toOptions();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(estimates(calls)).toHaveLength(1);
    // typing: nothing is asked while the keys come
    const cpus = screen.getByLabelText('CPUs') as HTMLInputElement;
    const mem = screen.getByLabelText('Arbeitsspeicher') as HTMLInputElement;
    fireEvent.change(cpus, { target: { value: '1' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    fireEvent.change(cpus, { target: { value: '1.5' } });
    fireEvent.change(mem, { target: { value: '2' } });
    fireEvent.change(mem, { target: { value: '2g' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(estimates(calls)).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(estimates(calls)).toHaveLength(2);
    expect(estimates(calls)[1]!.input).toEqual({
      host: 'home-server',
      template: 'node-dev',
      overrides: { cpus: 1.5, memory: '2g' },
    });
    // another host
    fireEvent.change(screen.getByLabelText('Host'), { target: { value: '' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(estimates(calls)).toHaveLength(3);
    expect(estimates(calls)[2]!.input).not.toHaveProperty('host');
  });

  it('does not ask for a half-typed or invalid entry', async () => {
    const calls = mount(() => estimate());
    await toOptions();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    const before = estimates(calls).length;
    fireEvent.change(screen.getByLabelText('Arbeitsspeicher'), { target: { value: 'g' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(estimates(calls)).toHaveLength(before);
  });

  it('keeps the last answer on screen (and a blocked one blocking) while the next is on its way', async () => {
    let release: (() => void) | undefined;
    let n = 0;
    installBridge((channel) => {
      switch (channel) {
        case 'skills:list':
          return { skills: [], problems: [] };
        case 'templates:list':
          return { templates: [NODE], problems: [] };
        case 'templates:show':
          return { template: {}, warnings: [], effectiveLimits: { exceedsProfile: [] } };
        case 'policy:get':
          return { view: { profile: null }, text: '', source: 'default', path: null };
        case 'hosts:list':
          return [HOME_SERVER];
        case 'projects:recent':
          return [];
        case 'capacity:estimate': {
          n++;
          return n === 1
            ? estimate({
                tone: 'error',
                fits: 0,
                blocked: [
                  { kind: 'host_limit', field: 'sandboxes', reason: 'its limit is 3', hint: '' },
                ],
              })
            : new Promise<FitEstimate>((resolve) => {
                release = () => resolve(estimate());
              });
        }
        default:
          throw new Error(channel);
      }
    });
    renderApp(<NewSandboxDialog host="home-server" onClose={vi.fn()} onCreated={vi.fn()} />, {
      locale: 'de',
    });
    await toOptions();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    await screen.findByTestId('fit-blocked');
    expect(next().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('CPUs'), { target: { value: '1' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    // second answer pending: the old one is still shown and still blocks
    expect(screen.getByTestId('fit-blocked')).toBeTruthy();
    expect(next().disabled).toBe(true);
    await act(async () => {
      release?.();
    });
    await waitFor(() => expect(screen.queryByTestId('fit-blocked')).toBeNull());
    expect(next().disabled).toBe(false);
  });
});
