// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TemplateReview } from '@abox/core';
import { NewSandboxDialog } from '../../src/renderer/views/NewSandbox';
import { ReviewDialog, TemplatesView } from '../../src/renderer/views/Templates';
import { installBridge, renderApp } from './harness';

afterEach(cleanup);
// jsdom has no scrolling; the create step scrolls its progress log
beforeAll(() => {
  Element.prototype.scrollTo = () => undefined;
});

const REVIEW: TemplateReview = {
  template: 'proj-tpl',
  source: { kind: 'project', path: '/p/.sandbox/proj-tpl.yaml' },
  contentHash: 'c'.repeat(64),
  trusted: false,
  against: { kind: 'none', label: 'nothing (new content)' },
  diff: '--- /dev/null\n+++ project template proj-tpl\n+name: proj-tpl\n+network: { mode: open }',
  risks: ['network mode open'],
};

describe('ReviewDialog (templates view)', () => {
  it('shows the review of a project template, scrollable and monospaced, without trusting anything', async () => {
    const calls = installBridge((channel) => {
      if (channel === 'templates:review') return REVIEW;
      throw new Error(`unexpected ${channel}`);
    });
    renderApp(<ReviewDialog name="proj-tpl" onClose={vi.fn()} />, { locale: 'en' });
    const dialog = await screen.findByRole('dialog', { name: 'Review of template proj-tpl' });
    const panel = await within(dialog).findByTestId('template-review');
    expect(within(panel).getByText('network mode open')).toBeTruthy();
    expect(panel.textContent).toContain('shown in full');
    expect(panel.textContent).toContain('content not trusted yet');
    const diff = within(panel).getByLabelText('Template as a diff');
    expect(diff.className).toContain('diff');
    expect(diff.getAttribute('tabindex')).toBe('0');
    expect(diff.querySelector('.diff-add')?.textContent).toContain('+name: proj-tpl');
    expect(calls).toEqual([{ channel: 'templates:review', input: { name: 'proj-tpl' } }]);
  });

  it('says so when there is no difference and shows a manager error as an alert', async () => {
    installBridge(() => ({ ...REVIEW, diff: '', risks: [], trusted: true }));
    const { unmount } = renderApp(<ReviewDialog name="proj-tpl" onClose={vi.fn()} />, {
      locale: 'en',
    });
    expect(await screen.findByText(/No difference in the resolved template/)).toBeTruthy();
    expect(screen.getByText('content trusted')).toBeTruthy();
    unmount();
    installBridge(() => {
      throw new Error('template "proj-tpl" not found');
    });
    renderApp(<ReviewDialog name="proj-tpl" onClose={vi.fn()} />, { locale: 'en' });
    expect((await screen.findByRole('alert')).textContent).toContain('not found');
  });
});

describe('new sandbox dialog: confirmation', () => {
  const TEMPLATE = {
    name: 'proj-tpl',
    description: 'A project template',
    backend: 'docker',
    isolation: 'container',
    networkMode: 'open',
    source: { kind: 'project', path: '/p/.sandbox/proj-tpl.yaml' },
    trusted: false,
    allowed: true,
    backendAvailable: true,
    contentHash: 'c'.repeat(64),
    hash: 'h',
  };
  const ITEMS = {
    template_trust: {
      kind: 'template_trust',
      reason: 'template "proj-tpl" comes from a project source whose content has not been approved',
      risk: 'A foreign template can run arbitrary setup commands.',
      invariant: true,
    },
    image_registry: {
      kind: 'image_registry',
      reason:
        'base image "ghcr.io/other/tools:1" of template "proj-tpl" is outside the image registries',
      risk: 'The sandbox is built from an image you have not allowed.',
      invariant: false,
    },
  };

  function open(items: unknown[], onReview: (input: unknown) => unknown = () => REVIEW) {
    const calls = installBridge((channel, input) => {
      switch (channel) {
        case 'templates:list':
          return { templates: [TEMPLATE], problems: [] };
        case 'policy:get':
          return {
            view: {
              profile: {
                name: 'human',
                limits: { cpus: 8, memory: '16g', ttl: '8h' },
                workspace: { roots: ['~'], modes: ['copy', 'empty'] },
                network: { modes: ['none', 'allowlist'], allow_presets: ['npm'], allow: [] },
                images: { registries: ['docker.io/library'] },
              },
            },
          };
        case 'hosts:list':
          return [];
        case 'templates:show':
          return {
            template: { ...TEMPLATE, base: { os: 'ghcr.io/other/tools:1' } },
            warnings: [],
            effectiveLimits: { exceedsProfile: [] },
          };
        case 'sandboxes:create':
          return {
            status: 'confirmation_required',
            reasons: [],
            risks: [],
            items,
            message: 'confirm',
          };
        case 'templates:review':
          return onReview(input);
        default:
          throw new Error(`unexpected ${channel}`);
      }
    });
    renderApp(<NewSandboxDialog onClose={vi.fn()} onCreated={vi.fn()} />, { locale: 'en' });
    return calls;
  }

  async function toConfirmation(workspace?: string) {
    fireEvent.click(await screen.findByRole('radio', { name: /proj-tpl/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    if (workspace) {
      fireEvent.change(await screen.findByLabelText(/Workspace mode/), {
        target: { value: 'copy' },
      });
      fireEvent.change(screen.getByLabelText(/Project directory/), {
        target: { value: workspace },
      });
    }
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Check and create' }));
    await screen.findByText('Confirmation required');
  }

  it('an untrusted project template: the review of the template is part of the confirmation', async () => {
    const calls = open([ITEMS.template_trust]);
    await toConfirmation();
    const panel = await screen.findByTestId('template-review');
    expect(within(panel).getByText('network mode open')).toBeTruthy();
    expect(screen.getByText('What the project template does')).toBeTruthy();
    expect(calls.find((c) => c.channel === 'templates:review')?.input).toEqual({
      name: 'proj-tpl',
    });
    // nothing is created before the explicit confirmation
    expect(calls.filter((c) => c.channel === 'sandboxes:create')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Confirm and create' })).toBeTruthy();
  });

  it('passes the chosen workspace so a template that lives in that project is found', async () => {
    const calls = open([ITEMS.template_trust]);
    await toConfirmation('/home/u/proj');
    await screen.findByTestId('template-review');
    expect(calls.find((c) => c.channel === 'templates:review')?.input).toEqual({
      name: 'proj-tpl',
      workspacePath: '/home/u/proj',
    });
  });

  it('an unavailable review is a notice and does not block the confirmation', async () => {
    open([ITEMS.template_trust], () => {
      throw new Error('boom');
    });
    await toConfirmation();
    expect(await screen.findByText(/template review is not available: boom/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Confirm and create' })).toBeTruthy();
  });

  it('an image outside the allowed registries shows image, registry and the allowlist', async () => {
    const calls = open([ITEMS.image_registry]);
    await toConfirmation();
    const block = await screen.findByTestId('image-use');
    expect(block.textContent).toContain('ghcr.io/other/tools:1');
    expect(within(block).getByText('ghcr.io')).toBeTruthy();
    expect(block.textContent).toContain('docker.io/library');
    expect(block.textContent).toContain('outside the allowed registries');
    // no review for a trusted template
    expect(calls.some((c) => c.channel === 'templates:review')).toBe(false);
    await waitFor(() => expect(screen.queryByTestId('template-review')).toBeNull());
  });
});

describe('templates view: Review for project templates', () => {
  const entry = (name: string, kind: 'builtin' | 'user' | 'project') => ({
    name,
    description: `${name} description`,
    backend: 'docker',
    isolation: 'container',
    networkMode: 'none',
    source: { kind, path: `/x/${name}.yaml` },
    trusted: kind !== 'project',
    allowed: true,
    backendAvailable: true,
    contentHash: 'c'.repeat(64),
    hash: 'h',
  });
  const YAML =
    'apiVersion: 1\nname: proj-tpl\ndescription: d\nbackend: docker\nbase: { os: ubuntu:24.04 }\n';

  function open() {
    return installBridge((channel, input) => {
      switch (channel) {
        case 'templates:list':
          return {
            templates: [entry('proj-tpl', 'project'), entry('node-dev', 'builtin')],
            problems: [],
          };
        case 'templates:catalog':
          return { baseImages: [], tools: [], networkPresets: [], userDir: '/u' };
        case 'templates:source':
          return {
            name: (input as { name: string }).name,
            yaml: YAML,
            source: {
              kind: (input as { name: string }).name === 'proj-tpl' ? 'project' : 'builtin',
              path: '/x',
            },
            readOnly: true,
          };
        case 'templates:validate':
          return { ok: true, issues: [], warnings: [] };
        case 'templates:review':
          return REVIEW;
        default:
          throw new Error(`unexpected ${channel}`);
      }
    });
  }

  it('offers Review for a project template only, and shows the same review as the approval', async () => {
    const calls = open();
    renderApp(<TemplatesView />, { locale: 'en' });
    fireEvent.click(await screen.findByRole('button', { name: /node-dev/ }));
    await waitFor(() => expect(calls.some((c) => c.channel === 'templates:source')).toBe(true));
    expect(screen.queryByRole('button', { name: 'Review …' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /proj-tpl/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Review …' }));
    const dialog = await screen.findByRole('dialog', { name: 'Review of template proj-tpl' });
    expect(await within(dialog).findByTestId('template-review')).toBeTruthy();
    expect(calls.find((c) => c.channel === 'templates:review')?.input).toEqual({
      name: 'proj-tpl',
    });
  });
});
