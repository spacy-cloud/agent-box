import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_POLICY_YAML, parsePolicy } from '@abox/core';
import type { Abox } from '@abox/core';
import { createSetupHandlers } from '../../src/main/setup';

let root: string;
let home: string;
let oldHome: string | undefined;
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'abox-app-setup-')));
  home = join(root, 'home');
  mkdirSync(join(home, 'lab', 'app'), { recursive: true });
  mkdirSync(join(home, 'lab', 'lib'), { recursive: true });
  mkdirSync(join(home, 'lab', '.hidden'), { recursive: true });
  mkdirSync(join(home, 'single', '.git'), { recursive: true });
  mkdirSync(join(home, '.secret-tools'), { recursive: true });
  mkdirSync(join(home, 'projects'), { recursive: true });
  writeFileSync(join(home, 'a-file.txt'), 'x');
  oldHome = process.env['HOME'];
  process.env['HOME'] = home; // os.homedir() follows HOME
});
afterAll(() => {
  if (oldHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = oldHome;
  rmSync(root, { recursive: true, force: true });
});

function build(opts: { roots?: string[]; contexts?: Record<string, { profile: string }> } = {}) {
  const policy = parsePolicy(DEFAULT_POLICY_YAML, { kind: 'default' });
  const view = {
    contexts: opts.contexts ?? {
      human: { profile: 'human' },
      'claude-code': { profile: 'default' },
      codex: { profile: 'default' },
    },
    profiles: {
      default: { workspace: { roots: opts.roots ?? ['~/projects'] } },
      other: { workspace: { roots: [] } },
    },
    policy: { source: 'default', path: null, contentHash: 'h'.repeat(64) },
  };
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  const abox = {
    showPolicy: vi.fn(() => Promise.resolve(view)),
    setupDetect: vi.fn((...args: unknown[]) => {
      calls.push({ fn: 'detect', args });
      return Promise.resolve([]);
    }),
    setupPlan: vi.fn((...args: unknown[]) => {
      calls.push({ fn: 'plan', args });
      return Promise.resolve({ digest: 'd'.repeat(64), steps: [], warnings: [], notes: [] });
    }),
    setupApply: vi.fn((...args: unknown[]) => {
      calls.push({ fn: 'apply', args });
      return Promise.resolve({ ok: true });
    }),
    suggestTemplate: vi.fn((_c: unknown, i: { path: string }) =>
      Promise.resolve({
        primary: i.path.endsWith('/app')
          ? { template: 'node-dev', basis: 'markers', files: ['package.json'], reason: '' }
          : i.path.endsWith('/lib')
            ? { template: 'node-dev', basis: 'markers', files: ['package.json'], reason: '' }
            : i.path.endsWith('/single')
              ? { template: 'proj', basis: 'project_template', files: [], reason: '' }
              : null,
      }),
    ),
  };
  void policy;
  return { handlers: createSetupHandlers(abox as unknown as Abox), abox, calls };
}

describe('setup:detect / plan / apply: the manager does the work, as the human', () => {
  it('plan and detect are plain human calls; apply carries the confirmation and the digest of the preview', async () => {
    const { handlers, calls } = build();
    await handlers['setup:detect']();
    await handlers['setup:plan']({ clients: ['claude-code', 'codex'], claudeCodeMethod: 'mcp' });
    await handlers['setup:apply']({
      clients: ['claude-code'],
      digest: 'd'.repeat(64),
      confirmed: true,
    });
    expect(calls[0]).toEqual({ fn: 'detect', args: [{ contextId: 'human' }] });
    expect(calls[1]).toEqual({
      fn: 'plan',
      args: [
        { contextId: 'human' },
        { clients: ['claude-code', 'codex'], claudeCodeMethod: 'mcp' },
      ],
    });
    expect(calls[2]).toEqual({
      fn: 'apply',
      args: [
        { contextId: 'human', humanConfirmed: true },
        { clients: ['claude-code'] },
        'd'.repeat(64),
      ],
    });
  });
});

describe('setup:roots', () => {
  it('proposes the new folder as ~/… and leaves covered and refused folders out', async () => {
    const { handlers } = build();
    const r = await handlers['setup:roots']({
      folders: [
        '~/lab',
        home, // the home directory itself
        join(home, '.secret-tools'), // hidden directory of the home directory
        join(home, 'missing'),
        join(home, 'a-file.txt'),
      ],
    });
    expect(r.profile).toBe('default');
    expect(r.usedBy).toEqual(['claude-code', 'codex']);
    expect(r.roots).toEqual(['~/projects']);
    const by = Object.fromEntries(r.folders.map((f) => [f.input, f]));
    expect(by['~/lab']).toMatchObject({
      status: 'new',
      entry: '~/lab',
      path: join(home, 'lab'),
    });
    expect(by[home]).toMatchObject({ status: 'refused' });
    expect(by[join(home, '.secret-tools')]).toMatchObject({ status: 'refused' });
    expect(by[join(home, 'missing')]).toMatchObject({ status: 'refused' });
    expect(by[join(home, 'a-file.txt')]).toMatchObject({ status: 'refused' });
    for (const bad of [home, join(home, '.secret-tools'), join(home, 'missing')]) {
      expect(by[bad]!.reason).toBeTruthy();
      expect(by[bad]!.entry).toBeNull();
    }
    expect(r.proposed).not.toBeNull();
    const roots = parsePolicy(r.proposed!, { kind: 'default' }).profiles['default']!.workspace
      .roots;
    expect(roots).toContain('~/lab');
    expect(roots).not.toContain(home);
    expect(r.baseHash).toBe('h'.repeat(64));
    expect(r.current).toBe(DEFAULT_POLICY_YAML);
  });

  it('a folder below an existing root is covered, and nothing is proposed for it', async () => {
    mkdirSync(join(home, 'projects', 'covered'), { recursive: true });
    const { handlers } = build();
    const r = await handlers['setup:roots']({
      folders: [join(home, 'projects', 'covered'), join(home, 'projects')],
    });
    expect(r.folders.map((f) => f.status)).toEqual(['covered', 'covered']);
    expect(r.folders[0]!.coveredBy).toBe('~/projects');
    expect(r.proposed).toBeNull();
  });

  it('warns when the folder itself looks like a project, and does not add a folder twice', async () => {
    const { handlers } = build();
    const r = await handlers['setup:roots']({
      folders: [join(home, 'single'), '~/single', '~/lab'],
    });
    expect(r.folders[0]).toMatchObject({ status: 'new', looksLikeProject: true });
    expect(r.folders[1]).toMatchObject({ status: 'covered' });
    expect(r.folders[2]).toMatchObject({ status: 'new', looksLikeProject: false });
    const roots = parsePolicy(r.proposed!, { kind: 'default' }).profiles['default']!.workspace
      .roots;
    expect(roots.filter((x) => x === '~/single')).toHaveLength(1);
  });

  it('a link to a folder is resolved to the folder', async () => {
    symlinkSync(join(home, 'lab'), join(home, 'lab-link'));
    const { handlers } = build({ roots: [] });
    const r = await handlers['setup:roots']({ folders: [join(home, 'lab-link')] });
    expect(r.folders[0]).toMatchObject({ path: join(home, 'lab'), entry: '~/lab' });
  });

  it('chooses the profile of claude-code, lets another one be named, and refuses an unknown one', async () => {
    const two = {
      contexts: {
        human: { profile: 'human' },
        'claude-code': { profile: 'other' },
        x: { profile: 'default' },
      },
    };
    const { handlers } = build(two);
    expect((await handlers['setup:roots']({ folders: [] })).profile).toBe('other');
    expect((await handlers['setup:roots']({ profile: 'default', folders: [] })).profile).toBe(
      'default',
    );
    await expect(handlers['setup:roots']({ profile: 'human', folders: [] })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('without any agent context there is no profile and no proposal', async () => {
    const { handlers } = build({ contexts: { human: { profile: 'human' } } });
    const r = await handlers['setup:roots']({ folders: ['~/lab'] });
    expect(r).toMatchObject({ profile: null, proposed: null, profiles: [] });
  });
});

describe('setup:scan', () => {
  it('counts the templates the projects below the folders point to; a project template is not offered', async () => {
    const { handlers, abox } = build();
    const r = await handlers['setup:scan']({ folders: ['~/lab', '~/single', '~/does-not-exist'] });
    expect(r.templates).toEqual([
      { name: 'node-dev', projects: 2, basis: 'markers', examples: ['app', 'lib'] },
    ]);
    // the folder itself and the visible folders directly below it, nothing hidden
    const asked = abox.suggestTemplate.mock.calls.map((c) => (c[1] as { path: string }).path);
    expect(asked).toContain(join(home, 'lab'));
    expect(asked).toContain(join(home, 'lab', 'app'));
    expect(asked.some((p) => p.includes('.hidden'))).toBe(false);
    expect(r.scanned).toBe(asked.length);
    expect(r.truncated).toBe(false);
  });

  it('a folder the manager refuses is skipped, not fatal', async () => {
    const { handlers, abox } = build();
    abox.suggestTemplate.mockRejectedValue(new Error('policy_denied'));
    expect(await handlers['setup:scan']({ folders: ['~/lab'] })).toMatchObject({ templates: [] });
  });
});
