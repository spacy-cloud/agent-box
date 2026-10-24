// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { SkillDetails, SkillListEntry, TemplateListEntry } from '@abox/core';
import { SkillsView } from '../../src/renderer/views/Skills';
import { NewSandboxDialog, buildCreateInput } from '../../src/renderer/views/NewSandbox';
import { installBridge, renderApp } from './harness';

afterEach(cleanup);
beforeAll(() => {
  Element.prototype.scrollTo = () => undefined;
});

function skill(name: string, over: Partial<SkillListEntry> = {}): SkillListEntry {
  return {
    name,
    description: `what ${name} does`,
    source: { kind: 'builtin', path: `/core/skills/${name}` },
    trusted: true,
    allowed: true,
    fileCount: 1,
    totalBytes: 100,
    contentHash: 'a'.repeat(64),
    ...over,
  };
}

const LIST = {
  skills: [
    skill('minimal-change'),
    skill('run-tests', { fileCount: 2 }),
    skill('repo-rules', {
      source: { kind: 'project', path: '/work/p/.sandbox/skills/repo-rules' },
      trusted: false,
    }),
  ],
  problems: [
    { kind: 'user', path: '/cfg/skills/Bad', name: 'Bad', message: 'bad name', issues: [] },
  ],
};

function details(name: string): SkillDetails {
  const e = LIST.skills.find((s) => s.name === name)!;
  return {
    ...e,
    frontMatter: { license: 'MIT' },
    // untrusted text: markup must stay text
    body: '# Run the tests\n\n<script>alert(1)</script>',
    files: [
      { path: 'SKILL.md', size: 80, executable: false },
      { path: 'scripts/run.sh', size: 20, executable: true },
    ],
    sandboxPath: `/skills/${name}`,
  };
}

describe('Skills view', () => {
  it('lists the skills with source and trust, shows problems, and a detail as plain text', async () => {
    const calls = installBridge((channel, input) => {
      if (channel === 'skills:list') return LIST;
      if (channel === 'skills:show') return details((input as { name: string }).name);
      if (channel === 'projects:recent') return [];
      throw new Error(`unexpected ${channel}`);
    });
    renderApp(<SkillsView />, { locale: 'en' });
    const list = await screen.findByRole('complementary', { name: 'Skill list' });
    await within(list).findByText('run-tests');
    expect(within(list).getByText('2 file(s)')).toBeTruthy();
    expect(within(list).getByText('Not approved yet')).toBeTruthy();
    expect(within(list).getByText('1 broken skill folder(s)')).toBeTruthy();

    // the search filters by name and description
    fireEvent.change(screen.getByPlaceholderText('Search skills'), {
      target: { value: 'minimal' },
    });
    expect(within(list).queryByText('run-tests')).toBeNull();
    fireEvent.change(screen.getByPlaceholderText('Search skills'), { target: { value: '' } });

    fireEvent.click(within(list).getByText('run-tests'));
    expect(await screen.findByText('/skills/run-tests')).toBeTruthy();
    expect(screen.getByText('scripts/run.sh')).toBeTruthy();
    expect(screen.getByText('executable')).toBeTruthy();
    expect(screen.getByText('license')).toBeTruthy();
    const body = screen.getByLabelText('Text of SKILL.md');
    expect(body.tagName).toBe('PRE');
    expect(body.textContent).toContain('<script>alert(1)</script>');
    expect(document.querySelector('script')).toBeNull();
    expect(calls.some((c) => c.channel === 'skills:show')).toBe(true);
  });

  it('explains an unapproved project skill', async () => {
    installBridge((channel, input) => {
      if (channel === 'skills:list') return LIST;
      if (channel === 'skills:show') return details((input as { name: string }).name);
      if (channel === 'projects:recent') return [];
      throw new Error(`unexpected ${channel}`);
    });
    renderApp(<SkillsView />, { locale: 'en' });
    fireEvent.click(await screen.findByText('repo-rules'));
    expect(await screen.findByText(/Project skill that nobody approved yet/)).toBeTruthy();
  });
});

const TEMPLATE: TemplateListEntry = {
  name: 'node-dev',
  description: 'node',
  backend: 'docker',
  isolation: 'container',
  networkMode: 'none',
  source: { kind: 'builtin', path: '/t/node-dev.yaml' },
  trusted: true,
  allowed: true,
  backendAvailable: true,
  ready: true,
  contentHash: 'c',
  hash: 'h',
};

describe('skills in New sandbox', () => {
  it('buildCreateInput sends only the skills the template does not bring', () => {
    const base = {
      template: 'node-dev',
      name: '',
      workspaceMode: 'empty',
      workspacePath: '',
      cpus: '',
      memory: '',
      ttl: '',
      networkMode: '',
      allow: '',
      presets: [],
    };
    expect(buildCreateInput(base).skills).toBeUndefined();
    expect(
      buildCreateInput({ ...base, skills: ['run-tests', 'minimal-change'] }, 'empty', [
        'minimal-change',
      ]).skills,
    ).toEqual(['run-tests']);
  });

  it('shows the template skills fixed, lets the others be added and sends them', async () => {
    const calls = installBridge((channel) => {
      switch (channel) {
        case 'templates:list':
          return { templates: [TEMPLATE], problems: [] };
        case 'templates:show':
          return {
            template: { workspace: { mode: 'empty', path: '/workspace' }, skills: ['run-tests'] },
            warnings: [],
            effectiveLimits: { exceedsProfile: [] },
          };
        case 'skills:list':
          return LIST;
        case 'policy:get':
          return { view: { profile: null }, text: '', source: 'default', path: null };
        case 'hosts:list':
        case 'projects:recent':
          return [];
        case 'capacity:estimate':
          throw new Error('no estimate');
        case 'sandboxes:create':
          return { status: 'created', sandbox: { id: 'local/x', name: 'x' }, warnings: [] };
        default:
          throw new Error(`unexpected ${channel}`);
      }
    });
    renderApp(<NewSandboxDialog onClose={() => undefined} onCreated={() => undefined} />, {
      locale: 'en',
    });
    fireEvent.click(await screen.findByRole('radio', { name: /node-dev/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    const group = await screen.findByRole('group', { name: 'Skills' });
    await within(group).findByText('run-tests');
    const fixed = within(group).getByRole('checkbox', { name: /run-tests/ }) as HTMLInputElement;
    await waitFor(() => expect(fixed.checked).toBe(true));
    expect(fixed.disabled).toBe(true);
    expect(within(group).getByText('(from the template)')).toBeTruthy();
    expect(within(group).getByText('Not approved yet')).toBeTruthy();
    const extra = within(group).getByRole('checkbox', {
      name: /minimal-change/,
    }) as HTMLInputElement;
    expect(extra.checked).toBe(false);
    fireEvent.click(extra);
    expect(extra.checked).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('run-tests, minimal-change')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Check and create' }));
    await waitFor(() => expect(calls.some((c) => c.channel === 'sandboxes:create')).toBe(true));
    const req = calls.find((c) => c.channel === 'sandboxes:create')!.input as { skills?: string[] };
    expect(req.skills).toEqual(['minimal-change']);
  });
});
