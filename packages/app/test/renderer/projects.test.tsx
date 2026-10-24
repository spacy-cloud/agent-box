// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TemplateListEntry, TemplateReview } from '@abox/core';
import { NewSandboxDialog, buildCreateInput } from '../../src/renderer/views/NewSandbox';
import { ReviewDialog } from '../../src/renderer/views/Templates';
import { ProjectFolderPicker } from '../../src/renderer/components/ProjectFolder';
import { installBridge, renderApp } from './harness';
import { useState } from 'react';

afterEach(cleanup);
// jsdom has no Element.scrollTo (the progress log of the dialog scrolls to its end)
beforeAll(() => {
  Element.prototype.scrollTo = () => undefined;
});

const PROJECT = '/work/demo';

function entry(over: Partial<TemplateListEntry> & { name: string }): TemplateListEntry {
  return {
    description: `${over.name} description`,
    backend: 'docker',
    isolation: 'container',
    networkMode: 'none',
    source: { kind: 'builtin', path: `/t/${over.name}.yaml` },
    trusted: true,
    allowed: true,
    backendAvailable: true,
    ready: true,
    contentHash: `c-${over.name}`,
    hash: `h-${over.name}`,
    ...over,
  };
}

const REVIEW: TemplateReview = {
  template: 'proj-shell',
  source: { kind: 'project', path: `${PROJECT}/.sandbox/proj-shell.yaml` },
  contentHash: 'c'.repeat(64),
  trusted: false,
  against: { kind: 'none', label: 'nothing (new content)' },
  diff: '--- /dev/null\n+++ project template proj-shell\n+backend: docker',
  risks: ['it runs setup commands'],
};

const BUILTIN = entry({ name: 'node-dev' });
const PROJECT_TPL = entry({
  name: 'proj-shell',
  trusted: false,
  source: { kind: 'project', path: `${PROJECT}/.sandbox/proj-shell.yaml` },
});

/** A bridge that behaves like the main process: project templates only for the remembered folder. */
function bridge(extra: (channel: string, input: unknown) => unknown = () => undefined) {
  const recent: string[] = ['/work/older'];
  return installBridge((channel, input) => {
    const x = extra(channel, input);
    if (x !== undefined) return x;
    switch (channel) {
      case 'skills:list':
        return { skills: [], problems: [] };
      case 'templates:list':
        return {
          templates: (input as { projectDir?: string } | undefined)?.projectDir
            ? [PROJECT_TPL, BUILTIN]
            : [BUILTIN],
          problems: [],
        };
      case 'projects:recent':
        return recent;
      case 'projects:remember': {
        const dir = (input as { dir: string }).dir;
        recent.unshift(dir);
        return { dir, recent };
      }
      case 'policy:get':
        return { view: { profile: null }, text: '', source: 'default', path: null };
      case 'hosts:list':
        return [];
      case 'templates:show':
        return { template: {}, warnings: [], effectiveLimits: { exceedsProfile: [] } };
      default:
        throw new Error(`unexpected ${channel}`);
    }
  });
}

describe('create request builder: project folder', () => {
  const base = {
    template: 't',
    name: '',
    workspaceMode: '',
    workspacePath: '',
    cpus: '',
    memory: '',
    ttl: '',
    networkMode: '',
    allow: '',
    presets: [] as string[],
  };
  it('sends the project folder only when one was chosen', () => {
    expect(buildCreateInput(base)).toEqual({ template: 't' });
    expect(buildCreateInput({ ...base, projectDir: '' })).toEqual({ template: 't' });
    expect(buildCreateInput({ ...base, projectDir: PROJECT })).toEqual({
      template: 't',
      projectDir: PROJECT,
    });
  });
});

describe('ProjectFolderPicker', () => {
  function Harness(props: { onChange?: (d: string) => void }) {
    const [dir, setDir] = useState('');
    return (
      <ProjectFolderPicker
        value={dir}
        onChange={(d) => {
          setDir(d);
          props.onChange?.(d);
        }}
      />
    );
  }

  it('applies the canonical folder the main process returns, remembers it and offers recent ones', async () => {
    const calls = bridge((channel, input) =>
      channel === 'projects:remember'
        ? { dir: '/real/demo', recent: ['/real/demo', '/work/older'], _in: input }
        : undefined,
    );
    const onChange = vi.fn();
    renderApp(<Harness onChange={onChange} />, { locale: 'en' });
    const input = await screen.findByRole('textbox', { name: 'Project folder' });
    fireEvent.change(input, { target: { value: '/link/demo' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('/real/demo'));
    expect(calls.find((c) => c.channel === 'projects:remember')!.input).toEqual({
      dir: '/link/demo',
    });
    expect((input as HTMLInputElement).value).toBe('/real/demo');
    expect(screen.getByRole('button', { name: 'Clear' })).toBeTruthy();
    // a recent folder is one choice away
    const select = await screen.findByRole('combobox', { name: 'Recent project folders' });
    expect(within(select).getByRole('option', { name: '/work/older' })).toBeTruthy();
    fireEvent.change(select, { target: { value: '/work/older' } });
    await waitFor(() =>
      expect(calls.filter((c) => c.channel === 'projects:remember').map((c) => c.input)).toEqual([
        { dir: '/link/demo' },
        { dir: '/work/older' },
      ]),
    );
  });

  it('shows the refusal of the main process and keeps the previous folder', async () => {
    installBridge((channel) => {
      if (channel === 'projects:recent') return [];
      throw new Error('/nope does not exist');
    });
    const onChange = vi.fn();
    renderApp(<Harness onChange={onChange} />, { locale: 'en' });
    const input = await screen.findByRole('textbox', { name: 'Project folder' });
    fireEvent.change(input, { target: { value: '/nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Show templates' }));
    expect(await screen.findByText(/\/nope does not exist/)).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('New sandbox dialog: project templates', () => {
  it('lists the templates of the chosen project next to the built-in ones, marked project with their trust state', async () => {
    const calls = bridge();
    renderApp(<NewSandboxDialog onClose={vi.fn()} onCreated={vi.fn()} />, { locale: 'en' });
    // without a project folder: only built-in and user templates
    await screen.findByText('node-dev');
    expect(screen.queryByText('proj-shell')).toBeNull();
    expect(calls.find((c) => c.channel === 'templates:list')!.input).toBeUndefined();

    const input = await screen.findByRole('textbox', { name: 'Project folder' });
    fireEvent.change(input, { target: { value: PROJECT } });
    fireEvent.keyDown(input, { key: 'Enter' });
    const card = (await screen.findByText('proj-shell')).closest('label')!;
    expect(within(card).getByText('Project template')).toBeTruthy();
    expect(within(card).getByText(/Untrusted/)).toBeTruthy();
    expect(screen.getByText('node-dev')).toBeTruthy();
    expect(calls.filter((c) => c.channel === 'templates:list').at(-1)!.input).toEqual({
      projectDir: PROJECT,
    });
  });

  it('a project without templates says so; clearing the folder brings the plain list back', async () => {
    bridge((channel, input) =>
      channel === 'templates:list' && (input as { projectDir?: string } | undefined)?.projectDir
        ? { templates: [BUILTIN], problems: [] }
        : undefined,
    );
    renderApp(<NewSandboxDialog onClose={vi.fn()} onCreated={vi.fn()} />, { locale: 'en' });
    const input = await screen.findByRole('textbox', { name: 'Project folder' });
    fireEvent.change(input, { target: { value: PROJECT } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByText(/No project templates in this folder/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() =>
      expect(screen.queryByText(/No project templates in this folder/)).toBeNull(),
    );
  });

  it('creating from a project template names the project folder and goes through the confirmation with the review', async () => {
    const calls = bridge((channel, input) => {
      if (channel === 'sandboxes:create') {
        const i = input as { confirmed?: boolean };
        return i.confirmed
          ? { status: 'created', sandbox: { id: 'local/aa', name: 'x' } }
          : {
              status: 'confirmation_required',
              reasons: ['untrusted'],
              risks: ['it runs setup commands'],
              items: [
                {
                  kind: 'template_trust',
                  reason: 'template "proj-shell" comes from a project',
                  risk: 'it runs setup commands',
                  invariant: false,
                },
              ],
              message: 'confirm',
            };
      }
      if (channel === 'templates:review') return REVIEW;
      return undefined;
    });
    renderApp(<NewSandboxDialog onClose={vi.fn()} onCreated={vi.fn()} />, { locale: 'en' });
    const input = await screen.findByRole('textbox', { name: 'Project folder' });
    fireEvent.change(input, { target: { value: PROJECT } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.click(await screen.findByRole('radio', { name: /proj-shell/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Next' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Check and create' }));
    // nothing is created before the human confirms; the review of the template is shown
    await screen.findByText('Confirmation required');
    await waitFor(() => expect(calls.some((c) => c.channel === 'templates:review')).toBe(true));
    expect(calls.find((c) => c.channel === 'templates:review')!.input).toEqual({
      name: 'proj-shell',
      projectDir: PROJECT,
    });
    expect(calls.find((c) => c.channel === 'sandboxes:create')!.input).toMatchObject({
      template: 'proj-shell',
      projectDir: PROJECT,
      confirmed: false,
    });
    expect(calls.filter((c) => c.channel === 'sandboxes:create')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and create' }));
    await waitFor(() =>
      expect(calls.filter((c) => c.channel === 'sandboxes:create')).toHaveLength(2),
    );
    expect(calls.filter((c) => c.channel === 'sandboxes:create').at(-1)!.input).toMatchObject({
      confirmed: true,
      projectDir: PROJECT,
    });
  });
});

describe('template review dialog', () => {
  it('asks for the review in the chosen project folder', async () => {
    const calls = bridge((channel) => (channel === 'templates:review' ? REVIEW : undefined));
    renderApp(<ReviewDialog name="proj-shell" projectDir={PROJECT} onClose={vi.fn()} />, {
      locale: 'en',
    });
    await screen.findByTestId('template-review');
    expect(calls.find((c) => c.channel === 'templates:review')!.input).toEqual({
      name: 'proj-shell',
      projectDir: PROJECT,
    });
  });
});
