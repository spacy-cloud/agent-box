import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestSpec, makeTestTemplate } from '@abox/contract-tests';
import type { ResolvedTemplate, SandboxSpec } from '@abox/core';
import { buildQcow2Overlay, readQcow2Header } from './qcow2.js';
import { createVmProvider, vmProviderFactory, type VmProvider } from './provider.js';
import { PREPARE_RECIPE_VERSION } from './seed.js';

/**
 * Provider tests that need neither KVM nor QEMU: the prepared image is fabricated, sandboxes are
 * only created (never started). Booting is covered by the guarded integration tests.
 */

let dataDir: string;
let cacheDir: string;
let p: VmProvider;
let template: ResolvedTemplate;

async function fakePreparedImage(
  t: ResolvedTemplate,
  buildId = 'b1',
  recipe: number = PREPARE_RECIPE_VERSION,
): Promise<string> {
  const dir = join(cacheDir, 'prepared', t.hash, buildId);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'disk.qcow2'),
    buildQcow2Overlay({ backingFile: '/nonexistent/base.qcow2', virtualSize: 10 * 1024 ** 3 }),
  );
  await writeFile(
    join(dir, 'meta.json'),
    JSON.stringify({
      version: 1,
      recipe,
      base: {
        id: 'debian-12',
        pin: `debian-12@sha512:${'a'.repeat(128)}`,
        path: '/nonexistent/base.qcow2',
      },
    }),
  );
  await writeFile(join(cacheDir, 'prepared', t.hash, 'current'), `${buildId}\n`);
  return join(dir, 'disk.qcow2');
}

async function mk(over: Partial<SandboxSpec> = {}): Promise<SandboxSpec> {
  const image = await p.prepare(template);
  return makeTestSpec(p, template, { image, ...over });
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'abox-vmu-d-'));
  cacheDir = await mkdtemp(join(tmpdir(), 'abox-vmu-c-'));
  p = createVmProvider({ host: 'local', kind: 'local' }, { dataDir, cacheDir });
  template = makeTestTemplate({
    backend: 'vm',
    isolation: 'vm',
    base: { os: 'debian-12', osFamily: 'debian' },
  });
  await fakePreparedImage(template);
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(cacheDir, { recursive: true, force: true });
});

describe('capabilities', () => {
  it('describes the VM backend honestly', () => {
    const c = p.capabilities();
    expect(c.isolation).toBe('vm');
    expect(p.kind).toBe('vm');
    expect(p.isolation).toBe('vm');
    expect(c.networkModes).toEqual(['none', 'allowlist', 'open']);
    expect(c.networkFilter).toBe(true);
    expect(c.workspaceDelivery).toEqual(['none', 'copy']); // no shared folders: they would weaken the VM boundary
    expect(c.mounts).toBe(false);
    expect(c.nonRootUser).toBe(true);
    expect(c.osFamilies).toEqual(['debian']);
    expect(c.secretInjection).toEqual(['proxy', 'env', 'file']);
    expect(c.remote).toBe(false);
    expect(c.snapshots).toBe(true);
    expect(typeof p.snapshot).toBe('function');
    expect(c.tty).toBe(true);
    expect(c.limits).toEqual({ cpus: true, memory: true, pids: true, disk: true });
  });

  it('the factory builds a provider from the host connection', () => {
    const f = vmProviderFactory({ host: 'local', kind: 'local', dataDir });
    expect(f.kind).toBe('vm');
    expect(() => vmProviderFactory({ host: 'local', kind: 'local' })).toThrowError(
      /data directory/,
    );
    expect(() => vmProviderFactory({ host: 'vps', kind: 'ssh', dataDir })).toThrowError(
      /local host only/,
    );
  });
});

describe('prepare (cache)', () => {
  it('returns the cached image with the pinned base', async () => {
    const img = await p.prepare(template);
    expect(img.cached).toBe(true);
    expect(img.templateHash).toBe(template.hash);
    expect(img.ref).toBe(join(cacheDir, 'prepared', template.hash, 'b1', 'disk.qcow2'));
    expect(img.pinnedBase).toBe(`debian-12@sha512:${'a'.repeat(128)}`);
  });

  it('ignores images built by an older recipe version', async () => {
    const other = makeTestTemplate({
      backend: 'vm',
      isolation: 'vm',
      base: { os: 'debian-12', osFamily: 'debian' },
      build: [{ name: 'x', script: 'true' }],
    });
    await fakePreparedImage(other, 'b1', PREPARE_RECIPE_VERSION - 1);
    // not cached any more: the call would build (we only check that it does not claim a cache hit)
    const abort = new AbortController();
    abort.abort();
    await expect(p.prepare(other, { signal: abort.signal })).rejects.toThrow();
  });

  it('rejects what the VM backend can not build', async () => {
    const bad = (over: Partial<ResolvedTemplate>): Promise<unknown> =>
      p.prepare({
        ...makeTestTemplate({
          backend: 'vm',
          isolation: 'vm',
          base: { os: 'debian-12', osFamily: 'debian' },
        }),
        hash: 'h'.repeat(8),
        ...over,
      });
    await expect(bad({ backend: 'docker' })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(bad({ base: { os: 'alpine:3.20', osFamily: 'debian' } })).rejects.toMatchObject({
      code: 'unsupported',
    });
    await expect(bad({ base: { os: 'debian-12', osFamily: 'alpine' } })).rejects.toMatchObject({
      code: 'unsupported',
    });
    await expect(
      bad({ base: { dockerfile: 'Dockerfile', osFamily: 'debian' } }),
    ).rejects.toMatchObject({ code: 'unsupported' });
    await expect(
      bad({ vm: { image: 'debian-12', cloudInit: 'user-data.yaml' } }),
    ).rejects.toMatchObject({ code: 'unsupported' });
    await expect(bad({ user: { name: 'root', uid: 0, sudo: false } })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(bad({ hash: '../etc' })).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('gcImages removes unreferenced images but keeps the kept one and those used by sandboxes', async () => {
    const other = makeTestTemplate({
      backend: 'vm',
      isolation: 'vm',
      base: { os: 'debian-12', osFamily: 'debian' },
      build: [{ name: 'x', script: 'true' }],
    });
    const otherRef = await fakePreparedImage(other);
    const third = makeTestTemplate({
      backend: 'vm',
      isolation: 'vm',
      base: { os: 'debian-12', osFamily: 'debian' },
      build: [{ name: 'y', script: 'true' }],
    });
    const thirdRef = await fakePreparedImage(third);
    const used = await makeTestSpec(p, third, {
      image: { ref: thirdRef, templateHash: third.hash, cached: true },
    });
    await p.create(used);
    const removed = await p.gcImages([template.hash]);
    expect(removed).toEqual([otherRef]);
    expect((await p.prepare(template)).cached).toBe(true);
    await expect(stat(thirdRef)).resolves.toBeDefined(); // a sandbox still needs it as backing file
    await p.remove(used.id);
    expect(await p.gcImages([template.hash])).toEqual([thirdRef]);
    expect(await readdir(join(cacheDir, 'prepared'))).toEqual([template.hash]);
  });
});

describe('gcImages and concurrent builds', () => {
  it('leaves a template alone while a build holds its lock, and removes crashed build leftovers', async () => {
    const busy = makeTestTemplate({
      backend: 'vm',
      isolation: 'vm',
      base: { os: 'debian-12', osFamily: 'debian' },
      build: [{ name: 'busy', script: 'true' }],
    });
    const busyDisk = await fakePreparedImage(busy);
    const work = join(cacheDir, 'prepared', busy.hash, '.build-1234');
    await mkdir(work, { recursive: true });
    await writeFile(join(work, 'disk.qcow2'), 'half written');
    // the lock of a live builder: owned by this (alive) process
    const lock = join(cacheDir, 'locks', `prepare-${busy.hash}`);
    await mkdir(lock, { recursive: true });
    await writeFile(join(lock, 'pid'), String(process.pid));
    expect(await p.gcImages([template.hash])).toEqual([]);
    await expect(stat(busyDisk)).resolves.toBeDefined();
    await expect(stat(work)).resolves.toBeDefined();
    // once the builder is gone (stale lock of a dead pid), the template is collectable again
    await writeFile(join(lock, 'pid'), '2147483646');
    expect(await p.gcImages([template.hash])).toEqual([busyDisk]);
    await expect(stat(work)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes .build leftovers of crashed builds', async () => {
    const old = join(cacheDir, 'prepared', template.hash, '.build-old');
    await mkdir(old, { recursive: true });
    await p.gcImages([template.hash]);
    await expect(stat(old)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await p.prepare(template)).cached).toBe(true);
  });
});

describe('start failures', () => {
  async function fakeQemu(script: string): Promise<string> {
    const f = join(dataDir, 'fake-qemu.sh');
    await writeFile(f, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    return f;
  }

  it('reports the QEMU error, kills what it started and leaves the sandbox startable', async () => {
    const q = await fakeQemu(
      'echo "Could not access KVM kernel module: No such file or directory" >&2; exit 1',
    );
    const broken = createVmProvider(
      { host: 'local', kind: 'local' },
      { dataDir, cacheDir, qemuBinary: q, startTimeoutMs: 20_000 },
    );
    const spec = await mk();
    await broken.create(spec);
    const err = await broken.start(spec.id).catch((e: unknown) => e);
    expect((err as { code: string }).code).toBe('backend_error');
    expect((err as Error).message).toMatch(/QEMU exited during startup/);
    expect((err as Error).message).toMatch(/Could not access KVM/);
    expect((await broken.inspect(spec.id)).state).toBe('created');
    // nothing left running or lying around
    const runDir = join(
      (broken as unknown as { layout: { runRoot: string } }).layout.runRoot,
      spec.id.split('/')[1] as string,
    );
    expect((await readdir(runDir).catch(() => [])).filter((n) => n.endsWith('.sock'))).toEqual([]);
    await expect(
      readFile(join(dataDir, 'vm', 'sandboxes', spec.id.split('/')[1] as string, 'qemu.pid')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('a guest that never answers makes start fail after the timeout and kills the VM', async () => {
    const q = await fakeQemu('exec sleep 60');
    const slow = createVmProvider(
      { host: 'local', kind: 'local' },
      { dataDir, cacheDir, qemuBinary: q, startTimeoutMs: 1500 },
    );
    const spec = await mk();
    await slow.create(spec);
    const err = await slow.start(spec.id).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/guest agent did not answer/);
    expect((await slow.inspect(spec.id)).state).toBe('created');
  });

  it('a missing QEMU binary is backend_unavailable with an install hint', async () => {
    const none = createVmProvider(
      { host: 'local', kind: 'local' },
      { dataDir, cacheDir, qemuBinary: '/nonexistent/qemu' },
    );
    const spec = await mk();
    await none.create(spec);
    const err = await none.start(spec.id).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/exited during startup|could not|ENOENT|127/);
    const st = await none.status();
    expect(st.ok).toBe(false);
  });
});

describe('create (no VM started)', () => {
  it('writes an overlay on the prepared image, keeps secrets in 0600 files and shows up in list/inspect', async () => {
    const spec = await mk({
      env: { SECRET_TOKEN: 'sekret-value' },
      files: [
        { sandboxPath: '/home/agent/.token', content: Buffer.from('file-secret'), mode: 0o600 },
      ],
      labels: { 'ct.k': 'v' },
      resources: {
        ...template.resources,
        cpus: 2.5,
        memoryBytes: 700 * 1024 * 1024,
        diskBytes: 20 * 1024 ** 3,
      },
    });
    const info = await p.create(spec);
    expect(info.state).toBe('created');
    expect(info.backend).toBe('vm');
    expect(info.isolation).toBe('vm');
    expect(info.effective).toMatchObject({
      cpus: 3,
      memoryMiB: 700,
      diskBytes: 20 * 1024 ** 3,
      networkMode: 'none',
    });
    const short = spec.id.split('/')[1] as string;
    const sdir = join(dataDir, 'vm', 'sandboxes', short);
    const header = await readQcow2Header(join(sdir, 'disk.qcow2'));
    expect(header.backingFile).toBe(join(cacheDir, 'prepared', template.hash, 'b1', 'disk.qcow2'));
    expect(header.virtualSize).toBe(20 * 1024 ** 3);
    for (const f of ['env.json', 'net.json', 'meta.json'])
      expect((await stat(join(sdir, f))).mode & 0o077).toBe(0);
    expect((await stat(sdir)).mode & 0o077).toBe(0);
    expect((await stat(join(sdir, 'init', 'files.json'))).mode & 0o077).toBe(0);
    // no secret value in what list()/inspect() expose
    const shown = JSON.stringify([...(await p.list()), await p.inspect(spec.id)]);
    expect(shown).not.toContain('sekret-value');
    expect(shown).not.toContain('file-secret');
    expect(await readFile(join(sdir, 'meta.json'), 'utf8')).not.toContain('sekret-value');
    expect((await p.list({ owner: spec.owner })).map((i) => i.id)).toEqual([spec.id]);
  });

  it('is atomic: invalid specs are rejected and leave nothing behind', async () => {
    const cases: Array<[string, Partial<SandboxSpec>, string]> = [
      [
        'bind',
        {
          workspace: { kind: 'bind', hostPath: tmpdir(), sandboxPath: '/workspace', access: 'rw' },
        },
        'unsupported',
      ],
      [
        'mounts',
        { mounts: [{ hostPath: tmpdir(), sandboxPath: '/mnt/x', access: 'ro' }] },
        'unsupported',
      ],
      [
        'missing copy source',
        {
          workspace: {
            kind: 'copy',
            hostPath: join(tmpdir(), 'abox-does-not-exist-xyz'),
            sandboxPath: '/workspace',
          },
        },
        'not_found',
      ],
      [
        'injection without allowlist',
        {
          network: {
            mode: 'open',
            allow: [],
            blockPrivate: true,
            privateExceptions: [],
            injections: [{ host: 'a.example', header: 'X', value: 'v' }],
          },
        },
        'invalid_input',
      ],
      ['root user', { user: { name: 'root', uid: 0, sudo: false } }, 'invalid_input'],
      ['bad env name', { env: { 'A B': 'x' } }, 'invalid_input'],
      [
        'foreign image',
        { image: { ref: '/etc/passwd', templateHash: 'x', cached: true } },
        'invalid_input',
      ],
      [
        'vanished image',
        {
          image: {
            ref: join(cacheDir, 'prepared', 'gone', 'b1', 'disk.qcow2'),
            templateHash: 'x',
            cached: true,
          },
        },
        'not_found',
      ],
      ['bad id', { id: 'local/../escape' }, 'invalid_input'],
      ['foreign host', { id: 'otherhost/abc' }, 'invalid_input'],
    ];
    for (const [name, over, code] of cases) {
      const spec = await mk(over);
      await expect(p.create(spec), name).rejects.toMatchObject({ code });
      expect(
        (await p.list()).map((i) => i.id),
        name,
      ).not.toContain(spec.id);
    }
    expect(await readdir(join(dataDir, 'vm', 'sandboxes'))).toEqual([]);
  });

  it('rejects a duplicate id with conflict and keeps the first sandbox', async () => {
    const spec = await mk();
    await p.create(spec);
    await expect(p.create(spec)).rejects.toMatchObject({ code: 'conflict' });
    expect((await p.inspect(spec.id)).state).toBe('created');
  });

  it('stages the workspace as a tar snapshot at create time (decoupled from later host changes)', async () => {
    const src = await mkdtemp(join(tmpdir(), 'abox-vmu-ws-'));
    try {
      await mkdir(join(src, 'node_modules'));
      await writeFile(join(src, 'a.txt'), 'a');
      await writeFile(join(src, 'node_modules', 'x.js'), 'x');
      const spec = await mk({
        workspace: {
          kind: 'copy',
          hostPath: src,
          sandboxPath: '/workspace',
          exclude: ['node_modules'],
        },
      });
      await p.create(spec);
      await rm(join(src, 'a.txt'));
      const tar = await readFile(
        join(dataDir, 'vm', 'sandboxes', spec.id.split('/')[1] as string, 'init', 'workspace.tar'),
      );
      expect(tar.includes(Buffer.from('./a.txt'))).toBe(true);
      expect(tar.includes(Buffer.from('node_modules'))).toBe(false);
    } finally {
      await rm(src, { recursive: true, force: true });
    }
  });

  it('reports expiry, filters, and removes idempotently', async () => {
    const live = await mk({ owner: 'agent:u1' });
    const dead = await mk({ owner: 'agent:u1', expiresAt: Date.now() - 1000 });
    await p.create(live);
    await p.create(dead);
    expect((await p.inspect(dead.id)).state).toBe('expired');
    expect((await p.list({ state: 'expired' })).map((i) => i.id)).toEqual([dead.id]);
    expect((await p.list({ owner: 'agent:u1', state: 'created' })).map((i) => i.id)).toEqual([
      live.id,
    ]);
    expect(await p.list({ template: 'nope' })).toEqual([]);
    await p.remove(live.id);
    await p.remove(live.id);
    await p.remove('local/never-existed');
    await p.remove('bad host/..');
    expect((await p.list()).map((i) => i.id)).toEqual([dead.id]);
    await expect(p.start(dead.id)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('unknown sandboxes are not_found, not running ones are a conflict', async () => {
    const ghost = 'local/ghost123';
    await expect(p.inspect(ghost)).rejects.toMatchObject({ code: 'not_found' });
    await expect(p.start(ghost)).rejects.toMatchObject({ code: 'not_found' });
    await expect(p.exec(ghost, { argv: ['true'] })).rejects.toMatchObject({ code: 'not_found' });
    await expect(p.snapshot(ghost, 'x')).rejects.toMatchObject({ code: 'not_found' });
    const spec = await mk();
    await p.create(spec);
    await expect(p.exec(spec.id, { argv: ['true'] })).rejects.toMatchObject({ code: 'conflict' });
    await expect(p.readFile(spec.id, '/etc/hostname', 10)).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(p.snapshot(spec.id, 'x')).rejects.toMatchObject({ code: 'conflict' });
    await expect(p.snapshot(spec.id, 'bad name!')).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(p.restore(spec.id, 'nope')).rejects.toMatchObject({ code: 'not_found' });
    expect(await p.networkEvents(spec.id)).toEqual([]);
    await p.stop(spec.id); // stopping a sandbox that never ran is fine
    expect((await p.inspect(spec.id)).state).toBe('stopped');
  });
});
