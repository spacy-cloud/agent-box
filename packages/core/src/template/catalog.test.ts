import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AboxError } from '../errors.js';
import { TemplateCatalog, builtinTemplatesDir } from './catalog.js';
import { validateTemplate } from './validate.js';
import { renderToolPreset, TOOL_PRESETS } from './presets.js';

const tpl = (name: string, extra = '', base = 'base:\n  os: alpine:3.22\n') =>
  `apiVersion: 1\nname: ${name}\ndescription: Template ${name} used in catalog tests\nbackend: docker\n${base}${extra}`;

let root: string;
let project: string;
let userDir: string;
let builtin: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'abox-catalog-'));
  project = join(root, 'project');
  userDir = join(root, 'user');
  builtin = join(root, 'builtin');
  await mkdir(join(project, '.sandbox'), { recursive: true });
  await mkdir(userDir);
  await mkdir(builtin);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('builtin templates', () => {
  const catalog = new TemplateCatalog();

  it('builtinTemplatesDir exists and contains the standard templates', async () => {
    expect(existsSync(builtinTemplatesDir)).toBe(true);
    const names = (await catalog.list()).map((t) => t.name);
    expect(names).toEqual([
      'alpine-min',
      'host-shell',
      'node-dev',
      'py-dev',
      'py-offline',
      'rust-dev',
    ]);
  });

  it('all builtin templates parse, resolve and validate (static checks, strict description)', async () => {
    const { templates, problems } = await catalog.listAll();
    expect(problems).toEqual([]);
    for (const s of templates) {
      const t = await catalog.get(s.name);
      const r = validateTemplate(t, { strictDescription: true });
      expect(r.issues, s.name).toEqual([]);
      expect(t.labels['use-for'], s.name).toBeTruthy();
      expect(t.source.kind).toBe('builtin');
      expect(t.user.uid).toBe(1000);
      expect(t.resources.ttlMs).toBeGreaterThan(0);
    }
  });

  it('has the documented security shape', async () => {
    const byName = Object.fromEntries((await catalog.list()).map((t) => [t.name, t]));
    expect(byName['alpine-min']).toMatchObject({ backend: 'docker', networkMode: 'none' });
    expect(byName['py-offline']).toMatchObject({ networkMode: 'none' });
    expect(byName['node-dev']).toMatchObject({ networkMode: 'allowlist' });
    expect(byName['host-shell']).toMatchObject({
      backend: 'process',
      isolation: 'none',
      networkMode: 'open',
    });
    expect(byName['host-shell']!.description).toContain('NO isolation');
    const node = await catalog.get('node-dev');
    expect(node.network.allow).toEqual(
      expect.arrayContaining(['registry.npmjs.org', 'github.com']),
    );
    expect(node.tools.map((t) => t.name)).toEqual(['node', 'pnpm', 'git']);
    const hostShell = validateTemplate(await catalog.get('host-shell'));
    expect(hostShell.warnings.join('\n')).toContain('NOT isolated');
    expect(hostShell.warnings.join('\n')).toContain('"open"');
  });
});

describe('precedence and shadowing', () => {
  it('project > user > builtin, with shadowing reported', async () => {
    await writeFile(join(builtin, 'a.yaml'), tpl('shared', 'labels: { use-for: builtin }\n'));
    await writeFile(join(builtin, 'only-builtin.yml'), tpl('only-builtin'));
    await writeFile(join(userDir, 'u.yaml'), tpl('shared', 'labels: { use-for: user }\n'));
    await writeFile(
      join(project, '.sandbox', 'p.yaml'),
      tpl('shared', 'labels: { use-for: project }\n'),
    );
    await writeFile(join(project, '.sandbox', 'notes.txt'), 'ignored');
    const catalog = new TemplateCatalog({ projectDir: project, userDir, builtinDir: builtin });

    const list = await catalog.list();
    expect(list.map((t) => t.name)).toEqual(['only-builtin', 'shared']);
    const shared = list.find((t) => t.name === 'shared')!;
    expect(shared.source.kind).toBe('project');
    expect(shared.useFor).toBe('project');
    expect(shared.shadows.map((s) => s.kind)).toEqual(['user', 'builtin']);

    expect((await catalog.get('shared')).labels['use-for']).toBe('project');
    expect((await catalog.get('only-builtin')).source.kind).toBe('builtin');
  });

  it('unknown names are not_found and list the available ones', async () => {
    await writeFile(join(builtin, 'a.yaml'), tpl('a'));
    const catalog = new TemplateCatalog({ builtinDir: builtin });
    await expect(catalog.get('nope')).rejects.toMatchObject({
      code: 'not_found',
      hint: expect.stringContaining('a'),
    });
  });

  it('missing directories are fine', async () => {
    const catalog = new TemplateCatalog({
      projectDir: join(root, 'nonexistent'),
      userDir: join(root, 'nope'),
      builtinDir: builtin,
    });
    expect(await catalog.list()).toEqual([]);
  });

  it('broken files are reported as problems and do not hide the rest', async () => {
    await writeFile(join(builtin, 'good.yaml'), tpl('good'));
    await writeFile(join(builtin, 'bad.yaml'), 'apiVersion: 1\nname: bad\nbackend: nope\n');
    await writeFile(join(builtin, 'aaa-first.yaml'), tpl('good'));
    const { templates, problems } = await new TemplateCatalog({ builtinDir: builtin }).listAll();
    expect(templates.map((t) => t.name)).toEqual(['good']);
    expect(problems.map((p) => p.path.split('/').pop()).sort()).toEqual(['bad.yaml', 'good.yaml']);
    expect(problems.find((p) => p.path.endsWith('bad.yaml'))!.error.issues[0]).toMatchObject({
      path: 'backend',
      line: 3,
    });
  });

  it('ignores symlinks', async () => {
    await writeFile(join(root, 'outside.yaml'), tpl('linked'));
    await symlink(join(root, 'outside.yaml'), join(project, '.sandbox', 'link.yaml'));
    const catalog = new TemplateCatalog({ projectDir: project, builtinDir: builtin });
    expect(await catalog.list()).toEqual([]);
  });
});

describe('extends across locations', () => {
  it('a user template can extend the builtin of the same name', async () => {
    await writeFile(join(builtin, 'base.yaml'), tpl('node-dev', 'packages:\n  apk: [git]\n'));
    await writeFile(
      join(userDir, 'mine.yaml'),
      tpl('node-dev', 'extends: node-dev\npackages:\n  apk: [curl]\n', ''),
    );
    const catalog = new TemplateCatalog({ userDir, builtinDir: builtin });
    const t = await catalog.get('node-dev');
    expect(t.source.kind).toBe('user');
    expect(t.build[0]!.name).toBe('apk: git curl');
  });

  it('a project template extends user and builtin templates by name', async () => {
    await writeFile(join(builtin, 'b.yaml'), tpl('root-tpl', 'labels: { team: core }\n'));
    await writeFile(
      join(userDir, 'u.yaml'),
      tpl('mid', 'extends: root-tpl\nenv: { A: "1" }\n', ''),
    );
    await writeFile(
      join(project, '.sandbox', 'p.yaml'),
      tpl('leaf', 'extends: mid\nenv: { B: "2" }\n', ''),
    );
    const t = await new TemplateCatalog({ projectDir: project, userDir, builtinDir: builtin }).get(
      'leaf',
    );
    expect(t.env).toEqual({ A: '1', B: '2' });
    expect(t.labels.team).toBe('core');
    expect(t.base.os).toBe('alpine:3.22');
  });

  it('a user template cannot extend a project template', async () => {
    await writeFile(join(project, '.sandbox', 'p.yaml'), tpl('proj-only'));
    await writeFile(join(userDir, 'u.yaml'), tpl('mine', 'extends: proj-only\n', ''));
    const catalog = new TemplateCatalog({ projectDir: project, userDir, builtinDir: builtin });
    await expect(catalog.get('mine')).rejects.toThrow(/unknown template "proj-only"/);
  });

  it('cycles across files are detected', async () => {
    await writeFile(join(userDir, 'a.yaml'), tpl('a', 'extends: b\n', ''));
    await writeFile(join(userDir, 'b.yaml'), tpl('b', 'extends: a\n', ''));
    const err = await new TemplateCatalog({ userDir, builtinDir: builtin })
      .get('a')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AboxError);
    expect((err as AboxError).message).toContain('cycle');
  });

  it('loadFile resolves an arbitrary file with the catalog as parent source', async () => {
    await writeFile(join(builtin, 'b.yaml'), tpl('parent', 'env: { A: "1" }\n'));
    const file = join(root, 'adhoc.yaml');
    await writeFile(file, tpl('adhoc', 'extends: parent\n', ''));
    const t = await new TemplateCatalog({ builtinDir: builtin }).loadFile(file, 'project');
    expect(t.source).toEqual({ kind: 'project', path: file });
    expect(t.env.A).toBe('1');
    await expect(
      new TemplateCatalog().loadFile(join(root, 'missing.yaml'), 'user'),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('contentHash covers the raw file text of the leaf only', async () => {
    await writeFile(join(userDir, 'a.yaml'), tpl('a'));
    const c = new TemplateCatalog({ userDir, builtinDir: builtin });
    const h1 = (await c.get('a')).contentHash;
    await writeFile(join(userDir, 'a.yaml'), tpl('a') + '# comment\n');
    const t2 = await c.get('a');
    expect(t2.contentHash).not.toBe(h1);
  });
});

describe('tool presets catalog', () => {
  it('lists the documented presets', () => {
    expect(Object.keys(TOOL_PRESETS).sort()).toEqual([
      'docker-cli',
      'gh',
      'git',
      'go',
      'java',
      'node',
      'playwright',
      'pnpm',
      'python',
      'rust',
    ]);
  });

  it('every preset renders for debian and alpine or fails with a clear message', () => {
    const sample: Record<string, string> = {
      node: 'node@24',
      pnpm: 'pnpm@10',
      python: 'python@3.13',
      rust: 'rust',
      go: 'go@1.24',
      java: 'java@21',
      git: 'git',
      gh: 'gh',
      playwright: 'playwright',
      'docker-cli': 'docker-cli',
    };
    for (const [name, ref] of Object.entries(sample)) {
      const deb = renderToolPreset(ref, 'debian');
      expect(deb.step.script.startsWith('set -eu'), name).toBe(true);
      expect(deb.step.script.endsWith('\n')).toBe(true);
      expect(deb.tool.check.length).toBeGreaterThan(3);
      if (name === 'playwright') {
        expect(() => renderToolPreset(ref, 'alpine')).toThrow(/"playwright".*"alpine"/);
      } else {
        expect(renderToolPreset(ref, 'alpine').step.script, name).toContain('set -eu');
      }
      expect(() => renderToolPreset(ref, 'fedora'), name).toThrow(/"fedora"/);
    }
  });

  it('validates versions', () => {
    expect(() => renderToolPreset('node', 'debian')).toThrow(/needs a version/);
    expect(() => renderToolPreset('node@lts', 'debian')).toThrow(/invalid version/);
    expect(() => renderToolPreset('git@2', 'debian')).toThrow(/does not take a version/);
    expect(() => renderToolPreset('cobol@1', 'debian')).toThrow(/unknown tool preset/);
    expect(() => renderToolPreset('python@2.7', 'debian')).toThrow(/invalid version/);
    expect(renderToolPreset('rust', 'debian').step.script).toContain(
      "--default-toolchain 'stable'",
    );
  });

  it('never pipes downloads into a shell', () => {
    for (const ref of ['node@24', 'python@3.13', 'rust', 'go@1.24', 'docker-cli']) {
      for (const os of ['debian', 'alpine'] as const) {
        if (ref === 'docker-cli' && os === 'alpine') continue;
        const s = renderToolPreset(ref, os).step.script;
        expect(s, `${ref}/${os}`).not.toMatch(/\|\s*(ba)?sh\b/);
      }
    }
  });
});
