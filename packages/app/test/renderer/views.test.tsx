// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { SandboxView } from '@abox/core';
import { SandboxesView } from '../../src/renderer/views/Sandboxes';
import { buildCreateInput } from '../../src/renderer/views/NewSandbox';
import { toAuditFilter } from '../../src/renderer/views/Audit';
import { IsolationBadge, Tabs } from '../../src/renderer/components/ui';
import { installBridge, renderApp } from './harness';

afterEach(cleanup);

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
    workspace: {
      mode: 'copy',
      sandboxPath: '/workspace',
      access: 'rw',
      source: '/home/u/proj',
      remote: false,
    },
    network: { mode: 'none', allow: [] },
    mounts: [],
    resources: { cpus: 2, memoryBytes: 2147483648, ttlMs: 3_600_000 },
    secretRefs: [],
    effective: null,
    requestId: null,
    ...over,
  };
}

describe('SandboxesView', () => {
  it('explains the next step when there is no sandbox', async () => {
    installBridge(() => ({ sandboxes: [], orphans: [], unreachableHosts: [] }));
    renderApp(<SandboxesView />);
    expect(await screen.findByText('Noch keine Sandbox')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Aus Template erstellen' })).toBeTruthy();
  });

  it('lists sandboxes with owner and isolation badges, colours isolation none red, shows orphans on top and filters', async () => {
    installBridge(() => ({
      sandboxes: [
        sb({}),
        sb({
          id: 'local/bbbb2222',
          name: 'beta',
          owner: 'agent:claude',
          isolation: 'none',
          backend: 'process',
          template: 'host-shell',
          network: { mode: 'open', allow: [] },
        }),
        sb({ id: 'local/cccc3333', name: 'gamma', state: 'stopped', stale: true }),
      ],
      orphans: [
        {
          id: 'local/dddd4444',
          name: 'x',
          host: 'local',
          backend: 'docker',
          template: 't',
          owner: 'human',
          state: 'running',
          createdAt: 1,
        },
      ],
      unreachableHosts: ['vps'],
    }));
    renderApp(<SandboxesView />);
    const beta = (await screen.findByText('beta')).closest('tr')!;
    expect(within(beta).getByText(/Keine Isolation/).className).toContain('badge-strong-danger');
    expect(within(beta).getByText('Agent: claude')).toBeTruthy();
    expect(within(beta).getByText('Offenes Netzwerk')).toBeTruthy();
    const alpha = screen.getByText('alpha').closest('tr')!;
    expect(within(alpha).getByText('Container').className).toContain('badge-info');
    expect(within(alpha).getByText('Mensch')).toBeTruthy();
    expect(within(screen.getByText('gamma').closest('tr')!).getByText('veraltet')).toBeTruthy();

    // orphans, stale and unreachable hints sit above the table
    expect(screen.getByText(/1 verwaiste Ressource gefunden/)).toBeTruthy();
    expect(screen.getByText(/Hosts nicht erreichbar: vps/)).toBeTruthy();

    // filter by owner "any agent"
    fireEvent.change(screen.getByLabelText('Besitzer'), { target: { value: 'agent' } });
    await waitFor(() => expect(screen.queryByText('alpha')).toBeNull());
    expect(screen.getByText('beta')).toBeTruthy();
  });

  it('row actions have accessible names and deleting asks for confirmation first', async () => {
    const calls = installBridge((c) => {
      if (c === 'sandboxes:list') return { sandboxes: [sb({})], orphans: [], unreachableHosts: [] };
      return { id: 'local/aaaa1111', removed: true };
    });
    renderApp(<SandboxesView />);
    await screen.findByText('alpha');
    expect(screen.getByRole('button', { name: 'Stoppen: alpha' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Verlängern: alpha' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Löschen: alpha' }));
    expect(await screen.findByText('Sandbox löschen?')).toBeTruthy();
    expect(calls.some((c) => c.channel === 'sandboxes:remove')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Endgültig löschen' }));
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.channel === 'sandboxes:remove' && (c.input as { id: string }).id === 'local/aaaa1111',
        ),
      ).toBe(true),
    );
  });
});

describe('create request builder', () => {
  const base = {
    template: 't',
    name: '',
    workspaceMode: '',
    workspacePath: '',
    cpus: '',
    memory: '',
    ttl: '',
    networkMode: '',
    allow: '',
    presets: [] as string[],
  };
  it('sends only what the user changed', () => {
    expect(buildCreateInput(base)).toEqual({ template: 't' });
    expect(
      buildCreateInput({
        ...base,
        name: 'x',
        workspaceMode: 'copy',
        workspacePath: ' /p ',
        cpus: '2',
        memory: '4g',
        ttl: '2h',
        networkMode: 'allowlist',
        allow: 'a.org, b.org',
        presets: ['npm'],
      }),
    ).toEqual({
      template: 't',
      name: 'x',
      workspace: { mode: 'copy', path: '/p' },
      overrides: {
        cpus: 2,
        memory: '4g',
        ttl: '2h',
        network: { mode: 'allowlist', allow: ['a.org', 'b.org'], presets: ['npm'] },
      },
    });
    expect(
      buildCreateInput({ ...base, workspaceMode: 'empty', workspacePath: '/ignored' }).workspace,
    ).toEqual({ mode: 'empty' });
  });
});

describe('audit filter builder', () => {
  it('maps the form to the IPC filter', () => {
    expect(
      toAuditFilter({
        actor: ' agent:x ',
        action: '',
        decision: 'deny',
        sandboxId: '',
        since: '',
        limit: '50',
      }),
    ).toEqual({ order: 'desc', actor: 'agent:x', decision: 'deny', limit: 50 });
    expect(
      toAuditFilter({ actor: '', action: '', decision: '', sandboxId: '', since: '', limit: 'abc' })
        .limit,
    ).toBe(200);
  });
});

describe('components', () => {
  it('isolation none is spelled out and red; other levels are not', () => {
    installBridge(() => ({}));
    renderApp(
      <>
        <IsolationBadge level="none" />
        <IsolationBadge level="vm" />
      </>,
    );
    expect(screen.getByText(/Keine Isolation/).className).toContain('badge-strong-danger');
    expect(screen.getByText('VM').className).toContain('badge-ok');
  });

  it('tabs follow the WAI-ARIA pattern (roles, roving tabindex, arrow keys)', () => {
    installBridge(() => ({}));
    let active = 'a';
    const tabs = [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
      { id: 'c', label: 'C' },
    ];
    const { rerender } = renderApp(
      <Tabs label="x" tabs={tabs} active={active} onChange={(i) => (active = i)}>
        body
      </Tabs>,
    );
    const list = screen.getByRole('tablist');
    expect(screen.getByRole('tab', { name: 'A' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'B' }).getAttribute('tabindex')).toBe('-1');
    fireEvent.keyDown(list, { key: 'ArrowRight' });
    expect(active).toBe('b');
    fireEvent.keyDown(list, { key: 'End' });
    expect(active).toBe('c');
    rerender(<></>);
  });
});
