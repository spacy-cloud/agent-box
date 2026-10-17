// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { HostProfile } from '@abox/core';
import type { HostRow } from '../../src/shared/types';
import { HostsView } from '../../src/renderer/views/Hosts';
import { SshTabsProvider } from '../../src/renderer/views/ssh-tabs';
import { sb } from './fixtures';
import { installBridge, renderApp } from './harness';

afterEach(cleanup);

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

const HOSTS = [
  profile({ id: 'local', kind: 'local' }),
  profile({
    id: 'lab1',
    tags: ['group.web', 'prod'],
    limits: { sandboxes: 2, cpus: 4, memory: '8g' },
  }),
  profile({ id: 'db1', tags: ['group.db'] }),
  profile({ id: 'plain' }),
];
const GiB = 2 ** 30;
const SANDBOXES = [
  sb({
    id: 'lab1/a',
    host: 'lab1',
    state: 'running',
    resources: { cpus: 2, memoryBytes: GiB, ttlMs: 1 },
  }),
  sb({
    id: 'lab1/b',
    host: 'lab1',
    state: 'stopped',
    resources: { cpus: 1, memoryBytes: GiB / 2, ttlMs: 1 },
  }),
  sb({
    id: 'lab1/c',
    host: 'lab1',
    state: 'removed',
    resources: { cpus: 8, memoryBytes: 8 * GiB, ttlMs: 1 },
  }),
  sb({ id: 'local/d', host: 'local', state: 'running' }),
];

function mount(unreachable: string[] = []) {
  installBridge((channel) => {
    switch (channel) {
      case 'hosts:list':
        return HOSTS.map(row);
      case 'hosts:forwards':
        return [];
      case 'sandboxes:list':
        return { sandboxes: SANDBOXES, orphans: [], unreachableHosts: unreachable };
      default:
        throw new Error(`unexpected ${channel}`);
    }
  });
  renderApp(
    <SshTabsProvider>
      <HostsView />
    </SshTabsProvider>,
  );
}

describe('Hosts view: utilisation and groups', () => {
  it('shows sandboxes, cpu and memory reserved against the limits of the host', async () => {
    mount();
    const lab = (await screen.findByRole('rowheader', { name: /lab1/ })).closest('tr')!;
    const cell = await within(lab).findByTestId('util-lab1');
    await waitFor(() => expect(cell.textContent).toContain('2 von 2 Sandboxes'));
    expect(cell.textContent).toContain('voll');
    // removed sandboxes do not occupy the host; running + stopped reserve 3 of 4 CPU and 1.5 of 8 GiB
    expect(cell.textContent).toContain('CPU: 3 von 4 reserviert');
    expect(cell.textContent).toContain('Speicher: 1.5 GiB von 8.0 GiB reserviert');
    expect(
      within(cell)
        .getByRole('meter', { name: /lab1.*Sandboxes/ })
        .getAttribute('value'),
    ).toBe('1');
    expect(
      within(cell)
        .getByRole('meter', { name: /lab1.*CPU/ })
        .getAttribute('value'),
    ).toBe('0.75');
    expect(within(cell).getByRole('meter', { name: /lab1.*Speicher/ })).toBeTruthy();
    // a host without a limit says so and has no meter
    const local = screen.getByRole('rowheader', { name: /local/ }).closest('tr')!;
    const localCell = within(local).getByTestId('util-local');
    expect(localCell.textContent).toContain('1 Sandbox (kein Limit)');
    expect(localCell.textContent).toContain('CPU: 2 reserviert');
    expect(localCell.textContent).toContain('Speicher: 2.0 GiB reserviert');
    expect(within(localCell).queryByRole('meter')).toBeNull();
  });

  it('says when the numbers are not known (sandbox list failed or the host is unreachable)', async () => {
    mount(['lab1']);
    const lab = (await screen.findByRole('rowheader', { name: /lab1/ })).closest('tr')!;
    expect((await within(lab).findByTestId('util-lab1')).textContent).toContain('Stand unbekannt');
    const db = screen.getByRole('rowheader', { name: /db1/ }).closest('tr')!;
    expect(within(db).getByTestId('util-db1').textContent).not.toContain('Stand unbekannt');
  });

  it('groups the table by group tags, shows the other tags as badges and filters by group', async () => {
    mount();
    await screen.findByRole('rowheader', { name: /lab1/ });
    const heads = [...document.querySelectorAll('tr.group-head th')].map((h) => h.textContent);
    expect(heads).toEqual(['Ohne Gruppe', 'Gruppe: db', 'Gruppe: web']);
    const lab = screen.getByRole('rowheader', { name: /lab1/ });
    expect(within(lab).getByText('prod')).toBeTruthy();
    expect(within(lab).queryByText('group.web')).toBeNull();
    fireEvent.change(screen.getByLabelText('Gruppe'), { target: { value: 'db' } });
    await waitFor(() => expect(screen.queryByRole('rowheader', { name: /lab1/ })).toBeNull());
    expect(screen.getByRole('rowheader', { name: /db1/ })).toBeTruthy();
    expect([...document.querySelectorAll('tr.group-head th')].map((h) => h.textContent)).toEqual([
      'Gruppe: db',
    ]);
  });
});
