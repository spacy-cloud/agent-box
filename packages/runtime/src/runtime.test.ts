import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemorySecretStore, type ProviderFactory } from '@abox/core';
import {
  engineSocket,
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
