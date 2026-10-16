import { access, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AboxError,
  type ExecEvent,
  type NetworkSpec,
  type ResolvedTemplate,
  type SandboxProvider,
  type SandboxSpec,
} from '@abox/core';
import { makeTestSpec, makeTestTemplate, randomId, waitFor } from '@abox/contract-tests';
import { createProcessProvider, ProcessProvider } from './index.js';

const OPEN: NetworkSpec = { mode: 'open', allow: [], blockPrivate: true, privateExceptions: [], injections: [] };

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof AboxError) return e.code;
    throw e;
  }
  return 'ok';
}

const exists = (p: string): Promise<boolean> => access(p).then(() => true, () => false);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('process backend specifics', () => {
  let dataDir: string;
  let provider: ProcessProvider;
  let template: ResolvedTemplate;
  const extraDirs: string[] = [];

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'abox-process-test-'));
    provider = createProcessProvider({ host: 'local', kind: 'local' }, { dataDir });
    template = makeTestTemplate();
  });

  afterEach(async () => {
    for (const i of await provider.list()) await provider.remove(i.id);
    await rm(dataDir, { recursive: true, force: true });
  });

  afterAll(async () => {
    for (const d of extraDirs) await rm(d, { recursive: true, force: true });
  });

  const spec = (overrides: Partial<SandboxSpec> = {}): Promise<SandboxSpec> =>
    makeTestSpec(provider, template, { network: OPEN, ...overrides });

  async function running(overrides: Partial<SandboxSpec> = {}): Promise<SandboxSpec> {
    const s = await spec(overrides);
    await provider.create(s);
    await provider.start(s.id);
    return s;
  }

  describe('construction and capabilities', () => {
    it('requires a data directory', () => {
      expect(() => createProcessProvider({ host: 'local', kind: 'local' })).toThrow(/data directory/);
    });

    it('takes the data directory from the host connection', async () => {
      const p = createProcessProvider({ host: 'local', kind: 'local', dataDir });
      expect((await p.status()).ok).toBe(true);
    });

    it('rejects remote hosts', () => {
      expect(() => createProcessProvider({ host: 'vps', kind: 'ssh', dataDir })).toThrow(/local host only/);
    });

    it('advertises exactly what it can deliver', () => {
      const caps = provider.capabilities();
      expect(provider.kind).toBe('process');
      expect(provider.isolation).toBe('none');
      expect(caps.networkModes).toEqual(['open']);
      expect(caps.workspaceDelivery).toEqual(['none', 'copy']);
      expect(caps.limits).toEqual({ cpus: false, memory: false, pids: false, disk: false });
      expect(caps.tty).toBe(false);
      expect(caps.mounts).toBe(false);
      expect(caps.nonRootUser).toBe(false);
      expect(caps.osFamilies).toEqual(['unknown']);
    });

    it('status warns about the missing isolation', async () => {
      const s = await provider.status();
      expect(s.ok).toBe(true);
      expect(s.warnings.join(' ')).toMatch(/isolation level "none"/);
    });
  });

  describe('prepare', () => {
    it('rejects templates with build steps instead of ignoring them', async () => {
      const t = makeTestTemplate({ build: [{ name: 'apt: git', script: 'apt-get install -y git' }] });
      const err = await provider.prepare(t).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AboxError);
      expect((err as AboxError).code).toBe('unsupported');
      expect((err as AboxError).message).toMatch(/cannot install packages/);
    });

    it('rejects containers-only templates', async () => {
      expect(await codeOf(provider.prepare(makeTestTemplate({ isolation: 'container' })))).toBe('unsupported');
      expect(await codeOf(provider.prepare(makeTestTemplate({ base: { os: 'ubuntu:24.04', osFamily: 'debian' } })))).toBe('unsupported');
      expect(await codeOf(provider.prepare(makeTestTemplate({ base: { dockerfile: 'Dockerfile', osFamily: 'unknown' } })))).toBe('unsupported');
      expect(await codeOf(provider.prepare(makeTestTemplate({ backend: 'docker' })))).toBe('invalid_input');
    });

    it('refuses hashes that are not safe file names', async () => {
      expect(await codeOf(provider.prepare(makeTestTemplate({ hash: '../escape' })))).toBe('invalid_input');
      expect(await codeOf(provider.prepare(makeTestTemplate({ hash: '' })))).toBe('invalid_input');
    });

    it('keeps a marker per hash, update bypasses the cache', async () => {
      const first = await provider.prepare(template);
      expect(first).toEqual({ ref: `process:${template.hash}`, templateHash: template.hash, cached: false });
      expect((await provider.prepare(template)).cached).toBe(true);
      expect((await provider.prepare(template, { update: true })).cached).toBe(false);
      expect(await exists(join(dataDir, 'process', 'images', template.hash))).toBe(true);
      expect(await provider.gcImages([])).toEqual([`process:${template.hash}`]);
      expect(await exists(join(dataDir, 'process', 'images', template.hash))).toBe(false);
    });
  });

  describe('create: rejected features leave nothing behind', () => {
    it('rejects bind with a clear message', async () => {
      const hostPath = await mkdtemp(join(tmpdir(), 'abox-bind-'));
      extraDirs.push(hostPath);
      const s = await spec({ workspace: { kind: 'bind', hostPath, sandboxPath: '/workspace', access: 'rw' } });
      const err = await provider.create(s).catch((e: unknown) => e);
      expect((err as AboxError).code).toBe('unsupported');
      expect((err as AboxError).message).toMatch(/bind/);
      expect(await provider.list()).toEqual([]);
      expect(await exists(join(dataDir, 'process', 'sandboxes', s.id.split('/')[1] as string))).toBe(false);
    });

    it('rejects none/allowlist networking with an explanatory message', async () => {
      for (const mode of ['none', 'allowlist'] as const) {
        const s = await spec({ network: { ...OPEN, mode } });
        const err = await provider.create(s).catch((e: unknown) => e);
        expect((err as AboxError).code).toBe('unsupported');
        expect((err as AboxError).message).toMatch(/cannot restrict network/);
        expect((err as AboxError).hint).toMatch(/container backend/);
      }
      expect(await provider.list()).toEqual([]);
    });

    it('rejects mounts, proxy injections and invalid ids', async () => {
      const m = await spec({ mounts: [{ hostPath: tmpdir(), sandboxPath: '/mnt/x', access: 'ro' }] });
      expect(await codeOf(provider.create(m))).toBe('unsupported');
      const inj = await spec({ network: { ...OPEN, injections: [{ host: 'a.example', header: 'X', value: 'v' }] } });
      expect(await codeOf(provider.create(inj))).toBe('unsupported');
      for (const bad of ['local/../x', 'local/a/b', 'other/ct1', 'local/', 'x y']) {
        expect(await codeOf(provider.create(await spec({ id: bad })))).toBe('invalid_input');
      }
      expect(await provider.list()).toEqual([]);
    });

    it('a failure while building the sandbox cleans up', async () => {
      const s = await spec({ files: [{ sandboxPath: '/etc/x', content: Buffer.from('x'), mode: 0o600 }] });
      // Make the file placement fail: root/etc is a file after copy of a source that contains it
      const src = await mkdtemp(join(tmpdir(), 'abox-src-'));
      extraDirs.push(src);
      await writeFile(join(src, 'f'), 'x');
      const bad = { ...s, workspace: { kind: 'copy', hostPath: join(src, 'f'), sandboxPath: '/workspace' } } as SandboxSpec;
      expect(await codeOf(provider.create(bad))).toBe('invalid_input');
      expect(await provider.list()).toEqual([]);
      expect(await exists(join(dataDir, 'process', 'sandboxes', s.id.split('/')[1] as string))).toBe(false);
    });
  });

  describe('workspace copy', () => {
    it('preserves symlinks and never follows them out of the source', async () => {
      const src = await mkdtemp(join(tmpdir(), 'abox-src-'));
      const outside = await mkdtemp(join(tmpdir(), 'abox-outside-'));
      extraDirs.push(src, outside);
      await writeFile(join(outside, 'secret'), 'top-secret');
      await writeFile(join(src, 'real.txt'), 'real');
      await symlink('real.txt', join(src, 'rel-link'));
      await symlink(join(outside, 'secret'), join(src, 'abs-link'));
      await symlink(outside, join(src, 'dir-link'));

      const s = await spec({ workspace: { kind: 'copy', hostPath: src, sandboxPath: '/workspace' } });
      const info = await provider.create(s);
      const ws = join(info.backendRef, 'root', 'workspace');
      expect((await lstat(join(ws, 'rel-link'))).isSymbolicLink()).toBe(true);
      expect(await readlink(join(ws, 'rel-link'))).toBe('real.txt');
      expect((await lstat(join(ws, 'abs-link'))).isSymbolicLink()).toBe(true);
      expect(await readlink(join(ws, 'abs-link'))).toBe(join(outside, 'secret'));
      expect((await lstat(join(ws, 'dir-link'))).isSymbolicLink()).toBe(true);
      // the file APIs refuse to follow them
      expect(await codeOf(provider.readFile(s.id, '/workspace/abs-link', 100))).toBe('invalid_input');
      expect(await codeOf(provider.readFile(s.id, '/workspace/dir-link/secret', 100))).toBe('invalid_input');
      expect((await provider.readFile(s.id, '/workspace/rel-link', 100)).data.toString()).toBe('real');
    });

    it('exclude patterns: names at any depth and anchored paths', async () => {
      const src = await mkdtemp(join(tmpdir(), 'abox-src-'));
      extraDirs.push(src);
      for (const d of ['node_modules/x', 'a/node_modules/y', 'build/cache', 'build/out', 'keep']) {
        await mkdir(join(src, d), { recursive: true });
        await writeFile(join(src, d, 'f.txt'), d);
      }
      await writeFile(join(src, 'debug.log'), 'log');
      await writeFile(join(src, 'a', 'trace.log'), 'log');
      const s = await spec({
        workspace: {
          kind: 'copy',
          hostPath: src,
          sandboxPath: '/workspace',
          exclude: ['node_modules', '*.log', 'build/cache'],
        },
      });
      await provider.create(s);
      const names = async (p: string): Promise<string[]> => (await provider.listDir(s.id, p)).map((e) => e.name);
      expect(await names('/workspace')).toEqual(['a', 'build', 'keep']);
      expect(await names('/workspace/a')).toEqual([]);
      expect(await names('/workspace/build')).toEqual(['out']);
    });

    it('delivery none creates an empty workspace at the requested path', async () => {
      const s = await spec({ workspace: { kind: 'none', sandboxPath: '/srv/project/app' } });
      await provider.create(s);
      await provider.start(s.id);
      expect(await provider.listDir(s.id, '/srv/project/app')).toEqual([]);
      const r = await provider.exec(s.id, { command: 'touch here' });
      expect(r.exitCode).toBe(0);
      expect((await provider.listDir(s.id, '/srv/project/app')).map((e) => e.name)).toEqual(['here']);
    });
  });

  describe('sandbox path mapping', () => {
    it('maps /workspace/x to <dir>/root/workspace/x and sets up HOME and TMPDIR inside the root', async () => {
      const s = await running();
      const info = await provider.inspect(s.id);
      await provider.writeFile(s.id, '/workspace/x.txt', Buffer.from('mapped'));
      expect((await readFile(join(info.backendRef, 'root', 'workspace', 'x.txt'))).toString()).toBe('mapped');
      const env = await provider.exec(s.id, { command: 'printf "%s\\n%s" "$HOME" "$TMPDIR"' });
      const [home, tmp] = env.stdout.split('\n');
      expect(home?.endsWith(`/root/home/${template.user.name}`)).toBe(true);
      expect(tmp?.endsWith('/root/tmp')).toBe(true);
      expect(await exists(home as string)).toBe(true);
    });
  });

  describe('exec environment (hygiene, not isolation)', () => {
    it('does not hand the host environment to commands', async () => {
      process.env['ABOX_TEST_HOST_SECRET'] = 'leak-me-not';
      try {
        const s = await running({ env: { FROM_SPEC: '1' } });
        const r = await provider.exec(s.id, { command: 'env' });
        expect(r.stdout).not.toContain('leak-me-not');
        expect(r.stdout).not.toContain('ABOX_TEST_HOST_SECRET');
        expect(r.stdout).toContain('FROM_SPEC=1');
        expect(r.stdout).toMatch(/^PATH=/m);
        expect(r.stdout).toMatch(/^HOME=/m);
        // an explicit request env still wins
        const explicit = await provider.exec(s.id, { command: 'printenv ABOX_TEST_HOST_SECRET', env: { ABOX_TEST_HOST_SECRET: 'given' } });
        expect(explicit.stdout).toBe('given\n');
      } finally {
        delete process.env['ABOX_TEST_HOST_SECRET'];
      }
    });

    it('spec env is persisted privately and not exposed by inspect/list', async () => {
      const s = await running({ env: { API_TOKEN: 'tok-123' } });
      const info = await provider.inspect(s.id);
      expect(JSON.stringify(info)).not.toContain('tok-123');
      expect(JSON.stringify(await provider.list())).not.toContain('tok-123');
      expect(await readFile(join(info.backendRef, 'meta.json'), 'utf8')).not.toContain('tok-123');
      const st = await lstat(join(info.backendRef, 'env.json'));
      expect(st.mode & 0o777).toBe(0o600);
    });

    it('running as another user is unsupported', async () => {
      const s = await running();
      expect(await codeOf(provider.exec(s.id, { argv: ['id'], user: 'root' }))).toBe('unsupported');
    });
  });

  describe('process lifecycle', () => {
    it('timeout kills the whole process group, including grandchildren', async () => {
      const s = await running();
      const r = await provider.exec(s.id, { command: 'sleep 60 & echo $! > child.pid; wait', timeoutMs: 600 });
      expect(r.timedOut).toBe(true);
      const pid = Number((await provider.readFile(s.id, '/workspace/child.pid', 32)).data.toString().trim());
      expect(Number.isInteger(pid)).toBe(true);
      expect(await waitFor(() => !alive(pid), 3000)).toBe(true);
    });

    it('stop kills background processes that outlived their exec', async () => {
      const s = await running();
      const r = await provider.exec(s.id, { command: 'nohup sleep 300 >/dev/null 2>&1 </dev/null & echo $!' });
      const pid = Number(r.stdout.trim());
      expect(alive(pid)).toBe(true);
      await provider.stop(s.id);
      expect(await waitFor(() => !alive(pid), 5000)).toBe(true);
    });

    it('remove kills background processes and deletes the directory', async () => {
      const s = await running();
      const r = await provider.exec(s.id, { command: 'nohup sleep 300 >/dev/null 2>&1 </dev/null & echo $!' });
      const pid = Number(r.stdout.trim());
      const dir = (await provider.inspect(s.id)).backendRef;
      await provider.remove(s.id);
      expect(await waitFor(() => !alive(pid), 5000)).toBe(true);
      expect(await exists(dir)).toBe(false);
    });

    it('remove deletes trees the sandbox made read-only', async () => {
      const s = await running();
      await provider.exec(s.id, { command: 'mkdir -p ro/inner && touch ro/inner/f && chmod -R a-w ro' });
      const dir = (await provider.inspect(s.id)).backendRef;
      await provider.remove(s.id);
      expect(await exists(dir)).toBe(false);
    });

    it('breaking out of spawn() early kills the command', async () => {
      const s = await running();
      let pid = 0;
      const events: ExecEvent[] = [];
      for await (const ev of provider.spawn(s.id, { command: 'echo $$; exec sleep 60' })) {
        events.push(ev);
        if (ev.type === 'stdout') {
          pid = Number(ev.data.toString().trim());
          break;
        }
      }
      expect(pid).toBeGreaterThan(1);
      expect(await waitFor(() => !alive(pid), 5000)).toBe(true);
    });

    it('an abort signal rejects with the abort reason and kills the command', async () => {
      const s = await running();
      const ac = new AbortController();
      const p = provider.exec(s.id, { command: 'echo $$ > pid.txt; exec sleep 60', signal: ac.signal });
      await waitFor(async () => (await provider.exec(s.id, { command: 'test -s pid.txt' })).exitCode === 0, 3000);
      ac.abort();
      await expect(p).rejects.toMatchObject({ name: 'AbortError' });
      const pid = Number((await provider.readFile(s.id, '/workspace/pid.txt', 32)).data.toString().trim());
      expect(await waitFor(() => !alive(pid), 5000)).toBe(true);
      await expect(provider.exec(s.id, { command: 'true', signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('a background child that keeps stdout open does not block exec forever', async () => {
      const s = await running();
      const started = Date.now();
      const r = await provider.exec(s.id, { command: 'echo done; sleep 30 & ' });
      expect(r.stdout).toBe('done\n');
      expect(Date.now() - started).toBeLessThan(5000);
      await provider.stop(s.id);
    });

    it('a stopped sandbox rejects exec with conflict and an actionable hint', async () => {
      const s = await running();
      await provider.stop(s.id);
      const err = await provider.exec(s.id, { argv: ['true'] }).catch((e: unknown) => e);
      expect((err as AboxError).code).toBe('conflict');
      expect((err as AboxError).hint).toMatch(/start/);
    });

    it('missing binaries and non-executable files give 127/126 and a message', async () => {
      const s = await running();
      const missing = await provider.exec(s.id, { argv: ['definitely-not-a-binary'] });
      expect(missing.exitCode).toBe(127);
      expect(missing.stderr).toMatch(/command not found/);
      await provider.writeFile(s.id, '/workspace/plain.txt', Buffer.from('x'), 0o644);
      const noexec = await provider.exec(s.id, { argv: ['./plain.txt'] });
      expect(noexec.exitCode).toBe(126);
    });
  });

  describe('expiry', () => {
    it('start and exec on an expired sandbox are rejected with conflict', async () => {
      let now = Date.now();
      const clocked = createProcessProvider({ host: 'local', kind: 'local' }, { dataDir, now: () => now });
      const s = await makeTestSpec(clocked, template, { network: OPEN, expiresAt: now + 1000 });
      await clocked.create(s);
      await clocked.start(s.id);
      expect((await clocked.exec(s.id, { argv: ['true'] })).exitCode).toBe(0);
      now += 5000;
      expect((await clocked.inspect(s.id)).state).toBe('expired');
      expect(await codeOf(clocked.exec(s.id, { argv: ['true'] }))).toBe('conflict');
      expect(await codeOf(clocked.start(s.id))).toBe('conflict');
      // stop and remove still work on expired sandboxes
      await clocked.stop(s.id);
      await clocked.remove(s.id);
      expect(await clocked.list()).toEqual([]);
    });
  });

  describe('persistence (no daemon, directory is the source of truth)', () => {
    it('a second provider instance sees and drives existing sandboxes', async () => {
      const s = await running({ owner: 'agent:persist', labels: { k: 'v' } });
      await provider.writeFile(s.id, '/workspace/keep.txt', Buffer.from('persisted'));
      const other = createProcessProvider({ host: 'local', kind: 'local' }, { dataDir });
      const listed = await other.list({ owner: 'agent:persist' });
      expect(listed.map((i) => i.id)).toEqual([s.id]);
      expect(listed[0]?.labels).toEqual({ k: 'v' });
      expect(listed[0]?.state).toBe('running');
      expect((await other.exec(s.id, { argv: ['cat', 'keep.txt'] })).stdout).toBe('persisted');
      await other.stop(s.id);
      expect((await provider.inspect(s.id)).state).toBe('stopped');
    });

    it('list ignores half-built and foreign directories', async () => {
      const s = await spec();
      await provider.create(s);
      await mkdir(join(dataDir, 'process', 'sandboxes', 'halfbuilt', 'root'), { recursive: true });
      await mkdir(join(dataDir, 'process', 'sandboxes', 'junk'), { recursive: true });
      await writeFile(join(dataDir, 'process', 'sandboxes', 'junk', 'meta.json'), '{not json');
      expect((await provider.list()).map((i) => i.id)).toEqual([s.id]);
      expect(await codeOf(provider.inspect('local/halfbuilt'))).toBe('not_found');
      await provider.remove('local/halfbuilt');
      expect(await exists(join(dataDir, 'process', 'sandboxes', 'halfbuilt'))).toBe(false);
    });

    it('ids of another host are unknown', async () => {
      const s = await running();
      const other = s.id.replace(/^local\//, 'elsewhere/');
      expect(await codeOf(provider.inspect(other))).toBe('not_found');
      await provider.remove(other); // idempotent, and must not touch our sandbox
      expect((await provider.inspect(s.id)).state).toBe('running');
    });
  });

  describe('snapshots', () => {
    it('snapshot names are unique, validated, and restore of an unknown snapshot is not_found', async () => {
      const s = await running();
      expect(await provider.snapshot(s.id, 'before')).toBe('before');
      expect(await codeOf(provider.snapshot(s.id, 'before'))).toBe('conflict');
      expect(await codeOf(provider.snapshot(s.id, '../evil'))).toBe('invalid_input');
      expect(await codeOf(provider.restore(s.id, 'nope'))).toBe('not_found');
      expect(await codeOf(provider.restore(s.id, '../root'))).toBe('not_found');
    });

    it('restore kills running processes and keeps symlinks and modes', async () => {
      const s = await running();
      await provider.exec(s.id, { command: 'echo v1 > f && chmod 750 f && ln -s f link' });
      await provider.snapshot(s.id, 'a');
      const r = await provider.exec(s.id, { command: 'echo v2 > f; rm link; nohup sleep 300 >/dev/null 2>&1 </dev/null & echo $!' });
      const pid = Number(r.stdout.trim());
      await provider.restore(s.id, 'a');
      expect(await waitFor(() => !alive(pid), 5000)).toBe(true);
      const entries = Object.fromEntries((await provider.listDir(s.id, '/workspace')).map((e) => [e.name, e]));
      expect(entries['link']?.type).toBe('symlink');
      expect((entries['f']?.mode ?? 0) & 0o777).toBe(0o750);
      expect((await provider.readFile(s.id, '/workspace/f', 10)).data.toString()).toBe('v1\n');
      expect((await provider.exec(s.id, { argv: ['cat', 'link'] })).stdout).toBe('v1\n');
    });
  });

  describe('unsupported', () => {
    it('attach rejects with unsupported and a hint', async () => {
      const s = await running();
      const err = await (provider as SandboxProvider).attach(s.id, { cols: 80, rows: 24 }).catch((e: unknown) => e);
      expect((err as AboxError).code).toBe('unsupported');
      expect((err as AboxError).hint).toBeTruthy();
    });
  });

  it('uses unique ids across tests (sanity)', () => {
    expect(randomId()).not.toBe(randomId());
  });
});
