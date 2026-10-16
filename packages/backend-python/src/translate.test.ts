import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { TemplateCatalog, UV_VERSION, type ResolvedTemplate } from '@abox/core';
import { loadProject } from './project.js';
import {
  projectStepScript,
  pythonImageVersion,
  translateTemplate,
  VENV_PATH,
} from './translate.js';
import { PINNED_UV_VERSION, UV_SHA256, uvInstallScript } from './uv.js';
import { pyTemplate } from './__tests__/helpers.js';

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function project(
  files: Record<string, string>,
  links: Record<string, string> = {},
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'abox-py-unit-'));
  dirs.push(dir);
  for (const [n, c] of Object.entries(files)) await writeFile(join(dir, n), c);
  for (const [n, target] of Object.entries(links)) await symlink(target, join(dir, n));
  return dir;
}

const PYPROJECT = '[project]\nname = "x"\nversion = "0.1"\nrequires-python = ">=3.13"\n';

describe('uv pin', () => {
  it('has embedded checksums for the uv version the core pins', () => {
    expect(PINNED_UV_VERSION).toBe(UV_VERSION);
    const sums = UV_SHA256[UV_VERSION];
    expect(sums, 'bump UV_SHA256 in uv.ts together with UV_VERSION in core').toBeDefined();
    expect(sums?.x86_64).toMatch(/^[0-9a-f]{64}$/);
    expect(sums?.aarch64).toMatch(/^[0-9a-f]{64}$/);
  });

  it('install script verifies the pinned digest and never pipes into a shell', () => {
    const s = uvInstallScript();
    expect(s).toContain(UV_SHA256[UV_VERSION]!.x86_64);
    expect(s).toContain('checksum mismatch');
    expect(s).not.toMatch(/\|\s*(ba)?sh\b/);
    expect(() => uvInstallScript('0.0.1')).toThrow(/no pinned checksums/);
  });
});

describe('translateTemplate', () => {
  it('defaults to python:<version>-slim-bookworm and installs uv first', () => {
    const t = pyTemplate({ base: { osFamily: 'unknown' } });
    const tr = translateTemplate(t);
    expect(tr.baseImage).toBe('python:3.13-slim-bookworm');
    expect(tr.dockerfile).toContain('FROM python:3.13-slim-bookworm');
    expect(tr.template.build[0]?.name).toMatch(/^uv /);
    expect(tr.template.build[0]?.script).toContain(UV_VERSION);
    expect(tr.template.base.osFamily).toBe('debian');
    expect(tr.template.backend).toBe('python');
    expect(tr.template.hash).toBe(t.hash);
    expect(tr.depsAtPrepare).toBe(false);
  });

  it('keeps the user build steps between uv and the project step', () => {
    const t = pyTemplate({
      python: { version: '3.13', project: '.' },
      build: [{ name: 'apt: git', script: 'echo apt' }],
    });
    const names = translateTemplate(t).template.build.map((s) => s.name);
    expect(names[0]).toMatch(/^uv /);
    expect(names[1]).toBe('apt: git');
    expect(names[2]).toMatch(/^python project/);
    expect(names).toHaveLength(3);
  });

  it('honours base.os; a python: image of another minor version is rejected', () => {
    const ok = translateTemplate(
      pyTemplate({
        python: { version: '3.12' },
        base: { os: 'python:3.12-alpine', osFamily: 'alpine' },
      }),
    );
    expect(ok.baseImage).toBe('python:3.12-alpine');
    expect(ok.template.base.osFamily).toBe('alpine');
    expect(() =>
      translateTemplate(
        pyTemplate({
          python: { version: '3.13' },
          base: { os: 'python:3.12-slim', osFamily: 'debian' },
        }),
      ),
    ).toThrow(/does not match the base image/);
  });

  it('uses the core python preset (uv + CPython) on a plain OS image', () => {
    const tr = translateTemplate(pyTemplate({ base: { os: 'ubuntu:24.04', osFamily: 'debian' } }));
    const names = tr.template.build.map((s) => s.name);
    expect(names[0]).toMatch(/prerequisites/);
    expect(tr.template.build.some((s) => s.script.includes('uv python install'))).toBe(true);
    expect(tr.template.env['UV_PYTHON_INSTALL_DIR']).toBe('/opt/uv/python');
  });

  it('rejects OS families it cannot install Python on, and its own Dockerfile', () => {
    expect(() =>
      translateTemplate(pyTemplate({ base: { os: 'fedora:42', osFamily: 'fedora' } })),
    ).toThrow(/cannot install Python/);
    expect(() =>
      translateTemplate(pyTemplate({ base: { dockerfile: './Dockerfile', osFamily: 'unknown' } })),
    ).toThrow(/base.dockerfile/);
    expect(() => translateTemplate(pyTemplate({ backend: 'docker' }))).toThrow(/not "python"/);
  });

  it('sets the venv environment only for templates with a project; template env wins', () => {
    const plain = translateTemplate(pyTemplate());
    expect(plain.template.env['VIRTUAL_ENV']).toBeUndefined();
    const withProject = translateTemplate(
      pyTemplate({ python: { version: '3.13', project: '.' }, env: { UV_CACHE_DIR: '/tmp/c' } }),
    );
    expect(withProject.template.env['VIRTUAL_ENV']).toBe(VENV_PATH);
    expect(withProject.template.env['PATH']?.startsWith(`${VENV_PATH}/bin:`)).toBe(true);
    expect(withProject.template.env['UV_CACHE_DIR']).toBe('/tmp/c');
  });

  it('puts the lock file into the build context and the cache key; installs deps at prepare only with a lock', async () => {
    const t = pyTemplate({ python: { version: '3.13', project: '.' } });
    const dir = await project({ 'pyproject.toml': PYPROJECT, 'uv.lock': 'version = 1\n' });
    const locked = translateTemplate(
      t,
      await loadProject({ ...t, python: { version: '3.13', project: dir } }),
    );
    expect(locked.depsAtPrepare).toBe(true);
    expect(locked.contextFiles.map((f) => f.name)).toEqual(['pyproject.toml', 'uv.lock']);
    expect(locked.dockerfile).toContain('COPY pyproject.toml uv.lock /opt/abox/project/');
    expect(locked.template.build.at(-1)?.script).toContain('uv sync --frozen --no-install-project');

    const dir2 = await project({
      'pyproject.toml': PYPROJECT,
      'uv.lock': 'version = 1\n# changed\n',
    });
    const changed = translateTemplate(
      t,
      await loadProject({ ...t, python: { version: '3.13', project: dir2 } }),
    );
    expect(changed.dockerfile).not.toBe(locked.dockerfile); // new lock => new image cache key

    const dir3 = await project({ 'pyproject.toml': PYPROJECT });
    const lockFree = translateTemplate(
      t,
      await loadProject({ ...t, python: { version: '3.13', project: dir3 } }),
    );
    expect(lockFree.depsAtPrepare).toBe(false);
    expect(lockFree.dockerfile).toContain('COPY pyproject.toml /opt/abox/project/');
    expect(lockFree.template.build.at(-1)?.script).not.toContain('uv sync');
  });

  it('is deterministic', () => {
    const t = pyTemplate({ python: { version: '3.13', project: '.' } });
    expect(translateTemplate(t)).toEqual(translateTemplate(t));
  });

  it('gives the sandbox user ownership of everything it may modify', () => {
    const s = projectStepScript(
      { user: { name: 'agent', uid: 1000, sudo: false }, python: { version: '3.13' } },
      true,
    );
    expect(s).toContain("chown -R 1000:1000 '/opt/venv' /opt/abox '/home/agent/.cache'");
    expect(s).toContain("UV_CACHE_DIR='/home/agent/.cache/uv'");
  });
});

describe('pythonImageVersion', () => {
  it('reads python: tags', () => {
    expect(pythonImageVersion('python:3.13-slim-bookworm')).toBe('3.13');
    expect(pythonImageVersion('docker.io/library/python:3.12.4')).toBe('3.12');
    expect(pythonImageVersion('ubuntu:24.04')).toBeUndefined();
    expect(pythonImageVersion(undefined)).toBeUndefined();
  });
});

describe('loadProject', () => {
  const t = (p: string): ResolvedTemplate =>
    pyTemplate({ python: { version: '3.13', project: p } });

  it('is undefined without python.project', async () => {
    expect(await loadProject(pyTemplate())).toBeUndefined();
  });

  it('requires pyproject.toml', async () => {
    const dir = await project({ 'uv.lock': 'x' });
    await expect(loadProject(t(dir))).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('resolves relative paths against the template file', async () => {
    const dir = await project({ 'pyproject.toml': PYPROJECT });
    await mkdir(join(dir, 'tpl'));
    const tpl = { ...t('..'), source: { kind: 'user' as const, path: join(dir, 'tpl', 'x.yaml') } };
    const p = await loadProject(tpl);
    expect(p?.dir).toBe(dir);
    expect(p?.lock).toBeUndefined();
  });

  it('refuses symlinked project files', async () => {
    const outside = await project({ secret: 'host secret' });
    const dir = await project(
      { 'pyproject.toml': PYPROJECT },
      { 'uv.lock': join(outside, 'secret') },
    );
    await expect(loadProject(t(dir))).rejects.toThrow(/regular file/);
  });
});

describe('builtin py-uv template', () => {
  it('resolves for backend python and translates', async () => {
    const tpl = await new TemplateCatalog().get('py-uv');
    expect(tpl).toMatchObject({
      backend: 'python',
      isolation: 'container',
      python: { version: '3.13' },
    });
    expect(tpl.network.mode).toBe('allowlist');
    const tr = translateTemplate(tpl);
    expect(tr.baseImage).toBe('python:3.13-slim-bookworm');
  });
});
