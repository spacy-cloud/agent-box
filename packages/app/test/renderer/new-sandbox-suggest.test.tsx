// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TemplateListEntry, TemplateSuggestion } from '@abox/core';
import { NewSandboxDialog } from '../../src/renderer/views/NewSandbox';
import { installBridge, renderApp } from './harness';

afterEach(cleanup);
beforeAll(() => {
  Element.prototype.scrollTo = () => undefined;
});

const NODE = '/work/node-app';
const PLAIN = '/work/plain';
const OWN = '/work/own';

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

const TEMPLATES = [
  entry({ name: 'node-dev' }),
  entry({ name: 'py-uv' }),
  entry({ name: 'rust-dev' }),
];

function suggestion(path: string, over: Partial<TemplateSuggestion> = {}): TemplateSuggestion {
  return { path, primary: null, alternatives: [], skipped: [], truncated: false, ...over };
}

const ANSWERS: Record<string, TemplateSuggestion> = {
  [NODE]: suggestion(NODE, {
    primary: {
      template: 'node-dev',
      basis: 'markers',
      files: ['package.json'],
      reason: 'found package.json (a Node.js project)',
    },
    alternatives: [
      { template: 'py-uv', basis: 'markers', files: ['uv.lock'], reason: 'found uv.lock' },
    ],
    skipped: [{ template: 'php-dev', files: ['index.php'], why: 'not_allowed' }],
  }),
  [PLAIN]: suggestion(PLAIN),
  [OWN]: suggestion(OWN, {
    primary: {
      template: 'proj-shell',
      basis: 'project_template',
      files: ['.sandbox/proj-shell.yaml'],
      reason: 'the project has its own template',
    },
  }),
};

function bridge(templates: TemplateListEntry[] = TEMPLATES) {
  return installBridge((channel, input) => {
    switch (channel) {
      case 'templates:list':
        return { templates, problems: [] };
      case 'templates:suggest':
        return ANSWERS[(input as { path: string }).path]!;
      case 'projects:recent':
        return [];
      case 'projects:remember':
        return { dir: (input as { dir: string }).dir, recent: [] };
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

async function pickFolder(dir: string, label = 'Project folder'): Promise<void> {
  const input = await screen.findByRole('textbox', { name: label });
  fireEvent.change(input, { target: { value: dir } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

const radio = (name: string): HTMLInputElement => {
  const el = document.querySelector<HTMLInputElement>(`input[type="radio"][value="${name}"]`);
  if (!el) throw new Error(`no radio ${name}`);
  return el;
};

describe('New sandbox: the template is suggested for the picked folder', () => {
  it('asks for nothing before a folder is picked', async () => {
    const calls = bridge();
    renderApp(<NewSandboxDialog onClose={vi.fn()} onCreated={vi.fn()} />, { locale: 'en' });
    await screen.findByText('node-dev');
    expect(calls.some((c) => c.channel === 'templates:suggest')).toBe(false);
    expect(screen.queryByTestId('template-suggestion')).toBeNull();
  });

  it('preselects the suggestion and shows the reason, the alternatives and what was left out', async () => {
    const calls = bridge();
    renderApp(<NewSandboxDialog onClose={vi.fn()} onCreated={vi.fn()} />, { locale: 'en' });
    await pickFolder(NODE);
    await waitFor(() => expect(radio('node-dev').checked).toBe(true));
    const note = await screen.findByTestId('template-suggestion');
    expect(note.textContent).toContain('Suggested: node-dev (found in the folder: package.json).');
    expect(note.textContent).toContain('Also possible: py-uv.');
    expect(note.textContent).toContain('php-dev');
    expect(calls.find((c) => c.channel === 'templates:suggest')!.input).toEqual({ path: NODE });
    // the wizard can go on with it
    expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('the human can still choose another template, which stays chosen', async () => {
    bridge();
    renderApp(<NewSandboxDialog onClose={vi.fn()} onCreated={vi.fn()} />, { locale: 'en' });
    await pickFolder(NODE);
    await waitFor(() => expect(radio('node-dev').checked).toBe(true));
    fireEvent.click(radio('rust-dev'));
    expect(radio('rust-dev').checked).toBe(true);
    expect(radio('node-dev').checked).toBe(false);
    expect((await screen.findByTestId('template-suggestion')).textContent).toContain(
      'You chose a different template.',
    );
    // a later reload of the same answer does not take the choice back
    await new Promise((r) => setTimeout(r, 30));
    expect(radio('rust-dev').checked).toBe(true);
  });

  it('says so when nothing fits, and preselects nothing', async () => {
    bridge();
    renderApp(<NewSandboxDialog onClose={vi.fn()} onCreated={vi.fn()} />, { locale: 'en' });
    await pickFolder(PLAIN);
    const note = await screen.findByTestId('template-suggestion');
    expect(note.textContent).toContain('No template suggested');
    for (const r of screen.getAllByRole('radio'))
      expect((r as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a project template of the folder is suggested with its own wording', async () => {
    bridge([
      ...TEMPLATES,
      entry({
        name: 'proj-shell',
        trusted: false,
        source: { kind: 'project', path: `${OWN}/.sandbox/proj-shell.yaml` },
      }),
    ]);
    renderApp(<NewSandboxDialog onClose={vi.fn()} onCreated={vi.fn()} />, { locale: 'en' });
    await pickFolder(OWN);
    await waitFor(() => expect(radio('proj-shell').checked).toBe(true));
    expect((await screen.findByTestId('template-suggestion')).textContent).toContain(
      'The project brings its own template (.sandbox/proj-shell.yaml)',
    );
  });

  it('never preselects a template that cannot be chosen', async () => {
    bridge([entry({ name: 'node-dev', allowed: false }), entry({ name: 'py-uv' })]);
    renderApp(<NewSandboxDialog onClose={vi.fn()} onCreated={vi.fn()} />, { locale: 'en' });
    await pickFolder(NODE);
    await screen.findByTestId('template-suggestion');
    await new Promise((r) => setTimeout(r, 30));
    for (const r of screen.getAllByRole('radio'))
      expect((r as HTMLInputElement).checked).toBe(false);
  });

  it('a failing suggestion is no error: the list stays usable', async () => {
    installBridge((channel) => {
      switch (channel) {
        case 'templates:list':
          return { templates: TEMPLATES, problems: [] };
        case 'templates:suggest':
          throw new Error('path is not allowed');
        case 'projects:recent':
          return [];
        case 'projects:remember':
          return { dir: NODE, recent: [] };
        case 'policy:get':
          return { view: { profile: null }, text: '', source: 'default', path: null };
        case 'hosts:list':
          return [];
        default:
          throw new Error(`unexpected ${channel}`);
      }
    });
    renderApp(<NewSandboxDialog onClose={vi.fn()} onCreated={vi.fn()} />, { locale: 'en' });
    await pickFolder(NODE);
    await screen.findByText('py-uv');
    expect(screen.queryByTestId('template-suggestion')).toBeNull();
    expect(screen.queryByText(/path is not allowed/)).toBeNull();
  });

  it('speaks German in the German UI', async () => {
    bridge();
    renderApp(<NewSandboxDialog onClose={vi.fn()} onCreated={vi.fn()} />, { locale: 'de' });
    await pickFolder(NODE, 'Projektordner');
    const note = await screen.findByTestId('template-suggestion');
    expect(
      within(note).getByText(/Vorschlag: node-dev \(im Ordner gefunden: package.json\)/),
    ).toBeTruthy();
    expect(note.textContent).toContain('Auch möglich: py-uv.');
  });
});
