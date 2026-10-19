// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ReadinessDialog } from '../../src/renderer/components/ReadinessCheck';
import type { ScopedDoctorReport } from '../../src/shared/types';
import { installBridge, renderApp } from './harness';

afterEach(cleanup);

const OK = {
  scope: { kind: 'template', name: 'flutter-dev', host: 'local' },
  ok: true,
  summary: { ok: 2, info: 1, warning: 0, error: 0 },
  checks: [
    { id: 'template', level: 'ok', severity: 'ok', title: 'template flutter-dev: found and valid' },
    {
      id: 'image',
      level: 'ok',
      severity: 'info',
      title: 'environment image is not built yet: the first create builds it',
      hint: '`abox template build flutter-dev` builds it ahead of time.',
      details: ['the build downloads packages and tools; nothing is downloaded by this check'],
    },
    { id: 'policy', level: 'ok', severity: 'ok', title: 'policy: you may create from flutter-dev' },
  ],
} as unknown as ScopedDoctorReport;

const FAILED = {
  scope: { kind: 'host', host: 'srv' },
  ok: false,
  summary: { ok: 0, info: 0, warning: 1, error: 2 },
  checks: [
    {
      id: 'host.srv',
      level: 'error',
      severity: 'error',
      title: 'host srv cannot be used',
      details: ['connection refused'],
      hint: 'Check the network.',
    },
    { id: 'disk', level: 'warn', severity: 'warning', title: 'disk space is tight' },
    { id: 'limits', level: 'error', severity: 'error', title: 'limits are reached' },
  ],
} as unknown as ScopedDoctorReport;

describe('ReadinessDialog', () => {
  it('asks the manager for the template and shows the checks under a verdict', async () => {
    const calls = installBridge((channel) => {
      if (channel === 'doctor:for') return OK;
      throw new Error(`unexpected ${channel}`);
    });
    const closed: number[] = [];
    renderApp(
      <ReadinessDialog
        target={{ kind: 'template', template: 'flutter-dev', projectDir: '/work/app' }}
        onClose={() => closed.push(1)}
      />,
      { locale: 'en' },
    );
    const dlg = await screen.findByRole('dialog', { name: 'Check: flutter-dev' });
    await waitFor(() => expect(within(dlg).getByText(/^Ready\. 1 note/)).toBeTruthy());
    expect(calls).toEqual([
      {
        channel: 'doctor:for',
        input: { kind: 'template', template: 'flutter-dev', projectDir: '/work/app' },
      },
    ]);
    const list = within(dlg).getByTestId('ready-checks');
    expect(within(list).getByText('template flutter-dev: found and valid')).toBeTruthy();
    // an info check shows its hint
    expect(within(list).getByText(/abox template build flutter-dev/)).toBeTruthy();
    fireEvent.click(within(dlg).getByRole('button', { name: 'Close' }));
    expect(closed).toEqual([1]);
  });

  it('says "not ready" with the number of failed checks, and runs again on request', async () => {
    let n = 0;
    const calls = installBridge((channel) => {
      if (channel !== 'doctor:for') throw new Error(`unexpected ${channel}`);
      n++;
      return FAILED;
    });
    renderApp(
      <ReadinessDialog target={{ kind: 'host', host: 'srv' }} onClose={() => undefined} />,
      {
        locale: 'en',
      },
    );
    const dlg = await screen.findByRole('dialog', { name: 'Check: host srv' });
    await waitFor(() => expect(within(dlg).getByText('Not ready: 2 checks failed.')).toBeTruthy());
    expect(calls[0]).toEqual({ channel: 'doctor:for', input: { kind: 'host', host: 'srv' } });
    // failures show their details and hint without opening anything
    expect(within(dlg).getByText('connection refused')).toBeTruthy();
    expect(within(dlg).getByText('Check the network.')).toBeTruthy();
    fireEvent.click(within(dlg).getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(n).toBe(2));
  });

  it('shows an error from the manager instead of a verdict', async () => {
    installBridge(() => {
      throw new Error('the manager is not available');
    });
    renderApp(
      <ReadinessDialog target={{ kind: 'template', template: 'x' }} onClose={() => undefined} />,
      { locale: 'en' },
    );
    const dlg = await screen.findByRole('dialog');
    await waitFor(() => expect(within(dlg).getByText(/the manager is not available/)).toBeTruthy());
    expect(within(dlg).queryByTestId('ready-checks')).toBeNull();
  });

  it('is German by default', async () => {
    installBridge(() => OK);
    renderApp(<ReadinessDialog target={{ kind: 'host', host: 'srv' }} onClose={() => undefined} />);
    const dlg = await screen.findByRole('dialog', { name: 'Prüfung: Host srv' });
    await waitFor(() => expect(within(dlg).getByText(/^Bereit\. 1 Hinweis/)).toBeTruthy());
    expect(within(dlg).getByRole('button', { name: 'Erneut prüfen' })).toBeTruthy();
  });
});
