// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ActivityEntry,
  ApprovalView,
  DoctorReport,
  HostCapacity,
  HostProfile,
} from '@abox/core';
import type { HostRow } from '../../src/shared/types';
import type { Route } from '../../src/renderer/context';
import { OverviewView } from '../../src/renderer/views/Overview';
import { sb } from './fixtures';
import { installBridge, renderApp } from './harness';

afterEach(cleanup);

const GIB = 2 ** 30;

function profile(over: Partial<HostProfile> & { id: string }): HostProfile {
  return {
    kind: 'ssh',
    hostname: `${over.id}.example.org`,
    user: 'abox',
    zone: 'shared',
    backends: ['docker'],
    tags: [],
    favorite: false,
    portForwards: [],
    ...over,
  } as HostProfile;
}
const row = (p: HostProfile, state: HostRow['status']['state'] = 'unknown'): HostRow => ({
  profile: p,
  minIsolation: 'none',
  requiresApproval: false,
  status: {
    state: p.kind === 'local' ? 'local' : state,
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
});

const LOCAL = profile({
  id: 'local',
  kind: 'local',
  zone: 'workstation',
  limits: { sandboxes: 10 },
});
const REMOTE = profile({ id: 'home-server', limits: { sandboxes: 2 } });

function capacity(host: string): HostCapacity {
  return {
    host,
    ts: 1,
    capacity: { cpus: 16, memoryBytes: 32 * GIB, source: 'engine' },
    live: {
      available: true,
      cpuPercent: 37.5,
      load: null,
      memoryTotalBytes: 32 * GIB,
      memoryAvailableBytes: 20 * GIB,
      memoryUsedBytes: 12 * GIB,
      source: 'local',
    },
    abox: { sandboxes: 3, running: 3, reserved: { cpus: 4, memoryBytes: 4 * GIB }, usage: null },
    limits: {},
  };
}

function approval(over: Partial<ApprovalView> = {}): ApprovalView {
  return {
    id: 'ap1',
    kind: 'access',
    requester: 'agent:claude-code',
    sandboxId: 'local/aaaa1111',
    status: 'pending',
    reason: 'Tests laufen noch',
    risks: [],
    items: [],
    kinds: [],
    reasons: [],
    base: null,
    request: {
      v: 1,
      kind: 'access_request',
      request: { kind: 'ttl', details: { ttlMs: 5 * 3_600_000 } },
    },
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    decidedAt: null,
    decidedBy: null,
    decisionNote: null,
    usedAt: null,
    ...over,
  };
}

const REPORT = {
  ok: true,
  summary: { ok: 5, info: 2, warning: 0, error: 0 },
  checks: [],
  backends: [],
} as unknown as DoctorReport;

const entry = (over: Partial<ActivityEntry>): ActivityEntry => ({
  seq: 1,
  ts: new Date(2026, 9, 19, 13, 20).getTime(),
  kind: 'exec',
  action: 'sandbox.exec',
  actor: 'agent:claude-code',
  outcome: 'ok',
  summary: '',
  detail: {},
  count: 1,
  sandboxId: 'local/aaaa1111',
  sandboxName: 'web-tests',
  ...over,
});

const ACTIVITY: ActivityEntry[] = [
  entry({
    seq: 4,
    subject: 'pnpm test',
    detail: { exitCode: 0, durationMs: 41_000 },
  }),
  entry({
    seq: 3,
    ts: new Date(2026, 9, 19, 13, 18).getTime(),
    kind: 'network',
    action: 'network.egress',
    outcome: 'denied',
    subject: 'registry.npmjs.org',
  }),
  entry({
    seq: 2,
    ts: new Date(2026, 9, 19, 13, 12).getTime(),
    kind: 'lifecycle',
    action: 'sandbox.export',
    sandboxId: 'local/gone0000',
    sandboxName: 'old-box',
    subject: 'diff',
    detail: { filesChanged: 4 },
  }),
  // left out: a human's own action, an approval request, an allowed proxy request
  entry({ seq: 7, actor: 'human', subject: 'ls' }),
  entry({ seq: 6, kind: 'approval', action: 'approval.request', outcome: 'pending' }),
  entry({ seq: 5, kind: 'network', action: 'network.egress', subject: 'github.com:443' }),
];

interface Setup {
  approvals?: ApprovalView[];
  activity?: ActivityEntry[];
  sandboxes?: ReturnType<typeof sb>[];
  hosts?: HostRow[];
  capacity?: (id: string) => HostCapacity | Error;
  doctor?: DoctorReport | Error;
  locale?: 'de' | 'en';
}

function mount(s: Setup = {}) {
  const navigate = vi.fn<(r: Route) => void>();
  const calls = installBridge((channel, input) => {
    switch (channel) {
      case 'sandboxes:list':
        return {
          sandboxes: s.sandboxes ?? [
            sb({ id: 'local/aaaa1111', name: 'web-tests', expiresAt: Date.now() + 3 * 3_600_000 }),
            sb({ id: 'local/bbbb2222', name: 'flutter-ci', expiresAt: Date.now() + 10 * 60_000 }),
          ],
          orphans: [],
          unreachableHosts: [],
        };
      case 'approvals:list':
        return s.approvals ?? [];
      case 'activity:recent':
        return { entries: s.activity ?? [] };
      case 'doctor:run': {
        const d = s.doctor ?? REPORT;
        if (d instanceof Error) throw d;
        return d;
      }
      case 'hosts:list':
        return s.hosts ?? [row(LOCAL), row(REMOTE)];
      case 'capacity:host': {
        const r = (s.capacity ?? capacity)((input as { id: string }).id);
        if (r instanceof Error) throw r;
        return r;
      }
      case 'approvals:approve':
      case 'approvals:deny':
        return { approval: approval() };
      default:
        throw new Error(`unexpected ${channel}`);
    }
  });
  renderApp(<OverviewView />, { navigate, ...(s.locale ? { locale: s.locale } : {}) });
  return { calls, navigate };
}

describe('OverviewView', () => {
  it('shows the four numbers with their badges and links each card to its view', async () => {
    const { navigate } = mount({ approvals: [approval()] });
    const running = await screen.findByTestId('stat-running');
    await waitFor(() => expect(running.textContent).toContain('2'));
    expect(running.textContent).toContain('Laufende Sandboxes');
    expect(running.textContent).toContain('alles gut');
    expect(screen.getByTestId('stat-approvals').textContent).toContain('wartet auf dich');
    const expiring = screen.getByTestId('stat-expiring');
    expect(expiring.textContent).toContain('1');
    expect(expiring.textContent).toContain('flutter-ci');
    await waitFor(() =>
      expect(screen.getByTestId('stat-problems').textContent).toContain('2 Hinweise'),
    );
    expect(screen.getByTestId('stat-problems').textContent).toContain('0');

    fireEvent.click(running);
    expect(navigate).toHaveBeenLastCalledWith({ view: 'sandboxes' });
    fireEvent.click(screen.getByTestId('stat-approvals'));
    expect(navigate).toHaveBeenLastCalledWith({ view: 'approvals' });
    fireEvent.click(screen.getByTestId('stat-problems'));
    expect(navigate).toHaveBeenLastCalledWith({ view: 'settings' });
  });

  it('counts problems: a sandbox the backend lost, and doctor errors and warnings', async () => {
    mount({
      sandboxes: [sb({ id: 'local/x', name: 'x', stale: true }), sb({ id: 'local/y', name: 'y' })],
      doctor: { ...REPORT, summary: { ok: 3, info: 0, warning: 2, error: 1 } } as DoctorReport,
    });
    await waitFor(() =>
      expect(screen.getByTestId('stat-running').textContent).toContain('1 mit Problem'),
    );
    await waitFor(() =>
      expect(screen.getByTestId('stat-problems').textContent).toContain('1 Fehler'),
    );
    expect(screen.getByTestId('stat-problems').textContent).toContain('3');
  });

  it('the diagnosis failing does not hold the page up', async () => {
    mount({ doctor: new Error('probe failed') });
    await waitFor(() =>
      expect(screen.getByTestId('stat-problems').textContent).toContain('nicht verfügbar'),
    );
    expect(screen.getByTestId('stat-running').textContent).toContain('2');
  });

  it('draws cpu, memory and sandbox bars per host; an unreachable host says so and keeps the sandbox count', async () => {
    mount({
      capacity: (id) => (id === 'local' ? capacity(id) : new Error('ssh: timed out')),
    });
    const local = await screen.findByTestId('ov-host-local');
    expect(local.textContent).toContain('Arbeitsplatz');
    await waitFor(() => expect(within(local).getByTestId('ov-cpu-local')).toBeTruthy());
    expect(within(local).getByTestId('ov-cpu-local').textContent).toContain('6 / 16 Kerne');
    expect(within(local).getByTestId('ov-ram-local').textContent).toContain('12 GiB / 32 GiB');
    const remote = screen.getByTestId('ov-host-home-server');
    await waitFor(() => expect(remote.textContent).toContain('nicht erreichbar'));
    expect(within(remote).queryByTestId('ov-cpu-home-server')).toBeNull();
    expect(within(remote).getByTestId('ov-sandboxes-home-server').textContent).toContain('0 / 2');
  });

  it('lists the open approvals with agent and reason; "Erlauben" uses the same channel as the approvals view', async () => {
    const { calls, navigate } = mount({ approvals: [approval()] });
    const list = await screen.findByTestId('ov-approvals');
    const item = await within(list).findByText(/Laufzeit verlängern auf 5h 00m: web-tests/, {
      selector: 'strong',
    });
    expect(item.closest('li')!.textContent).toContain('claude-code · „Tests laufen noch“');
    fireEvent.click(within(list).getByRole('button', { name: /^Erlauben/ }));
    await waitFor(() =>
      expect(calls.filter((c) => c.channel === 'approvals:approve')).toEqual([
        { channel: 'approvals:approve', input: { id: 'ap1' } },
      ]),
    );
    fireEvent.click(within(list).getByRole('button', { name: /^Details/ }));
    expect(navigate).toHaveBeenLastCalledWith({ view: 'approvals', approvalId: 'ap1' });
  });

  it('"Ablehnen" denies through approvals:deny', async () => {
    const { calls } = mount({ approvals: [approval()] });
    const list = await screen.findByTestId('ov-approvals');
    fireEvent.click(await within(list).findByRole('button', { name: /^Ablehnen/ }));
    await waitFor(() =>
      expect(calls.filter((c) => c.channel === 'approvals:deny')).toEqual([
        { channel: 'approvals:deny', input: { id: 'ap1' } },
      ]),
    );
  });

  it('a request the title cannot describe (a create with no isolation) offers no quick "Erlauben"', async () => {
    mount({
      approvals: [
        approval({
          kind: 'create',
          request: { kind: 'create', template: { name: 'host-shell' }, isolation: 'none' },
        }),
      ],
    });
    const list = await screen.findByTestId('ov-approvals');
    await within(list).findByText(/Sandbox erstellen/, { selector: 'strong' });
    expect(within(list).queryByRole('button', { name: /^Erlauben/ })).toBeNull();
    expect(within(list).getByRole('button', { name: /^Details/ })).toBeTruthy();
    expect(within(list).getByRole('button', { name: /^Ablehnen/ })).toBeTruthy();
  });

  it('agent text stays plain text: markup and control characters in the reason are neutralised', async () => {
    mount({
      approvals: [approval({ reason: '<img src=x onerror=alert(1)>‮ evil' })],
    });
    const list = await screen.findByTestId('ov-approvals');
    const item = await within(list).findByText(/Laufzeit verlängern/, { selector: 'strong' });
    const text = item.closest('li')!.textContent ?? '';
    expect(text).toContain('<img src=x onerror=alert(1)>');
    expect(text).not.toContain('‮');
    expect(list.querySelector('img')).toBeNull();
  });

  it('shows the recent activity: time, sandbox as a link, summary and badge', async () => {
    const { navigate } = mount({ activity: ACTIVITY });
    const rows = await screen.findAllByTestId('activity-row');
    expect(rows).toHaveLength(3);
    expect(rows[0]!.textContent).toContain('13:20');
    expect(rows[0]!.textContent).toContain('Befehl: pnpm test (exit 0, 41s)');
    expect(rows[0]!.textContent).toContain('ok');
    expect(rows[1]!.textContent).toContain('Anfrage blockiert: registry.npmjs.org');
    expect(rows[1]!.textContent).toContain('blockiert');
    expect(rows[2]!.textContent).toContain('Ergebnis exportiert: diff (4 Dateien geändert)');
    expect(rows[2]!.textContent).toContain('Export');
    // a sandbox that is gone is plain text, a live one is a link to its detail view
    expect(within(rows[2]!).queryByRole('button')).toBeNull();
    fireEvent.click(within(rows[0]!).getByRole('button', { name: 'web-tests' }));
    expect(navigate).toHaveBeenLastCalledWith({ view: 'detail', sandboxId: 'local/aaaa1111' });
  });

  it('empty states for approvals and activity; "nichts offen" instead of a warning', async () => {
    mount();
    expect(await screen.findByText(/Keine offenen Freigaben/)).toBeTruthy();
    expect(await screen.findByText(/Noch keine Aktivität/)).toBeTruthy();
    expect(screen.getByTestId('stat-approvals').textContent).toContain('nichts offen');
  });

  it('is available in English', async () => {
    mount({ locale: 'en', approvals: [approval()], activity: ACTIVITY });
    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeTruthy();
    expect(screen.getByTestId('stat-approvals').textContent).toContain('waiting for you');
    expect(
      await screen.findByText(/Extend lifetime to 5h 00m: web-tests/, { selector: 'strong' }),
    ).toBeTruthy();
    expect((await screen.findAllByTestId('activity-row'))[1]!.textContent).toContain(
      'Request blocked',
    );
  });

  it('"Neue Sandbox" opens the new-sandbox dialog', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Neue Sandbox' }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });
});
