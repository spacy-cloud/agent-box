import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupSandbox, makeTestSpec } from '@abox/contract-tests';
import {
  UV_VERSION,
  type PreparedImage,
  type ResolvedTemplate,
  type SandboxSpec,
} from '@abox/core';
import { createPythonProvider, type PythonProvider } from './index.js';
import {
  testLabels,
  docker,
  dockerEnabled,
  makeProject,
  pyTemplate,
  sweepTestObjects,
  type Fixture,
} from './__tests__/helpers.js';

// Container mode against a real engine: ABOX_TEST_DOCKER=1. Needs network (image build pulls uv and wheels).
const suite = dockerEnabled ? describe : describe.skip;

suite('python backend, container mode (docker)', { timeout: 240_000 }, () => {
  let provider: PythonProvider;
  const tmpDirs: string[] = [];
  const sandboxes: string[] = [];
  let locked: Fixture;
  let lockFree: Fixture;

  async function sandbox(
    template: ResolvedTemplate,
    image: PreparedImage,
    network: Partial<SandboxSpec['network']> = {},
  ): Promise<string> {
    const base = await makeTestSpec(provider, template, { image });
    const spec: SandboxSpec = { ...base, network: { ...base.network, ...network } };
    sandboxes.push(spec.id);
    await provider.create(spec);
    await provider.start(spec.id);
    return spec.id;
  }

  const sh = (id: string, command: string, timeoutMs = 120_000) =>
    provider.exec(id, { command, timeoutMs });

  beforeAll(async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'abox-python-test-'));
    tmpDirs.push(dataDir);
    provider = createPythonProvider(
      { host: 'local', kind: 'local' },
      { dataDir, docker: { extraLabels: testLabels('container'), stopTimeoutSec: 1 } },
    );
    await provider.init();
    locked = await makeProject({ lock: true });
    lockFree = await makeProject({ lock: false });
    tmpDirs.push(locked.dir, lockFree.dir);
  }, 120_000);

  afterAll(async () => {
    for (const id of sandboxes) await cleanupSandbox(provider, id);
    for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
    await sweepTestObjects('container');
  }, 120_000);

  describe('plain template', () => {
    const template = pyTemplate({ name: 'abox-test-py-plain' });
    let image: PreparedImage;
    let id: string;

    beforeAll(async () => {
      image = await provider.prepare(template);
      id = await sandbox(template, image);
    }, 300_000);

    it('prepare is cached by template hash', async () => {
      const again = await provider.prepare(template);
      expect(again.ref).toBe(image.ref);
      expect(again.cached).toBe(true);
      expect(again.templateHash).toBe(template.hash);
    });

    it('runs python and the pinned uv as a non-root user', async () => {
      expect((await sh(id, 'id -u')).stdout.trim()).not.toBe('0');
      expect((await sh(id, 'id -u')).exitCode).toBe(0);
      const py = await sh(id, 'python --version');
      expect(py.exitCode).toBe(0);
      expect(py.stdout + py.stderr).toMatch(/Python 3\.13\./);
      const uv = await sh(id, 'uv --version');
      expect(uv.exitCode).toBe(0);
      expect(uv.stdout).toContain(`uv ${UV_VERSION}`);
    });

    it('reports itself as python/container and lists only python sandboxes', async () => {
      const info = await provider.inspect(id);
      expect(info).toMatchObject({
        backend: 'python',
        isolation: 'container',
        template: template.name,
      });
      const all = await provider.list();
      expect(all.map((s) => s.id)).toContain(id);
      expect(all.every((s) => s.backend === 'python')).toBe(true);
      expect(provider.capabilities().isolation).toBe('container');
      expect(provider.capabilities().nonRootUser).toBe(true);
    });

    it('network none blocks uv pip install, network open allows it', async () => {
      const setup = 'uv venv /tmp/v --python 3.13 -q';
      const blocked = await sh(id, `${setup} && uv pip install --python /tmp/v requests`);
      expect(blocked.exitCode).not.toBe(0);
      expect(blocked.stderr).toMatch(/fetch|network|dns|connect|resolve|lookup/i);

      const open = await sandbox(template, image, { mode: 'open' });
      const ok = await sh(
        open,
        `${setup} && uv pip install --python /tmp/v six==1.17.0 && /tmp/v/bin/python -c "import six; print(six.__version__)"`,
      );
      expect(ok.exitCode, ok.stderr).toBe(0);
      expect(ok.stdout.trim()).toBe('1.17.0');
    });

    it('allowlist mode: PyPI reachable, other hosts denied', async ({ skip }) => {
      if (!provider.capabilities().networkModes.includes('allowlist')) return skip();
      const allowed = await sandbox(template, image, {
        mode: 'allowlist',
        allow: ['pypi.org', 'files.pythonhosted.org'],
      });
      const ok = await sh(
        allowed,
        'uv venv /tmp/v --python 3.13 -q && uv pip install --python /tmp/v six==1.17.0',
      );
      expect(ok.exitCode, ok.stderr).toBe(0);
      const denied = await sh(
        allowed,
        `python -c "import urllib.request,sys; urllib.request.urlopen('https://example.org', timeout=15)"`,
      );
      expect(denied.exitCode).not.toBe(0);
    });

    it('updateNetwork is delegated to the container provider (allowlist) and refused for none', async ({
      skip,
    }) => {
      if (!provider.capabilities().networkModes.includes('allowlist')) return skip();
      const net = (allow: string[]) => ({
        mode: 'allowlist' as const,
        allow,
        blockPrivate: true,
        privateExceptions: [],
        injections: [],
      });
      const al = await sandbox(template, image, { mode: 'allowlist', allow: ['pypi.org'] });
      const short = al.split('/')[1];
      const config = async (): Promise<{ allow: string[] }> =>
        JSON.parse(
          await docker(['exec', `abox-proxy-${short}`, 'cat', '/etc/abox-proxy/config.json']),
        ) as { allow: string[] };
      expect((await config()).allow).toEqual(['pypi.org']);
      await provider.updateNetwork(al, net(['pypi.org', 'example.org']));
      expect((await config()).allow).toEqual(['pypi.org', 'example.org']);
      expect((await provider.inspect(al)).state).toBe('running');
      expect((await sh(al, 'echo still-works')).stdout).toBe('still-works\n');
      // the mode cannot change, and a sandbox without rules says so
      await expect(provider.updateNetwork(al, { ...net([]), mode: 'open' })).rejects.toMatchObject({
        code: 'invalid_input',
      });
      await expect(provider.updateNetwork(id, net(['example.org']))).rejects.toMatchObject({
        code: 'unsupported',
      });
    });

    it('status reports the engine and uv', async () => {
      const s = await provider.status();
      expect(s.ok).toBe(true);
      expect(s.details.join('\n')).toContain(`uv ${UV_VERSION}`);
      expect(s.details.join('\n')).toMatch(/docker \d/);
      expect(s.details.join('\n')).not.toMatch(/python engine|python \d/);
    });

    it('gcImages with this template kept removes nothing of it', async () => {
      const removed = await provider.gcImages([template.hash]);
      expect(removed.filter((r) => r.includes('abox-test-py-plain'))).toEqual([]);
    });
  });

  describe('project with uv.lock (dependencies installed at prepare time)', () => {
    let template: ResolvedTemplate;
    let image: PreparedImage;

    beforeAll(async () => {
      if (!locked.locked) return;
      template = pyTemplate({
        name: 'abox-test-py-locked',
        python: { version: '3.13', project: locked.dir },
      });
      image = await provider.prepare(template);
    }, 300_000);

    it('has the locked dependencies without any network', async ({ skip }) => {
      if (!locked.locked) return skip();
      const id = await sandbox(template, image); // network none
      const r = await sh(id, 'command -v python && python -c "import six; print(six.__version__)"');
      expect(r.exitCode, r.stderr).toBe(0);
      expect(r.stdout).toContain('/opt/venv/bin/python');
      expect(r.stdout).toContain('1.17.0');
      expect((await sh(id, 'test -e /opt/venv/.abox-synced')).exitCode).toBe(0);
      // The package cache travels in the image: reinstalling works offline.
      const offline = await sh(
        id,
        'uv sync --offline --frozen --no-install-project --project /opt/abox/project',
      );
      expect(offline.exitCode, offline.stderr).toBe(0);
      expect((await sh(id, 'id -u')).stdout.trim()).not.toBe('0');
    });

    it('a changed lock file builds a new image', async ({ skip }) => {
      if (!locked.locked) return skip();
      const lock = join(locked.dir, 'uv.lock');
      const original = await readFile(lock);
      try {
        await writeFile(lock, Buffer.concat([original, Buffer.from('\n# touched\n')]));
        const next = await provider.prepare(template);
        expect(next.cached).toBe(false);
        expect(next.ref).not.toBe(image.ref);
        expect(next.templateHash).toBe(template.hash);
      } finally {
        await writeFile(lock, original);
      }
      expect((await provider.prepare(template)).ref).toBe(image.ref);
    }, 300_000);

    it('cache poisoning: a sandbox cannot change the cache (or venv) other sandboxes see', async ({
      skip,
    }) => {
      if (!locked.locked) return skip();
      const evil = await sandbox(template, image);
      const victim = await sandbox(template, image);

      // The cache is not a shared mount at all: no volumes or binds on the container.
      for (const id of [evil, victim]) {
        const ref = (await provider.inspect(id)).backendRef;
        const mounts = JSON.parse(
          await docker(['inspect', '--format', '{{json .Mounts}}', ref]),
        ) as unknown[];
        expect(mounts).toEqual([]);
      }

      const cacheDir = (await sh(evil, 'echo "$UV_CACHE_DIR"')).stdout.trim();
      expect(cacheDir).toBe('/home/agent/.cache/uv');
      const pkg = (await sh(evil, 'python -c "import six; print(six.__file__)"')).stdout.trim();
      const before = (await sh(victim, `sha256sum ${pkg}`)).stdout;

      // Precondition (the test is not vacuous): the sandbox user may write to its OWN cache and venv.
      const attack = await sh(
        evil,
        [
          `echo poisoned > ${cacheDir}/poison`,
          `find ${cacheDir} -type f -name '*.whl' -o -type f -name '*.py' | head -n 20 | while read f; do echo "# evil" >> "$f"; done`,
          `echo "raise RuntimeError('pwned')" >> ${pkg}`,
        ].join(' && '),
      );
      expect(attack.exitCode, attack.stderr).toBe(0);
      expect((await sh(evil, `python -c "import six"`)).exitCode).not.toBe(0);

      // ...and nothing of that is visible to a running neighbour or to a brand new sandbox.
      const fresh = await sandbox(template, image);
      for (const id of [victim, fresh]) {
        expect((await sh(id, `test ! -e ${cacheDir}/poison`)).exitCode).toBe(0);
        expect((await sh(id, `sha256sum ${pkg}`)).stdout).toBe(before);
        const ok = await sh(id, 'python -c "import six; print(six.__version__)"');
        expect(ok.exitCode, ok.stderr).toBe(0);
      }
    });
  });

  describe('project without uv.lock (dependencies resolved on first start)', () => {
    let template: ResolvedTemplate;
    let image: PreparedImage;

    beforeAll(async () => {
      template = pyTemplate({
        name: 'abox-test-py-lockfree',
        python: { version: '3.13', project: lockFree.dir },
      });
      image = await provider.prepare(template);
    }, 300_000);

    it('installs the dependencies on first start when the network allows it', async () => {
      const id = await sandbox(template, image, { mode: 'open' });
      const r = await sh(id, 'python -c "import six; print(six.__version__)"');
      expect(r.exitCode, r.stderr).toBe(0);
      expect(r.stdout.trim()).toBe('1.17.0');
      // Second start does not sync again.
      await provider.stop(id);
      await provider.start(id);
      expect((await sh(id, 'test -e /opt/venv/.abox-synced')).exitCode).toBe(0);
    });

    it('fails clearly on first start with network none, and leaves the sandbox stopped', async () => {
      const base = await makeTestSpec(provider, template, { image });
      sandboxes.push(base.id);
      await provider.create(base);
      await expect(provider.start(base.id)).rejects.toMatchObject({
        code: 'backend_error',
        hint: expect.stringContaining('uv.lock'),
      });
      expect((await provider.inspect(base.id)).state).toBe('stopped');
    });
  });

  it('rejects a template with its own Dockerfile and a missing project', async () => {
    await expect(
      provider.prepare(
        pyTemplate({ base: { dockerfile: '/nope/Dockerfile', osFamily: 'unknown' } }),
      ),
    ).rejects.toMatchObject({
      code: 'unsupported',
    });
    await expect(
      provider.prepare(
        pyTemplate({
          python: { version: '3.13', project: join(tmpdir(), 'abox-no-such-project') },
        }),
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });
});
