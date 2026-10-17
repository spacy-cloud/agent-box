import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../state/db.js';
import { HostCache } from '../state/host-cache.js';
import { HostRegistry } from './registry.js';
import { createHostResolver } from './resolver.js';
import { hostsEnvFromPaths } from './ssh-args.js';
import { TunnelManager } from './tunnel.js';

/**
 * Roadmap 4b.8: a host with its own services is only used through a rootless engine of a
 * dedicated user. The engine is a fake behind a fake ssh (__tests__/fake-ssh.mjs) that answers
 * `/info` like Docker/Podman do; no sshd, no docker.
 */
const FAKE_SSH = fileURLToPath(new URL('./__tests__/fake-ssh.mjs', import.meta.url));
const ROOTLESS =
  '{"SecurityOptions":["name=seccomp","name=rootless"],"Runtimes":{"runc":{},"runsc":{}}}';
const ROOTFUL = '{"SecurityOptions":["name=seccomp,profile=builtin"],"Runtimes":{"runc":{}}}';
const USER_SOCK = '/run/user/1001/podman/podman.sock';

let root: string;
let tunnels: TunnelManager;
let cache: HostCache;
let registry: HostRegistry;
let log: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'abox-reng-'));
  log = join(root, 'ssh.log');
  process.env['FAKE_SSH_LOG'] = log;
  const env = hostsEnvFromPaths(
    { configDir: join(root, 'config'), runtimeDir: join(root, 'run') },
    { sshConfigFile: null, sshBinary: FAKE_SSH, connectTimeoutSec: 2 },
  );
  tunnels = new TunnelManager(env);
  cache = new HostCache({ db: openDatabase(':memory:'), now: () => 1000 });
  registry = new HostRegistry({ file: join(root, 'hosts.yaml') });
});
afterEach(async () => {
  await tunnels.closeAll();
  for (const k of ['FAKE_SSH_LOG', 'FAKE_SSH_INFO']) delete process.env[k];
  rmSync(root, { recursive: true, force: true });
});

const tunnelCalls = (): number =>
  existsSync(log)
    ? readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .filter((l) => l.includes('"-N"')).length
    : 0;

function add(over: Record<string, unknown> = {}): void {
  registry.add({
    id: 'srv',
    hostname: 'srv.example.org',
    zone: 'shared',
    backends: ['podman'],
    engineSocket: USER_SOCK,
    ...over,
  });
}

describe('rootless engines on hosts with their own services', () => {
  it('uses a rootless engine, reports what the engine says and passes the host runtimes on', async () => {
    process.env['FAKE_SSH_INFO'] = ROOTLESS;
    add({ runtimes: { podman: 'runsc' } });
    const r = await createHostResolver(registry, tunnels, { cache })('srv');
    expect(r.connection).toMatchObject({
      host: 'srv',
      kind: 'ssh',
      runtimes: { podman: 'runsc' },
    });
    expect(r.engine).toEqual({ rootless: true, runtimes: ['runc', 'runsc'] });
    expect(cache.get('srv')!.info).toMatchObject({ rootless: true, runtimes: ['runc', 'runsc'] });
  });

  it('refuses a rootful engine on a shared host, closes the connection and says why', async () => {
    process.env['FAKE_SSH_INFO'] = ROOTFUL;
    add();
    const err = await createHostResolver(registry, tunnels, { cache })('srv').catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({
      code: 'policy_denied',
      details: { reason: 'engine_rootful', host: 'srv', zone: 'shared' },
    });
    expect((err as Error).message).toMatch(/must use a rootless engine.*is not rootless/);
    expect((err as { hint: string }).hint).toMatch(/allow_rootful/);
    expect(tunnels.peek('srv')).toBeUndefined();
    expect(cache.get('srv')).toMatchObject({ ok: false });
  });

  it('refuses the system-wide engine socket before any connection is made', async () => {
    for (const sock of ['/var/run/docker.sock', '/run/podman/podman.sock']) {
      add({ id: sock.includes('docker') ? 'dk' : 'pm', engineSocket: sock, backends: ['docker'] });
    }
    const resolve = createHostResolver(registry, tunnels, { cache });
    for (const id of ['dk', 'pm']) {
      await expect(resolve(id)).rejects.toMatchObject({
        code: 'policy_denied',
        details: { reason: 'engine_rootful' },
      });
    }
    expect(tunnelCalls()).toBe(0);
  });

  it('refuses an engine that does not say whether it is rootless', async () => {
    process.env['FAKE_SSH_INFO'] = 'none';
    add({ zone: 'restricted' });
    const err = await createHostResolver(registry, tunnels, { cache })('srv').catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ code: 'policy_denied' });
    expect((err as Error).message).toMatch(/cannot verify/);
  });

  it('accepts a rootful engine only with the explicit allow_rootful opt-in', async () => {
    process.env['FAKE_SSH_INFO'] = ROOTFUL;
    add({ allowRootful: true });
    const r = await createHostResolver(registry, tunnels, { cache })('srv');
    expect(r.engine?.rootless).toBe(false);
    registry.add({
      id: 'sys',
      hostname: 'sys.example.org',
      zone: 'shared',
      backends: ['docker'],
      engineSocket: '/var/run/docker.sock',
      allowRootful: true,
    });
    await expect(createHostResolver(registry, tunnels, { cache })('sys')).resolves.toBeDefined();
  });

  it('does not insist on rootless for a lab host (the doctor/host test only warn)', async () => {
    process.env['FAKE_SSH_INFO'] = ROOTFUL;
    add({ zone: 'lab' });
    const r = await createHostResolver(registry, tunnels, { cache })('srv');
    expect(r.engine?.rootless).toBe(false);
  });
});
