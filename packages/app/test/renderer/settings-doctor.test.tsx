// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SettingsView } from '../../src/renderer/views/Settings';
import type { DoctorReport } from '../../src/shared/types';
import { installBridge, renderApp } from './harness';

afterEach(cleanup);

const ROOTFUL =
  'The docker daemon is rootful: access to its socket is root-equivalent on the host. Prefer a rootless engine.';
const NO_QUOTA = 'The storage driver (overlay2 on extfs) has no disk quota';

const REPORT = {
  ok: true,
  summary: { ok: 2, info: 1, warning: 1, error: 0 },
  checks: [
    {
      id: 'backend.local.docker',
      level: 'ok',
      severity: 'ok',
      title: 'backend docker on local: ok',
      detail: 'docker 29; storage driver: overlay2',
      details: ['docker 29', 'storage driver: overlay2'],
      notes: [
        { severity: 'info', message: ROOTFUL },
        { severity: 'info', message: NO_QUOTA },
      ],
    },
    {
      id: 'backend.local.podman',
      level: 'ok',
      severity: 'info',
      title: 'backend podman on local: not installed or not running (optional)',
      hint: 'Start it with `systemctl --user start podman.socket` to use it.',
      details: ['podman engine unreachable: ENOENT'],
    },
    {
      id: 'policy.perms',
      level: 'warn',
      severity: 'warning',
      title: 'policy.yaml is writable by others (mode 666)',
      hint: 'chmod 600 policy.yaml',
      details: ['Anyone who can write this file can widen agent rights.'],
    },
    { id: 'audit', level: 'ok', severity: 'ok', title: 'audit chain intact (3 entries)' },
    {
      id: 'policy.default',
      level: 'ok',
      severity: 'info',
      title: 'no policy.yaml: the built-in default policy is active',
    },
  ],
  backends: [
    {
      host: 'local',
      backend: 'docker',
      available: true,
      status: { ok: true, version: '29.0.0', rootless: false, details: [], warnings: [] },
      capabilities: { isolation: 'container' },
    },
    { host: 'local', backend: 'podman', available: false, status: { ok: false } },
  ],
} as unknown as DoctorReport;

function mount(report: DoctorReport = REPORT) {
  return installBridge((channel) => {
    switch (channel) {
      case 'doctor:run':
        return report;
      case 'mcp:status':
        return {
          contexts: [],
          tokens: { active: 0, revoked: 0, lastUsedAt: null },
          lastActivityAt: null,
        };
      case 'mcp:config':
        return { agent: 'claude-code', claudeCommand: 'c', json: '{}', contexts: ['claude-code'] };
      case 'caches:list':
        return { caches: [], totalBytes: 0, unreachable: [] };
      case 'tokens:list':
        return [];
      default:
        throw new Error(`unexpected ${channel}`);
    }
  });
}

async function backends() {
  return within(await screen.findByRole('table', { name: 'Backends' }));
}

describe('Settings: diagnostics severities', () => {
  it('labels each backend by what it is: a working one OK, an optional missing one neutral, never red', async () => {
    mount();
    renderApp(<SettingsView />);
    const table = await backends();
    const docker = table.getByRole('cell', { name: 'docker' }).closest('tr')!;
    expect(within(docker).getByText('verfügbar').className).toContain('badge-ok');
    const podman = table.getByRole('cell', { name: 'podman' }).closest('tr')!;
    const badge = within(podman).getByText('nicht installiert (optional)');
    expect(badge.className).toContain('badge-neutral');
    expect(podman.textContent).not.toContain('nicht verfügbar');
    expect(podman.textContent).toContain('systemctl --user start podman.socket');
  });

  it('shows a real failure as red "nicht verfügbar"', async () => {
    const report = {
      ...REPORT,
      ok: false,
      checks: [
        {
          id: 'backend.local.docker',
          level: 'error',
          severity: 'error',
          title: 'backend docker on local: not usable',
          details: ['docker engine unreachable at /var/run/docker.sock: ENOENT'],
        },
      ],
      backends: [{ host: 'local', backend: 'docker', available: false, status: { ok: false } }],
    } as unknown as DoctorReport;
    mount(report);
    renderApp(<SettingsView />);
    const table = await backends();
    expect(table.getByText('nicht verfügbar').className).toContain('badge-danger');
    expect(screen.getByText(/Die Diagnose meldet Probleme/)).toBeTruthy();
  });

  it('collapses the advisory notes of a backend into a disclosure instead of run-on text', async () => {
    mount();
    renderApp(<SettingsView />);
    const table = await backends();
    const docker = table.getByRole('cell', { name: 'docker' }).closest('tr')!;
    const summary = within(docker).getByText('Hinweise (2)');
    expect(summary.tagName).toBe('SUMMARY');
    const details = summary.closest('details')!;
    expect(details.open).toBe(false);
    // the notes are in the DOM but hidden until the disclosure is opened
    expect(details.textContent).toContain('rootful');
    fireEvent.click(summary);
    details.open = true; // jsdom does not toggle <details> on click
    expect(within(details).getAllByRole('listitem')).toHaveLength(2);
    // the one-line summary stays short
    expect(docker.textContent).toContain('29.0.0');
  });

  it('badges the checks OK / Hinweis / Warnung / Fehler and shows what needs a look without a click', async () => {
    mount();
    renderApp(<SettingsView />);
    const list = (await screen.findByRole('heading', { name: 'Prüfungen' })).nextElementSibling!;
    const item = (text: string) =>
      within(list as HTMLElement)
        .getByText(text)
        .closest('li')!;
    expect(within(item('audit chain intact (3 entries)')).getByText('OK').className).toContain(
      'badge-ok',
    );
    const info = item('no policy.yaml: the built-in default policy is active');
    expect(within(info).getByText('Hinweis').className).toContain('badge-neutral');
    const warn = item('policy.yaml is writable by others (mode 666)');
    expect(within(warn).getByText('Warnung').className).toContain('badge-warn');
    // details of a warning are visible directly, not behind a disclosure
    expect(within(warn).getByText(/widen agent rights/)).toBeTruthy();
    expect(warn.querySelector('details')).toBeNull();
    // the backend checks are the Backends table's rows: not repeated here
    expect(list.textContent).not.toContain('backend docker on local');
  });

  it('summarises: warnings make the banner amber, notes only keep it green', async () => {
    mount();
    const { unmount } = renderApp(<SettingsView />);
    expect(await screen.findByText(/1 Warnung, die einen Blick wert ist/)).toBeTruthy();
    unmount();
    mount({ ...REPORT, summary: { ok: 3, info: 2, warning: 0, error: 0 } } as DoctorReport);
    renderApp(<SettingsView />);
    expect(await screen.findByText(/Alles funktioniert\. 2 Hinweise/)).toBeTruthy();
  });

  it('translates the severities to English', async () => {
    mount();
    renderApp(<SettingsView />, { locale: 'en' });
    const table = await screen.findByRole('table', { name: 'Backends' });
    expect(within(table).getByText('not installed (optional)')).toBeTruthy();
    expect(within(table).getByText('Notes (2)')).toBeTruthy();
    const list = screen.getByRole('heading', { name: 'Checks' }).nextElementSibling as HTMLElement;
    expect(within(list).getByText('Info')).toBeTruthy();
    expect(within(list).getByText('Warning')).toBeTruthy();
  });

  it('still renders a report from before severities existed (only `level`)', async () => {
    const old = {
      ok: true,
      checks: [
        { id: 'a', level: 'warn', title: 'old warning' },
        { id: 'b', level: 'ok', title: 'old ok' },
      ],
      backends: [],
    } as unknown as DoctorReport;
    mount(old);
    renderApp(<SettingsView />);
    const list = (await screen.findByRole('heading', { name: 'Prüfungen' })).nextElementSibling!;
    expect(within(list as HTMLElement).getByText('Warnung')).toBeTruthy();
  });
});
