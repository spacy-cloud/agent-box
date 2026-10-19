// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type {
  DeleteSnapshotsResult,
  SnapshotEntry,
  SnapshotOverview,
  SnapshotView,
} from '../../src/shared/types';
import { SnapshotsSection } from '../../src/renderer/components/SnapshotsSection';
import { SnapshotsTab } from '../../src/renderer/components/SnapshotsTab';
import { HIDDEN_CHARS, RLO } from './fixtures';
import { installBridge, renderApp } from './harness';

afterEach(cleanup);
// jsdom has no <dialog> behaviour
beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
  Element.prototype.scrollTo ??= () => undefined;
});

const MIB = 1024 ** 2;
const now = Date.now();

function entry(over: Partial<SnapshotEntry> = {}): SnapshotEntry {
  return {
    id: 'abox-snap/aaaaaaaa:installed',
    name: 'installed',
    createdAt: now - 2 * 86_400_000,
    sizeBytes: 300 * MIB,
    deletable: true,
    cloneable: true,
    host: 'local',
    backend: 'docker',
    sandboxId: 'local/aaaaaaaa',
    sandboxName: 'web',
    template: 'node-dev',
    orphaned: false,
    ...over,
  };
}

const A = entry();
const B = entry({
  id: 'abox-snap/bbbbbbbb:before',
  name: 'before',
  sandboxId: 'local/bbbbbbbb',
  sandboxName: undefined,
  sizeBytes: 1024 * MIB,
  orphaned: true,
});
const C = entry({
  id: 'p-snap',
  name: 'plain',
  sandboxId: 'local/cccccccc',
  sandboxName: 'proc',
  backend: 'process',
  sizeBytes: undefined,
  deletable: false,
  cloneable: false,
});

function overview(list: SnapshotEntry[]): SnapshotOverview {
  return {
    snapshots: list,
    totalBytes: list.reduce((n, s) => n + (s.sizeBytes ?? 0), 0),
    unreachable: [],
  };
}

describe('Settings: all snapshots', () => {
  function mount(
    initial: SnapshotEntry[],
    opts: { del?: (input: unknown) => DeleteSnapshotsResult; unreachable?: boolean } = {},
  ) {
    let current = initial;
    return installBridge((channel, input) => {
      switch (channel) {
        case 'snapshots:listAll':
          return {
            ...overview(current),
            unreachable: opts.unreachable
              ? [{ host: 'lab', backend: 'docker', error: 'ssh: connection refused' }]
              : [],
          };
        case 'snapshots:delete': {
          const refs = (input as { refs: Array<{ snapshotId: string }> }).refs;
          const res = opts.del
            ? opts.del(input)
            : {
                removed: refs.map((r) => ({ ...r, backend: 'docker', sandboxId: 'x' })),
                errors: [],
              };
          const gone = new Set(res.removed.map((r) => r.snapshotId));
          current = current.filter((s) => !gone.has(s.id));
          return res;
        }
        default:
          throw new Error(`unexpected ${channel}`);
      }
    });
  }

  it('lists name, sandbox, size, age and whether the sandbox still exists, with the total', async () => {
    mount([A, B, C]);
    renderApp(<SnapshotsSection />, { locale: 'en' });
    const table = await screen.findByRole('table', { name: 'Snapshots' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]!.textContent).toContain('web');
    expect(rows[0]!.textContent).toContain('300 MiB');
    expect(rows[0]!.textContent).toContain('2d 0h ago');
    expect(rows[0]!.textContent).toContain('sandbox exists');
    expect(rows[1]!.textContent).toContain('1.0 GiB');
    expect(rows[1]!.textContent).toContain('sandbox deleted');
    expect(rows[2]!.textContent).toContain('unknown');
    const summary = within(screen.getByTestId('snapshots-summary'));
    expect(summary.getByText('3')).toBeTruthy();
    expect(summary.getByText('1.3 GiB')).toBeTruthy();
    expect(summary.getByText('1 (1.0 GiB)')).toBeTruthy();
  });

  it('is written in German too', async () => {
    mount([A]);
    renderApp(<SnapshotsSection />);
    expect(await screen.findByRole('heading', { name: 'Snapshots' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ausgewählte löschen (0)' })).toBeTruthy();
    expect(screen.getByRole('table').textContent).toContain('vor 2d 0h');
  });

  it('shows the empty state without a table', async () => {
    mount([]);
    renderApp(<SnapshotsSection />, { locale: 'en' });
    expect(await screen.findByText(/No snapshots yet/)).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('names the backends that could not be asked', async () => {
    mount([A], { unreachable: true });
    renderApp(<SnapshotsSection />, { locale: 'en' });
    await screen.findByRole('table');
    const banner = screen.getByText(/could not be asked/).closest('.banner') as HTMLElement;
    expect(banner.textContent).toContain('docker @ lab');
    expect(banner.textContent).toContain('ssh: connection refused');
  });

  it('makes hostile names harmless', async () => {
    mount([entry({ name: `x${RLO}evil\u0007`, sandboxName: `a${RLO}b` })]);
    renderApp(<SnapshotsSection />, { locale: 'en' });
    const table = await screen.findByRole('table');
    expect(HIDDEN_CHARS.test(table.textContent ?? '')).toBe(false);
  });

  it('cannot select a snapshot the backend cannot delete, and says why', async () => {
    mount([A, C]);
    renderApp(<SnapshotsSection />, { locale: 'en' });
    await screen.findByRole('table');
    const plain = screen.getByRole('checkbox', {
      name: 'Select snapshot plain of proc',
    }) as HTMLInputElement;
    expect(plain.disabled).toBe(true);
    expect(plain.title).toMatch(/cannot delete a single snapshot/);
    const ok = screen.getByRole('checkbox', {
      name: 'Select snapshot installed of web',
    }) as HTMLInputElement;
    expect(ok.disabled).toBe(false);
  });

  it('selects, asks, and deletes exactly the chosen snapshots', async () => {
    const calls = mount([A, B]);
    renderApp(<SnapshotsSection />, { locale: 'en' });
    await screen.findByRole('table');
    const del = () => screen.getByRole('button', { name: /^Delete selected/ }) as HTMLButtonElement;
    expect(del().disabled).toBe(true);
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Select snapshot before of local/bbbbbbbb' }),
    );
    expect(del().textContent).toBe('Delete selected (1)');
    fireEvent.click(del());
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('1 snapshots (1.0 GiB) will be deleted');
    expect(dialog.textContent).toContain('cannot be undone');
    expect(dialog.textContent).toContain('keep their files');
    // nothing happened yet
    expect(calls.some((c) => c.channel === 'snapshots:delete')).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(calls.some((c) => c.channel === 'snapshots:delete')).toBe(true));
    expect(calls.filter((c) => c.channel === 'snapshots:delete').map((c) => c.input)).toEqual([
      {
        refs: [{ backend: 'docker', sandboxId: 'local/bbbbbbbb', snapshotId: B.id }],
      },
    ]);
    await waitFor(() => expect(screen.queryByText('before')).toBeNull());
    expect(screen.getByText('1 snapshot deleted', { selector: 'strong' })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('installed')).toBeTruthy();
  });

  it('"select those of deleted sandboxes" picks exactly the orphans; cancel deletes nothing', async () => {
    const calls = mount([A, B]);
    renderApp(<SnapshotsSection />, { locale: 'en' });
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Select those of deleted sandboxes' }));
    const boxes = screen.getAllByRole('checkbox').slice(1) as HTMLInputElement[];
    expect(boxes.map((b) => b.checked)).toEqual([false, true]);
    fireEvent.click(screen.getByRole('button', { name: /^Delete selected/ }));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls.some((c) => c.channel === 'snapshots:delete')).toBe(false);
  });

  it('reports what could not be deleted', async () => {
    mount([A, B], {
      del: (input) => {
        const refs = (
          input as { refs: Array<{ snapshotId: string; backend: string; sandboxId: string }> }
        ).refs;
        return {
          removed: [],
          errors: refs.map((r) => ({
            ref: r as never,
            message: 'image is in use',
            code: 'conflict',
          })),
        };
      },
    });
    renderApp(<SnapshotsSection />, { locale: 'en' });
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all snapshots' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete selected (2)' }));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }),
    );
    expect(await screen.findByText('Nothing was deleted.')).toBeTruthy();
    expect(screen.getAllByText(/image is in use/).length).toBeGreaterThan(0);
    // both are still listed
    expect(screen.getAllByRole('row')).toHaveLength(3);
  });
});

describe('Snapshots tab of a sandbox', () => {
  const view = (over: Partial<SnapshotView> = {}): SnapshotView => ({
    id: 'abox-snap/aaaaaaaa:installed',
    name: 'installed',
    createdAt: now - 3_600_000,
    sizeBytes: 12 * MIB,
    deletable: true,
    cloneable: true,
    ...over,
  });

  function mount(list: SnapshotView[]) {
    let current = list;
    return installBridge((channel, input) => {
      switch (channel) {
        case 'snapshots:list':
          return current;
        case 'snapshots:delete': {
          const refs = (input as { refs: Array<{ snapshotId: string }> }).refs;
          current = current.filter((s) => !refs.some((r) => r.snapshotId === s.id));
          return { removed: refs, errors: [] };
        }
        case 'snapshots:restore':
          return { restored: (input as { snapshotId: string }).snapshotId };
        case 'snapshots:clone':
          return {
            status: 'created',
            sandbox: { id: 'local/dddddddd', name: 'web-copy' },
            idempotent: false,
            warnings: [],
          };
        default:
          throw new Error(`unexpected ${channel}`);
      }
    });
  }
  const tab = (navigate?: (r: unknown) => void) =>
    renderApp(
      <SnapshotsTab id="local/aaaaaaaa" name="web" template="node-dev" backend="docker" />,
      {
        locale: 'en',
        ...(navigate ? { navigate: navigate as never } : {}),
      },
    );

  it('shows name, size and age with restore, clone and delete per snapshot', async () => {
    mount([view()]);
    tab();
    const table = await screen.findByRole('table', { name: 'Snapshots' });
    const row = within(within(table).getAllByRole('row')[1]!);
    expect(row.getByText('12 MiB')).toBeTruthy();
    expect(row.getByText('1h 00m ago')).toBeTruthy();
    expect(row.getByRole('button', { name: 'Restore snapshot installed' })).toBeTruthy();
    expect(
      row.getByRole('button', { name: 'Clone snapshot installed into a new sandbox' }),
    ).toBeTruthy();
    expect(row.getByRole('button', { name: 'Delete snapshot installed' })).toBeTruthy();
  });

  it('disables clone and delete with the reason when the backend cannot', async () => {
    mount([
      view({ cloneable: false, cloneBlocked: 'secrets', deletable: false, sizeBytes: undefined }),
    ]);
    tab();
    await screen.findByRole('table');
    const clone = screen.getByRole('button', {
      name: 'Clone snapshot installed into a new sandbox',
    }) as HTMLButtonElement;
    expect(clone.disabled).toBe(true);
    expect(clone.title).toMatch(/secrets inside it/);
    const del = screen.getByRole('button', {
      name: 'Delete snapshot installed',
    }) as HTMLButtonElement;
    expect(del.disabled).toBe(true);
    expect(del.title).toMatch(/cannot delete a single snapshot/);
    expect(screen.getByText('unknown')).toBeTruthy();
  });

  it('asks before restoring and before deleting', async () => {
    const calls = mount([view()]);
    tab();
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Restore snapshot installed' }));
    let dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Changes since then are lost');
    expect(calls.some((c) => c.channel === 'snapshots:restore')).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(calls.some((c) => c.channel === 'snapshots:restore')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Delete snapshot installed' }));
    dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('"installed" (12 MiB) will be deleted');
    expect(calls.some((c) => c.channel === 'snapshots:delete')).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(calls.some((c) => c.channel === 'snapshots:delete')).toBe(true));
    expect(calls.find((c) => c.channel === 'snapshots:delete')!.input).toEqual({
      refs: [
        {
          backend: 'docker',
          sandboxId: 'local/aaaaaaaa',
          snapshotId: 'abox-snap/aaaaaaaa:installed',
        },
      ],
    });
    await waitFor(() => expect(screen.queryByRole('table')).toBeNull());
    expect(screen.getByText(/No snapshots yet/)).toBeTruthy();
  });

  it('clone: the dialog names the template, sends a create request for it and opens the new sandbox', async () => {
    const calls = mount([view()]);
    const opened: unknown[] = [];
    tab((r) => opened.push(r));
    await screen.findByRole('table');
    fireEvent.click(
      screen.getByRole('button', { name: 'Clone snapshot installed into a new sandbox' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Clone snapshot into a new sandbox' });
    expect(dialog.textContent).toContain('node-dev');
    expect(dialog.textContent).toContain('not the snapshot');
    fireEvent.change(within(dialog).getByLabelText('Name (optional)'), {
      target: { value: 'web-copy' },
    });
    fireEvent.change(within(dialog).getByLabelText('Lifetime (optional)'), {
      target: { value: '2h' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create sandbox' }));
    await waitFor(() => expect(calls.some((c) => c.channel === 'snapshots:clone')).toBe(true));
    const sent = calls.find((c) => c.channel === 'snapshots:clone')!.input as {
      source: unknown;
      request: Record<string, unknown>;
    };
    expect(sent.source).toEqual({
      sandboxId: 'local/aaaaaaaa',
      snapshotId: 'abox-snap/aaaaaaaa:installed',
    });
    expect(sent.request).toMatchObject({
      template: 'node-dev',
      name: 'web-copy',
      overrides: { ttl: '2h' },
      confirmed: false,
    });
    await waitFor(() => expect(opened).toEqual([{ view: 'detail', sandboxId: 'local/dddddddd' }]));
  });

  it('clone: shows what needs confirming and only then creates with confirmed: true', async () => {
    let first = true;
    const calls = installBridge((channel) => {
      if (channel === 'snapshots:list') return [view()];
      if (channel === 'snapshots:clone') {
        if (first) {
          first = false;
          return {
            status: 'confirmation_required',
            reasons: ['the template changed'],
            risks: ['runs new build steps'],
            items: [
              { kind: 'image_registry', reason: 'image from a new registry', risk: 'untrusted' },
            ],
          };
        }
        return {
          status: 'created',
          sandbox: { id: 'local/dddddddd', name: 'copy' },
          idempotent: false,
          warnings: [],
        };
      }
      throw new Error(`unexpected ${channel}`);
    });
    tab();
    await screen.findByRole('table');
    fireEvent.click(
      screen.getByRole('button', { name: 'Clone snapshot installed into a new sandbox' }),
    );
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create sandbox' }));
    expect(await within(dialog).findByText('image from a new registry')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: /Confirm/ }));
    await waitFor(() =>
      expect(calls.filter((c) => c.channel === 'snapshots:clone')).toHaveLength(2),
    );
    expect(
      (calls.filter((c) => c.channel === 'snapshots:clone')[1]!.input as { request: unknown })
        .request,
    ).toMatchObject({ confirmed: true });
  });

  it('clone: validates name and lifetime before sending anything', async () => {
    const calls = mount([view()]);
    tab();
    await screen.findByRole('table');
    fireEvent.click(
      screen.getByRole('button', { name: 'Clone snapshot installed into a new sandbox' }),
    );
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Name (optional)'), {
      target: { value: '../evil' },
    });
    expect(
      (within(dialog).getByRole('button', { name: 'Create sandbox' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Name (optional)'), { target: { value: '' } });
    fireEvent.change(within(dialog).getByLabelText('Lifetime (optional)'), {
      target: { value: 'forever' },
    });
    expect(
      (within(dialog).getByRole('button', { name: 'Create sandbox' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(calls.some((c) => c.channel === 'snapshots:clone')).toBe(false);
  });
});
