// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { TemplateListEntry, WorkspaceEstimate } from '@abox/core';
import { WorkspaceEstimateNote } from '../../src/renderer/components/WorkspaceEstimate';
import { NewSandboxDialog, buildCreateInput } from '../../src/renderer/views/NewSandbox';
import type { ProgressEvent } from '../../src/shared/constants';
import { renderApp } from './harness';

afterEach(cleanup);
// jsdom has no Element.scrollTo (the progress log of the dialog scrolls to its end)
beforeAll(() => {
  Element.prototype.scrollTo = () => undefined;
});

const GIB = 1024 ** 3;
const TEMPLATE: TemplateListEntry = {
  name: 'alpine-min',
  description: 'minimal',
  backend: 'docker',
  isolation: 'container',
  networkMode: 'none',
  source: { kind: 'builtin', path: '/t/alpine-min.yaml' },
  trusted: true,
  allowed: true,
  backendAvailable: true,
  ready: true,
  contentHash: 'c',
  hash: 'h',
};

function estimate(over: Partial<WorkspaceEstimate>): WorkspaceEstimate {
  return {
    path: '/work/proj',
    mode: 'copy',
    applicable: true,
    bytes: 12 * 1024 ** 2,
    entries: 400,
    files: 340,
    truncated: false,
    overSoftLimit: false,
    overHardLimit: false,
    soft: { bytes: GIB, entries: 50_000 },
    hard: { bytes: 64 * GIB, entries: 2_000_000 },
    durationMs: 3,
    ...over,
  };
}

interface Rig {
  calls: Array<{ channel: string; input: unknown }>;
  emit(ev: ProgressEvent): void;
  /** Settle the pending `sandboxes:create`. */
  finishCreate(result: unknown): void;
}

/** A bridge with a controllable event channel and a create call that stays open until released. */
function rig(opts: { estimate: () => WorkspaceEstimate; failEstimate?: boolean }): Rig {
  const calls: Rig['calls'] = [];
  const listeners = new Set<(p: ProgressEvent) => void>();
  let settle: { resolve(v: unknown): void; reject(e: Error): void } | undefined;
  let createKey: string | undefined;
  const invoke = async (channel: string, input?: unknown) => {
    calls.push({ channel, input });
    const data = await (async (): Promise<unknown> => {
      switch (channel) {
        case 'templates:list':
          return { templates: [TEMPLATE], problems: [] };
        case 'policy:get':
          return { view: { profile: null }, text: '', source: 'default', path: null };
        case 'hosts:list':
          return [];
        case 'projects:recent':
          return [];
        case 'templates:show':
          return {
            template: { workspace: { mode: 'copy', path: '/workspace' } },
            warnings: [],
            effectiveLimits: { exceedsProfile: [] },
          };
        case 'workspace:estimate':
          if (opts.failEstimate) throw new Error('not readable');
          return opts.estimate();
        case 'jobs:cancel': {
          // like the main process: only the call with this key is cancelled
          const hit = (input as { key: string }).key === createKey;
          if (hit) settle?.reject(new Error('create cancelled'));
          return { cancelled: hit };
        }
        case 'sandboxes:create':
          createKey = (input as { progressKey: string }).progressKey;
          return new Promise((resolve, reject) => {
            settle = { resolve, reject };
          });
        default:
          throw new Error(`unexpected ${channel}`);
      }
    })().then(
      (d) => ({ ok: true as const, data: d }),
      (e: Error) => ({ ok: false as const, error: { code: 'internal', message: e.message } }),
    );
    return data;
  };
  (window as unknown as { abox: unknown }).abox = {
    invoke,
    on: (channel: string, l: (p: ProgressEvent) => void) => {
      if (channel !== 'evt:progress') return () => undefined;
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
  return {
    calls,
    emit: (ev) => act(() => listeners.forEach((l) => l(ev))),
    finishCreate: (r) => settle?.resolve(r),
  };
}

async function toOptions(): Promise<void> {
  fireEvent.click(await screen.findByRole('radio', { name: /alpine-min/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  await screen.findByLabelText('Project directory');
}

function typeFolder(path: string): void {
  fireEvent.change(screen.getByLabelText('Project directory'), { target: { value: path } });
}

const mount = () =>
  renderApp(<NewSandboxDialog onClose={() => undefined} onCreated={() => undefined} />, {
    locale: 'en',
  });

describe('New sandbox: folder size when the folder is picked', () => {
  it('shows size and file count for a small folder, from one debounced scan', async () => {
    const r = rig({ estimate: () => estimate({}) });
    mount();
    await toOptions();
    typeFolder('/work/p');
    typeFolder('/work/proj');
    expect((await screen.findByTestId('estimate-ok', {}, { timeout: 3000 })).textContent).toBe(
      '≈ 12 MiB, 340 files will be copied',
    );
    const asks = r.calls.filter((c) => c.channel === 'workspace:estimate');
    expect(asks).toHaveLength(1);
    expect(asks[0]!.input).toMatchObject({ path: '/work/proj', mode: 'copy' });
    expect((asks[0]!.input as { progressKey: string }).progressKey).toMatch(/^estimate-/);
    expect(screen.getByRole('button', { name: 'Next' })).toHaveProperty('disabled', false);
  });

  it('shows the live scan line while measuring', async () => {
    // the scan stays open, so the line is what the note shows
    const r = rig({ estimate: () => new Promise<never>(() => undefined) as never });
    mount();
    await toOptions();
    typeFolder('/work/proj');
    const scanning = await screen.findByTestId('estimate-scanning');
    const key = await waitFor(
      () => {
        const c = r.calls.find((x) => x.channel === 'workspace:estimate');
        if (!c) throw new Error('not yet');
        return (c.input as { progressKey: string }).progressKey;
      },
      { timeout: 3000 },
    );
    r.emit({ key, line: 'scanning workspace … 12 345 files, 1.2 GiB' });
    await waitFor(() => expect(scanning.textContent).toContain('12 345 files, 1.2 GiB'));
  });

  it('warns about a large folder and offers mount / clone; choosing one sets the mode', async () => {
    rig({
      estimate: () =>
        estimate({ bytes: 3.2 * GIB, files: 41_000, entries: 45_000, overSoftLimit: true }),
    });
    mount();
    await toOptions();
    typeFolder('/work/proj');
    const warn = await screen.findByTestId('estimate-large', {}, { timeout: 3000 });
    expect(warn.textContent).toContain('≈ 3.2 GiB, 41,000 files');
    expect(warn.textContent).toContain('Copying will take a while');
    const banner = warn.closest('.banner') as HTMLElement;
    expect(banner.textContent).toContain('"mount" or "clone"');
    fireEvent.click(within(banner).getByRole('button', { name: 'Use mode Clone' }));
    expect((screen.getByLabelText('Workspace mode') as HTMLSelectElement).value).toBe('clone');
    // not measured any more: a clone does not copy the folder
    await waitFor(() => expect(screen.queryByTestId('estimate-large')).toBeNull());
    expect(screen.getByRole('button', { name: 'Next' })).toHaveProperty('disabled', false);
  });

  it('blocks Next with an error when the folder is beyond the copy limit', async () => {
    rig({
      estimate: () =>
        estimate({
          bytes: 65 * GIB,
          files: 900,
          entries: 1000,
          truncated: true,
          overSoftLimit: true,
          overHardLimit: true,
        }),
    });
    mount();
    await toOptions();
    typeFolder('/work/huge');
    const err = await screen.findByTestId('estimate-too-large', {}, { timeout: 3000 });
    expect(err.textContent).toContain('Larger than the copy limit (64 GiB, 2,000,000 entries)');
    const banner = err.closest('.banner') as HTMLElement;
    expect(banner.textContent).toContain('≥ 65 GiB, 900 files');
    expect(screen.getByRole('button', { name: 'Next' })).toHaveProperty('disabled', true);
    // the suggestion is one click away; afterwards the dialog can go on
    fireEvent.click(within(banner).getByRole('button', { name: 'Use mode Mount' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Next' })).toHaveProperty('disabled', false),
    );
  });

  it('a folder that cannot be measured is only a note, not a blocker', async () => {
    rig({ estimate: () => estimate({}), failEstimate: true });
    mount();
    await toOptions();
    typeFolder('/work/proj');
    const note = await screen.findByTestId('estimate-error', {}, { timeout: 3000 });
    expect(note.textContent).toContain('could not be checked: not readable');
    expect(screen.getByRole('button', { name: 'Next' })).toHaveProperty('disabled', false);
  });

  it('measures nothing for a mode that does not copy, and offers no exclude field there', async () => {
    const r = rig({ estimate: () => estimate({}) });
    mount();
    await toOptions();
    fireEvent.change(screen.getByLabelText('Workspace mode'), { target: { value: 'mount' } });
    typeFolder('/work/proj');
    await new Promise((res) => setTimeout(res, 600));
    expect(r.calls.some((c) => c.channel === 'workspace:estimate')).toBe(false);
    expect(screen.queryByLabelText(/exclude/i)).toBeNull();
  });

  it('repeats the size note in the summary before Create', async () => {
    rig({ estimate: () => estimate({}) });
    mount();
    await toOptions();
    typeFolder('/work/proj');
    await screen.findByTestId('estimate-ok', {}, { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByRole('button', { name: 'Check and create' });
    expect((await screen.findByTestId('estimate-ok')).textContent).toBe(
      '≈ 12 MiB, 340 files will be copied',
    );
  });
});

describe('New sandbox: respecting .gitignore', () => {
  it('offers the checkbox, ticked, for copy workspaces only', async () => {
    rig({ estimate: () => estimate({}) });
    mount();
    await toOptions();
    const box = (await screen.findByLabelText('Respect .gitignore')) as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.change(screen.getByLabelText('Workspace mode'), { target: { value: 'mount' } });
    expect(screen.queryByLabelText('Respect .gitignore')).toBeNull();
    fireEvent.change(screen.getByLabelText('Workspace mode'), { target: { value: 'sync' } });
    expect(screen.getByLabelText('Respect .gitignore')).toBeTruthy();
  });

  it('shows how much .gitignore saved next to the size', async () => {
    rig({
      estimate: () =>
        estimate({
          ignored: 12,
          ignoredTotals: { files: 30_000, bytes: 2.1 * GIB, partial: false },
        }),
    });
    mount();
    await toOptions();
    typeFolder('/work/proj');
    expect((await screen.findByTestId('estimate-ok', {}, { timeout: 3000 })).textContent).toBe(
      '≈ 12 MiB, 340 files will be copied',
    );
    // an info banner: the bold first line and what .gitignore left out underneath
    const banner = screen.getByTestId('estimate-ok').closest('.banner') as HTMLElement;
    expect(banner.className).toContain('banner-info');
    expect(within(banner).getByTestId('estimate-left-out').textContent).toBe(
      '2.1 GiB in 30,000 files left out by .gitignore',
    );
  });

  it('writes the numbers the German way', () => {
    renderApp(
      <WorkspaceEstimateNote
        state={{
          status: 'ready',
          estimate: estimate({
            bytes: 38 * 1024 ** 2,
            files: 1240,
            ignoredTotals: { files: 61_000, bytes: 2.1 * GIB, partial: false },
          }),
        }}
        modes={[]}
      />,
      { locale: 'de' },
    );
    expect(screen.getByTestId('estimate-ok').textContent).toBe(
      '≈ 38 MiB, 1 240 Dateien werden kopiert',
    );
    expect(screen.getByTestId('estimate-left-out').textContent).toBe(
      '2,1 GiB in 61 000 Dateien durch .gitignore ausgelassen',
    );
  });

  it('says "at least" when measuring the ignored part stopped early, and nothing when it is empty', async () => {
    let e = estimate({ ignored: 1, ignoredTotals: { files: 9, bytes: GIB, partial: true } });
    rig({ estimate: () => e });
    mount();
    await toOptions();
    typeFolder('/work/proj');
    await screen.findByTestId('estimate-ok', {}, { timeout: 3000 });
    expect(screen.getByTestId('estimate-left-out').textContent).toBe(
      '≥ 1.0 GiB in 9 files left out by .gitignore',
    );
    e = estimate({ ignored: 1, ignoredTotals: { files: 0, bytes: 0, partial: false } });
    typeFolder('/work/other');
    await waitFor(() => expect(screen.queryByTestId('estimate-left-out')).toBeNull(), {
      timeout: 3000,
    });
  });

  it('unticking measures again without .gitignore and sends the choice with the create', async () => {
    const r = rig({ estimate: () => estimate({}) });
    mount();
    await toOptions();
    typeFolder('/work/proj');
    await screen.findByTestId('estimate-ok', {}, { timeout: 3000 });
    fireEvent.click(screen.getByLabelText('Respect .gitignore'));
    await waitFor(
      () => {
        const asks = r.calls.filter((c) => c.channel === 'workspace:estimate');
        expect(asks).toHaveLength(2);
        expect(asks[1]!.input).toMatchObject({ path: '/work/proj', gitignore: false });
      },
      { timeout: 3000 },
    );
    expect(
      r.calls.find((c) => c.channel === 'workspace:estimate')!.input as object,
    ).not.toHaveProperty('gitignore');
    await screen.findByTestId('estimate-ok', {}, { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect((await screen.findByText(/\.gitignore not applied/)).textContent).toContain(
      '.gitignore not applied',
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Check and create' }));
    const c = await waitFor(() => {
      const x = r.calls.find((y) => y.channel === 'sandboxes:create');
      if (!x) throw new Error('not yet');
      return x;
    });
    expect((c.input as { workspace: unknown }).workspace).toEqual({
      path: '/work/proj',
      gitignore: false,
    });
  });
});

describe('New sandbox: feedback while creating', () => {
  async function startCreate(r: Rig): Promise<string> {
    await toOptions();
    typeFolder('/work/proj');
    await screen.findByTestId('estimate-ok', {}, { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Check and create' }));
    const c = await waitFor(() => {
      const x = r.calls.find((y) => y.channel === 'sandboxes:create');
      if (!x) throw new Error('not yet');
      return x;
    });
    return (c.input as { progressKey: string }).progressKey;
  }

  it('renders the scan and copy lines, replaces the repeating ones and draws a determinate bar', async () => {
    const r = rig({ estimate: () => estimate({}) });
    mount();
    const key = await startCreate(r);
    await screen.findByText(/checking and copying the workspace/);
    r.emit({ key, line: 'scanning workspace … 10 files, 1.0 MiB', phase: 'scan', done: 1 });
    r.emit({ key, line: 'workspace: 40 files, 4.0 MiB', phase: 'scan', done: 4 });
    r.emit({
      key,
      line: 'copying workspace … 1.0 MiB of 4.0 MiB',
      phase: 'copy',
      done: 1048576,
      total: 4194304,
    });
    r.emit({
      key,
      line: 'copying workspace … 2.0 MiB of 4.0 MiB',
      phase: 'copy',
      done: 2097152,
      total: 4194304,
    });
    const log = screen.getByLabelText('Progress');
    expect(log.textContent).toBe(
      ['workspace: 40 files, 4.0 MiB', 'copying workspace … 2.0 MiB of 4.0 MiB'].join('\n'),
    );
    const bar = screen.getByLabelText('Progress of the workspace copy') as HTMLProgressElement;
    expect(bar.max).toBe(4194304);
    expect(bar.value).toBe(2097152);
    // image build lines (no phase) are appended as they are
    r.emit({ key, line: 'Step 1/3' });
    expect(log.textContent?.endsWith('Step 1/3')).toBe(true);
    // a step without numbers (scan, delivering) is an indeterminate bar
    r.emit({ key, line: 'delivering workspace into the sandbox …', phase: 'deliver' });
    expect(
      (screen.getByLabelText('Progress of the workspace copy') as HTMLProgressElement).position,
    ).toBe(-1);
  });

  it('Cancel is a working button: it cancels the create and returns to the summary', async () => {
    const r = rig({ estimate: () => estimate({}) });
    mount();
    const key = await startCreate(r);
    const cancel = await screen.findByRole('button', { name: 'Cancel' });
    expect((cancel as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(cancel);
    await screen.findByText(/Cancelling/);
    expect(r.calls.filter((c) => c.channel === 'jobs:cancel').at(-1)!.input).toEqual({ key });
    await screen.findByRole('button', { name: 'Check and create' });
    expect(screen.queryByText(/Creating sandbox/)).toBeNull();
  });
});

describe('create request builder: exclude', () => {
  const base = {
    template: 't',
    name: '',
    workspaceMode: '',
    workspacePath: '/work/p',
    cpus: '',
    memory: '',
    ttl: '',
    networkMode: '',
    allow: '',
    presets: [] as string[],
  };
  it('sends the exclude patterns for copy workspaces only', () => {
    expect(buildCreateInput({ ...base, exclude: 'node_modules, *.log dist' }).workspace).toEqual({
      path: '/work/p',
      exclude: ['node_modules', '*.log', 'dist'],
    });
    expect(
      buildCreateInput({ ...base, workspaceMode: 'copy', exclude: 'node_modules' }).workspace,
    ).toEqual({ mode: 'copy', path: '/work/p', exclude: ['node_modules'] });
    expect(
      buildCreateInput({ ...base, workspaceMode: 'mount', exclude: 'node_modules' }).workspace,
    ).toEqual({ mode: 'mount', path: '/work/p' });
    expect(buildCreateInput({ ...base, exclude: '  ' }).workspace).toEqual({ path: '/work/p' });
  });
});

describe('create request builder: gitignore', () => {
  const base = {
    template: 't',
    name: '',
    workspaceMode: 'copy',
    workspacePath: '/work/p',
    cpus: '',
    memory: '',
    ttl: '',
    networkMode: '',
    allow: '',
    presets: [] as string[],
  };
  it('sends the choice only when it was made, and only where it applies', () => {
    expect(buildCreateInput(base).workspace).toEqual({ mode: 'copy', path: '/work/p' });
    expect(buildCreateInput({ ...base, gitignore: false }).workspace).toEqual({
      mode: 'copy',
      path: '/work/p',
      gitignore: false,
    });
    expect(buildCreateInput({ ...base, gitignore: true, workspaceMode: 'sync' }).workspace).toEqual(
      { mode: 'sync', path: '/work/p', gitignore: true },
    );
    // the core refuses the option for other modes: a stale choice must not be sent
    for (const m of ['mount', 'clone', 'worktree', 'empty'])
      expect(
        buildCreateInput({ ...base, gitignore: false, workspaceMode: m }).workspace,
      ).not.toHaveProperty('gitignore');
    // the template's mode counts when the form has none
    const t = { ...base, workspaceMode: '', gitignore: false };
    expect(buildCreateInput(t).workspace).toEqual({ path: '/work/p' });
    expect(buildCreateInput(t, 'copy').workspace).toEqual({ path: '/work/p', gitignore: false });
    expect(buildCreateInput(t, 'mount').workspace).toEqual({ path: '/work/p' });
  });
});
