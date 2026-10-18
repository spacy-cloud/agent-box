// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { HostProfile } from '@abox/core';
import type { HostRow } from '../../src/shared/types';
import { HostsView } from '../../src/renderer/views/Hosts';
import { SshTabsProvider } from '../../src/renderer/views/ssh-tabs';
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

const LOCAL = profile({ id: 'local', kind: 'local', backends: ['docker'] });

function mount(hosts: HostProfile[]) {
  const calls = installBridge((channel, input) => {
    switch (channel) {
      case 'hosts:list':
        return hosts.map(row);
      case 'hosts:forwards':
        return [];
      case 'sandboxes:list':
        return { sandboxes: [], orphans: [], unreachableHosts: [] };
      case 'capacity:host':
        throw new Error('not measured in this test');
      case 'hosts:add':
        return row(profile({ ...(input as object), id: (input as { id: string }).id }));
      case 'hosts:update':
        return row(hosts.find((h) => h.id === (input as { id: string }).id)!);
      default:
        throw new Error(`unexpected ${channel}`);
    }
  });
  renderApp(
    <SshTabsProvider>
      <HostsView />
    </SshTabsProvider>,
    { locale: 'de' },
  );
  return calls;
}

const limitFields = () => ({
  sandboxes: screen.getByLabelText('Max. Sandboxes') as HTMLInputElement,
  cpus: screen.getByLabelText('CPUs gesamt') as HTMLInputElement,
  memory: screen.getByLabelText('Arbeitsspeicher gesamt') as HTMLInputElement,
});
const saveButton = () => screen.getByRole('button', { name: 'Speichern' }) as HTMLButtonElement;
const update = (calls: ReturnType<typeof mount>) =>
  calls.find((c) => c.channel === 'hosts:update')!.input as {
    id: string;
    patch: Record<string, unknown>;
  };

describe('Host dialog: Limits', () => {
  it('edit: shows the current limits, empty fields for the ones that are not set', async () => {
    mount([LOCAL, profile({ id: 'home-server', limits: { sandboxes: 3, memory: '16g' } })]);
    const line = (await screen.findByRole('rowheader', { name: /home-server/ })).closest('tr')!;
    fireEvent.click(within(line).getByRole('button', { name: /Bearbeiten/ }));
    const dialog = await screen.findByRole('dialog', { name: /Host bearbeiten/ });
    const group = within(dialog).getByRole('group', { name: 'Limits' });
    expect(group).toBeTruthy();
    const f = limitFields();
    expect([f.sandboxes.value, f.cpus.value, f.memory.value]).toEqual(['3', '', '16g']);
    expect(f.sandboxes.placeholder).toBe('kein Limit');
    // the point of the feature: 3 containers, no remove + add
    expect(dialog.textContent).toContain('höchstens 3 Sandboxes');
  });

  it('edit: saves the limits through the existing update path; empty clears them', async () => {
    const calls = mount([LOCAL, profile({ id: 'home-server' })]);
    const line = (await screen.findByRole('rowheader', { name: /home-server/ })).closest('tr')!;
    fireEvent.click(within(line).getByRole('button', { name: /Bearbeiten/ }));
    await screen.findByRole('dialog', { name: /Host bearbeiten/ });
    const f = limitFields();
    fireEvent.change(f.sandboxes, { target: { value: '3' } });
    fireEvent.change(f.cpus, { target: { value: '2,5' } });
    fireEvent.change(f.memory, { target: { value: '16g' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(calls.some((c) => c.channel === 'hosts:update')).toBe(true));
    expect(update(calls)).toMatchObject({
      id: 'home-server',
      patch: { limits: { sandboxes: 3, cpus: 2.5, memory: '16g' } },
    });
  });

  it('edit: emptying all fields removes the limits (null)', async () => {
    const calls = mount([
      LOCAL,
      profile({ id: 'home-server', limits: { sandboxes: 3, cpus: 4, memory: '8g' } }),
    ]);
    const line = (await screen.findByRole('rowheader', { name: /home-server/ })).closest('tr')!;
    fireEvent.click(within(line).getByRole('button', { name: /Bearbeiten/ }));
    await screen.findByRole('dialog', { name: /Host bearbeiten/ });
    const f = limitFields();
    for (const el of [f.sandboxes, f.cpus, f.memory])
      fireEvent.change(el, { target: { value: '' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(calls.some((c) => c.channel === 'hosts:update')).toBe(true));
    expect(update(calls).patch['limits']).toBeNull();
  });

  it('0 sandboxes is allowed, like on the command line', async () => {
    const calls = mount([LOCAL, profile({ id: 'home-server' })]);
    const line = (await screen.findByRole('rowheader', { name: /home-server/ })).closest('tr')!;
    fireEvent.click(within(line).getByRole('button', { name: /Bearbeiten/ }));
    await screen.findByRole('dialog', { name: /Host bearbeiten/ });
    fireEvent.change(limitFields().sandboxes, { target: { value: '0' } });
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());
    await waitFor(() => expect(calls.some((c) => c.channel === 'hosts:update')).toBe(true));
    expect(update(calls).patch['limits']).toEqual({ sandboxes: 0 });
  });

  it('validates like the CLI: an error under the field, Save is disabled, nothing is sent', async () => {
    const calls = mount([LOCAL, profile({ id: 'home-server' })]);
    const line = (await screen.findByRole('rowheader', { name: /home-server/ })).closest('tr')!;
    fireEvent.click(within(line).getByRole('button', { name: /Bearbeiten/ }));
    await screen.findByRole('dialog', { name: /Host bearbeiten/ });
    const f = limitFields();
    fireEvent.change(f.sandboxes, { target: { value: '3.5' } });
    expect(f.sandboxes.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('Eine ganze Zahl von 0 bis 10000, oder leer.')).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
    fireEvent.change(f.sandboxes, { target: { value: '3' } });
    fireEvent.change(f.cpus, { target: { value: '0' } });
    expect(screen.getByText('Eine Zahl größer als 0 und höchstens 1024, oder leer.')).toBeTruthy();
    fireEvent.change(f.cpus, { target: { value: '8' } });
    fireEvent.change(f.memory, { target: { value: 'viel' } });
    expect(screen.getByText('Eine Größe wie 512m oder 16g, oder leer.')).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
    // submitting by Enter does not get around it
    fireEvent.submit(document.getElementById('host-form')!);
    expect(calls.some((c) => c.channel === 'hosts:update')).toBe(false);
    fireEvent.change(f.memory, { target: { value: '512m' } });
    expect(saveButton().disabled).toBe(false);
  });

  it('add: the section is part of the new-host dialog and its values go to hosts:add', async () => {
    const calls = mount([LOCAL]);
    fireEvent.click(await screen.findByRole('button', { name: 'Host hinzufügen' }));
    await screen.findByRole('dialog');
    fireEvent.change(screen.getByLabelText('ID'), { target: { value: 'nas' } });
    fireEvent.change(screen.getByLabelText('Hostname oder IP'), { target: { value: 'nas.lan' } });
    const f = limitFields();
    fireEvent.change(f.sandboxes, { target: { value: '3' } });
    fireEvent.change(f.memory, { target: { value: '12g' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(calls.some((c) => c.channel === 'hosts:add')).toBe(true));
    expect(calls.find((c) => c.channel === 'hosts:add')!.input).toMatchObject({
      id: 'nas',
      limits: { sandboxes: 3, memory: '12g' },
    });
  });

  it('add: without limits none are sent', async () => {
    const calls = mount([LOCAL]);
    fireEvent.click(await screen.findByRole('button', { name: 'Host hinzufügen' }));
    await screen.findByRole('dialog');
    fireEvent.change(screen.getByLabelText('ID'), { target: { value: 'nas' } });
    fireEvent.change(screen.getByLabelText('Hostname oder IP'), { target: { value: 'nas.lan' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(calls.some((c) => c.channel === 'hosts:add')).toBe(true));
    expect(calls.find((c) => c.channel === 'hosts:add')!.input).not.toHaveProperty('limits');
  });

  it('this computer: only the limits can be edited, and only they are sent', async () => {
    const calls = mount([{ ...LOCAL, limits: { cpus: 8 } }]);
    const line = (await screen.findByRole('rowheader', { name: /local/ })).closest('tr')!;
    fireEvent.click(within(line).getByRole('button', { name: /Limits/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Limits für diesen Rechner' });
    // no ssh fields in this dialog
    expect(within(dialog).queryByLabelText('Hostname oder IP')).toBeNull();
    expect(within(dialog).queryByLabelText('Zone')).toBeNull();
    expect(dialog.textContent).toContain('hosts.yaml');
    const f = limitFields();
    expect(f.cpus.value).toBe('8');
    fireEvent.change(f.sandboxes, { target: { value: '2' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(calls.some((c) => c.channel === 'hosts:update')).toBe(true));
    expect(update(calls)).toEqual({
      id: 'local',
      patch: { limits: { sandboxes: 2, cpus: 8 } },
    });
  });
});
