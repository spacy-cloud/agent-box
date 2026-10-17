// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalView } from '@abox/core';
import { PolicyChangeDialog } from '../../src/renderer/components/PolicyChangeDialog';
import { installBridge, renderApp } from './harness';

afterEach(cleanup);

const TEXT = `version: 1
profiles:
  agent:
    approval: medium
    templates: [node-dev]
    network: { modes: [none, allowlist], allow_presets: [npm], allow: [] }
contexts:
  sim: { profile: agent }
`;

const PROFILE = {
  name: 'agent',
  approval: 'medium',
  exec: { approval: false },
  network: { modes: ['none', 'allowlist'], allow_presets: ['npm'], allow: [] as string[] },
  images: { registries: ['docker.io/library'] },
};

function doc(text = TEXT) {
  return {
    text,
    source: 'file',
    path: '/p/policy.yaml',
    view: {
      policy: { contentHash: 'hash-1', revision: 3, source: 'file' },
      profiles: { agent: PROFILE },
      contexts: { sim: { profile: 'agent' } },
    },
  };
}

function approval(over: Partial<ApprovalView> = {}): ApprovalView {
  return {
    id: 'ap1',
    kind: 'create',
    requester: 'agent:sim',
    sandboxId: null,
    status: 'pending',
    reason: 'because',
    risks: [],
    items: [],
    kinds: ['image_registry', 'network_domains'],
    reasons: [],
    base: { os: 'ghcr.io/acme/tool:1', registry: 'ghcr.io' },
    request: {
      kind: 'create',
      profile: 'agent',
      template: { name: 't', trusted: true },
      network: { mode: 'allowlist', allow: ['api.example.com'], privateExceptions: [] },
    },
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    decidedAt: null,
    decidedBy: null,
    decisionNote: null,
    usedAt: null,
    ...over,
  } as ApprovalView;
}

function mount(a: ApprovalView, handler: (c: string, i: unknown) => unknown = () => undefined) {
  const onClose = vi.fn();
  const onDone = vi.fn();
  const calls = installBridge((channel, input) => {
    const x = handler(channel, input);
    if (x !== undefined) return x;
    switch (channel) {
      case 'policy:get':
        return doc();
      case 'policy:validate':
        return { ok: true, contentHash: 'h', issues: [] };
      case 'policy:set':
        return { revision: 4, changed: true, contentHash: 'h2' };
      default:
        throw new Error(`unexpected ${channel}`);
    }
  });
  renderApp(<PolicyChangeDialog approval={a} onClose={onClose} onDone={onDone} />);
  return { calls, onClose, onDone };
}

describe('PolicyChangeDialog ("allow permanently")', () => {
  it('shows the proposed change as a diff, writes nothing before the confirmation, then writes through policy:set', async () => {
    const { calls, onDone } = mount(approval());
    const dlg = await screen.findByRole('dialog', { name: /Dauerhaft erlauben: Policy ändern/ });
    // proposals as checkboxes, all on
    const registry = await within(dlg).findByRole('checkbox', {
      name: /Registry „ghcr.io\/acme“ in images.registries erlauben/,
    });
    const domain = within(dlg).getByRole('checkbox', {
      name: /Ziel „api.example.com“ in network.allow aufnehmen/,
    });
    expect((registry as HTMLInputElement).checked).toBe(true);
    expect((domain as HTMLInputElement).checked).toBe(true);
    // the diff
    const diff = await within(dlg).findByLabelText('Diff der Policy');
    await waitFor(() => expect(diff.textContent).toContain('ghcr.io/acme'));
    expect(diff.querySelector('.diff-add')?.textContent).toContain('+ ');
    expect(diff.textContent).toContain('api.example.com');
    // nothing is written yet
    expect(calls.some((c) => c.channel === 'policy:set')).toBe(false);
    const apply = within(dlg).getByRole('button', { name: 'Policy ändern' });
    await waitFor(() => expect((apply as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(apply);
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(4));
    const set = calls.find((c) => c.channel === 'policy:set')!;
    const input = set.input as { text: string; baseHash: string };
    expect(input.baseHash).toBe('hash-1'); // revisioned: refused when the file changed meanwhile
    expect(input.text).toContain('ghcr.io/acme');
    expect(input.text).toContain('api.example.com');
    expect(input.text).toContain('docker.io/library'); // the inherited default stays in the list
    // no decision about the request is taken
    expect(calls.some((c) => c.channel.startsWith('approvals:'))).toBe(false);
  });

  it('an unchecked change is left out of the diff and of the written text', async () => {
    const { calls } = mount(approval());
    const dlg = await screen.findByRole('dialog', { name: /Dauerhaft erlauben/ });
    const domain = await within(dlg).findByRole('checkbox', { name: /api.example.com/ });
    fireEvent.click(domain);
    const diff = await within(dlg).findByLabelText('Diff der Policy');
    await waitFor(() => expect(diff.textContent).not.toContain('api.example.com'));
    const apply = within(dlg).getByRole('button', { name: 'Policy ändern' });
    await waitFor(() => expect((apply as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(apply);
    await waitFor(() => expect(calls.some((c) => c.channel === 'policy:set')).toBe(true));
    const text = (calls.find((c) => c.channel === 'policy:set')!.input as { text: string }).text;
    expect(text).toContain('ghcr.io/acme');
    expect(text).not.toContain('api.example.com');
  });

  it('does not write while the manager says the proposed text is invalid', async () => {
    const { calls } = mount(approval(), (c) =>
      c === 'policy:validate'
        ? { ok: false, contentHash: 'h', issues: [{ message: 'nope', path: 'profiles.agent' }] }
        : undefined,
    );
    const dlg = await screen.findByRole('dialog', { name: /Dauerhaft erlauben/ });
    await within(dlg).findByText('Die Policy ist ungültig:');
    expect(
      (within(dlg).getByRole('button', { name: 'Policy ändern' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(calls.some((c) => c.channel === 'policy:set')).toBe(false);
  });

  it('shows a conflict from the revisioned write instead of overwriting', async () => {
    mount(approval(), (c) => {
      if (c === 'policy:set') throw new Error('policy.yaml changed while it was being edited');
      return undefined;
    });
    const dlg = await screen.findByRole('dialog', { name: /Dauerhaft erlauben/ });
    const apply = within(dlg).getByRole('button', { name: 'Policy ändern' });
    await waitFor(() => expect((apply as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(apply);
    expect(await within(dlg).findByRole('alert')).toBeTruthy();
  });

  it('proposes nothing for findings no policy setting can waive and says why', async () => {
    mount(approval({ kinds: ['isolation_none', 'mount'], base: null }));
    const dlg = await screen.findByRole('dialog', { name: /Dauerhaft erlauben/ });
    await within(dlg).findByText('Nicht als Regel vorgeschlagen');
    expect(
      within(dlg).getByText(/Keine Policy-Einstellung kann es dauerhaft erlauben/),
    ).toBeTruthy();
    expect(within(dlg).getByText(/Nur der breite Freigabemodus „open“/)).toBeTruthy();
    expect(within(dlg).queryByRole('button', { name: 'Policy ändern' })).toBeNull();
    expect(within(dlg).getByRole('button', { name: 'Im Policy-Editor öffnen' })).toBeTruthy();
  });

  it('shows agent-chosen text neutralised (a destination with a right-to-left override)', async () => {
    const evil = 'evil.example‮.com';
    mount(
      approval({
        kinds: ['network_domains'],
        base: null,
        request: { profile: 'agent', network: { allow: [evil] } },
      }),
    );
    const dlg = await screen.findByRole('dialog', { name: /Dauerhaft erlauben/ });
    await within(dlg).findByRole('checkbox', { name: /evil.example\\u202e.com/ });
    expect(dlg.textContent).not.toContain('‮');
  });

  it('says so when the profile is not in the policy', async () => {
    mount(approval({ request: { profile: 'ghost' } }));
    const dlg = await screen.findByRole('dialog', { name: /Dauerhaft erlauben/ });
    await within(dlg).findByText('Das Profil dieser Anfrage wurde in der Policy nicht gefunden.');
  });
});
