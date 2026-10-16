// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalView } from '@abox/core';
import { ApprovalDialog } from '../../src/renderer/views/Approvals';
import { installBridge, renderApp } from './harness';

afterEach(cleanup);

const XSS =
  '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script> **bold** [link](javascript:alert(1))';

function approval(over: Partial<ApprovalView> = {}): ApprovalView {
  return {
    id: 'ap1',
    kind: 'create',
    requester: 'agent:evil',
    sandboxId: null,
    status: 'pending',
    reason: XSS,
    risks: ['Code runs with your user rights on the host.'],
    request: {
      kind: 'create',
      template: { name: 'host-shell', trusted: true, source: { kind: 'builtin', path: '/t.yaml' } },
      isolation: 'none',
      network: { mode: 'open', allow: [], privateExceptions: [] },
      mounts: [{ hostPath: '/etc', target: '/mnt', access: 'rw' }],
      secrets: [],
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

function mount(a: ApprovalView) {
  const calls = installBridge((channel) => {
    if (channel === 'approvals:approve' || channel === 'approvals:deny') return { approval: a };
    throw new Error(`unexpected ${channel}`);
  });
  const onApproved = vi.fn();
  const onDenied = vi.fn();
  const onPermanent = vi.fn();
  renderApp(
    <ApprovalDialog
      approval={a}
      now={Date.now()}
      onApproved={onApproved}
      onDenied={onDenied}
      onPermanent={onPermanent}
    />,
  );
  return { calls, onApproved, onDenied, onPermanent, dialog: screen.getByRole('dialog') };
}

describe('ApprovalDialog', () => {
  it('shows agent text as plain, labelled text and never as HTML', () => {
    const { dialog } = mount(approval());
    const quote = within(dialog).getByText((_, el) => el?.tagName === 'BLOCKQUOTE');
    expect(quote.textContent).toBe(XSS);
    expect(dialog.querySelector('img')).toBeNull();
    expect(dialog.querySelector('script')).toBeNull();
    expect(dialog.querySelector('a')).toBeNull();
    expect((window as unknown as Record<string, unknown>)['__pwned']).toBeUndefined();
    expect(within(dialog).getByText(/Begründung des Agenten \(ungeprüfter Text/)).toBeTruthy();
  });

  it('shows risk hints and the options as a diff against the defaults', () => {
    const { dialog } = mount(approval());
    for (const hint of [
      'Mount außerhalb des Workspace',
      'Offenes Netzwerk',
      'Keine Isolation (Host)',
    ]) {
      expect(within(dialog).getByText(hint)).toBeTruthy();
    }
    const row = within(dialog).getByText('isolation').closest('tr')!;
    expect(row.className).toContain('row-changed');
    expect(row.textContent).toContain('container');
    expect(row.textContent).toContain('none');
    expect(within(dialog).getByText('Risiken')).toBeTruthy();
    expect(within(dialog).getByText('Code runs with your user rights on the host.')).toBeTruthy();
  });

  it('offers deny and allow-once; "allow permanently" only navigates (no hidden toggle)', async () => {
    const { calls, onPermanent, dialog } = mount(approval());
    expect(within(dialog).getByRole('button', { name: 'Ablehnen' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Einmal erlauben' })).toBeTruthy();
    expect(dialog.querySelector('input[type=checkbox]')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: /Dauerhaft erlauben/ }));
    expect(onPermanent).toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('Esc denies', async () => {
    const { calls, onDenied, dialog } = mount(approval());
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(onDenied).toHaveBeenCalled());
    expect(calls).toEqual([{ channel: 'approvals:deny', input: { id: 'ap1' } }]);
  });

  it('Enter allows once only when the dialog itself has focus', async () => {
    const { calls, onApproved, dialog } = mount(approval());
    // Enter from inside a button: the button handles it, the dialog shortcut must not fire
    fireEvent.keyDown(within(dialog).getByRole('button', { name: 'Ablehnen' }), { key: 'Enter' });
    // key auto-repeat on the dialog is ignored
    fireEvent.keyDown(dialog, { key: 'Enter', repeat: true });
    expect(calls).toHaveLength(0);
    fireEvent.keyDown(dialog, { key: 'Enter' });
    await waitFor(() => expect(onApproved).toHaveBeenCalled());
    expect(calls).toEqual([{ channel: 'approvals:approve', input: { id: 'ap1' } }]);
  });

  it('a decided request is read-only (no shortcuts, no buttons)', () => {
    const { calls, dialog } = mount(
      approval({ status: 'denied', decidedBy: 'human', decidedAt: Date.now() }),
    );
    expect(within(dialog).queryByRole('button', { name: 'Einmal erlauben' })).toBeNull();
    fireEvent.keyDown(dialog, { key: 'Enter' });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(calls).toHaveLength(0);
  });

  it('renders in English too', () => {
    installBridge(() => ({}));
    renderApp(
      <ApprovalDialog
        approval={approval()}
        now={Date.now()}
        onApproved={vi.fn()}
        onDenied={vi.fn()}
        onPermanent={vi.fn()}
      />,
      { locale: 'en' },
    );
    expect(screen.getByRole('button', { name: 'Allow once' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Deny' })).toBeTruthy();
  });
});
