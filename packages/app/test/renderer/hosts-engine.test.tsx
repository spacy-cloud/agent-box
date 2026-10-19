// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { HostProfile } from '@abox/core';
import type { HostRow } from '../../src/shared/types';
import { HostsView } from '../../src/renderer/views/Hosts';
import { SshTabsProvider } from '../../src/renderer/views/ssh-tabs';
import { IPC } from '../../src/shared/ipc';
import { RLO } from './fixtures';
import { installBridge, renderApp } from './harness';
import { rowAction } from './row-action';

afterEach(cleanup);

const LAB = {
  id: 'lab1',
  kind: 'ssh',
  hostname: 'lab1.example.org',
  user: 'abox',
  zone: 'shared',
  backends: ['docker', 'podman'],
  runtimes: { docker: 'runsc' },
  allowRootful: true,
  tags: [],
  favorite: false,
  portForwards: [],
} as unknown as HostProfile;

function row(p: HostProfile, over: Partial<HostRow['status']> = {}): HostRow {
  return {
    profile: p,
    minIsolation: 'hardened',
    requiresApproval: true,
    status: {
      state: 'reachable',
      checkedAt: Date.now(),
      lastOkAt: Date.now(),
      latencyMs: 12,
      stale: false,
      error: null,
      hostKey: 'trusted',
      authOk: true,
      remoteUser: 'abox',
      backends: [],
      engine: { rootless: false, runtimes: ['runc', 'runsc'] },
      runtimes: [
        { engine: 'docker', runtime: 'runsc', available: true },
        { engine: 'podman', runtime: `kata${RLO}`, available: false },
      ],
      warnings: [],
      ...over,
    },
    forwardsRunning: 0,
  };
}

function mount() {
  return installBridge((channel) => {
    switch (channel) {
      case 'hosts:list':
        return [row(LAB)];
      case 'hosts:forwards':
        return [];
      case 'sandboxes:list':
        return { sandboxes: [], orphans: [], unreachableHosts: [] };
      case 'hosts:update':
        return row(LAB);
      default:
        throw new Error(`unexpected ${channel}`);
    }
  });
}

describe('Hosts view: engine and runtimes', () => {
  it('shows rootless / rootful, the hardened runtimes and whether the engine has them', async () => {
    mount();
    renderApp(
      <SshTabsProvider>
        <HostsView />
      </SshTabsProvider>,
    );
    const r = (await screen.findByRole('rowheader', { name: /lab1/ })).closest('tr')!;
    expect(r.textContent).toContain('⚠ Engine: rootful');
    expect(r.textContent).toContain('Laufzeiten: runc, runsc');
    expect(r.textContent).toContain('Gehärtete Laufzeit docker: runsc (vorhanden)');
    expect(r.textContent).toMatch(/Gehärtete Laufzeit podman: kata\\u202e \(FEHLT in der Engine\)/);
    expect(r.textContent).not.toContain(RLO);
    // the profile: runtime next to the backend, rootful opt-in as a red badge
    expect(within(r).getByText('docker (runsc), podman')).toBeTruthy();
    expect(within(r).getByText('Rootful erlaubt').className).toContain('badge-danger');
  });

  it('the edit form has the runtimes and the rootful opt-in with a clear warning, and sends them', async () => {
    const calls = mount();
    renderApp(
      <SshTabsProvider>
        <HostsView />
      </SshTabsProvider>,
    );
    const r = (await screen.findByRole('rowheader', { name: /lab1/ })).closest('tr')!;
    fireEvent.click(rowAction(r, /^Bearbeiten/));
    const dlg = await screen.findByRole('dialog', { name: /Host bearbeiten/ });
    expect(
      (within(dlg).getByLabelText('Gehärtete Laufzeit für Docker') as HTMLInputElement).value,
    ).toBe('runsc');
    const rootful = within(dlg).getByRole('checkbox', {
      name: 'Rootful-Engine erlauben',
    }) as HTMLInputElement;
    expect(rootful.checked).toBe(true);
    expect(within(dlg).getByRole('alert').textContent).toContain('Root');
    fireEvent.change(within(dlg).getByLabelText('Gehärtete Laufzeit für Podman'), {
      target: { value: 'kata' },
    });
    fireEvent.change(within(dlg).getByLabelText('Gehärtete Laufzeit für Docker'), {
      target: { value: '' },
    });
    fireEvent.click(rootful);
    expect(within(dlg).queryByRole('alert')).toBeNull();
    fireEvent.click(within(dlg).getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(calls.some((c) => c.channel === 'hosts:update')).toBe(true));
    const patch = (
      calls.find((c) => c.channel === 'hosts:update')!.input as { patch: Record<string, unknown> }
    ).patch;
    expect(patch['runtimes']).toEqual({ podman: 'kata' });
    expect(patch['allowRootful']).toBeNull();
  });
});

describe('host IPC input: runtimes', () => {
  it('accepts runtime names and the opt-in, refuses anything else', () => {
    const ok = (v: unknown) => IPC['hosts:add'].safeParse(v).success;
    expect(ok({ id: 'a', runtimes: { docker: 'runsc' }, allowRootful: true })).toBe(true);
    expect(ok({ id: 'a', runtimes: { docker: 'runsc; rm' } })).toBe(false);
    expect(ok({ id: 'a', runtimes: { vm: 'x' } })).toBe(false);
    expect(ok({ id: 'a', allowRootful: 'yes' })).toBe(false);
    expect(
      IPC['hosts:update'].safeParse({ id: 'a', patch: { runtimes: null, allowRootful: null } })
        .success,
    ).toBe(true);
  });
});
