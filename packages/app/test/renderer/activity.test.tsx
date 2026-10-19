// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ActivityEntry, ActivityView } from '../../src/shared/types';
import type { Route } from '../../src/renderer/context';
import { ActivityTimeline } from '../../src/renderer/components/ActivityTimeline';
import { installBridge, renderApp } from './harness';

afterEach(cleanup);

const ID = 'local/aaaa1111';
const NOW = Date.now();

function entry(
  seq: number,
  over: Partial<ActivityEntry> & Pick<ActivityEntry, 'action' | 'kind'>,
): ActivityEntry {
  return {
    seq,
    ts: NOW - (100 - seq) * 1000,
    actor: 'claude-code',
    outcome: 'ok',
    summary: '',
    detail: {},
    count: 1,
    sandboxId: ID,
    ...over,
  };
}

const ENTRIES: ActivityEntry[] = [
  entry(9, {
    action: 'sandbox.exec',
    kind: 'exec',
    subject: 'pnpm test',
    detail: { exitCode: 0, durationMs: 41000, env: 'CI' },
  }),
  entry(8, {
    action: 'sandbox.exec',
    kind: 'exec',
    outcome: 'error',
    subject: 'false',
    detail: { exitCode: 1 },
  }),
  entry(7, {
    action: 'sandbox.write_file',
    kind: 'file',
    subject: '/workspace/out.txt',
    detail: { size: 2048 },
  }),
  entry(6, {
    action: 'network.egress',
    kind: 'network',
    outcome: 'denied',
    subject: 'registry.example.org',
    count: 3,
    from: NOW - 200_000,
    detail: { reason: 'not in allowlist' },
  }),
  entry(5, {
    action: 'approval.request',
    kind: 'approval',
    outcome: 'pending',
    subject: 'sandbox.exec',
    approvalId: 'ap-1',
    detail: { kind: 'exec' },
  }),
];

function view(over: Partial<ActivityView> = {}): ActivityView {
  return { sandboxId: ID, entries: ENTRIES, ...over };
}

function mount(
  handler: (input: Record<string, unknown>) => ActivityView = () => view(),
  o: { initialKinds?: string[]; navigate?: (r: Route) => void } = {},
) {
  const calls = installBridge((channel, input) => {
    if (channel !== 'activity:list') throw new Error(`unexpected ${channel}`);
    return handler(input as Record<string, unknown>);
  });
  renderApp(
    <ActivityTimeline id={ID} {...(o.initialKinds ? { initialKinds: o.initialKinds } : {})} />,
    {
      ...(o.navigate ? { navigate: o.navigate } : {}),
    },
  );
  return calls;
}

describe('ActivityTimeline', () => {
  it('lists the entries with kind and outcome badges, label, subject and exit code', async () => {
    mount();
    const list = await screen.findByRole('list', { name: 'Aktivitätsverlauf' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(5);
    expect(within(items[0]!).getByText('Befehl')).toBeTruthy();
    expect(within(items[0]!).getAllByText('pnpm test').length).toBeGreaterThan(0);
    expect(within(items[0]!).getByText('(Exit 0)')).toBeTruthy();
    expect(within(items[1]!).getByText('Fehler').className).toContain('badge-danger');
    expect(within(items[1]!).getByText('Exit 1').className).toContain('badge-warn');
    expect(within(items[2]!).getByText('Datei geschrieben')).toBeTruthy();
    expect(within(items[3]!).getByText('Anfrage blockiert')).toBeTruthy();
    expect(within(items[3]!).getByText('3×')).toBeTruthy();
    expect(within(items[4]!).getByText('Wartet auf Freigabe').className).toContain('badge-warn');
  });

  it('expands the facts of an entry, sizes and durations readable, env as names', async () => {
    mount();
    const list = await screen.findByRole('list', { name: 'Aktivitätsverlauf' });
    const items = within(list).getAllByRole('listitem');
    expect(within(items[0]!).getByText('Umgebungsvariablen (nur Namen)')).toBeTruthy();
    expect(within(items[0]!).getByText('41s')).toBeTruthy();
    expect(within(items[2]!).getByText('2.0 KiB (2048)')).toBeTruthy();
  });

  it('filters by kind through the server and starts with the kinds of a link', async () => {
    const calls = mount(
      (i) =>
        view({
          entries: ENTRIES.filter((e) => !i['kinds'] || (i['kinds'] as string[]).includes(e.kind)),
        }),
      {
        initialKinds: ['approval'],
      },
    );
    const group = await screen.findByRole('group', { name: 'Nach Art filtern' });
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(1));
    expect(calls[0]!.input).toMatchObject({ id: ID, kinds: ['approval'] });
    expect(
      within(group).getByRole('button', { name: 'Freigaben' }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(within(group).getByRole('button', { name: 'Alle' }).getAttribute('aria-pressed')).toBe(
      'false',
    );

    fireEvent.click(within(group).getByRole('button', { name: 'Befehle' }));
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(3));
    expect(calls.at(-1)!.input).toMatchObject({ kinds: ['approval', 'exec'] });
    fireEvent.click(within(group).getByRole('button', { name: 'Alle' }));
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(5));
    expect(calls.at(-1)!.input).not.toHaveProperty('kinds');
  });

  it('links an approval entry to the approvals view', async () => {
    const seen: Route[] = [];
    mount(() => view(), { navigate: (r) => seen.push(r) });
    fireEvent.click(await screen.findByRole('button', { name: 'Freigabe öffnen' }));
    expect(seen).toEqual([{ view: 'approvals', approvalId: 'ap-1' }]);
  });

  it('asks for a longer page when older entries exist, and stops at the cap', async () => {
    const calls = mount(() => view({ nextCursor: '5' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Ältere Einträge anzeigen' }));
    await waitFor(() => expect(calls.at(-1)!.input).toMatchObject({ limit: 200 }));
    fireEvent.click(await screen.findByRole('button', { name: 'Ältere Einträge anzeigen' }));
    await waitFor(() => expect(calls.at(-1)!.input).toMatchObject({ limit: 400 }));
    fireEvent.click(await screen.findByRole('button', { name: 'Ältere Einträge anzeigen' }));
    await waitFor(() => expect(calls.at(-1)!.input).toMatchObject({ limit: 500 }));
    await screen.findByText(/neuesten 500 Audit-Einträge/);
    expect(screen.queryByRole('button', { name: 'Ältere Einträge anzeigen' })).toBeNull();
  });

  it('shows an empty state, and says so when a filter matches nothing', async () => {
    mount(() => view({ entries: [] }));
    await screen.findByText('Noch keine Aktivität');
    cleanup();
    mount(() => view({ entries: [] }), { initialKinds: ['file'] });
    await screen.findByText('Noch nichts von den gewählten Arten.');
  });

  it('neutralises what an agent wrote (control and bidi characters)', async () => {
    mount(() =>
      view({
        entries: [
          entry(1, {
            action: 'sandbox.exec',
            kind: 'exec',
            subject: 'echo \u202Eevil\nsecond line',
            detail: { reason: 'x\u200Bymessage' },
          }),
        ],
      }),
    );
    const item = await screen.findByRole('listitem');
    expect(item.textContent).not.toMatch(/[\u202E\u200B]/);
    expect(item.textContent).not.toContain('\n');
  });
});
