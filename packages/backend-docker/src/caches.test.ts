import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Docker from 'dockerode';
import type { CacheMount, PreparedImage, ResolvedTemplate, SandboxSpec } from '@abox/core';
import { cacheVolumeName } from './caches.js';
import type { DockerProvider } from './index.js';
import { makeSpec, makeTemplate } from './__tests__/helpers.js';
import {
  TEST_INSTANCE,
  TEST_SOCKET,
  dockerEnabled,
  newProvider,
  sweepTestObjects,
  Tracker,
} from './__tests__/harness.js';

describe('cacheVolumeName', () => {
  it('names the volume after the instance, the key and, for another uid, the uid', () => {
    expect(cacheVolumeName('inst', 'abcdef0123456789')).toBe('abox-cache-inst-abcdef0123456789');
    expect(cacheVolumeName(undefined, 'abcdef0123456789')).toBe('abox-cache-abcdef0123456789');
    expect(cacheVolumeName('inst', 'abcdef0123456789', 1001)).toBe(
      'abox-cache-inst-abcdef0123456789-u1001',
    );
  });
});

const raw = new Docker({ socketPath: TEST_SOCKET });

describe.skipIf(!dockerEnabled)('package cache volumes (real docker)', () => {
  const provider: DockerProvider = newProvider();
  const other: DockerProvider = newProvider({ instanceId: `${TEST_INSTANCE}x` });
  const track = new Tracker(provider);
  const tag = randomBytes(3).toString('hex');
  const template: ResolvedTemplate = makeTemplate({
    name: `abox-test-cache-${tag}`,
    // a directory the image already has, with content: a new cache volume starts as a copy of it
    build: [
      {
        name: 'seed',
        script: 'mkdir -p /opt/seed && echo seeded > /opt/seed/file && chmod -R a+rX /opt/seed',
      },
    ],
  });
  let prepared: PreparedImage;

  const mount = (name: string, path: string, k = randomBytes(8).toString('hex')): CacheMount => ({
    key: k,
    name,
    path,
    project: '/tmp/some/project',
    stack: template.name,
    owner: 'human',
  });
  const sb = (caches: CacheMount[], over: Partial<SandboxSpec> = {}): Promise<SandboxSpec> =>
    track.create({ ...makeSpec(template, prepared.ref), caches, ...over });
  const sh = (s: SandboxSpec, command: string) => provider.exec(s.id, { command });

  beforeAll(async () => {
    await sweepTestObjects();
    await provider.init();
    await other.init();
    prepared = await provider.prepare(template);
  }, 300_000);

  afterAll(async () => {
    await track.cleanup();
    await sweepTestObjects();
  }, 120_000);

  it('mounts a writable volume for the sandbox user, with its parents, and keeps it after the sandbox is gone', async () => {
    const store = mount('store', '/home/dev/.local/share/tool/store');
    const first = await sb([store, mount('plain', '/var/cache/plain')]);
    const r = await sh(
      first,
      'id -u; for d in /home/dev/.local /home/dev/.local/share /home/dev/.local/share/tool /home/dev/.local/share/tool/store /var/cache/plain; do stat -c "%U %a $d" "$d"; done; echo hello > /home/dev/.local/share/tool/store/f && echo /var/cache/plain/p > /dev/null',
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(
      [
        '1000',
        'dev 755 /home/dev/.local',
        'dev 755 /home/dev/.local/share',
        'dev 755 /home/dev/.local/share/tool',
        'dev 755 /home/dev/.local/share/tool/store',
        'dev 755 /var/cache/plain',
        '',
      ].join('\n'),
    );
    await provider.remove(first.id);

    // the volume is still there; a second sandbox with the same key sees the file
    const second = await sb([store]);
    expect((await sh(second, 'cat /home/dev/.local/share/tool/store/f')).stdout).toBe('hello\n');
    // a different key is a different, empty cache
    const third = await sb([mount('store', '/home/dev/.local/share/tool/store')]);
    expect((await sh(third, 'ls /home/dev/.local/share/tool/store | wc -l')).stdout).toBe('0\n');
  }, 120_000);

  it('labels the volume and the engine reports it as a cache of this instance only', async () => {
    const m = mount('labelled', '/var/cache/labelled');
    const s = await sb([m]);
    const info = await raw.getVolume(cacheVolumeName(TEST_INSTANCE, m.key)).inspect();
    expect(info.Labels).toMatchObject({
      'abox.managed': '1',
      'abox.role': 'cache',
      'abox.instance': TEST_INSTANCE,
      'abox.cache': m.key,
      'abox.cache-name': 'labelled',
      'abox.cache-project': '/tmp/some/project',
      'abox.cache-stack': template.name,
      'abox.cache-owner': 'human',
    });
    const mine = (await provider.listCaches()).find((c) => c.key === m.key)!;
    expect(mine).toMatchObject({
      name: 'labelled',
      project: '/tmp/some/project',
      stack: template.name,
      owner: 'human',
      inUse: true,
      sizeBytes: null,
      engine: 'docker',
    });
    expect(mine.createdAt).toBeGreaterThan(0);
    // another installation on the same engine neither sees, uses nor removes it
    expect((await other.listCaches()).map((c) => c.key)).not.toContain(m.key);
    expect(await other.removeCache(m.key)).toEqual({ removed: false });
    expect((await provider.listCaches()).map((c) => c.key)).toContain(m.key);
    await provider.remove(s.id);
  }, 120_000);

  it('measures sizes, refuses to remove a cache in use and removes it afterwards', async () => {
    const m = mount('sized', '/var/cache/sized');
    const s = await sb([m]);
    await sh(s, 'head -c 300000 /dev/zero > /var/cache/sized/blob');
    const sized = (await provider.listCaches({ size: true })).find((c) => c.key === m.key)!;
    expect(sized.sizeBytes).toBeGreaterThanOrEqual(300_000);
    expect(sized.inUse).toBe(true);
    await expect(provider.removeCache(m.key)).rejects.toMatchObject({ code: 'conflict' });
    await provider.remove(s.id);
    const idle = (await provider.listCaches()).find((c) => c.key === m.key)!;
    expect(idle.inUse).toBe(false);
    expect(await provider.removeCache(m.key)).toEqual({ removed: true });
    expect((await provider.listCaches()).map((c) => c.key)).not.toContain(m.key);
    expect(await provider.removeCache(m.key)).toEqual({ removed: false });
  }, 120_000);

  it('a new volume starts as a copy of what the image has at the path', async () => {
    const s = await sb([mount('seed', '/opt/seed')]);
    expect((await sh(s, 'cat /opt/seed/file')).stdout).toBe('seeded\n');
    expect((await sh(s, 'touch /opt/seed/mine && echo ok')).stdout).toBe('ok\n');
  }, 120_000);

  it('only the declared paths are mounted, read-write; the rest of the filesystem is unchanged', async () => {
    const m = mount('only', '/var/cache/only');
    const s = await sb([m]);
    const mounts = (
      await sh(s, 'cut -d" " -f2 /proc/mounts | grep -E "^/var/cache|^/home|^/workspace" || true')
    ).stdout;
    expect(mounts.split('\n').filter(Boolean)).toEqual(['/var/cache/only']);
    const c = await raw.getContainer(`abox-local-${s.id.split('/')[1]}`).inspect();
    const cache = c.Mounts.filter((x: { Type: string }) => x.Type === 'volume');
    expect(cache).toHaveLength(1);
    expect(cache[0]).toMatchObject({ Destination: '/var/cache/only', RW: true });
  }, 120_000);

  it.each([
    ['the workspace', [['w', '/workspace/cache']], /overlaps/],
    ['/tmp', [['t', '/tmp/cache']], /overlaps/],
    ['the abox directory', [['a', '/usr/local/share/abox/cache']], /overlaps/],
    [
      'another cache',
      [
        ['a', '/var/cache/x'],
        ['b', '/var/cache/x/y'],
      ],
      /overlaps/,
    ],
    ['a system path', [['p', '/proc/cache']], /proc/],
  ] as const)(
    'refuses a cache that overlaps %s',
    async (_what, list, re) => {
      const spec = {
        ...makeSpec(template, prepared.ref),
        caches: list.map(([n, p]) => mount(n, p)),
      };
      await expect(provider.create(spec)).rejects.toThrowError(re);
      expect((await provider.list()).map((i) => i.id)).not.toContain(spec.id);
    },
    60_000,
  );

  it('refuses a spec file inside a cache and leaves no cache volume behind from the failure', async () => {
    const m = mount('files', '/var/cache/files');
    const spec: SandboxSpec = {
      ...makeSpec(template, prepared.ref),
      caches: [m],
      files: [{ sandboxPath: '/var/cache/files/token', content: Buffer.from('x'), mode: 0o600 }],
    };
    await expect(provider.create(spec)).rejects.toThrowError(/never go into a cache/);
    expect((await provider.listCaches()).map((c) => c.key)).not.toContain(m.key);
  }, 60_000);

  it('refuses to mount a volume of that name that abox did not create', async () => {
    const m = mount('foreign', '/var/cache/foreign');
    const name = cacheVolumeName(TEST_INSTANCE, m.key);
    await raw.createVolume({ Name: name, Labels: { 'abox.dtest-foreign': '1' } });
    try {
      await expect(
        provider.create({ ...makeSpec(template, prepared.ref), caches: [m] }),
      ).rejects.toMatchObject({
        code: 'conflict',
      });
    } finally {
      await raw
        .getVolume(name)
        .remove()
        .catch(() => undefined);
    }
  }, 60_000);

  it('advertises the capability', () => {
    expect(provider.capabilities().caches).toBe(true);
  });
});
