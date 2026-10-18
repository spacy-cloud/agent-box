// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalView, InspectResult, SandboxPortForward } from '@abox/core';
import { PortsPanel } from '../../src/renderer/components/PortsPanel';
import { ApprovalDialog, ApprovalsView } from '../../src/renderer/views/Approvals';
import { installBridge, renderApp } from './harness';
import { sb } from './fixtures';

afterEach(cleanup);

const fwd = (over: Partial<SandboxPortForward> = {}): SandboxPortForward => ({
  sandboxPort: 5173,
  hostAddress: '127.0.0.1',
  hostPort: 40001,
  url: 'http://127.0.0.1:40001/',
  createdAt: 1,
  target: 'up',
  ...over,
});

/** A running docker sandbox with network mode allowlist: the case where a forward is possible. */
function inspect(over: Partial<InspectResult> = {}): InspectResult {
  return {
    ...sb({ network: { mode: 'allowlist', allow: [] } }),
    processes: [],
    ports: [],
    pendingApprovals: 0,
    ...over,
  };
}

type Reply = unknown | (() => unknown);
const reply = (v: Reply) => (typeof v === 'function' ? (v as () => unknown)() : v);

/** A bridge whose channels answer from `answers`; `{ error }` makes the channel fail like the main process does. */
function bridge(answers: Record<string, Reply>) {
  const calls: Array<{ channel: string; input: unknown }> = [];
  const invoke = (channel: string, input?: unknown) => {
    calls.push({ channel, input });
    const a = reply(answers[channel]);
    if (a && typeof a === 'object' && 'error' in a) {
      return Promise.resolve({ ok: false as const, error: (a as { error: unknown }).error });
    }
    return Promise.resolve({ ok: true as const, data: a });
  };
  (window as unknown as { abox: unknown }).abox = { invoke, on: () => () => undefined };
  return calls;
}

const applied = (p: SandboxPortForward) => ({
  status: 'applied',
  kind: 'port',
  sandbox: sb(),
  message: 'forwarded',
  port: p,
});

describe('PortsPanel: the forwards', () => {
  it('lists the forwards with address, state and connection count', async () => {
    bridge({
      'ports:list': [
        fwd({ connections: 3 }),
        fwd({ sandboxPort: 8000, hostPort: 40002, url: 'http://127.0.0.1:40002/', target: 'down' }),
        fwd({
          sandboxPort: 9000,
          hostPort: 40003,
          url: 'http://127.0.0.1:40003/',
          target: 'unknown',
        }),
      ],
    });
    renderApp(<PortsPanel sandbox={inspect()} />);
    const table = await screen.findByRole('table', { name: 'Freigegebene Ports' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]!.textContent).toContain('5173');
    expect(rows[0]!.textContent).toContain('http://127.0.0.1:40001/');
    expect(rows[0]!.textContent).toContain('Server antwortet');
    expect(rows[0]!.textContent).toContain('3 Verbindungen');
    // nothing answers: says what to do (0.0.0.0), not only "down"
    expect(rows[1]!.textContent).toContain('Kein Server antwortet');
    expect(rows[1]!.textContent).toContain('0.0.0.0');
    expect(rows[2]!.textContent).toContain('Nicht geprüft');
  });

  it('shows the counters that only some backends report, singular included', async () => {
    bridge({ 'ports:list': [fwd({ connections: 1, rejected: 2, failed: 1 })] });
    renderApp(<PortsPanel sandbox={inspect()} />);
    const row = (await screen.findByText('5173')).closest('tr')!;
    expect(row.textContent).toContain('1 Verbindung');
    expect(row.textContent).toContain('2 abgewiesen, 1 nicht zur Sandbox durchgekommen');
  });

  it('says so when no port is forwarded, in English too', async () => {
    bridge({ 'ports:list': [] });
    renderApp(<PortsPanel sandbox={inspect()} />, { locale: 'en' });
    expect(await screen.findByText('No port forwarded.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Preview' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Forward port' })).toBeTruthy();
  });

  it('asks only for the forwards of its sandbox', async () => {
    const calls = bridge({ 'ports:list': [] });
    renderApp(<PortsPanel sandbox={inspect({ id: 'local/zzzz9999' })} />);
    await screen.findByText('Kein Port freigegeben.');
    expect(calls.filter((c) => c.channel === 'ports:list')[0]!.input).toEqual({
      id: 'local/zzzz9999',
    });
  });

  it('writes agent-influenced text as plain text (the URL field is data, not markup)', async () => {
    bridge({ 'ports:list': [fwd({ url: '<img src=x onerror=alert(1)>‮' })] });
    const { container } = renderApp(<PortsPanel sandbox={inspect()} />);
    await screen.findByText('5173');
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).not.toContain('‮');
  });
});

describe('PortsPanel: add', () => {
  const form = () => ({
    port: screen.getByLabelText('Port in der Sandbox') as HTMLInputElement,
    host: screen.getByLabelText('Port auf diesem Rechner (optional)') as HTMLInputElement,
    submit: screen.getByRole('button', { name: 'Port freigeben' }) as HTMLButtonElement,
  });

  it('forwards the port: asks for the sandbox port only, then reloads the list and clears the form', async () => {
    let listed: SandboxPortForward[] = [];
    const calls = bridge({
      'ports:list': () => listed,
      'ports:add': () => {
        listed = [fwd()];
        return applied(fwd());
      },
    });
    renderApp(<PortsPanel sandbox={inspect()} />);
    await screen.findByText('Kein Port freigegeben.');
    const f = form();
    fireEvent.change(f.port, { target: { value: '5173' } });
    fireEvent.click(f.submit);
    await screen.findByRole('table', { name: 'Freigegebene Ports' });
    const add = calls.filter((c) => c.channel === 'ports:add');
    expect(add).toEqual([{ channel: 'ports:add', input: { id: 'local/aaaa1111', port: 5173 } }]);
    await waitFor(() => expect(form().port.value).toBe(''));
  });

  it('passes an optional host port', async () => {
    const calls = bridge({ 'ports:list': [], 'ports:add': applied(fwd({ hostPort: 8080 })) });
    renderApp(<PortsPanel sandbox={inspect()} />);
    await screen.findByText('Kein Port freigegeben.');
    const f = form();
    fireEvent.change(f.port, { target: { value: '5173' } });
    fireEvent.change(f.host, { target: { value: '8080' } });
    fireEvent.click(f.submit);
    await waitFor(() =>
      expect(calls.find((c) => c.channel === 'ports:add')?.input).toEqual({
        id: 'local/aaaa1111',
        port: 5173,
        hostPort: 8080,
      }),
    );
  });

  it('refuses nonsense before asking anyone and says what is expected', async () => {
    const calls = bridge({ 'ports:list': [] });
    renderApp(<PortsPanel sandbox={inspect()} />);
    await screen.findByText('Kein Port freigegeben.');
    const f = form();
    fireEvent.click(f.submit);
    expect(await screen.findByText('Eine Zahl von 1 bis 65535 eingeben.')).toBeTruthy();
    expect(f.port.getAttribute('aria-invalid')).toBe('true');
    expect(f.port.getAttribute('aria-describedby')).toBeTruthy();
    fireEvent.change(f.port, { target: { value: '70000' } });
    fireEvent.click(f.submit);
    expect(screen.getByText('Eine Zahl von 1 bis 65535 eingeben.')).toBeTruthy();
    fireEvent.change(f.port, { target: { value: '80' } });
    fireEvent.change(f.host, { target: { value: '80' } });
    fireEvent.click(f.submit);
    expect(
      await screen.findByText('Leer lassen oder eine Zahl von 1024 bis 65535 eingeben.'),
    ).toBeTruthy();
    expect(calls.some((c) => c.channel === 'ports:add')).toBe(false);
  });

  it('shows the error of the manager with its hint', async () => {
    bridge({
      'ports:list': [],
      'ports:add': {
        error: {
          code: 'conflict',
          message: 'host port 8080 is already in use',
          hint: 'Pick another host port or leave it empty.',
        },
      },
    });
    renderApp(<PortsPanel sandbox={inspect()} />);
    await screen.findByText('Kein Port freigegeben.');
    const f = form();
    fireEvent.change(f.port, { target: { value: '5173' } });
    fireEvent.change(f.host, { target: { value: '8080' } });
    fireEvent.click(f.submit);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Konflikt');
    expect(alert.textContent).toContain('host port 8080 is already in use');
    expect(alert.textContent).toContain('Pick another host port or leave it empty.');
    // the typed values stay so that they can be corrected
    expect(form().port.value).toBe('5173');
  });

  it('asks for the confirmation the manager requires and repeats the call with it', async () => {
    let first = true;
    const calls = bridge({
      'ports:list': [],
      'ports:add': () => {
        if (first) {
          first = false;
          return {
            status: 'confirmation_required',
            reasons: ['profile "human" uses approval mode strict'],
            risks: ['Every program on this computer can then talk to that port.'],
            items: [],
            message: 'confirm',
          };
        }
        return applied(fwd());
      },
    });
    renderApp(<PortsPanel sandbox={inspect()} />);
    await screen.findByText('Kein Port freigegeben.');
    fireEvent.change(form().port, { target: { value: '5173' } });
    fireEvent.click(form().submit);
    expect(await screen.findByText(/approval mode strict/)).toBeTruthy();
    expect(screen.getByText(/Every program on this computer/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Bestätigen' }));
    await waitFor(() =>
      expect(calls.filter((c) => c.channel === 'ports:add').map((c) => c.input)).toEqual([
        { id: 'local/aaaa1111', port: 5173 },
        { id: 'local/aaaa1111', port: 5173, confirmed: true },
      ]),
    );
  });
});

describe('PortsPanel: remove and open preview', () => {
  it('removes one forward by its sandbox port and reloads', async () => {
    let listed = [
      fwd(),
      fwd({ sandboxPort: 8000, hostPort: 40002, url: 'http://127.0.0.1:40002/' }),
    ];
    const calls = bridge({
      'ports:list': () => listed,
      'ports:remove': () => {
        listed = listed.filter((p) => p.sandboxPort !== 8000);
        return { removed: true };
      },
    });
    renderApp(<PortsPanel sandbox={inspect()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Freigabe entfernen: Port 8000' }));
    await waitFor(() => expect(screen.queryByText('8000')).toBeNull());
    expect(calls.find((c) => c.channel === 'ports:remove')?.input).toEqual({
      id: 'local/aaaa1111',
      port: 8000,
    });
    expect(screen.getByText('5173')).toBeTruthy();
  });

  it('opens the preview by naming sandbox and port only, never a URL', async () => {
    const calls = bridge({
      'ports:list': [fwd({ url: 'https://evil.example/' })],
      'ports:openPreview': { url: 'http://127.0.0.1:40001/' },
    });
    renderApp(<PortsPanel sandbox={inspect()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Vorschau öffnen: Port 5173' }));
    await waitFor(() => expect(calls.some((c) => c.channel === 'ports:openPreview')).toBe(true));
    const open = calls.find((c) => c.channel === 'ports:openPreview')!;
    expect(open.input).toEqual({ id: 'local/aaaa1111', port: 5173 });
    // no link either: the page itself cannot navigate to the preview
    expect(document.querySelector('a[href]')).toBeNull();
  });

  it('shows a refusal of the main process (and keeps the list)', async () => {
    bridge({
      'ports:list': [fwd()],
      'ports:openPreview': {
        error: {
          code: 'not_found',
          message: 'port 5173 of this sandbox is not forwarded',
          hint: 'Forward the port first.',
        },
      },
    });
    renderApp(<PortsPanel sandbox={inspect()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Vorschau öffnen: Port 5173' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('port 5173 of this sandbox is not forwarded');
    expect(alert.textContent).toContain('Forward the port first.');
  });
});

describe('PortsPanel: when no forward is possible it says why and offers nothing', () => {
  function expectDisabled(): void {
    expect(
      (screen.getByRole('button', { name: 'Port freigeben' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((screen.getByLabelText('Port in der Sandbox') as HTMLInputElement).disabled).toBe(true);
  }

  it('sandbox not running', async () => {
    const calls = bridge({ 'ports:list': [] });
    renderApp(<PortsPanel sandbox={inspect({ state: 'stopped' })} />);
    expect(await screen.findByText(/Die Sandbox läuft nicht/)).toBeTruthy();
    expectDisabled();
    expect(calls.some((c) => c.channel === 'ports:list')).toBe(false);
  });

  it('network mode none: names the template setting that is needed', async () => {
    bridge({ 'ports:list': [] });
    renderApp(<PortsPanel sandbox={inspect({ network: { mode: 'none', allow: [] } })} />);
    const note = await screen.findByText(/„Kein Netzwerk“/);
    expect(note.textContent).toContain('„allowlist“');
    expect(note.textContent).toContain('neu an');
    expectDisabled();
  });

  it('network mode none, in English', async () => {
    bridge({ 'ports:list': [] });
    renderApp(<PortsPanel sandbox={inspect({ network: { mode: 'none', allow: [] } })} />, {
      locale: 'en',
    });
    const note = await screen.findByText(/"No network"/);
    expect(note.textContent).toContain('"allowlist"');
    expect(
      (screen.getByRole('button', { name: 'Forward port' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('process backend / isolation none and remote hosts', async () => {
    bridge({ 'ports:list': [] });
    const { unmount } = renderApp(
      <PortsPanel sandbox={inspect({ isolation: 'none', backend: 'process' })} />,
    );
    expect(await screen.findByText(/läuft direkt auf dem Host/)).toBeTruthy();
    expectDisabled();
    unmount();
    renderApp(<PortsPanel sandbox={inspect({ host: 'vps' })} />);
    expect(await screen.findByText(/entfernten Hosts \(SSH\)/)).toBeTruthy();
    expectDisabled();
  });

  it('does not offer anything for a running sandbox with a network path as disabled', async () => {
    bridge({ 'ports:list': [] });
    renderApp(<PortsPanel sandbox={inspect()} />);
    await screen.findByText('Kein Port freigegeben.');
    expect(
      (screen.getByRole('button', { name: 'Port freigeben' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(screen.queryByText(/Die Sandbox läuft nicht/)).toBeNull();
  });
});

// The request as the manager stores it for an agent's port request (sandbox_port_forward).
function portApproval(over: Partial<ApprovalView> = {}): ApprovalView {
  return {
    id: 'ap-port',
    kind: 'access',
    requester: 'agent:claude',
    sandboxId: 'local/aaaa1111',
    status: 'pending',
    reason: 'preview the vite dev server',
    risks: [
      'Any process on this machine can then talk to that port of the sandbox. The sandbox gets no new way out.',
    ],
    items: [
      {
        kind: 'port_forward',
        reason: 'forward port 5173 of sandbox local/aaaa1111 to 127.0.0.1 on this machine',
        risk: 'Any process on this machine can then talk to that port of the sandbox.',
        invariant: true,
      },
    ],
    kinds: ['port_forward'],
    reasons: ['forward port 5173 of sandbox local/aaaa1111 to 127.0.0.1 on this machine'],
    base: null,
    request: {
      v: 1,
      kind: 'access_request',
      owner: 'agent:claude',
      context: 'claude',
      profile: 'agent',
      sandbox: 'local/aaaa1111',
      request: { kind: 'port', details: { sandboxPort: 5173 } },
      policy: 'hash',
      apply: { kind: 'port', sandboxPort: 5173 },
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

describe('Approvals: a port request of an agent', () => {
  function mount(a: ApprovalView, locale: 'de' | 'en' = 'de') {
    const calls = installBridge((channel) => {
      if (channel === 'approvals:approve') return { approval: a };
      if (channel === 'approvals:image') return null;
      throw new Error(`unexpected ${channel}`);
    });
    const onApproved = vi.fn();
    renderApp(
      <ApprovalDialog approval={a} now={Date.now()} onApproved={onApproved} onDenied={vi.fn()} />,
      { locale },
    );
    return { calls, onApproved, dialog: screen.getByRole('dialog') };
  }

  it('has a title of its own, names agent, sandbox and port, and shows the risk from the core', () => {
    const { dialog } = mount(portApproval());
    expect(
      within(dialog).getByRole('heading', { name: 'Port-Weiterleitung (Vorschau)' }),
    ).toBeTruthy();
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy();
    const summary = within(dialog).getByTestId('port-summary');
    expect(summary.textContent).toBe(
      'Der Agent möchte Port 5173 der Sandbox local/aaaa1111 auf diesem Rechner unter 127.0.0.1 erreichbar machen.',
    );
    expect(within(dialog).getByText('Port auf diesem Rechner geöffnet')).toBeTruthy();
    expect(within(dialog).getByText(/Any process on this machine can then talk/)).toBeTruthy();
    expect(within(dialog).getByText(/forward port 5173 of sandbox/)).toBeTruthy();
    expect(within(dialog).getByText(/Begründung des Agenten/)).toBeTruthy();
    // explanation of what "allow once" does, and the port is a row of the details, not an unknown request
    expect(dialog.textContent).toContain('„Einmal erlauben“ öffnet genau diese Weiterleitung');
    expect(
      within(dialog).getByText('request.details.sandboxPort').closest('tr')!.textContent,
    ).toContain('5173');
    // it is not presented as an unknown kind of request
    expect(dialog.textContent).not.toContain('Anfrage-Typ');
  });

  it('English labels', () => {
    const { dialog } = mount(portApproval(), 'en');
    expect(within(dialog).getByRole('heading', { name: 'Port forward (preview)' })).toBeTruthy();
    expect(within(dialog).getByTestId('port-summary').textContent).toBe(
      'The agent wants to make port 5173 of sandbox local/aaaa1111 reachable on this computer at 127.0.0.1.',
    );
    expect(within(dialog).getByText('Port opened on this computer')).toBeTruthy();
  });

  it('allow once approves through the normal approve call', async () => {
    const { calls, onApproved, dialog } = mount(portApproval());
    fireEvent.click(within(dialog).getByRole('button', { name: 'Einmal erlauben' }));
    await waitFor(() => expect(onApproved).toHaveBeenCalled());
    expect(calls.filter((c) => c.channel === 'approvals:approve')).toEqual([
      { channel: 'approvals:approve', input: { id: 'ap-port' } },
    ]);
  });

  it('the queue names the kind and the port', async () => {
    const a = portApproval();
    installBridge((channel) => {
      if (channel === 'approvals:list') return [a];
      if (channel === 'approvals:image') return null;
      throw new Error(`unexpected ${channel}`);
    });
    renderApp(<ApprovalsView />);
    const item = await screen.findByRole('button', { name: /Port-Weiterleitung \(Vorschau\)/ });
    expect(item.textContent).toContain('Port 5173 · local/aaaa1111');
  });

  it('other access requests keep their generic title', () => {
    const a = portApproval({
      kinds: [],
      request: {
        ...(portApproval().request as object),
        request: { kind: 'ttl', details: { ttlMs: 1 } },
      },
    });
    const { dialog } = mount(a);
    expect(within(dialog).getByRole('heading', { name: 'Zugriff erweitern' })).toBeTruthy();
    expect(within(dialog).queryByTestId('port-summary')).toBeNull();
  });
});
