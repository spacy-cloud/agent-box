import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { openDatabase } from '../state/db.js';
import { HostCache } from '../state/host-cache.js';
import { HostRegistry } from './registry.js';
import { createHostResolver } from './resolver.js';
import { auditSession, hostsEnvFromPaths } from './ssh-args.js';
import { testHost } from './test-host.js';
import { TunnelManager, openEngineTunnel } from './tunnel.js';
import type { HostProfile } from './model.js';

const root = mkdtempSync(join(tmpdir(), 'abox-res-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const env = hostsEnvFromPaths(
  { configDir: join(root, 'config'), runtimeDir: join(root, 'run') },
  { sshConfigFile: null, connectTimeoutSec: 2 },
);

function registry(): HostRegistry {
  return new HostRegistry({
    file: join(root, `hosts-${Math.random().toString(16).slice(2)}.yaml`),
  });
}

describe('createHostResolver (no network)', () => {
  it('resolves local without I/O, with zone defaults and backends', async () => {
    const resolve = createHostResolver(registry(), new TunnelManager(env));
    expect(await resolve('local')).toEqual({
      connection: { host: 'local', kind: 'local' },
      zone: 'workstation',
      minIsolation: 'none',
      limits: {},
      backends: ['docker', 'podman', 'process', 'python', 'vm'],
      requiresApproval: false,
    });
  });

  it('unknown host -> not_found', async () => {
    const resolve = createHostResolver(registry(), new TunnelManager(env));
    await expect(resolve('nope')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('reports configuration gaps before touching the network and records them in the cache', async () => {
    const reg = registry();
    reg.add({ id: 'bare', hostname: 'bare.example.org' });
    reg.add({ id: 'noengine', hostname: 'noengine.example.org', backends: ['podman'] });
    const cache = new HostCache({ db: openDatabase(':memory:'), now: () => 5000 });
    const resolve = createHostResolver(reg, new TunnelManager(env), { cache });
    await expect(resolve('bare')).rejects.toMatchObject({
      code: 'unsupported',
      message: /no backends/,
    });
    await expect(resolve('noengine')).rejects.toMatchObject({
      code: 'unsupported',
      message: /engine_socket/,
    });
    const entry = cache.get('bare')!;
    expect(entry.ok).toBe(false);
    expect((entry.info as { lastError: string }).lastError).toMatch(/no backends/);
  });

  it('an unreachable host is host_unreachable with a hint (no ssh login attempted)', async () => {
    const reg = registry();
    reg.add({
      id: 'dead',
      hostname: '127.0.0.1',
      port: 1,
      backends: ['docker'],
      engineSocket: '/run/user/1000/docker.sock',
    });
    const cache = new HostCache({ db: openDatabase(':memory:'), now: () => Date.now() });
    cache.put('dead', { lastOkAt: 1000 }, true, 1000);
    const resolve = createHostResolver(reg, new TunnelManager(env), { cache });
    const err = await resolve('dead').catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: 'host_unreachable',
      details: { host: 'dead', lastOkAt: 1000 },
    });
    expect(cache.get('dead')).toMatchObject({ ok: false, info: { lastOkAt: 1000 } });
  });
});

describe('testHost (no network)', () => {
  it('a closed port is reachable=false without throwing', async () => {
    const p: HostProfile = {
      id: 'dead',
      kind: 'ssh',
      hostname: '127.0.0.1',
      port: 1,
      zone: 'lab',
      backends: [],
      tags: [],
      favorite: false,
      portForwards: [],
    };
    const res = await testHost(p, env);
    expect(res).toMatchObject({ reachable: false, hostKey: 'unavailable', authOk: false });
    expect(res.error).toBeTruthy();
  });
});

describe('tunnel input validation', () => {
  const p: HostProfile = {
    id: 'x',
    kind: 'ssh',
    hostname: 'x.example.org',
    zone: 'lab',
    backends: ['docker'],
    tags: [],
    favorite: false,
    portForwards: [],
  };
  it('rejects unsafe remote and local socket paths before spawning ssh', async () => {
    await expect(openEngineTunnel(p, env, { remoteSocket: '/tmp/a;b' })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(openEngineTunnel(p, env, { remoteSocket: 'rel' })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(
      openEngineTunnel(p, env, {
        remoteSocket: '/run/e.sock',
        localSocket: `/tmp/${'x'.repeat(120)}.sock`,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input', message: /too long/ });
  });
});

describe('auditSession', () => {
  it('emits open and close with a duration, once', () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    let t = 1000;
    const e = {
      ...env,
      audit: (a: string, d: Record<string, unknown>) => calls.push([a, d]),
      now: () => t,
    };
    const s = auditSession({ id: 'v', kind: 'ssh', user: 'abox' } as HostProfile, e);
    t = 4500;
    s.end();
    s.end();
    expect(calls).toEqual([
      ['host.session.open', { host: 'v', user: 'abox' }],
      ['host.session.close', { host: 'v', user: 'abox', durationMs: 3500 }],
    ]);
  });
});
