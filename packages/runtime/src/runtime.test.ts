import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemorySecretStore, defaultConfig, type ProviderFactory } from '@abox/core';
import {
  INSTANCE_ID_FILE,
  configuredRuntime,
  engineSocket,
  loadInstanceId,
  openAbox,
  providerFactories,
  registerProvider,
  registeredBackends,
  unregisterProvider,
} from './index.js';

let root: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'abox-rt-')));
  env = { PATH: process.env['PATH'], HOME: join(root, 'home'), ABOX_HOME: join(root, 'abox') };
  mkdirSync(join(root, 'home'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('openAbox', () => {
  it('opens the manager as the human with all paths below ABOX_HOME', async () => {
    const rt = await openAbox({ env, secretStore: new MemorySecretStore() });
    try {
      expect(rt.caller).toEqual({ contextId: 'human' });
      expect(rt.paths.dataDir).toBe(join(root, 'abox', 'data'));
      expect(rt.paths.stateDb.startsWith(root)).toBe(true);
      const templates = await rt.abox.listTemplates(rt.caller);
      expect(templates.templates.map((x) => x.name)).toContain('alpine-min');
      const list = await rt.abox.listSandboxes(rt.caller);
      expect(Array.isArray(list.sandboxes)).toBe(true);
    } finally {
      await rt.close();
    }
  });

  it('uses the given context and is safe to close twice', async () => {
    const rt = await openAbox({ env, contextId: 'default' });
    expect(rt.caller.contextId).toBe('default');
    await rt.close();
    await rt.close();
  });

  it('registers docker, podman and process; vm and python are added by registerProvider', () => {
    expect(registeredBackends()).toEqual(expect.arrayContaining(['docker', 'podman', 'process']));
    const factories = providerFactories({ env });
    expect(Object.keys(factories)).toEqual(expect.arrayContaining(['docker', 'podman', 'process']));
    const fake: ProviderFactory = (host) => ({ kind: 'vm', host }) as never;
    registerProvider('vm', () => fake);
    try {
      expect(providerFactories({ env }).vm).toBe(fake);
    } finally {
      unregisterProvider('vm');
    }
    expect(providerFactories({ env }).vm).toBeUndefined();
  });

  it('works without host resolution (hosts: false) and with it', async () => {
    const off = await openAbox({ env, hosts: false });
    await off.close();
    writeFileSync(join(root, 'dummy'), '');
    const on = await openAbox({ env, hosts: true });
    expect(on.hostRegistry.list().map((h) => h.id)).toEqual(['local']);
    await on.close();
  });

  it('gives access to the process provider for operations outside the manager', async () => {
    const rt = await openAbox({ env, hosts: false });
    try {
      const p = await rt.providerFor('local', 'process');
      expect(p.kind).toBe('process');
      expect((await p.status()).ok).toBe(true);
      await expect(rt.providerFor('local', 'vm')).rejects.toMatchObject({
        code: 'backend_unavailable',
      });
    } finally {
      await rt.close();
    }
  });

  it('writes audit entries for operations outside the manager', async () => {
    const rt = await openAbox({ env, hosts: false });
    try {
      rt.audit('test.outside', { note: 'hello' });
      const entries = await rt.abox.queryAudit(rt.caller, { action: 'test.outside' });
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ actor: 'human', details: { note: 'hello' } });
      expect((await rt.abox.verifyAudit(rt.caller)).ok).toBe(true);
    } finally {
      await rt.close();
    }
  });
});

describe('backends on the local host', () => {
  it('offers every registered backend on local unless hosts.yaml defines local itself', async () => {
    const open = await openAbox({ env, secretStore: new MemorySecretStore() });
    try {
      const doctor = await open.abox.doctor(open.caller);
      const kinds = doctor.backends.filter((b) => b.host === 'local').map((b) => b.backend);
      expect(kinds).toEqual(expect.arrayContaining(['docker', 'podman', 'process']));
    } finally {
      await open.close();
    }
    mkdirSync(join(root, 'abox', 'config'), { recursive: true });
    writeFileSync(
      join(root, 'abox', 'config', 'hosts.yaml'),
      'hosts:\n  local:\n    backends: [process]\n',
    );
    const restricted = await openAbox({ env, secretStore: new MemorySecretStore() });
    try {
      const doctor = await restricted.abox.doctor(restricted.caller);
      expect(doctor.backends.filter((b) => b.host === 'local').map((b) => b.backend)).toEqual([
        'process',
      ]);
    } finally {
      await restricted.close();
    }
  });
});

describe('engine sockets', () => {
  const base = (e: NodeJS.ProcessEnv, socket?: string) =>
    ({
      env: e,
      paths: {} as never,
      config: { backends: { docker: { socket }, podman: {}, default: 'docker' } } as never,
    }) as Parameters<typeof engineSocket>[1];

  it('prefers a forwarded socket, then config.yaml, then DOCKER_HOST, then the default', () => {
    expect(engineSocket('docker', base({}), '/tmp/forwarded.sock')).toBe('/tmp/forwarded.sock');
    expect(engineSocket('docker', base({ DOCKER_HOST: 'unix:///a.sock' }, '/cfg.sock'))).toBe(
      '/cfg.sock',
    );
    expect(engineSocket('docker', base({ DOCKER_HOST: 'unix:///a.sock' }))).toBe('/a.sock');
    expect(engineSocket('docker', base({}))).toBe('/var/run/docker.sock');
    expect(engineSocket('podman', base({ XDG_RUNTIME_DIR: '/run/user/9' }))).toBe(
      '/run/user/9/podman/podman.sock',
    );
    expect(engineSocket('podman', base({ CONTAINER_HOST: 'unix:///p.sock' }))).toBe('/p.sock');
  });

  it('reads the socket from config.yaml', async () => {
    mkdirSync(join(root, 'abox', 'config'), { recursive: true });
    writeFileSync(
      join(root, 'abox', 'config', 'config.yaml'),
      'backends:\n  docker:\n    socket: /nonexistent/from-config.sock\n',
    );
    const rt = await openAbox({ env, hosts: false });
    try {
      const doctor = await rt.abox.doctor(rt.caller);
      const docker = doctor.backends.find((b) => b.backend === 'docker');
      expect(docker?.available).toBe(false);
      expect(JSON.stringify(docker)).toContain('/nonexistent/from-config.sock');
    } finally {
      await rt.close();
    }
  });
});

describe('instance id', () => {
  it('is generated once per data dir, persisted with mode 0600 and stable', () => {
    const dir = join(root, 'abox', 'data');
    const id = loadInstanceId(dir);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    const file = join(dir, INSTANCE_ID_FILE);
    expect(readFileSync(file, 'utf8').trim()).toBe(id);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(loadInstanceId(dir)).toBe(id);
    expect(loadInstanceId(join(root, 'other', 'data'))).not.toBe(id);
  });

  it('replaces a garbage file and leaves no temporary files behind', () => {
    const dir = join(root, 'abox', 'data');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, INSTANCE_ID_FILE), 'not an id');
    const id = loadInstanceId(dir);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(loadInstanceId(dir)).toBe(id);
    chmodSync(join(dir, INSTANCE_ID_FILE), 0o600);
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('is passed to the docker, podman and python providers, one id per installation', async () => {
    const mk = (home: string) =>
      providerFactories({ env: { ...env, ABOX_HOME: home } as NodeJS.ProcessEnv });
    const host = { host: 'local', kind: 'local' } as const;
    const a = mk(join(root, 'a'));
    const idA = (a.docker!(host) as unknown as { instanceId?: string }).instanceId;
    expect(idA).toMatch(/^[0-9a-f]{16}$/);
    expect((a.podman!(host) as unknown as { instanceId?: string }).instanceId).toBe(idA);
    expect((a.python!(host) as unknown as { instanceId?: string }).instanceId).toBe(idA);
    expect(readFileSync(join(root, 'a', 'data', INSTANCE_ID_FILE), 'utf8').trim()).toBe(idA);
    const idB = (mk(join(root, 'b')).docker!(host) as unknown as { instanceId?: string })
      .instanceId;
    expect(idB).toMatch(/^[0-9a-f]{16}$/);
    expect(idB).not.toBe(idA);
  });
});

describe('hardened runtime from config', () => {
  const cfg = (backends: Record<string, unknown>) =>
    ({ ...defaultConfig(), backends: { ...defaultConfig().backends, ...backends } }) as never;
  const host = { host: 'local', kind: 'local' } as const;

  it('reads backends.<engine>.runtime defensively', () => {
    expect(configuredRuntime('docker', cfg({}))).toBeUndefined();
    expect(configuredRuntime('docker', cfg({ docker: { runtime: 'runsc' } }))).toBe('runsc');
    expect(configuredRuntime('podman', cfg({ podman: { runtime: ' kata ' } }))).toBe('kata');
    expect(configuredRuntime('docker', cfg({ docker: { runtime: '' } }))).toBeUndefined();
    expect(configuredRuntime('docker', cfg({ docker: { runtime: 42 } }))).toBeUndefined();
    expect(configuredRuntime('docker', cfg({ docker: undefined }))).toBeUndefined();
  });

  it('is passed to the docker, podman and python providers', () => {
    const f = providerFactories({
      env,
      config: cfg({ docker: { runtime: 'runsc' }, podman: { runtime: 'kata' } }),
    });
    const rt = (p: unknown) => (p as { hardenedRuntime?: string }).hardenedRuntime;
    expect(rt(f.docker!(host))).toBe('runsc');
    expect(rt(f.podman!(host))).toBe('kata');
    expect(rt(f.python!(host))).toBe('runsc');
    expect(rt(providerFactories({ env, config: cfg({}) }).docker!(host))).toBeUndefined();
  });
});
