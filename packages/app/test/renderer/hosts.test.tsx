// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { HostProfile } from '@abox/core';
import type { HostRow } from '../../src/shared/types';
import { HostsView } from '../../src/renderer/views/Hosts';
import { NewSandboxDialog } from '../../src/renderer/views/NewSandbox';
import { SshTabsProvider } from '../../src/renderer/views/ssh-tabs';
import { installBridge, renderApp } from './harness';

afterEach(cleanup);
// jsdom has no Element.scrollTo (the progress log of the dialog scrolls to its end)
beforeAll(() => {
  Element.prototype.scrollTo = () => undefined;
});

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
      warnings: [],
    },
    forwardsRunning: 0,
  };
}

const LOCAL = profile({ id: 'local', kind: 'local', backends: ['docker'] });
const LAB = profile({ id: 'lab1' });
const BARE = profile({ id: 'bare', backends: [] });

function bridge(extra: (channel: string, input: unknown) => unknown = () => undefined) {
  return installBridge((channel, input) => {
    const x = extra(channel, input);
    if (x !== undefined) return x;
    switch (channel) {
      case 'hosts:list':
        return [row(LOCAL), row(LAB), row(BARE)];
      case 'hosts:forwards':
        return [];
      case 'templates:list':
        return { templates: [NODE], problems: [] };
      case 'templates:show':
        return { template: {}, warnings: [], effectiveLimits: { exceedsProfile: [] } };
      case 'policy:get':
        return { view: { profile: null }, text: '', source: 'default', path: null };
      case 'projects:recent':
        return [];
      default:
        throw new Error(`unexpected ${channel}`);
    }
  });
}

async function toOptions() {
  // pick the one template, then Next to the options step
  fireEvent.click(await screen.findByRole('radio', { name: /node-dev/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  return screen.findByRole('combobox', { name: /Host/ });
}
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
const withTemplates = (channel: string) =>
  channel === 'templates:list'
    ? { templates: [NODE], problems: [] }
    : channel === 'templates:show'
      ? { template: {}, warnings: [], effectiveLimits: { exceedsProfile: [] } }
      : undefined;

describe('Hosts view: new sandbox on a host', () => {
  it('offers the action for every host and opens the wizard with that host preselected', async () => {
    const navigate = vi.fn();
    const calls = bridge((channel) =>
      channel === 'sandboxes:create'
        ? { status: 'created', sandbox: { id: 'lab1/aa', name: 'x' } }
        : undefined,
    );
    renderApp(
      <SshTabsProvider>
        <HostsView />
      </SshTabsProvider>,
      { locale: 'en', navigate },
    );
    const lab = (await screen.findByRole('rowheader', { name: /lab1/ })).closest('tr')!;
    // the local row has the action too
    const local = screen.getByRole('rowheader', { name: /local/ }).closest('tr')!;
    expect(within(local).getByRole('button', { name: /New sandbox/ })).toBeTruthy();

    fireEvent.click(within(lab).getByRole('button', { name: /New sandbox/ }));
    await screen.findByRole('dialog', { name: 'New sandbox' });
    const select = (await toOptions()) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('lab1'));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Check and create' }));
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({ view: 'detail', sandboxId: 'lab1/aa' }),
    );
    expect(calls.find((c) => c.channel === 'sandboxes:create')!.input).toMatchObject({
      template: 'node-dev',
      host: 'lab1',
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('local means this computer: the host field stays empty', async () => {
    bridge();
    renderApp(
      <SshTabsProvider>
        <HostsView />
      </SshTabsProvider>,
      { locale: 'en' },
    );
    const local = (await screen.findByRole('rowheader', { name: /local/ })).closest('tr')!;
    fireEvent.click(within(local).getByRole('button', { name: /New sandbox/ }));
    await screen.findByRole('dialog', { name: 'New sandbox' });
    expect(((await toOptions()) as HTMLSelectElement).value).toBe('');
  });
});

describe('New sandbox dialog: preselected host', () => {
  it('shows the host in the select, also for a host without backends, and sends it on create', async () => {
    const calls = bridge((channel, input) => {
      if (channel === 'sandboxes:create')
        return { status: 'created', sandbox: { id: 'bare/aa', name: 'x' }, input };
      return withTemplates(channel);
    });
    const onCreated = vi.fn();
    renderApp(<NewSandboxDialog host="bare" onClose={vi.fn()} onCreated={onCreated} />, {
      locale: 'en',
    });
    const select = (await toOptions()) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('bare'));
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => (o as HTMLOptionElement).value),
    ).toEqual(['', 'lab1', 'bare']);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Check and create' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('bare/aa'));
    expect(calls.find((c) => c.channel === 'sandboxes:create')!.input).toMatchObject({
      template: 'node-dev',
      host: 'bare',
    });
  });

  it('without a host the default is this computer, and "local" sends no host', async () => {
    for (const host of [undefined, 'local']) {
      cleanup();
      const calls = bridge((channel) => {
        if (channel === 'sandboxes:create')
          return { status: 'created', sandbox: { id: 'local/aa', name: 'x' } };
        return withTemplates(channel);
      });
      renderApp(
        <NewSandboxDialog {...(host ? { host } : {})} onClose={vi.fn()} onCreated={vi.fn()} />,
        { locale: 'en' },
      );
      const select = (await toOptions()) as HTMLSelectElement;
      expect(select.value).toBe('');
      fireEvent.click(screen.getByRole('button', { name: 'Next' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Check and create' }));
      await waitFor(() => expect(calls.some((c) => c.channel === 'sandboxes:create')).toBe(true));
      expect(calls.find((c) => c.channel === 'sandboxes:create')!.input).not.toHaveProperty('host');
    }
  });
});
