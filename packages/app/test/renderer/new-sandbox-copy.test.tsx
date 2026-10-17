// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { TemplateListEntry, WorkspaceEstimate } from '@abox/core';
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
      '≈ 12 MiB, 340 files',
    );
    const asks = r.calls.filter((c) => c.channel === 'workspace:estimate');
    expect(asks).toHaveLength(1);
    expect(asks[0]!.input).toMatchObject({ path: '/work/proj', mode: 'copy' });
    expect((asks[0]!.input as { progressKey: string }).progressKey).toMatch(/^estimate-/);
    expect(screen.getByRole('button', { name: 'Next' })).toHaveProperty('disabled', false);
  });

  it('shows the live scan line while measuring', async () => {
    const r = rig({ estimate: () => estimate({}) });
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
    expect(warn.textContent).toContain('≈ 3.2 GiB, 41 000 files');
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
    expect(err.textContent).toContain('Larger than the copy limit (64 GiB, 2 000 000 entries)');
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
    expect(screen.queryByLabelText(/Exclude/)).toBeNull();
  });

  it('repeats the size note in the summary before Create', async () => {
    rig({ estimate: () => estimate({}) });
    mount();
    await toOptions();
    typeFolder('/work/proj');
    await screen.findByTestId('estimate-ok', {}, { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByRole('button', { name: 'Check and create' });
    expect((await screen.findByTestId('estimate-ok')).textContent).toBe('≈ 12 MiB, 340 files');
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
