// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BuildDialog } from '../../src/renderer/components/BuildDialog';
import { FromProjectDialog } from '../../src/renderer/components/TemplateFromProject';
import { TemplateSaveDialog } from '../../src/renderer/components/TemplateSaveDialog';
import { buildLogs } from '../../src/renderer/build-logs';
import type { TemplateDraft, TemplateSavePlanView } from '../../src/shared/types';
import { installBridge, renderApp } from './harness';

beforeAll(() => {
  Element.prototype.scrollTo = () => undefined;
});
afterEach(() => {
  cleanup();
  buildLogs.clear();
});

const OLD = 'apiVersion: 1\nname: mine\nbackend: docker\nresources:\n  memory: 512m\n';
const NEW = 'apiVersion: 1\nname: mine\nbackend: docker\nresources:\n  memory: 2g\n';

function plan(over: Partial<TemplateSavePlanView> = {}): TemplateSavePlanView {
  return {
    name: 'mine',
    target: 'user',
    path: '/cfg/templates/mine.yaml',
    exists: true,
    current: OLD,
    shadows: [],
    usedBy: { count: 0, names: [] },
    ...over,
  };
}

function renderSave(
  handler: (channel: string, input: unknown) => unknown,
  props: Partial<Parameters<typeof TemplateSaveDialog>[0]> = {},
) {
  const calls = installBridge(handler);
  const onSaved = vi.fn();
  const onClose = vi.fn();
  renderApp(
    <TemplateSaveDialog
      yaml={NEW}
      name="mine"
      projectDir=""
      userDir="/cfg/templates"
      inPlace
      initialTarget="user"
      onClose={onClose}
      onSaved={onSaved}
      {...props}
    />,
    { locale: 'en' },
  );
  return { calls, onSaved, onClose };
}

describe('review before saving', () => {
  it('shows the old and the new text as a diff, saves only after the button, and replaces the file it showed', async () => {
    const { calls, onSaved } = renderSave((channel) => {
      if (channel === 'templates:savePlan') return plan();
      if (channel === 'templates:save')
        return {
          name: 'mine',
          path: '/cfg/templates/mine.yaml',
          shadows: [],
          target: 'user',
          created: false,
          trusted: true,
        };
      throw new Error(`unexpected ${channel}`);
    });
    const diff = await screen.findByLabelText('Difference between the file and the editor content');
    expect(diff.textContent).toContain('- ');
    expect(diff.textContent).toContain('memory: 512m');
    expect(diff.textContent).toContain('memory: 2g');
    expect(calls.some((c) => c.channel === 'templates:save')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Replace file' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(calls.find((c) => c.channel === 'templates:save')!.input).toEqual({
      yaml: NEW,
      target: 'user',
      overwrite: true,
      confirmed: true,
    });
  });

  it('says that sandboxes created from a template of that name keep their old resolved template', async () => {
    renderSave((channel) =>
      channel === 'templates:savePlan'
        ? plan({ usedBy: { count: 2, names: ['web-1', 'web-2'] } })
        : undefined,
    );
    const note = await screen.findByText(
      /2 sandbox\(es\) were created from a template named "mine"/,
    );
    expect(note.textContent).toContain('web-1, web-2');
    expect(note.textContent).toContain('keep the template they were created from');
  });

  it('a new file is saved without overwrite; replacing a template that was not opened is called out', async () => {
    const { calls } = renderSave(
      (channel) =>
        channel === 'templates:savePlan'
          ? plan({ exists: false, current: null })
          : { name: 'mine', path: '/p', shadows: [], target: 'user', created: true, trusted: true },
      { inPlace: false },
    );
    await screen.findByText('new file');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.channel === 'templates:save')).toBe(true));
    expect(calls.find((c) => c.channel === 'templates:save')!.input).not.toHaveProperty(
      'overwrite',
    );
    cleanup();
    renderSave((channel) => (channel === 'templates:savePlan' ? plan() : undefined), {
      inPlace: false,
    });
    expect(await screen.findByText(/it is not the one you opened/)).toBeTruthy();
  });

  it('project target: needs a folder, names the file, says the template is untrusted afterwards', async () => {
    const { calls } = renderSave(
      (channel, input) => {
        if (channel !== 'templates:savePlan') return undefined;
        const i = input as { target: string; projectDir?: string };
        return i.target === 'project'
          ? plan({
              target: 'project',
              path: `${i.projectDir}/.sandbox/mine.yaml`,
              exists: false,
              current: null,
            })
          : plan();
      },
      { projectDir: '/work/app' },
    );
    await screen.findByTestId('save-review');
    fireEvent.click(screen.getByRole('radio', { name: /\.sandbox in the project folder/ }));
    expect(await screen.findByText('/work/app/.sandbox/mine.yaml')).toBeTruthy();
    expect(screen.getByText(/saving does not trust it/)).toBeTruthy();
    expect(calls.filter((c) => c.channel === 'templates:savePlan').at(-1)!.input).toEqual({
      yaml: NEW,
      target: 'project',
      projectDir: '/work/app',
    });
  });

  it('without a project folder the project target is off and says why', async () => {
    renderSave((channel) => (channel === 'templates:savePlan' ? plan() : undefined));
    await screen.findByTestId('save-review');
    const radio = screen.getByRole('radio', { name: /\.sandbox in the project folder/ });
    expect((radio as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/Pick a project folder above the list first/)).toBeTruthy();
  });

  it('a refused plan (for example a symbolic link) is shown and nothing can be saved', async () => {
    renderSave((channel) => {
      if (channel === 'templates:savePlan') throw new Error('.sandbox is a symbolic link');
      return undefined;
    });
    expect(await screen.findByText(/symbolic link/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('no change against the file: nothing to save', async () => {
    renderSave((channel) =>
      channel === 'templates:savePlan' ? plan({ current: NEW }) : undefined,
    );
    expect(
      await screen.findByText(/No change: the file already has exactly this content/),
    ).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Replace file' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

const DRAFT: TemplateDraft = {
  path: '/work/my-app',
  name: 'my-app',
  yaml: 'apiVersion: 1\nname: my-app\nbackend: docker\nextends: node-dev\n',
  base: {
    template: 'node-dev',
    basis: 'markers',
    files: ['package.json'],
    reason: 'found package.json',
  },
  alternatives: [
    { template: 'rust-dev', basis: 'markers', files: ['Cargo.toml'], reason: 'found Cargo.toml' },
  ],
  projectTemplates: [],
  skipped: [],
  truncated: false,
};

describe('create template from project', () => {
  it('picks the folder, shows the detection with its reason, and hands the draft over (nothing saved)', async () => {
    const calls = installBridge((channel, input) => {
      switch (channel) {
        case 'projects:recent':
          return [];
        case 'templates:draft': {
          const i = input as { name?: string; base?: string };
          return {
            ...DRAFT,
            name: i.name ?? DRAFT.name,
            yaml: DRAFT.yaml.replace('my-app', i.name ?? 'my-app'),
            ...(i.base
              ? { base: { ...DRAFT.base, template: i.base, basis: 'chosen' as const } }
              : {}),
          };
        }
        default:
          throw new Error(`unexpected ${channel}`);
      }
    });
    const onCreate = vi.fn();
    renderApp(
      <FromProjectDialog
        initialDir="/work/my-app"
        bases={['alpine-min', 'node-dev']}
        onClose={vi.fn()}
        onCreate={onCreate}
      />,
      { locale: 'en' },
    );
    const detection = await screen.findByTestId('draft-detection');
    expect(detection.textContent).toContain(
      'Detected: node-dev (found in the folder: package.json)',
    );
    expect(detection.textContent).toContain('Also possible: rust-dev');
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('my-app');
    // a rename asks the manager again so that it validates the name and writes it into the text
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'web' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create draft' }));
    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    expect(onCreate.mock.calls[0]![0].yaml).toContain('name: web');
    expect(calls.map((c) => c.channel)).not.toContain('templates:save');
    expect(calls.filter((c) => c.channel === 'templates:draft').at(-1)!.input).toEqual({
      path: '/work/my-app',
      name: 'web',
    });
  });

  it('a folder without markers says that the draft is standalone', async () => {
    installBridge((channel) => {
      if (channel === 'projects:recent') return [];
      if (channel === 'templates:draft')
        return {
          ...DRAFT,
          base: { template: null, basis: 'fallback', files: [], reason: 'no marker' },
          alternatives: [],
        };
      throw new Error(`unexpected ${channel}`);
    });
    renderApp(
      <FromProjectDialog
        initialDir="/work/plain"
        bases={[]}
        onClose={vi.fn()}
        onCreate={vi.fn()}
      />,
      { locale: 'en' },
    );
    expect((await screen.findByTestId('draft-detection')).textContent).toContain(
      'small standalone template',
    );
  });

  it('shows a refusal of the folder and offers no draft', async () => {
    installBridge((channel) => {
      if (channel === 'projects:recent') return [];
      throw new Error('the project folder /x does not exist');
    });
    renderApp(
      <FromProjectDialog initialDir="/x" bases={[]} onClose={vi.fn()} onCreate={vi.fn()} />,
      { locale: 'en' },
    );
    expect(await screen.findByText(/does not exist/)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Create draft' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe('build log', () => {
  /** A build whose lines the test delivers by hand through the progress event. */
  function buildBridge(outcome: 'ok' | 'fail') {
    let emit: (ev: { key: string; line: string }) => void = () => undefined;
    let release: () => void = () => undefined;
    let key = '';
    const gate = new Promise<void>((r) => (release = r));
    const invoke = (channel: string, input?: unknown) => {
      if (channel !== 'templates:build') throw new Error(`unexpected ${channel}`);
      key = (input as { progressKey: string }).progressKey;
      return gate.then(() =>
        outcome === 'ok'
          ? {
              ok: true as const,
              data: { image: { ref: 'abox/mine:1' }, cached: false, durationMs: 4200 },
            }
          : {
              ok: false as const,
              error: { code: 'backend_error', message: 'Image build failed: boom' },
            },
      );
    };
    (window as unknown as { abox: unknown }).abox = {
      invoke,
      on: (_: string, cb: typeof emit) => {
        emit = cb;
        return () => undefined;
      },
    };
    return { line: (line: string) => emit({ key, line }), release: () => release() };
  }

  it('streams the output while running, then shows the outcome and the duration, and keeps the log', async () => {
    const b = buildBridge('ok');
    const view = renderApp(<BuildDialog name="mine" onClose={vi.fn()} />, { locale: 'en' });
    fireEvent.click(screen.getByRole('button', { name: 'Build' }));
    const log = await screen.findByTestId('build-log');
    act(() => {
      b.line('Step 1/3 : FROM ubuntu');
      b.line('Step 2/3 : ENV API_TOKEN=[redacted]');
    });
    expect(log.textContent).toBe('Step 1/3 : FROM ubuntu\nStep 2/3 : ENV API_TOKEN=[redacted]');
    expect((screen.getByRole('button', { name: 'Close' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await act(async () => b.release());
    expect(await screen.findByText(/Image built/)).toBeTruthy();
    expect(screen.getByText(/abox\/mine:1/)).toBeTruthy();
    expect(screen.getByText('succeeded')).toBeTruthy();
    expect(screen.getByText(/took 4\.2 s|took 4s|took 4\.2s/)).toBeTruthy();
    view.unmount();

    // reopened: the last log of that template is still there, with its outcome
    installBridge(() => undefined);
    renderApp(<BuildDialog name="mine" onClose={vi.fn()} />, { locale: 'en' });
    expect(screen.getByTestId('build-log').textContent).toContain('Step 1/3 : FROM ubuntu');
    expect(screen.getByText('succeeded')).toBeTruthy();
    // another template has no log
    cleanup();
    renderApp(<BuildDialog name="other" onClose={vi.fn()} />, { locale: 'en' });
    expect(screen.queryByTestId('build-log')).toBeNull();
  });

  it('a failed build shows the failure with the time it took, and the log stays', async () => {
    const b = buildBridge('fail');
    renderApp(<BuildDialog name="broken" onClose={vi.fn()} />, { locale: 'en' });
    fireEvent.click(screen.getByRole('button', { name: 'Build' }));
    await screen.findByTestId('build-log');
    act(() => b.line('ERROR: boom'));
    await act(async () => b.release());
    const alert = await screen.findAllByRole('alert');
    expect(alert.map((a) => a.textContent).join(' ')).toMatch(/Build failed after/);
    expect(screen.getByText('failed')).toBeTruthy();
    expect(screen.getByTestId('build-log').textContent).toBe('ERROR: boom');
    expect(buildLogs.get('broken')).toMatchObject({ status: 'failed' });
    // the dialog can be closed and a new build started again
    expect(
      (screen.getByRole('button', { name: 'Build again' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('keeps the buffer bounded and neutralises control characters', () => {
    buildLogs.start('noisy', false);
    for (let i = 0; i < 2500; i++)
      buildLogs.append('noisy', i === 2499 ? 'last\u001b[2J' : `l${i}`);
    const log = buildLogs.get('noisy')!;
    expect(log.lines).toHaveLength(2000);
    expect(log.dropped).toBe(500);
    expect(log.lines.at(-1)).toBe('last\\x1b[2J');
  });
});
