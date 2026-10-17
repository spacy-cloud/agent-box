import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupSandbox,
  defineProviderContract,
  makeTestSpec,
  makeTestTemplate,
} from '@abox/contract-tests';
import type { ResolvedTemplate, SandboxProvider, SandboxSpec } from '@abox/core';
import { VENV_MODE_WARNING, createPythonProvider, type PythonProvider } from './index.js';
import { hostPythonVersion, hostUv, makeProject } from './__tests__/helpers.js';

/**
 * Venv mode (isolation none): host uv + the process backend. No container engine involved; the
 * wrapped Docker provider points at a socket that does not exist, which also proves that venv
 * mode does not need one. Skipped, with the reason in the suite name, when host uv/python is missing.
 */
const uv = await hostUv();
const pyVersion = uv ? await hostPythonVersion() : undefined;
const missing = !uv
  ? 'host uv not found (venv mode needs it)'
  : !pyVersion
    ? 'host uv finds no local Python'
    : undefined;

const NO_ENGINE = { socketPath: '/nonexistent/abox-python-test.sock' };
const dirs: string[] = [];

async function newProvider(
  extra: { dataDir?: string; uvBinary?: string } = {},
): Promise<PythonProvider> {
  const dataDir = extra.dataDir ?? (await mkdtemp(join(tmpdir(), 'abox-python-venv-')));
  if (!extra.dataDir) dirs.push(dataDir);
  return createPythonProvider(
    { host: 'local', kind: 'local' },
    { dataDir, docker: NO_ENGINE, ...(extra.uvBinary ? { uvBinary: extra.uvBinary } : {}) },
  );
}

const venvTemplate = (over: Partial<ResolvedTemplate> = {}): ResolvedTemplate =>
  makeTestTemplate({
    name: 'abox-test-venv',
    backend: 'python',
    isolation: 'none',
    python: { version: pyVersion ?? '3.13' },
    network: { mode: 'open', allow: [] },
    ...over,
  });

afterAll(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/**
 * The provider is dual-mode; the contract describes one mode at a time. This view presents the
 * venv half: capabilities, isolation and status are those of venv mode, everything else is the
 * real provider.
 */
function venvView(p: PythonProvider): SandboxProvider {
  return new Proxy(p, {
    get(target, prop, receiver) {
      if (prop === 'capabilities') return () => target.venvCapabilities();
      if (prop === 'isolation') return 'none';
      if (prop === 'status') return () => target.venvStatus();
      const v = Reflect.get(target, prop, receiver) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as SandboxProvider;
}

defineProviderContract({
  name: 'python (venv mode)',
  skip: missing ?? false,
  timeoutMs: 120_000,
  createProvider: async () => venvView(await newProvider()),
  template: () => venvTemplate(),
  // The process backend can only offer network mode 'open'.
  spec: (base) => ({ ...base, network: { ...base.network, mode: 'open' } }),
});

describe.skipIf(missing !== undefined)('python backend, venv mode', { timeout: 120_000 }, () => {
  let provider: PythonProvider;
  const made: string[] = [];

  async function sandbox(
    template: ResolvedTemplate,
    overrides: Partial<SandboxSpec> = {},
  ): Promise<string> {
    const image = await provider.prepare(template);
    const base = await makeTestSpec(provider, template, { image });
    const spec: SandboxSpec = { ...base, network: { ...base.network, mode: 'open' }, ...overrides };
    made.push(spec.id);
    await provider.create(spec);
    await provider.start(spec.id);
    return spec.id;
  }

  beforeAll(async () => {
    provider = await newProvider();
  });
  afterAll(async () => {
    for (const id of made) await cleanupSandbox(provider, id);
  });

  it('creates a venv with the host uv; python and pip installs resolve to it', async () => {
    const id = await sandbox(venvTemplate());
    const r = await provider.exec(id, {
      command:
        'command -v python && python -c "import sys; print(sys.prefix != sys.base_prefix)" && echo "$VIRTUAL_ENV"',
    });
    expect(r.exitCode, r.stderr).toBe(0);
    const [py, isVenv, venvDir] = r.stdout.trim().split('\n');
    expect(isVenv).toBe('True');
    expect(py).toBe(`${venvDir}/bin/python`);
    const info = await provider.inspect(id);
    expect(info).toMatchObject({ backend: 'python', isolation: 'none' });
    expect(info.effective?.['mode']).toBe('venv');
    expect(String(info.effective?.['warning'])).toContain('NO security boundary');
    expect((await stat(venvDir!)).isDirectory()).toBe(true);
    expect((await provider.list()).map((s) => s.id)).toContain(id);
    // sandbox files are visible through the file API under the sandbox path
    expect((await provider.listDir(id, '/opt/venv')).map((e) => e.name)).toContain('pyvenv.cfg');
  });

  it('installs the dependencies of python.project from uv.lock into the venv', async ({ skip }) => {
    const fixture = await makeProject({ lock: true });
    dirs.push(fixture.dir);
    if (!fixture.locked) return skip();
    const id = await sandbox(
      venvTemplate({ python: { version: pyVersion!, project: fixture.dir } }),
    );
    const r = await provider.exec(id, {
      command: 'python -c "import six; print(six.__version__)"',
    });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe('1.17.0');
  });

  it('remove deletes the venv with the sandbox', async () => {
    const id = await sandbox(venvTemplate());
    const venv = (await provider.exec(id, { command: 'echo "$VIRTUAL_ENV"' })).stdout.trim();
    await provider.stop(id);
    await provider.remove(id);
    await expect(stat(venv)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(provider.inspect(id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('status carries the big venv-mode warning and the host uv version', async () => {
    const s = await provider.status();
    expect(s.ok).toBe(false); // no engine in this setup; venv mode is still reported
    expect(s.warnings.join('\n')).toContain(VENV_MODE_WARNING);
    expect(s.details.join('\n')).toMatch(/venv mode: available with host uv \d/);
    expect(await provider.venvStatus()).toMatchObject({ ok: true });
    expect(provider.venvCapabilities()).toMatchObject({
      isolation: 'none',
      networkModes: ['open'],
      nonRootUser: false,
    });
  });

  it('rejects what venv mode cannot deliver', async () => {
    const net = venvTemplate({ network: { mode: 'none', allow: [] } });
    await expect(provider.prepare(net)).rejects.toMatchObject({ code: 'unsupported' });
    const build = venvTemplate({ build: [{ name: 'apt: git', script: 'true' }] });
    await expect(provider.prepare(build)).rejects.toMatchObject({ code: 'unsupported' });
    const base = venvTemplate({ base: { os: 'python:3.13-slim-bookworm', osFamily: 'debian' } });
    await expect(provider.prepare(base)).rejects.toMatchObject({ code: 'unsupported' });
  });
});

describe('python backend, venv mode: unavailable', () => {
  it('reports backend_unavailable when host uv is missing', async () => {
    const p = await newProvider({ uvBinary: '/nonexistent/uv' });
    await expect(p.prepare(venvTemplate())).rejects.toMatchObject({ code: 'backend_unavailable' });
    const s = await p.status();
    expect(s.details.join('\n')).toContain('venv mode: unavailable, host uv');
  });

  it('is unsupported without a data directory', async () => {
    const p = createPythonProvider({ host: 'local', kind: 'local' }, { docker: NO_ENGINE });
    await expect(p.prepare(venvTemplate())).rejects.toMatchObject({ code: 'unsupported' });
    expect(p.venvCapabilities()).toBeUndefined();
    // container templates are not affected by this
    expect(p.capabilities().isolation).toBe('container');
  });
});
