// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { NetworkLogEntry, NetworkLogView, NetworkPolicyProposal } from '@abox/core';
import { NetworkTab } from '../../src/renderer/components/NetworkLog';
import { installBridge, renderApp } from './harness';

afterEach(cleanup);

const ID = 'local/aaaa1111';
const NOW = Date.now();

function entry(over: Partial<NetworkLogEntry> & Pick<NetworkLogEntry, 'host'>): NetworkLogEntry {
  return {
    port: 443,
    decision: 'deny',
    allowed: 0,
    denied: 1,
    count: 1,
    firstSeen: NOW - 5000,
    lastSeen: NOW - 1000,
    reason: 'not in allowlist',
    reasonKind: 'not_in_allowlist',
    methods: ['CONNECT'],
    summarized: 0,
    allowedNow: false,
    allow: { possible: true, pattern: over.host, wildcard: '*.example.org' },
    ...over,
  };
}

const ENTRIES: NetworkLogEntry[] = [
  entry({ host: 'registry.example.org', denied: 3, count: 3 }),
  entry({
    host: 'nas.example.org',
    reason: 'blocked address 192.168.1.5 (private network)',
    reasonKind: 'blocked_address',
    allow: { possible: false, why: 'resolves to a private address' },
  }),
  entry({
    host: 'registry.npmjs.org',
    decision: 'allow',
    allowed: 4,
    denied: 0,
    count: 4,
    allowedNow: true,
    reason: undefined as never,
    reasonKind: undefined as never,
    allow: undefined as never,
  }),
  entry({
    host: 'fixed.example.org',
    decision: 'allow',
    allowed: 2,
    denied: 1,
    count: 3,
    allowedNow: true,
    allow: undefined as never,
  }),
];

function view(over: Partial<NetworkLogView> = {}): NetworkLogView {
  return {
    sandboxId: ID,
    mode: 'allowlist',
    entries: ENTRIES,
    totals: { allowed: 6, denied: 5, destinations: 4 },
    truncated: false,
    maxEvents: 10_000,
    ...over,
  };
}

const APPLIED = {
  status: 'applied',
  kind: 'network',
  message: 'allowlist now has 3 destination(s)',
  sandbox: {},
};

type Handler = (channel: string, input: unknown) => unknown;
function mount(handler: Handler = () => undefined) {
  const calls = installBridge((channel, input) => {
    const x = handler(channel, input);
    if (x !== undefined) return x;
    switch (channel) {
      case 'network:log':
        return view();
      case 'network:allow':
        return APPLIED;
      default:
        throw new Error(`unexpected ${channel}`);
    }
  });
  renderApp(<NetworkTab id={ID} />);
  return calls;
}

describe('NetworkTab', () => {
  it('shows the destinations with decision badges, count, reason and the actions that apply', async () => {
    mount();
    const table = await screen.findByRole('table', { name: 'Netzwerkanfragen nach Ziel' });
    const row = (host: string) =>
      within(table).getByRole('rowheader', { name: host }).closest('tr')!;

    const reg = row('registry.example.org');
    expect(within(reg).getByText('Blockiert').className).toContain('badge-danger');
    expect(within(reg).getByText('3')).toBeTruthy();
    expect(within(reg).getByText('Nicht in der Allowlist')).toBeTruthy();
    expect(
      within(reg).getByRole('button', { name: 'Für diese Sandbox erlauben: registry.example.org' }),
    ).toBeTruthy();
    expect(
      within(reg).getByRole('button', { name: 'Dauerhaft erlauben: registry.example.org' }),
    ).toBeTruthy();
    expect(
      within(reg).getByRole('button', { name: 'Alle Subdomains erlauben: *.example.org' }),
    ).toBeTruthy();

    // not allowable: no buttons, the reason is one click away
    const nas = row('nas.example.org');
    expect(within(nas).queryAllByRole('button')).toHaveLength(0);
    expect(within(nas).getByText('Private oder Metadaten-Adresse')).toBeTruthy();
    expect(within(nas).getByText('Nicht erlaubbar')).toBeTruthy();
    expect(within(nas).getByText(/Ein privater Adressbereich lässt sich nur/)).toBeTruthy();

    // allowed: green, nothing to do
    const npm = row('registry.npmjs.org');
    expect(within(npm).getByText('Erlaubt').className).toContain('badge-ok');
    expect(within(npm).queryAllByRole('button')).toHaveLength(0);

    // was denied, allowed since: a warning badge, "allowed now", no buttons
    const fixed = row('fixed.example.org');
    expect(within(fixed).getByText('Jetzt erlaubt').className).toContain('badge-warn');
    expect(within(fixed).getByText('1 blockiert, 2 erlaubt')).toBeTruthy();
    expect(within(fixed).getByText('Bereits erlaubt')).toBeTruthy();
    expect(within(fixed).queryAllByRole('button')).toHaveLength(0);

    expect(screen.getByRole('status', { name: '' }).textContent).toContain(
      '5 blockiert, 6 erlaubt, 4 Ziele',
    );
  });

  it('the filter "nur blockierte" asks the manager for denials only', async () => {
    const calls = mount();
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('checkbox', { name: 'nur blockierte' }));
    await waitFor(() =>
      expect(
        calls.some(
          (c) => c.channel === 'network:log' && (c.input as { denied?: boolean }).denied === true,
        ),
      ).toBe(true),
    );
    expect(calls[0]!.input).toMatchObject({ id: ID, limit: 500 });
    expect((calls[0]!.input as { denied?: boolean }).denied).toBeUndefined();
  });

  it('"Für diese Sandbox erlauben" is one click: network:allow with the exact destination, then the list refreshes', async () => {
    const calls = mount();
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Für diese Sandbox erlauben: registry.example.org',
      }),
    );
    await waitFor(() => expect(calls.some((c) => c.channel === 'network:allow')).toBe(true));
    const allow = calls.find((c) => c.channel === 'network:allow')!;
    expect(allow.input).toEqual({ id: ID, destinations: ['registry.example.org'] });
    // no policy change, no dialog
    expect(calls.some((c) => c.channel === 'policy:set')).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() =>
      expect(calls.filter((c) => c.channel === 'network:log').length).toBeGreaterThan(1),
    );
  });

  it('a wildcard is a separate, warned choice and goes out confirmed', async () => {
    const calls = mount();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Alle Subdomains erlauben: *.example.org' }),
    );
    const dlg = await screen.findByRole('dialog', { name: 'Alle Subdomains erlauben?' });
    expect(dlg.textContent).toContain('*.example.org erlaubt jede Subdomain');
    expect(dlg.textContent).toContain('Bevorzuge den genauen Host');
    expect(calls.some((c) => c.channel === 'network:allow')).toBe(false);
    fireEvent.click(within(dlg).getByRole('button', { name: 'Alle Subdomains erlauben' }));
    await waitFor(() => expect(calls.some((c) => c.channel === 'network:allow')).toBe(true));
    expect(calls.find((c) => c.channel === 'network:allow')!.input).toEqual({
      id: ID,
      destinations: ['*.example.org'],
      confirmed: true,
    });
  });

  it('when the manager wants a confirmation it is shown first, and only then the call is repeated', async () => {
    let n = 0;
    const calls = mount((channel) => {
      if (channel === 'network:allow')
        return n++ === 0
          ? {
              status: 'confirmation_required',
              reasons: ['destination is beyond your profile'],
              risks: ['it can send data'],
              items: [],
              message: 'm',
            }
          : APPLIED;
      return undefined;
    });
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Für diese Sandbox erlauben: registry.example.org',
      }),
    );
    const dlg = await screen.findByRole('dialog', { name: 'Erlauben bestätigen' });
    expect(dlg.textContent).toContain('destination is beyond your profile');
    expect(dlg.textContent).toContain('it can send data');
    fireEvent.click(within(dlg).getByRole('button', { name: 'Bestätigen' }));
    await waitFor(() => expect(calls.filter((c) => c.channel === 'network:allow')).toHaveLength(2));
    expect(calls.filter((c) => c.channel === 'network:allow')[1]!.input).toMatchObject({
      confirmed: true,
    });
  });

  it('an error of the manager is shown, not swallowed', async () => {
    mount((channel) => {
      if (channel === 'network:allow') throw new Error('policy says no');
      return undefined;
    });
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Für diese Sandbox erlauben: registry.example.org',
      }),
    );
    expect(await screen.findByText(/policy says no/)).toBeTruthy();
  });

  describe('"Dauerhaft erlauben…" opens the policy change dialog', () => {
    const CURRENT = 'profiles:\n  agent:\n    network: { modes: [none, allowlist], allow: [] }\n';
    const PROPOSAL: NetworkPolicyProposal = {
      context: 'agent-a',
      profile: 'agent',
      usedBy: ['agent-a', 'agent-b'],
      added: ['registry.example.org'],
      alreadyAllowed: [],
      baseHash: 'hash-1',
      current: CURRENT,
      proposed:
        'profiles:\n  agent:\n    network: { modes: [none, allowlist], allow: [registry.example.org] }\n',
    };

    it('shows the diff, writes nothing before the confirmation, then saves the policy and allows the sandbox', async () => {
      const calls = mount((channel) => {
        if (channel === 'network:propose') return PROPOSAL;
        if (channel === 'policy:validate') return { ok: true, contentHash: 'h', issues: [] };
        if (channel === 'policy:set') return { revision: 8, changed: true, contentHash: 'h2' };
        return undefined;
      });
      fireEvent.click(
        await screen.findByRole('button', { name: 'Dauerhaft erlauben: registry.example.org' }),
      );
      const dlg = await screen.findByRole('dialog', { name: /Dauerhaft erlauben: Policy ändern/ });
      expect(calls.find((c) => c.channel === 'network:propose')!.input).toEqual({
        id: ID,
        destinations: ['registry.example.org'],
      });
      await within(dlg).findByText(/Ziel „registry.example.org“ in network.allow aufnehmen/);
      expect(dlg.textContent).toContain('„agent“');
      expect(dlg.textContent).toContain('agent-a, agent-b');
      const diff = await within(dlg).findByLabelText('Diff der Policy');
      expect(diff.querySelector('.diff-add')?.textContent).toContain(
        'allow: [registry.example.org]',
      );
      expect(diff.querySelector('.diff-del')?.textContent).toContain('allow: []');
      expect(calls.some((c) => c.channel === 'policy:set')).toBe(false);
      expect(calls.some((c) => c.channel === 'network:allow')).toBe(false);

      const apply = within(dlg).getByRole('button', { name: 'Policy ändern' });
      await waitFor(() => expect((apply as HTMLButtonElement).disabled).toBe(false));
      fireEvent.click(apply);
      await waitFor(() => expect(calls.some((c) => c.channel === 'network:allow')).toBe(true));
      const order = calls.map((c) => c.channel).filter((c) => /policy:set|network:allow/.test(c));
      expect(order).toEqual(['policy:set', 'network:allow']);
      const set = calls.find((c) => c.channel === 'policy:set')!.input as {
        text: string;
        baseHash: string;
      };
      expect(set.baseHash).toBe('hash-1');
      expect(set.text).toBe(PROPOSAL.proposed);
      expect(calls.find((c) => c.channel === 'network:allow')!.input).toEqual({
        id: ID,
        destinations: ['registry.example.org'],
      });
    });

    it('cancelling changes nothing', async () => {
      const calls = mount((channel) => (channel === 'network:propose' ? PROPOSAL : undefined));
      fireEvent.click(
        await screen.findByRole('button', { name: 'Dauerhaft erlauben: registry.example.org' }),
      );
      const dlg = await screen.findByRole('dialog');
      fireEvent.click(within(dlg).getByRole('button', { name: 'Abbrechen' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(calls.some((c) => c.channel === 'policy:set' || c.channel === 'network:allow')).toBe(
        false,
      );
    });

    it('a profile that covers the destination already needs no policy change, only the sandbox', async () => {
      const calls = mount((channel) =>
        channel === 'network:propose'
          ? { ...PROPOSAL, added: [], alreadyAllowed: ['registry.example.org'], proposed: null }
          : undefined,
      );
      fireEvent.click(
        await screen.findByRole('button', { name: 'Dauerhaft erlauben: registry.example.org' }),
      );
      const dlg = await screen.findByRole('dialog');
      await within(dlg).findByText(/erlaubt dieses Ziel bereits/);
      expect(within(dlg).queryByRole('button', { name: 'Policy ändern' })).toBeNull();
      fireEvent.click(within(dlg).getByRole('button', { name: 'Nur für diese Sandbox erlauben' }));
      await waitFor(() => expect(calls.some((c) => c.channel === 'network:allow')).toBe(true));
      expect(calls.some((c) => c.channel === 'policy:set')).toBe(false);
    });
  });

  it('explains a sandbox without an allowlist instead of an empty table', async () => {
    mount((channel) =>
      channel === 'network:log'
        ? view({ mode: 'none', entries: [], totals: { allowed: 0, denied: 0, destinations: 0 } })
        : undefined,
    );
    expect(await screen.findByText('Das Netzwerk dieser Sandbox ist aus')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    cleanup();
    mount((channel) =>
      channel === 'network:log' ? view({ mode: 'open', entries: [] }) : undefined,
    );
    expect(await screen.findByText('Das Netzwerk dieser Sandbox ist offen')).toBeTruthy();
  });

  it('says so when there is nothing to show', async () => {
    mount((channel) =>
      channel === 'network:log'
        ? view({ entries: [], totals: { allowed: 0, denied: 0, destinations: 0 } })
        : undefined,
    );
    expect(await screen.findByText('Noch keine Netzwerkanfragen in dieser Sandbox.')).toBeTruthy();
  });

  it('shows hostile destination and reason texts as plain, neutralised text', async () => {
    mount((channel) =>
      channel === 'network:log'
        ? view({
            entries: [
              entry({
                host: 'evil‮.example.org\u0007',
                reason: 'not in allowlist <img src=x onerror=alert(1)>',
                allow: { possible: false, why: '<b>x</b>' },
              }),
            ],
          })
        : undefined,
    );
    const table = await screen.findByRole('table');
    expect(table.querySelector('img, b')).toBeNull();
    expect(table.textContent).not.toContain('‮');
    expect(table.textContent).not.toContain('\u0007');
    expect(table.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('is English in the English GUI', async () => {
    installBridge((channel) => (channel === 'network:log' ? view() : undefined));
    renderApp(<NetworkTab id={ID} />, { locale: 'en' });
    expect(
      await screen.findByRole('table', { name: 'Network requests by destination' }),
    ).toBeTruthy();
    expect(screen.getAllByText('Blocked').length).toBeGreaterThan(0);
    expect(
      screen.getByRole('button', { name: 'Allow for this sandbox: registry.example.org' }),
    ).toBeTruthy();
  });
});
