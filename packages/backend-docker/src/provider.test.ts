import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Docker from 'dockerode';
import { AboxError, collectBuildContext } from '@abox/core';
import type { ExecEvent, PreparedImage, ResolvedTemplate, SandboxSpec } from '@abox/core';
import { defineProviderContract, makeTestTemplate } from '@abox/contract-tests';
import { createDockerProvider, type DockerProvider } from './index.js';
import { MiB, makeSpec, makeTemplate } from './__tests__/helpers.js';
import {
  TEST_INSTANCE,
  TEST_LABEL,
  TEST_RUN,
  TEST_SOCKET,
  dockerEnabled,
  newProvider,
  sweepTestObjects,
  Tracker,
} from './__tests__/harness.js';
import { defaultProxyAssets } from './proxy.js';
import { existsSync } from 'node:fs';

const SOCK = TEST_SOCKET;
const raw = new Docker({ socketPath: SOCK });

describe.skipIf(!dockerEnabled)('DockerProvider (real docker)', () => {
  const provider: DockerProvider = newProvider();
  const track = new Tracker(provider);
  const template: ResolvedTemplate = makeTemplate();
  let prepared: PreparedImage;
  let tmp: string;

  const spec = (over: Partial<SandboxSpec> = {}): SandboxSpec =>
    makeSpec(template, prepared.ref, over);
  const sb = async (over: Partial<SandboxSpec> = {}, start = true): Promise<SandboxSpec> =>
    track.create(spec(over), start);
  const run = async (s: SandboxSpec, command: string, extra: Record<string, unknown> = {}) =>
    provider.exec(s.id, { command, ...extra });
  const inspectRaw = async (s: SandboxSpec) =>
    raw.getContainer(`abox-local-${s.id.split('/')[1]}`).inspect();

  beforeAll(async () => {
    await sweepTestObjects();
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'abox-dtest-'));
    await provider.init();
    prepared = await provider.prepare(template);
  }, 300_000);

  afterAll(async () => {
    await track.cleanup();
    await sweepTestObjects();
    await fs.rm(tmp, { recursive: true, force: true });
  }, 120_000);

  // -------------------------------------------------------------------------
  describe('prepare / images', () => {
    it('built the image with labels, user and quoted steps intact', async () => {
      expect(prepared.cached).toBe(false);
      expect(prepared.ref).toBe(`abox/abox-test-alpine:${template.hash.slice(0, 16)}`);
      expect(prepared.templateHash).toBe(template.hash);
      expect(prepared.pinnedBase).toMatch(/^alpine@sha256:[0-9a-f]{64}$/);
      const img = await raw.getImage(prepared.ref).inspect();
      const l = img.Config.Labels;
      expect(l['abox.managed']).toBe('1');
      expect(l['abox.template']).toBe(template.name);
      expect(l['abox.template-hash']).toBe(template.hash);
      expect(l['abox.base-digest']).toBe(prepared.pinnedBase);
      expect(img.Config.User).toBe('1000:1000');
      expect(img.Config.WorkingDir).toBe('/workspace');
      const s = await sb();
      expect((await run(s, 'cat /etc/abox-marker')).stdout).toBe('built by abox test\n');
      expect((await run(s, 'cat /etc/abox-quote')).stdout).toBe(`it's $HOME "quoted"\n`);
      expect((await run(s, 'id -un; pwd')).stdout).toBe('dev\n/workspace\n');
      await provider.remove(s.id);
    });

    it('second prepare is a cache hit in < 2 s and keeps the pin', async () => {
      const t0 = Date.now();
      const again = await provider.prepare(template);
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(again.cached).toBe(true);
      expect(again.ref).toBe(prepared.ref);
      expect(again.pinnedBase).toBe(prepared.pinnedBase);
    });

    it('update re-resolves the base; an unchanged digest stays cached', async () => {
      const lines: string[] = [];
      const r = await provider.prepare(template, {
        update: true,
        onProgress: (l) => lines.push(l),
      });
      expect(r.cached).toBe(true);
      expect(r.pinnedBase).toBe(prepared.pinnedBase);
      expect(lines.some((l) => l.startsWith('pull alpine:3.22'))).toBe(true);
    });

    it('builds from a pinned base and streams progress', async () => {
      const t = makeTemplate({ name: 'abox-test-pinned' });
      const lines: string[] = [];
      const r = await provider.prepare(t, {
        pinnedBase: prepared.pinnedBase,
        onProgress: (l) => lines.push(l),
      });
      expect(r.cached).toBe(false);
      expect(r.pinnedBase).toBe(prepared.pinnedBase);
      expect(lines.join('\n')).toMatch(/Step 1\//);
    });

    it('a failing build step fails with backend_error and the log tail', async () => {
      const t = makeTemplate({
        name: 'abox-test-broken',
        build: [{ name: 'boom', script: 'echo about to fail; exit 7' }],
      });
      const err = await provider.prepare(t).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AboxError);
      expect((err as AboxError).code).toBe('backend_error');
      expect(JSON.stringify((err as AboxError).details)).toContain('about to fail');
    });

    it('debian family: replaces the base image user that owns uid 1000 (ubuntu:24.04)', async () => {
      const t = makeTemplate(
        { name: 'abox-test-ubuntu', base: { os: 'ubuntu:24.04', osFamily: 'debian' }, build: [] },
        'debian',
      );
      const img = await provider.prepare(t);
      const s = await sb({ template: t, image: img });
      expect((await run(s, 'id; getent passwd 1000; echo $HOME; pwd')).stdout).toMatch(
        /uid=1000\(dev\) gid=1000\(dev\)[\s\S]*dev:x:1000:1000[\s\S]*\/home\/dev\n\/workspace/,
      );
      expect((await run(s, 'getent passwd ubuntu; echo rc=$?')).stdout).toBe('rc=2\n');
      // GNU tar (not busybox): copyIn / copyOut under the /tmp tmpfs
      const dir = path.join(tmp, 'gnu-tar');
      await fs.mkdir(path.join(dir, 'sub'), { recursive: true });
      await fs.writeFile(path.join(dir, 'sub', 'f.txt'), 'gnu', { mode: 0o640 });
      await fs.symlink('sub/f.txt', path.join(dir, 'link'));
      await provider.copyIn(s.id, dir, '/tmp/gnu');
      expect(
        (await run(s, 'cat /tmp/gnu/sub/f.txt; stat -c "%U %a" /tmp/gnu/sub/f.txt')).stdout,
      ).toBe('gnudev 640\n');
      await provider.copyOut(s.id, '/tmp/gnu', path.join(tmp, 'gnu-tar-out'));
      expect(await fs.readFile(path.join(tmp, 'gnu-tar-out', 'sub', 'f.txt'), 'utf8')).toBe('gnu');
      expect(await fs.readlink(path.join(tmp, 'gnu-tar-out', 'link'))).toBe('sub/f.txt');
    }, 300_000);

    it('template.env is baked into the image and applied at runtime; spec.env wins', async () => {
      const t = makeTemplate({
        name: 'abox-test-env',
        env: { TOOL_HOME: '/opt/tool', FOO: 'from-template', Q: 'a "b" $c' },
      });
      const img = await provider.prepare(t);
      const s = await sb({ template: t, image: img });
      expect((await run(s, 'echo "$TOOL_HOME|$FOO|$Q"')).stdout).toBe('/opt/tool|bar|a "b" $c\n');
      expect((await raw.getImage(img.ref).inspect()).Config.Env).toContain('TOOL_HOME=/opt/tool');
    });

    it('templates with their own Dockerfile: content change invalidates the cache', async () => {
      const dir = await fs.mkdtemp(path.join(tmp, 'custom-'));
      await fs.writeFile(
        path.join(dir, 'Dockerfile'),
        'FROM alpine:3.22\nRUN echo one > /etc/custom\nCOPY extra.txt /etc/extra.txt\n',
      );
      await fs.writeFile(path.join(dir, 'extra.txt'), 'from context');
      const t = makeTemplate({
        name: 'abox-test-custom',
        base: { dockerfile: './Dockerfile', osFamily: 'alpine' },
        source: { kind: 'project', path: path.join(dir, 'template.yaml') },
      });
      const a = await provider.prepare(t);
      expect(a.cached).toBe(false);
      expect((await provider.prepare(t)).cached).toBe(true);
      const s = await sb({ template: t, image: a }, true);
      expect((await run(s, 'cat /etc/custom; cat /etc/extra.txt; echo; id -un')).stdout).toBe(
        'one\nfrom context\ndev\n',
      );
      await fs.writeFile(
        path.join(dir, 'Dockerfile'),
        'FROM alpine:3.22\nRUN echo two > /etc/custom\nCOPY extra.txt /etc/extra.txt\n',
      );
      const b = await provider.prepare(t);
      expect(b.cached).toBe(false);
      expect(b.ref).not.toBe(a.ref);
      const s2 = await sb({ template: t, image: b }, true);
      expect((await run(s2, 'cat /etc/custom')).stdout).toBe('two\n');
      expect((await raw.getImage(b.ref).inspect()).Config.Labels['abox.template-hash']).toBe(
        t.hash,
      );
    }, 120_000);

    it('refuses to build a context that changed since it was approved', async () => {
      const dir = await fs.mkdtemp(path.join(tmp, 'approved-'));
      const dockerfile = path.join(dir, 'Dockerfile');
      await fs.writeFile(dockerfile, 'FROM alpine:3.22\nCOPY extra.txt /etc/extra.txt\n');
      await fs.writeFile(path.join(dir, 'extra.txt'), 'reviewed');
      const approved = await collectBuildContext(dockerfile);
      const t = makeTemplate({
        name: 'abox-test-approved-ctx',
        base: { dockerfile: './Dockerfile', osFamily: 'alpine' },
        source: { kind: 'project', path: path.join(dir, 'template.yaml') },
        buildContext: approved,
      });
      // a file swapped after the review: nothing is built
      await fs.writeFile(path.join(dir, 'extra.txt'), 'swapped after review');
      const err = await provider.prepare(t).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AboxError);
      expect((err as AboxError).code).toBe('conflict');
      expect((err as AboxError).message).toContain('changed since it was approved');
      const images = await raw.listImages({ filters: { label: ['abox.managed=1'] } });
      expect(images.flatMap((i) => i.RepoTags ?? []).some((x) => x.includes('approved-ctx'))).toBe(
        false,
      );
      // the reviewed content builds
      await fs.writeFile(path.join(dir, 'extra.txt'), 'reviewed');
      const img = await provider.prepare(t);
      const s = await sb({ template: t, image: img }, true);
      expect((await run(s, 'cat /etc/extra.txt')).stdout).toBe('reviewed');
    }, 120_000);

    it('gcImages removes unreferenced template images only', async () => {
      const t = makeTemplate({ name: 'abox-test-gc' });
      const img = await provider.prepare(t);
      const all = await raw.listImages({ filters: { label: ['abox.managed=1'] } });
      const keep = all
        .map((i) => i.Labels?.['abox.template-hash'])
        .filter((h): h is string => !!h && h !== t.hash);
      const removed = await provider.gcImages(keep);
      expect(removed).toEqual([img.ref]);
      await expect(raw.getImage(img.ref).inspect()).rejects.toMatchObject({ statusCode: 404 });
      // an image used by a container survives
      const s = await sb({}, false);
      expect(await provider.gcImages(keep)).not.toContain(prepared.ref);
      await provider.remove(s.id);
    });
  });

  // -------------------------------------------------------------------------
  describe('lifecycle and listing', () => {
    it('create -> start -> exec -> stop -> start -> remove (idempotent)', async () => {
      const s = spec();
      track.ids.push(s.id);
      const info = await provider.create(s);
      expect(info).toMatchObject({
        id: s.id,
        host: 'local',
        name: s.name,
        state: 'created',
        backend: 'docker',
        isolation: 'container',
        template: template.name,
        templateHash: template.hash,
        owner: 'human',
        createdAt: s.createdAt,
        expiresAt: s.expiresAt,
        labels: { [TEST_LABEL]: TEST_RUN, note: 'x' },
      });
      expect(info.backendRef).toMatch(/^[0-9a-f]{64}$/);
      await provider.start(s.id);
      await provider.start(s.id); // idempotent
      expect((await provider.inspect(s.id)).state).toBe('running');
      expect((await run(s, 'echo $FOO')).stdout).toBe('bar\n');
      await provider.stop(s.id);
      expect((await provider.inspect(s.id)).state).toBe('stopped');
      await expect(run(s, 'true')).rejects.toMatchObject({ code: 'conflict' });
      await provider.start(s.id);
      expect((await run(s, 'echo again')).stdout).toBe('again\n');
      await provider.remove(s.id);
      await provider.remove(s.id);
      await expect(provider.inspect(s.id)).rejects.toMatchObject({ code: 'not_found' });
    });

    it('create is conflict-safe and atomic on failure', async () => {
      const s = await sb({}, false);
      await expect(provider.create(s)).rejects.toMatchObject({ code: 'conflict' });
      // failing create (mount of a missing host path) leaves nothing behind
      const bad = spec({
        mounts: [
          { hostPath: path.join(tmp, 'does-not-exist'), sandboxPath: '/mnt/x', access: 'ro' },
        ],
      });
      track.ids.push(bad.id);
      await expect(provider.create(bad)).rejects.toBeInstanceOf(AboxError);
      expect(
        await raw.listContainers({
          all: true,
          filters: { name: [`abox-local-${bad.id.split('/')[1]}`] },
        }),
      ).toHaveLength(0);
      await provider.remove(s.id);
    });

    it('list/inspect come from labels and filter by owner/template/state', async () => {
      const a = await sb({ owner: 'agent:claude-code/default' });
      const b = await sb({ owner: 'human' }, false);
      const all = await provider.list();
      const ids = all.map((i) => i.id);
      expect(ids).toContain(a.id);
      expect(ids).toContain(b.id);
      expect(
        (await provider.list({ owner: 'agent:claude-code/default' })).map((i) => i.id),
      ).toContain(a.id);
      expect(
        (await provider.list({ owner: 'agent:claude-code/default' })).map((i) => i.id),
      ).not.toContain(b.id);
      expect((await provider.list({ state: 'created' })).map((i) => i.id)).toContain(b.id);
      expect((await provider.list({ state: 'created' })).map((i) => i.id)).not.toContain(a.id);
      expect((await provider.list({ template: 'nope' })).length).toBe(0);
      // the proxy sidecar / other objects are never listed as sandboxes
      expect(all.every((i) => i.id.startsWith('local/'))).toBe(true);
    });

    it('unknown ids give not_found; other hosts and garbage too', async () => {
      for (const id of ['local/doesnotexist', 'other/abcd1234', 'weird id']) {
        await expect(provider.inspect(id)).rejects.toMatchObject({ code: 'not_found' });
        await expect(provider.exec(id, { command: 'true' })).rejects.toMatchObject({
          code: 'not_found',
        });
        await expect(provider.start(id)).rejects.toMatchObject({ code: 'not_found' });
        await expect(provider.readFile(id, '/x', 10)).rejects.toMatchObject({ code: 'not_found' });
        await expect(provider.remove(id)).resolves.toBeUndefined();
      }
    });

    it('an unreachable engine is backend_unavailable', async () => {
      const dead = createDockerProvider({
        host: 'local',
        kind: 'local',
        engineSocket: '/nonexistent/docker.sock',
      });
      await expect(dead.inspect('local/abcd1234')).rejects.toMatchObject({
        code: 'backend_unavailable',
      });
      await expect(dead.list()).rejects.toMatchObject({ code: 'backend_unavailable' });
      const st = await dead.status();
      expect(st.ok).toBe(false);
    });

    it('status reports version, rootless flag and warnings', async () => {
      const st = await provider.status();
      expect(st.ok).toBe(true);
      expect(st.version).toMatch(/^\d+\./);
      expect(typeof st.rootless).toBe('boolean');
      expect(st.details.join('\n')).toMatch(/internal networks: work/);
      if (!st.rootless) expect(st.warnings.join('\n')).toMatch(/rootful.*root-equivalent/);
    });

    it('capabilities reflect the engine', () => {
      const c = provider.capabilities();
      expect(c).toMatchObject({
        isolation: 'container',
        tty: true,
        nonRootUser: true,
        snapshots: true,
        remote: false,
        mounts: true,
        workspaceDelivery: ['none', 'bind', 'copy'],
        secretInjection: ['proxy', 'env', 'file'],
        osFamilies: ['debian', 'alpine', 'fedora', 'arch'],
      });
      expect(c.limits).toMatchObject({ cpus: true, memory: true, pids: true });
      expect(c.networkModes.includes('allowlist')).toBe(defaultProxyAssets !== undefined);
    });
  });

  // -------------------------------------------------------------------------
  describe('hardening', () => {
    it('docker inspect shows every mandatory option', async () => {
      const s = await sb({
        resources: { ...template.resources, memoryBytes: 200 * MiB, pids: 77, cpus: 1.5 },
      });
      const c = await inspectRaw(s);
      const hc = c.HostConfig;
      expect(c.Config.User).toBe('1000:1000');
      expect(hc.CapDrop).toEqual(['ALL']);
      expect(hc.CapAdd ?? []).toEqual([]);
      expect(hc.SecurityOpt).toEqual(['no-new-privileges:true']);
      expect(hc.Privileged).toBe(false);
      expect(hc.PidsLimit).toBe(77);
      expect(hc.Memory).toBe(200 * MiB);
      expect(hc.MemorySwap).toBe(200 * MiB);
      expect(hc.NanoCpus).toBe(1.5e9);
      expect(hc.NetworkMode).toBe('none');
      expect(hc.IpcMode).toBe('private');
      expect(hc.PidMode ?? '').toBe('');
      expect(hc.UTSMode ?? '').toBe('');
      expect(hc.Devices ?? []).toEqual([]);
      expect((hc as { Init?: boolean }).Init).toBe(true);
      expect(hc.Tmpfs).toHaveProperty('/tmp');
      expect(hc.Tmpfs?.['/tmp']).toMatch(/rw,nosuid,nodev,size=\d+/);
      expect(hc.ReadonlyRootfs).toBe(false);
      expect((c.Mounts ?? []).some((m) => m.Source.endsWith('.sock'))).toBe(false);
      expect(hc.Binds ?? []).toEqual([]);
      const info = await provider.inspect(s.id);
      expect(info.effective).toMatchObject({
        user: '1000:1000',
        capDrop: ['ALL'],
        pidsLimit: 77,
        memoryBytes: 200 * MiB,
        cpus: 1.5,
        networkMode: 'none',
        readonlyRootfs: false,
        privileged: false,
        init: true,
      });
    });

    it('behaviour inside the sandbox: non-root, no capabilities, no sockets, no new privileges', async () => {
      const s = await sb();
      expect((await run(s, 'id -u')).stdout.trim()).toBe('1000');
      expect((await run(s, 'id -g')).stdout.trim()).toBe('1000');
      const caps = (await run(s, 'grep -E "^Cap(Eff|Prm|Inh|Bnd|Amb)" /proc/self/status')).stdout;
      for (const line of caps.trim().split('\n')) expect(line).toMatch(/:\s+0000000000000000$/);
      expect((await run(s, 'grep NoNewPrivs /proc/self/status')).stdout).toMatch(/NoNewPrivs:\s+1/);
      expect(
        (await run(s, 'ls /var/run/docker.sock /run/docker.sock 2>&1; echo rc=$?')).stdout,
      ).toMatch(/No such file[\s\S]*rc=1/);
      // even `su`/root exec cannot gain privileges
      const asRoot = await provider.exec(s.id, {
        command: 'grep CapEff /proc/self/status; mount -t tmpfs none /mnt 2>&1; echo rc=$?',
        user: 'root',
      });
      expect(asRoot.stdout).toMatch(/CapEff:\s+0000000000000000/);
      expect(asRoot.stdout).not.toMatch(/rc=0/);
      // /tmp is tmpfs and writable; rootfs writable by default
      expect((await run(s, 'echo x > /tmp/f && mount | grep " /tmp " | head -1')).stdout).toMatch(
        /tmpfs/,
      );
    });

    it('rejects root and unenforceable options instead of silently ignoring them', async () => {
      const root = spec({ user: { name: 'root', uid: 0, sudo: false } });
      await expect(provider.create(root)).rejects.toMatchObject({ code: 'invalid_input' });
      const disk = spec({ resources: { ...template.resources, diskBytes: 1024 ** 3 } });
      if (!provider.capabilities().limits.disk) {
        await expect(provider.create(disk)).rejects.toMatchObject({ code: 'unsupported' });
      }
      const iso = spec({ template: makeTemplate({ ...template, isolation: 'hardened' }) });
      await expect(provider.create(iso)).rejects.toMatchObject({ code: 'unsupported' });
      const ssh = createDockerProvider(
        { host: 'local', kind: 'ssh', engineSocket: SOCK },
        { extraLabels: { [TEST_LABEL]: TEST_RUN } },
      );
      expect(ssh.capabilities().workspaceDelivery).toEqual(['none', 'copy']);
      expect(ssh.capabilities().mounts).toBe(false);
      await expect(
        ssh.create(
          spec({
            workspace: { kind: 'bind', hostPath: tmp, sandboxPath: '/workspace', access: 'rw' },
          }),
        ),
      ).rejects.toMatchObject({ code: 'unsupported' });
      await expect(
        ssh.create(spec({ mounts: [{ hostPath: tmp, sandboxPath: '/mnt/x', access: 'ro' }] })),
      ).rejects.toMatchObject({ code: 'unsupported' });
    });

    it('never mounts sockets or runtime dirs, even if asked', async () => {
      for (const hostPath of [SOCK, '/var/run', '/run/user', '/proc', '/sys', '/', '/dev']) {
        const s = spec({ mounts: [{ hostPath, sandboxPath: '/mnt/evil', access: 'ro' }] });
        track.ids.push(s.id);
        await expect(provider.create(s), hostPath).rejects.toMatchObject({
          code: expect.stringMatching(/policy_denied|invalid_input/),
        });
      }
      const sockDir = await fs.mkdtemp(path.join(tmp, 'sock-'));
      await fs.writeFile(path.join(sockDir, 'agent.sock'), '');
      const s = spec({
        mounts: [
          { hostPath: path.join(sockDir, 'agent.sock'), sandboxPath: '/mnt/agent', access: 'ro' },
        ],
      });
      await expect(provider.create(s)).rejects.toMatchObject({ code: 'policy_denied' });
      const t = spec({ mounts: [{ hostPath: tmp, sandboxPath: '/proc/x', access: 'ro' }] });
      await expect(provider.create(t)).rejects.toMatchObject({ code: 'policy_denied' });
    });

    it('pids limit stops a fork bomb', async () => {
      const s = await sb({ resources: { ...template.resources, pids: 40 } });
      const r = await run(
        s,
        'i=0; while [ $i -lt 200 ]; do sleep 4 & i=$((i+1)); echo $i > /tmp/n; done',
        { timeoutMs: 8000 },
      );
      expect(r.stderr).toMatch(/can't fork|Resource temporarily unavailable/i);
      await new Promise((res) => setTimeout(res, 5000)); // the stragglers are short-lived
      const n = Number((await run(s, 'cat /tmp/n')).stdout.trim());
      expect(n).toBeGreaterThan(20);
      expect(n).toBeLessThan(40);
      expect((await run(s, 'echo alive')).stdout).toBe('alive\n');
    }, 30_000);

    it('memory limit kills a memory hog', async () => {
      const s = await sb({ resources: { ...template.resources, memoryBytes: 64 * MiB } });
      const r = await run(
        s,
        'awk "BEGIN{while(1){s=s \\"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\\"}}"; echo survived',
        { timeoutMs: 20_000 },
      );
      expect(r.stdout).not.toContain('survived');
      expect(r.exitCode).toBe(137);
      expect((await run(s, 'echo alive')).stdout).toBe('alive\n');
    });

    it('read-only rootfs (label) keeps workspace, home, /tmp writable and the rest not', async () => {
      const t = makeTemplate({ ...template, labels: { 'abox.readonly-rootfs': 'true' } });
      const s = spec({
        template: t,
        labels: { 'abox.readonly-rootfs': 'true' },
        files: [
          { sandboxPath: '/usr/local/share/abox/note.txt', content: Buffer.from('n'), mode: 0o644 },
        ],
      });
      await track.create(s);
      expect((await inspectRaw(s)).HostConfig.ReadonlyRootfs).toBe(true);
      expect((await run(s, '{ echo a > /etc/x; } 2>&1; echo rc=$?')).stdout).toMatch(
        /Read-only file system[\s\S]*rc=1|rc=1/,
      );
      expect(
        (await run(s, 'echo a > /workspace/x && echo a > /tmp/x && echo a > $HOME/x && echo ok'))
          .stdout,
      ).toBe('ok\n');
      expect(
        (await provider.readFile(s.id, '/usr/local/share/abox/note.txt', 10)).data.toString(),
      ).toBe('n');
      await expect(provider.snapshot!(s.id, 'x')).rejects.toMatchObject({ code: 'unsupported' });
      const bad = spec({
        template: t,
        labels: { 'abox.readonly-rootfs': 'true' },
        files: [{ sandboxPath: '/etc/x', content: Buffer.from('n'), mode: 0o644 }],
      });
      await expect(provider.create(bad)).rejects.toMatchObject({ code: 'unsupported' });
    });
  });

  // -------------------------------------------------------------------------
  describe('network', () => {
    it('none: no interfaces beyond lo, no route, no DNS, no connections', async () => {
      const s = await sb();
      expect((await inspectRaw(s)).HostConfig.NetworkMode).toBe('none');
      const links = (await run(s, 'ls /sys/class/net')).stdout.trim().split(/\s+/);
      expect(links).toEqual(['lo']);
      expect(
        (await run(s, 'ip route 2>&1; cat /proc/net/route | wc -l')).stdout.trim().endsWith('1'),
      ).toBe(true);
      const nc = await run(s, 'nc -w 2 -z 1.1.1.1 443', { timeoutMs: 10_000 });
      expect(nc.exitCode).not.toBe(0);
      const wget = await run(s, 'wget -q -T 3 -O- http://1.1.1.1/ 2>&1', { timeoutMs: 10_000 });
      expect(wget.exitCode).not.toBe(0);
      const dns = await run(s, 'nslookup example.com 2>&1; getent hosts example.com', {
        timeoutMs: 10_000,
      });
      expect(dns.exitCode).not.toBe(0);
      expect(dns.stdout).not.toMatch(/Address: \d+\.\d+/);
    });

    it('open: a user-defined bridge abox-open, never the default bridge', async () => {
      const s = await sb({
        network: {
          mode: 'open',
          allow: [],
          blockPrivate: true,
          privateExceptions: [],
          injections: [],
        },
      });
      const c = await inspectRaw(s);
      expect(c.HostConfig.NetworkMode).toBe('abox-open');
      expect(Object.keys(c.NetworkSettings.Networks)).toEqual(['abox-open']);
      const net = await raw.getNetwork('abox-open').inspect();
      expect(net.Driver).toBe('bridge');
      expect(net.Internal).toBe(false);
      expect(net.Labels['abox.managed']).toBe('1');
      expect((await provider.inspect(s.id)).effective).toMatchObject({ networkMode: 'abox-open' });
    });
  });

  describe.skipIf(
    defaultProxyAssets === undefined ||
      !existsSync(`${defaultProxyAssets?.runtimeDir ?? ''}/proxy.mjs`),
  )('network: allowlist via proxy sidecar', () => {
    it('sandbox is only on the internal network; proxy filters; events are logged; removal cleans up', async () => {
      const s = await sb({
        network: {
          mode: 'allowlist',
          allow: ['example.com'],
          blockPrivate: true,
          privateExceptions: [],
          injections: [],
        },
      });
      const short = s.id.split('/')[1];
      const c = await inspectRaw(s);
      expect(c.HostConfig.NetworkMode).toBe(`abox-int-${short}`);
      expect(Object.keys(c.NetworkSettings.Networks)).toEqual([`abox-int-${short}`]);
      const env = Object.fromEntries(
        c.Config.Env.map((e) => e.split(/=(.*)/s).slice(0, 2) as [string, string]),
      );
      expect(env['HTTPS_PROXY']).toBe('http://abox-proxy:3128');
      expect(env['http_proxy']).toBe('http://abox-proxy:3128');
      expect(env['NO_PROXY']).toBe('localhost,127.0.0.1');
      const internal = await raw.getNetwork(`abox-int-${short}`).inspect();
      expect(internal.Internal).toBe(true);
      const proxy = await raw.getContainer(`abox-proxy-${short}`).inspect();
      expect(Object.keys(proxy.NetworkSettings.Networks).sort()).toEqual([
        'abox-egress',
        `abox-int-${short}`,
      ]);
      expect(proxy.Config.User).toBe('10001:10001');
      expect(proxy.HostConfig.CapDrop).toEqual(['ALL']);
      expect(proxy.HostConfig.SecurityOpt).toEqual(['no-new-privileges:true']);
      expect(proxy.HostConfig.ReadonlyRootfs).toBe(true);
      expect(proxy.HostConfig.Memory).toBe(128 * MiB);
      expect(proxy.HostConfig.PidsLimit).toBe(64);
      expect(JSON.stringify(proxy.Config.Env) + JSON.stringify(proxy.Config.Labels)).not.toContain(
        'Authorization',
      );

      // direct egress is impossible: no route, no DNS
      const direct = await run(s, 'nc -w 2 -z 1.1.1.1 443; echo rc=$?', { timeoutMs: 10_000 });
      expect(direct.stdout).not.toContain('rc=0');
      const dns = await run(s, 'getent hosts example.com; echo rc=$?', { timeoutMs: 10_000 });
      expect(dns.stdout).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
      // denied via proxy
      const denied = await run(s, 'wget -q -T 5 -O- http://example.org/ 2>&1; echo rc=$?', {
        timeoutMs: 15_000,
      });
      expect(denied.stdout).not.toContain('rc=0');
      // allowed via proxy (needs internet on the dev machine)
      const ok = await run(
        s,
        'wget -q -T 10 -O- http://example.com/ 2>&1 | head -c 200; echo; echo rc=${PIPESTATUS:-x}',
        { timeoutMs: 20_000 },
      );
      const events = await provider.networkEvents!(s.id);
      expect(events.some((e) => e.host === 'example.org' && e.decision === 'deny')).toBe(true);
      if (/Example Domain/i.test(ok.stdout)) {
        expect(events.some((e) => e.host === 'example.com' && e.decision === 'allow')).toBe(true);
      }
      expect(await provider.networkEvents!(s.id, Date.now() + 60_000)).toEqual([]);

      // stop/start also stop/start the proxy
      await provider.stop(s.id);
      expect((await raw.getContainer(`abox-proxy-${short}`).inspect()).State.Running).toBe(false);
      await provider.start(s.id);
      expect((await raw.getContainer(`abox-proxy-${short}`).inspect()).State.Running).toBe(true);
      expect((await run(s, 'echo back')).stdout).toBe('back\n');

      await provider.remove(s.id);
      await expect(raw.getContainer(`abox-proxy-${short}`).inspect()).rejects.toMatchObject({
        statusCode: 404,
      });
      await expect(raw.getNetwork(`abox-int-${short}`).inspect()).rejects.toMatchObject({
        statusCode: 404,
      });
    }, 120_000);

    it('secret injection installs the CA bundle and env, config never leaks via env/labels', async () => {
      const s = await sb({
        network: {
          mode: 'allowlist',
          allow: ['example.com'],
          blockPrivate: true,
          privateExceptions: [],
          injections: [
            { host: 'example.com', header: 'Authorization', value: 'Bearer SUPER-SECRET-VALUE' },
          ],
        },
      });
      const short = s.id.split('/')[1];
      const c = await inspectRaw(s);
      expect(c.Config.Env).toContain('SSL_CERT_FILE=/usr/local/share/abox/ca-bundle.crt');
      expect(c.Config.Env).toContain('NODE_EXTRA_CA_CERTS=/usr/local/share/abox/ca.crt');
      const ca = (
        await provider.readFile(s.id, '/usr/local/share/abox/ca.crt', 100_000)
      ).data.toString();
      expect(ca).toContain('BEGIN CERTIFICATE');
      const bundle = (
        await provider.readFile(s.id, '/usr/local/share/abox/ca-bundle.crt', 10 * MiB)
      ).data.toString();
      expect(bundle).toContain(ca.trim());
      expect(bundle.split('BEGIN CERTIFICATE').length).toBeGreaterThan(5); // system roots + abox CA
      const proxy = await raw.getContainer(`abox-proxy-${short}`).inspect();
      expect(JSON.stringify(proxy.Config)).not.toContain('SUPER-SECRET-VALUE');
      expect(JSON.stringify(c.Config)).not.toContain('SUPER-SECRET-VALUE');
      expect((await run(s, 'ls -l /usr/local/share/abox/ca.crt')).stdout).toMatch(/root/);
      // restart refreshes the CA (the proxy generates a new one on every start)
      await provider.stop(s.id);
      await provider.start(s.id);
      const ca2 = (
        await provider.readFile(s.id, '/usr/local/share/abox/ca.crt', 100_000)
      ).data.toString();
      expect(ca2).toContain('BEGIN CERTIFICATE');
      expect(ca2).not.toBe(ca);
    }, 120_000);

    it('at expiry the proxy sidecar, its secret config and the internal network go; the sandbox stays for export', async () => {
      const now = Date.now();
      const s = await sb(
        {
          createdAt: now,
          expiresAt: now + 10_000,
          network: {
            mode: 'allowlist',
            allow: ['example.com'],
            blockPrivate: true,
            privateExceptions: [],
            injections: [
              { host: 'example.com', header: 'Authorization', value: 'Bearer EXPIRY-SECRET' },
            ],
          },
        },
        true,
      );
      const short = s.id.split('/')[1];
      await run(s, 'echo exported > /workspace/result.txt');
      // the deadline is moved to a time that is not a whole second (it is stored rounded up)
      const deadline = now + 11_500;
      await provider.extendExpiry!(s.id, deadline);
      await provider.extendExpiry!(s.id, deadline); // idempotent
      const proxy = await raw.getContainer(`abox-proxy-${short}`).inspect();
      const volume = proxy.Mounts.find((m) => m.Destination === '/etc/abox-proxy')?.Name ?? '';
      expect(volume).not.toBe('');
      // a stop before the deadline is an ordinary stop: everything stays and can be started again
      await provider.stop(s.id);
      expect((await raw.getContainer(`abox-proxy-${short}`).inspect()).State.Running).toBe(false);
      await provider.start(s.id);
      expect((await run(s, 'cat /workspace/result.txt')).stdout).toBe('exported\n');
      // ... after it, the stop also removes the sidecar, its volume and the internal network
      while (Date.now() < deadline + 50) await new Promise((r) => setTimeout(r, 100));
      await provider.stop(s.id);
      await expect(raw.getContainer(`abox-proxy-${short}`).inspect()).rejects.toMatchObject({
        statusCode: 404,
      });
      await expect(raw.getVolume(volume).inspect()).rejects.toMatchObject({ statusCode: 404 });
      await expect(raw.getNetwork(`abox-int-${short}`).inspect()).rejects.toMatchObject({
        statusCode: 404,
      });
      // nothing of the secret is left on the engine
      const all = JSON.stringify(await raw.listContainers({ all: true }));
      expect(all).not.toContain('EXPIRY-SECRET');
      // the sandbox itself is kept, stopped, expired, and its workspace can be read and copied out
      expect((await inspectRaw(s)).State.Running).toBe(false);
      await new Promise((r) => setTimeout(r, 1100)); // (the stored deadline is rounded up to a second)
      expect((await provider.inspect(s.id)).state).toBe('expired');
      expect((await provider.readFile(s.id, '/workspace/result.txt', 100)).data.toString()).toBe(
        'exported\n',
      );
      const out = path.join(tmp, `expired-out-${short}`);
      await provider.copyOut(s.id, '/workspace', out);
      expect(await fs.readFile(path.join(out, 'result.txt'), 'utf8')).toBe('exported\n');
      expect(await provider.networkEvents!(s.id)).toEqual([]);
      // stopping again, starting and removing stay fine
      await provider.stop(s.id);
      await expect(provider.start(s.id)).rejects.toMatchObject({ code: 'conflict' });
      await provider.remove(s.id);
    }, 120_000);

    it('start refuses an expired allowlist sandbox and removes its leftover sidecar', async () => {
      const now = Date.now();
      const s = await sb(
        {
          createdAt: now,
          expiresAt: now + 4000,
          network: {
            mode: 'allowlist',
            allow: ['example.com'],
            blockPrivate: true,
            privateExceptions: [],
            injections: [],
          },
        },
        true,
      );
      const short = s.id.split('/')[1];
      await new Promise((r) => setTimeout(r, 5500));
      // the container ended itself at its deadline; nobody called stop
      expect((await raw.getContainer(`abox-proxy-${short}`).inspect()).State.Running).toBe(true);
      await expect(provider.start(s.id)).rejects.toMatchObject({ code: 'conflict' });
      await expect(raw.getContainer(`abox-proxy-${short}`).inspect()).rejects.toMatchObject({
        statusCode: 404,
      });
      await provider.remove(s.id);
    }, 60_000);

    it('injections without allowlist are rejected', async () => {
      const s = spec({
        network: {
          mode: 'none',
          allow: [],
          blockPrivate: true,
          privateExceptions: [],
          injections: [{ host: 'a.b', header: 'X', value: 'y' }],
        },
      });
      await expect(provider.create(s)).rejects.toMatchObject({ code: 'unsupported' });
    });
  });

  // -------------------------------------------------------------------------
  describe('exec', () => {
    it('argv, command, cwd, env, user, stdin, exit codes, stderr', async () => {
      const s = await sb();
      expect((await provider.exec(s.id, { argv: ['echo', 'a b', '$HOME'] })).stdout).toBe(
        'a b $HOME\n',
      );
      const r = await provider.exec(s.id, {
        command: 'echo out; echo err >&2; exit 3',
        cwd: '/tmp',
        env: { X: '1' },
      });
      expect(r).toMatchObject({
        exitCode: 3,
        stdout: 'out\n',
        stderr: 'err\n',
        truncated: false,
        timedOut: false,
      });
      expect(r.durationMs).toBeGreaterThanOrEqual(0);
      expect(
        (await provider.exec(s.id, { command: 'pwd; echo $X', cwd: '/tmp', env: { X: 'envval' } }))
          .stdout,
      ).toBe('/tmp\nenvval\n');
      expect((await provider.exec(s.id, { command: 'id -un', user: 'root' })).stdout).toBe(
        'root\n',
      );
      expect((await provider.exec(s.id, { argv: ['cat'], stdin: 'from stdin' })).stdout).toBe(
        'from stdin',
      );
      expect(
        (await provider.exec(s.id, { argv: ['cat'], stdin: Buffer.from([0x68, 0x69]) })).stdout,
      ).toBe('hi');
      expect((await provider.exec(s.id, { argv: ['sh', '-c', 'exit 42'] })).exitCode).toBe(42);
      await expect(provider.exec(s.id, {})).rejects.toMatchObject({ code: 'invalid_input' });
      await expect(provider.exec(s.id, { argv: ['a'], command: 'b' })).rejects.toMatchObject({
        code: 'invalid_input',
      });
    });

    it('large stdin and stdout survive demuxing', async () => {
      const s = await sb();
      const big = Buffer.alloc(3 * MiB, 'x');
      const r = await provider.exec(s.id, {
        argv: ['sh', '-c', 'cat; echo done >&2'],
        stdin: big,
        maxOutputBytes: 10 * MiB,
      });
      expect(r.stdout.length).toBe(big.length);
      expect(r.stderr).toBe('done\n');
    });

    it('truncates output per stream at maxOutputBytes', async () => {
      const s = await sb();
      const r = await run(
        s,
        'head -c 100000 /dev/zero | tr "\\0" a; head -c 50 /dev/zero | tr "\\0" b >&2',
        { maxOutputBytes: 1000 },
      );
      expect(r.truncated).toBe(true);
      expect(r.stdout.length).toBe(1000);
      expect(r.stderr.length).toBe(50);
      expect(r.exitCode).toBe(0);
    });

    it('timeout really kills the process tree', async () => {
      const s = await sb();
      const t0 = Date.now();
      const r = await run(s, 'sleep 300', { timeoutMs: 1000 });
      expect(Date.now() - t0).toBeLessThan(6000);
      expect(r.timedOut).toBe(true);
      expect(r.exitCode).toBe(137);
      expect((await run(s, 'ps -o args | grep -c "[s]leep 300"; true')).stdout.trim()).toBe('0');
      // nested tree, background children, subshells
      const r2 = await run(s, '(sleep 301 & sleep 302 & sh -c "sleep 303 & wait") & wait', {
        timeoutMs: 1000,
      });
      expect(r2.timedOut).toBe(true);
      expect((await run(s, 'ps -o args | grep -c "[s]leep 30"; true')).stdout.trim()).toBe('0');
      // a fast command with a timeout is unaffected and leaves no helper behind
      const ok = await run(s, 'echo quick', { timeoutMs: 30_000 });
      expect(ok).toMatchObject({ stdout: 'quick\n', exitCode: 0, timedOut: false });
      expect(
        (
          await run(
            s,
            'ps -o args | grep -c "[s]leep 30"; ls /tmp/.abox-exec-* 2>/dev/null | wc -l',
          )
        ).stdout
          .trim()
          .split('\n'),
      ).toEqual(['0', '0']);
    });

    it('timeout works even when the pids limit is exhausted', async () => {
      // 7 processes are the sandbox's own (init, deadline shell + its sleep, wrapper, watchdog + its sleep, shell): fill the rest
      const s = await sb({ resources: { ...template.resources, pids: 30 } });
      const r = await run(s, 'i=0; while [ $i -lt 23 ]; do sleep 100 & i=$((i+1)); done; wait', {
        timeoutMs: 2000,
      });
      expect(r.timedOut).toBe(true);
      expect((await run(s, 'ps -o args | grep -c "[s]leep 100"; true')).stdout.trim()).toBe('0');
    }, 60_000);

    it('exec keeps working after a timeout, as non-default user too', async () => {
      const s = await sb();
      const r = await provider.exec(s.id, { command: 'sleep 300', timeoutMs: 500, user: 'root' });
      expect(r.timedOut).toBe(true);
      expect((await run(s, 'ps -o args | grep -c "[s]leep 300"; true')).stdout.trim()).toBe('0');
    });

    it('the PATH an agent sets applies to its command, not to the exec wrapper', async () => {
      const s = await sb();
      for (const PATH of ['/nonexistent', '', '/nonexistent:/also/missing']) {
        const t0 = Date.now();
        // a PATH without the system directories: the wrapper's own helpers must still work, so the
        // command runs (by absolute path) and finishes normally instead of being "killed after 0s"
        const ok = await provider.exec(s.id, {
          argv: ['/bin/echo', 'still works'],
          env: { PATH },
          timeoutMs: 30_000,
        });
        expect(ok, PATH).toMatchObject({ stdout: 'still works\n', exitCode: 0, timedOut: false });
        expect(Date.now() - t0, PATH).toBeLessThan(5000);
        // the command sees exactly the PATH it was given
        const seen = await provider.exec(s.id, {
          argv: ['/bin/sh', '-c', 'echo "[$PATH]"'],
          env: { PATH },
          timeoutMs: 30_000,
        });
        expect(seen.stdout, PATH).toBe(`[${PATH}]\n`);
        // and finds nothing it should not: the user's PATH, not the wrapper's, is used for lookup
        const lookup = await provider.exec(s.id, {
          command: 'ls /',
          env: { PATH },
          timeoutMs: 30_000,
        });
        expect(lookup, PATH).toMatchObject({ exitCode: 127, timedOut: false });
        // the watchdog still kills what runs too long with such a PATH
        const slow = await provider.exec(s.id, {
          argv: ['/bin/sleep', '300'],
          env: { PATH },
          timeoutMs: 1000,
        });
        expect(slow, PATH).toMatchObject({ timedOut: true, exitCode: 137 });
      }
      // a PATH that includes the system directories finds commands as usual
      const found = await provider.exec(s.id, {
        command: 'ls / > /dev/null && echo found',
        env: { PATH: '/nonexistent:/bin:/usr/bin' },
        timeoutMs: 30_000,
      });
      expect(found).toMatchObject({ stdout: 'found\n', exitCode: 0 });
      expect((await run(s, 'ps -o args | grep -c "[s]leep 300"; true')).stdout.trim()).toBe('0');
      expect((await run(s, 'ls /tmp/.abox-exec-* 2>/dev/null | wc -l')).stdout.trim()).toBe('0');
      // abort (kill script) also works with such a PATH
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 700);
      await expect(
        provider.exec(s.id, {
          argv: ['/bin/sleep', '300'],
          env: { PATH: '/nonexistent' },
          signal: ac.signal,
        }),
      ).rejects.toMatchObject({ name: 'AbortError' });
    }, 90_000);

    it('abort signal kills the command and rejects', async () => {
      const s = await sb();
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 700);
      const p = provider.exec(s.id, { command: 'sleep 300', signal: ac.signal });
      await expect(p).rejects.toMatchObject({ name: 'AbortError' });
      await new Promise((r) => setTimeout(r, 500));
      expect((await run(s, 'ps -o args | grep -c "[s]leep 300"; true')).stdout.trim()).toBe('0');
      await expect(
        provider.exec(s.id, { command: 'true', signal: AbortSignal.abort() }),
      ).rejects.toBeDefined();
    });

    it('spawn streams events and ends with exit', async () => {
      const s = await sb();
      const events: ExecEvent[] = [];
      for await (const e of provider.spawn(s.id, {
        command: 'echo one; sleep 0.3; echo two >&2; exit 5',
      }))
        events.push(e);
      expect(events[events.length - 1]).toEqual({ type: 'exit', exitCode: 5, timedOut: false });
      const out = events
        .filter((e) => e.type === 'stdout')
        .map((e) => (e as { data: Buffer }).data.toString())
        .join('');
      const err = events
        .filter((e) => e.type === 'stderr')
        .map((e) => (e as { data: Buffer }).data.toString())
        .join('');
      expect(out).toBe('one\n');
      expect(err).toBe('two\n');
      const timed: ExecEvent[] = [];
      for await (const e of provider.spawn(s.id, { command: 'sleep 300', timeoutMs: 800 }))
        timed.push(e);
      expect(timed[timed.length - 1]).toMatchObject({ type: 'exit', timedOut: true });
    });

    it('a background process holding stdout does not hang exec forever', async () => {
      const s = await sb();
      const t0 = Date.now();
      const r = await run(s, '(sleep 20 &) ; echo started');
      expect(r.stdout).toBe('started\n');
      expect(Date.now() - t0).toBeLessThan(8000);
      await run(s, 'pkill sleep; true');
    });

    it('attach gives a TTY with resize and exit code', async () => {
      const s = await sb();
      const tty = await provider.attach(s.id, { cols: 100, rows: 30, argv: ['/bin/sh'] });
      let out = '';
      tty.stream.on('data', (d: Buffer) => (out += d.toString()));
      tty.stream.write('echo cols=$(stty size)\n');
      await new Promise((r) => setTimeout(r, 400));
      await tty.resize(120, 40);
      tty.stream.write('stty size; tty\nexit 7\n');
      expect(await tty.wait()).toBe(7);
      expect(out).toContain('cols=30 100');
      expect(out).toContain('40 120');
      expect(out).toMatch(/\/dev\/pts\//);
      await tty.close();
    });
  });

  // -------------------------------------------------------------------------
  describe('files and workspace', () => {
    it('writeFile/readFile/listDir with ownership and mode', async () => {
      const s = await sb();
      await provider.writeFile(s.id, '/workspace/deep/dir/hello.txt', Buffer.from('hello'), 0o640);
      expect(
        (await run(s, 'stat -c "%U %a" /workspace/deep/dir/hello.txt /workspace/deep')).stdout,
      ).toBe('dev 640\ndev 755\n');
      const r = await provider.readFile(s.id, '/workspace/deep/dir/hello.txt', 3);
      expect(r).toMatchObject({ truncated: true, size: 5 });
      expect(r.data.toString()).toBe('hel');
      expect(
        (await provider.readFile(s.id, '/workspace/deep/dir/hello.txt', 100)).data.toString(),
      ).toBe('hello');
      await run(s, 'ln -s hello.txt /workspace/deep/dir/link; mkdir /workspace/deep/dir/sub');
      expect((await provider.readFile(s.id, '/workspace/deep/dir/link', 100)).data.toString()).toBe(
        'hello',
      );
      await expect(provider.readFile(s.id, '/workspace/nope', 10)).rejects.toMatchObject({
        code: 'not_found',
      });
      await expect(provider.readFile(s.id, '/workspace/deep', 10)).rejects.toMatchObject({
        code: 'invalid_input',
      });
      const ls = await provider.listDir(s.id, '/workspace/deep/dir');
      expect(ls.map((e) => [e.name, e.type])).toEqual([
        ['hello.txt', 'file'],
        ['link', 'symlink'],
        ['sub', 'dir'],
      ]);
      expect(ls[0]).toMatchObject({ size: 5, mode: 0o640 });
      expect(ls[0]?.mtimeMs).toBeGreaterThan(Date.now() - 60_000);
      await expect(provider.listDir(s.id, '/workspace/missing')).rejects.toMatchObject({
        code: 'not_found',
      });
      // works on a stopped sandbox too
      await provider.stop(s.id);
      expect(
        (await provider.readFile(s.id, '/workspace/deep/dir/hello.txt', 100)).data.toString(),
      ).toBe('hello');
      expect((await provider.listDir(s.id, '/workspace/deep/dir')).map((e) => e.name)).toEqual([
        'hello.txt',
        'link',
        'sub',
      ]);
      await provider.writeFile(s.id, '/workspace/while-stopped', Buffer.from('x'));
    });

    it('copyIn / copyOut round trip, directories, symlinks preserved', async () => {
      const s = await sb();
      const src = path.join(tmp, 'ci');
      await fs.mkdir(path.join(src, 'd'), { recursive: true });
      await fs.writeFile(path.join(src, 'd', 'f.txt'), 'file');
      await fs.symlink('f.txt', path.join(src, 'd', 'rel'));
      await fs.symlink('/etc/passwd', path.join(src, 'abs'));
      await provider.copyIn(s.id, src, '/workspace/in');
      expect(
        (
          await run(
            s,
            'cat /workspace/in/d/f.txt; echo; for l in /workspace/in/d/rel /workspace/in/abs; do readlink $l; done; stat -c %U /workspace/in/d/f.txt',
          )
        ).stdout,
      ).toBe('file\nf.txt\n/etc/passwd\ndev\n');
      await provider.copyIn(s.id, path.join(src, 'd', 'f.txt'), '/workspace/single.txt');
      expect((await run(s, 'cat /workspace/single.txt')).stdout).toBe('file');
      // out (relative symlink ok; absolute symlink is refused by the safety rules)
      const out = path.join(tmp, 'co');
      await run(s, 'rm /workspace/in/abs');
      await provider.copyOut(s.id, '/workspace/in', out);
      expect(await fs.readFile(path.join(out, 'd', 'f.txt'), 'utf8')).toBe('file');
      expect((await fs.lstat(path.join(out, 'd', 'rel'))).isSymbolicLink()).toBe(true);
      const one = path.join(tmp, 'one.txt');
      await provider.copyOut(s.id, '/workspace/single.txt', one);
      expect(await fs.readFile(one, 'utf8')).toBe('file');
      await expect(
        provider.copyOut(s.id, '/workspace/missing', path.join(tmp, 'zzz')),
      ).rejects.toMatchObject({ code: 'not_found' });
      await expect(
        provider.copyIn(s.id, path.join(tmp, 'nope'), '/workspace/x'),
      ).rejects.toBeInstanceOf(AboxError);
    });

    it('copyOut refuses archives that escape (symlinks planted by the sandbox)', async () => {
      const s = await sb();
      await run(
        s,
        'mkdir /workspace/evil && ln -s /etc/passwd /workspace/evil/abs && ln -s ../../../escape /workspace/evil/up',
      );
      const dest = path.join(tmp, 'evil-out');
      await expect(provider.copyOut(s.id, '/workspace/evil', dest)).rejects.toMatchObject({
        code: 'policy_denied',
      });
      await run(
        s,
        'rm /workspace/evil/abs /workspace/evil/up; ln -s .. /workspace/evil/dotdot; mkdir -p /workspace/evil/dotdot2; echo data > /workspace/evil/dotdot2/f',
      );
      const dest2 = path.join(tmp, 'evil-out2');
      await expect(provider.copyOut(s.id, '/workspace/evil', dest2))
        .resolves.toBeUndefined()
        .catch(() => undefined);
      await expect(fs.access(path.join(tmp, 'escape'))).rejects.toThrow();
    });

    it('copyIn / copyOut reach the /tmp tmpfs of a running sandbox (the archive API only sees the hidden image dir)', async () => {
      const s = await sb();
      const src = path.join(tmp, 'tmpfs-in');
      await fs.mkdir(path.join(src, 'd', 'empty'), { recursive: true });
      await fs.writeFile(path.join(src, 'd', 'f.txt'), 'tmp-file');
      await fs.writeFile(path.join(src, 'secret'), 'x', { mode: 0o600 });
      await fs.writeFile(path.join(src, 'script.sh'), '#!/bin/sh\n', { mode: 0o755 });
      await fs.symlink('f.txt', path.join(src, 'd', 'rel'));
      await fs.symlink('/etc/passwd', path.join(src, 'abs'));
      await provider.copyIn(s.id, src, '/tmp/in');
      // visible to the sandbox itself, owned by its user, modes and symlinks preserved
      const seen = await run(
        s,
        'cat /tmp/in/d/f.txt; echo; stat -c "%U %a" /tmp/in /tmp/in/secret /tmp/in/script.sh /tmp/in/d/empty /tmp/in/d/f.txt; for l in /tmp/in/d/rel /tmp/in/abs; do readlink $l; done',
      );
      expect(seen.stdout).toBe(
        'tmp-file\ndev 755\ndev 600\ndev 755\ndev 755\ndev 644\nf.txt\n/etc/passwd\n',
      );
      // ... and through the other file APIs
      expect((await provider.readFile(s.id, '/tmp/in/d/f.txt', 100)).data.toString()).toBe(
        'tmp-file',
      );
      expect((await provider.listDir(s.id, '/tmp/in')).map((e) => e.name)).toEqual([
        'abs',
        'd',
        'script.sh',
        'secret',
      ]);
      // the hidden image directory below the mount was not touched
      const hidden = await raw
        .getContainer(`abox-local-${s.id.split('/')[1]}`)
        .getArchive({ path: '/tmp/in' })
        .then(
          () => true,
          () => false,
        );
      expect(hidden).toBe(false);

      // single file, and overwriting an existing file
      await provider.copyIn(s.id, path.join(src, 'd', 'f.txt'), '/tmp/single.txt');
      await fs.writeFile(path.join(src, 'd', 'f.txt'), 'v2');
      await provider.copyIn(s.id, path.join(src, 'd', 'f.txt'), '/tmp/single.txt');
      expect((await run(s, 'cat /tmp/single.txt')).stdout).toBe('v2');
      // deeper, not yet existing destination directories are created
      await provider.copyIn(s.id, path.join(src, 'd', 'f.txt'), '/tmp/new/dir/f.txt');
      expect((await run(s, 'cat /tmp/new/dir/f.txt')).stdout).toBe('v2');

      // out: what the sandbox wrote itself (the absolute symlink is refused by the safety rules)
      await run(
        s,
        'rm /tmp/in/abs; mkdir /tmp/made && echo made > /tmp/made/m.txt && head -c 300000 /dev/urandom > /tmp/made/big.bin',
      );
      const out = path.join(tmp, 'tmpfs-out');
      await provider.copyOut(s.id, '/tmp/in', out);
      expect(await fs.readFile(path.join(out, 'd', 'f.txt'), 'utf8')).toBe('tmp-file');
      expect((await fs.lstat(path.join(out, 'd', 'rel'))).isSymbolicLink()).toBe(true);
      expect((await fs.stat(path.join(out, 'secret'))).mode & 0o777).toBe(0o600);
      expect((await fs.stat(path.join(out, 'd', 'empty'))).isDirectory()).toBe(true);
      const made = path.join(tmp, 'tmpfs-made');
      await provider.copyOut(s.id, '/tmp/made', made);
      expect(await fs.readFile(path.join(made, 'm.txt'), 'utf8')).toBe('made\n');
      expect((await fs.stat(path.join(made, 'big.bin'))).size).toBe(300000);
      const one = path.join(tmp, 'tmpfs-one.txt');
      await provider.copyOut(s.id, '/tmp/single.txt', one);
      expect(await fs.readFile(one, 'utf8')).toBe('v2');
      // a file named like an option does not confuse tar
      await run(s, 'echo dash > /tmp/-n');
      await provider.copyOut(s.id, '/tmp/-n', path.join(tmp, 'tmpfs-dash'));
      expect(await fs.readFile(path.join(tmp, 'tmpfs-dash'), 'utf8')).toBe('dash\n');
      // a whole round trip of binary content
      const blob = Buffer.from(Array.from({ length: 70_000 }, (_, i) => (i * 31) % 256));
      await fs.writeFile(path.join(tmp, 'blob.bin'), blob);
      await provider.copyIn(s.id, path.join(tmp, 'blob.bin'), '/tmp/blob.bin');
      await provider.copyOut(s.id, '/tmp/blob.bin', path.join(tmp, 'blob.back'));
      expect((await fs.readFile(path.join(tmp, 'blob.back'))).equals(blob)).toBe(true);
    });

    it('copyIn / copyOut under /tmp: errors are clear (missing, stopped, mount point, tmpfs full, escapes)', async () => {
      const s = await sb();
      await expect(
        provider.copyOut(s.id, '/tmp/missing', path.join(tmp, 'tmpfs-missing')),
      ).rejects.toMatchObject({ code: 'not_found' });
      await expect(
        provider.copyIn(s.id, path.join(tmp, 'does-not-exist'), '/tmp/x'),
      ).rejects.toMatchObject({ code: 'not_found' });
      await expect(provider.copyIn(s.id, tmp, '/tmp')).rejects.toMatchObject({
        code: 'invalid_input',
      });
      // a symlink is refused as the source (it is never followed)
      await fs.symlink('/etc/passwd', path.join(tmp, 'tmpfs-link'));
      await expect(
        provider.copyIn(s.id, path.join(tmp, 'tmpfs-link'), '/tmp/l'),
      ).rejects.toMatchObject({ code: 'invalid_input' });
      // the sandbox cannot make copyOut write outside the destination
      await run(
        s,
        'mkdir /tmp/evil && ln -s /etc/passwd /tmp/evil/abs && ln -s ../../../escape /tmp/evil/up',
      );
      await expect(
        provider.copyOut(s.id, '/tmp/evil', path.join(tmp, 'tmpfs-evil')),
      ).rejects.toMatchObject({ code: 'policy_denied' });
      await expect(fs.access(path.join(tmp, 'escape'))).rejects.toThrow();
      // the tmpfs size is limited: a copy that does not fit fails loudly instead of truncating
      await fs.writeFile(path.join(tmp, 'tmpfs-big.txt'), 'small');
      const big = path.join(tmp, 'tmpfs-big.bin');
      const mib = (await run(s, 'df -m /tmp | tail -1 | tr -s " " | cut -d" " -f2')).stdout.trim();
      await fs.writeFile(big, Buffer.alloc((Number(mib) + 8) * 1024 * 1024, 1));
      await expect(provider.copyIn(s.id, big, '/tmp/big.bin')).rejects.toMatchObject({
        code: 'backend_error',
      });
      await fs.rm(big);
      // stopped (or never started): the tmpfs does not exist, so nothing can be copied silently into the void
      await provider.stop(s.id);
      await expect(provider.copyIn(s.id, tmp, '/tmp/stopped')).rejects.toMatchObject({
        code: 'conflict',
      });
      await expect(
        provider.copyOut(s.id, '/tmp/in', path.join(tmp, 'tmpfs-stopped')),
      ).rejects.toMatchObject({ code: 'conflict' });
      // outside the tmpfs a stopped sandbox keeps working
      await provider.copyIn(s.id, path.join(tmp, 'tmpfs-big.txt'), '/workspace/stopped.txt');
    });

    it('copy delivery: files owned by the user, symlinks stay symlinks, nothing outside is read', async () => {
      const secret = path.join(tmp, 'secret-outside.txt');
      await fs.writeFile(secret, 'TOP-SECRET-HOST-DATA');
      const src = path.join(tmp, 'ws-copy');
      await fs.mkdir(path.join(src, 'sub'), { recursive: true });
      await fs.mkdir(path.join(src, 'node_modules'), { recursive: true });
      await fs.writeFile(path.join(src, 'node_modules', 'big'), 'x');
      await fs.writeFile(path.join(src, 'a.txt'), 'A');
      await fs.writeFile(path.join(src, 'sub', 'b.txt'), 'B');
      await fs.symlink(secret, path.join(src, 'leak'));
      await fs.symlink('../secret-outside.txt', path.join(src, 'sub', 'leak-rel'));
      await fs.symlink(tmp, path.join(src, 'leak-dir'));
      const s = await sb({
        workspace: {
          kind: 'copy',
          hostPath: src,
          sandboxPath: '/workspace',
          exclude: ['node_modules'],
        },
      });
      expect((await run(s, 'cat a.txt sub/b.txt; stat -c "%U:%G" a.txt sub .')).stdout).toBe(
        'AB' + 'dev:dev\ndev:dev\ndev:dev\n',
      );
      expect(
        (await run(s, 'for l in leak sub/leak-rel leak-dir; do readlink $l; done')).stdout,
      ).toBe(`${secret}\n../secret-outside.txt\n${tmp}\n`);
      // the host path of the symlink target does not exist in the sandbox: nothing was dereferenced
      expect(
        (
          await run(
            s,
            `cat leak 2>&1; ls leak-dir 2>&1; grep -r TOP-SECRET /workspace /home /tmp 2>/dev/null | head -1; true`,
          )
        ).stdout,
      ).not.toContain('TOP-SECRET');
      expect((await run(s, 'ls node_modules 2>&1')).stdout).toMatch(/No such file/);
      // workspace changes do not touch the host copy
      await run(s, 'echo changed > a.txt');
      expect(await fs.readFile(path.join(src, 'a.txt'), 'utf8')).toBe('A');
    });

    it('none delivery gives an empty user-owned directory (also at custom paths)', async () => {
      const s = await sb({ workspace: { kind: 'none', sandboxPath: '/work/space' } });
      expect((await run(s, 'pwd; ls -A | wc -l; stat -c %U .')).stdout).toBe(
        '/work/space\n0\ndev\n',
      );
      expect((await run(s, 'touch f && echo writable')).stdout).toBe('writable\n');
    });

    it('bind delivery: rw workspace with read-only .git, ro mode, extra ro mounts', async () => {
      const src = path.join(tmp, 'ws-bind');
      await fs.mkdir(path.join(src, '.git', 'hooks'), { recursive: true });
      await fs.writeFile(path.join(src, '.git', 'config'), '[core]');
      await fs.writeFile(path.join(src, 'code.ts'), 'x');
      const extra = path.join(tmp, 'extra-ro');
      await fs.mkdir(extra);
      await fs.writeFile(path.join(extra, 'data.txt'), 'extra');
      const s = await sb({
        workspace: {
          kind: 'bind',
          hostPath: src,
          sandboxPath: '/workspace',
          access: 'rw',
          readonlySubpaths: ['.git', 'does-not-exist'],
        },
        mounts: [{ hostPath: extra, sandboxPath: '/mnt/extra', access: 'ro' }],
      });
      expect((await run(s, 'echo new > code.ts && echo ok')).stdout).toBe('ok\n');
      expect(await fs.readFile(path.join(src, 'code.ts'), 'utf8')).toBe('new\n');
      const hook = await run(
        s,
        '{ echo evil > .git/hooks/pre-commit; } 2>&1; echo rc=$?; { echo evil > .git/config; } 2>&1; echo rc=$?',
      );
      expect(hook.stdout).toMatch(
        /Read-only file system[\s\S]*rc=1[\s\S]*Read-only file system[\s\S]*rc=1/,
      );
      await expect(fs.access(path.join(src, '.git', 'hooks', 'pre-commit'))).rejects.toThrow();
      expect(
        (await run(s, 'cat /mnt/extra/data.txt; touch /mnt/extra/x 2>&1; echo rc=$?')).stdout,
      ).toMatch(/^extra[\s\S]*Read-only[\s\S]*rc=1/);
      const mounts = (
        (await provider.inspect(s.id)).effective as {
          mounts: Array<{ target: string; readOnly: boolean }>;
        }
      ).mounts;
      expect(mounts.find((m) => m.target === '/workspace/.git')?.readOnly).toBe(true);
      expect(mounts.find((m) => m.target === '/workspace')?.readOnly).toBe(false);
      // ro workspace
      const ro = await sb({
        workspace: { kind: 'bind', hostPath: src, sandboxPath: '/workspace', access: 'ro' },
      });
      expect((await run(ro, 'touch x 2>&1; echo rc=$?')).stdout).toMatch(/Read-only[\s\S]*rc=1/);
    });

    describe.skipIf(process.platform !== 'linux' || !process.getuid || process.getuid() === 0)(
      'bind delivery maps the sandbox process to the host user',
      () => {
        const hostUid = process.getuid?.() ?? 0;
        const hostGid = process.getgid?.() ?? 0;
        // a template uid that differs from the host user (CI runners have uid 1001, laptops 1000)
        const tUid = [4242, 4343].find((u) => u !== hostUid) ?? 4242;
        const mapped = makeTemplate({
          name: 'abox-test-hostmap',
          user: { name: 'dev', uid: tUid, sudo: false },
          build: [
            {
              name: 'seed home',
              script:
                'mkdir -p /home/dev/.cache && echo old > /home/dev/.cache/seed && chown -R dev:dev /home/dev',
            },
          ],
        });
        let mappedImage: PreparedImage;
        const msb = async (over: Partial<SandboxSpec> = {}): Promise<SandboxSpec> =>
          track.create(makeSpec(mapped, mappedImage.ref, over));

        beforeAll(async () => {
          mappedImage = await provider.prepare(mapped);
        }, 300_000);

        for (const readonlyRootfs of [false, true]) {
          it(`rw bind: runs as host uid:gid, writes work, home is usable (read-only rootfs: ${readonlyRootfs})`, async () => {
            const src = await fs.mkdtemp(path.join(tmp, 'ws-map-'));
            await fs.writeFile(path.join(src, 'code.ts'), 'x');
            const s = await msb({
              workspace: { kind: 'bind', hostPath: src, sandboxPath: '/workspace', access: 'rw' },
              files: [
                {
                  sandboxPath: '/home/dev/.config/tool/secret',
                  content: Buffer.from('s3cret'),
                  mode: 0o600,
                },
              ],
              labels: readonlyRootfs ? { 'abox.readonly-rootfs': 'true' } : {},
            });
            const c = await inspectRaw(s);
            expect(c.Config.User).toBe(`${hostUid}:${hostGid}`);
            const home = readonlyRootfs ? '/tmp' : '/home/dev';
            expect(c.Config.Env).toContain(`HOME=${home}`);
            expect(c.Config.Labels['abox.user']).toBe(`dev:${tUid}`);
            // hardening is unchanged
            expect(c.HostConfig.CapDrop).toEqual(['ALL']);
            expect(c.HostConfig.SecurityOpt).toContain('no-new-privileges:true');
            expect(c.HostConfig.ReadonlyRootfs).toBe(readonlyRootfs);
            expect((await run(s, 'id -u; id -g; echo $HOME')).stdout).toBe(
              `${hostUid}\n${hostGid}\n${home}\n`,
            );
            expect(
              (await run(s, 'echo new > code.ts && echo n > created.ts && echo ok')).stdout,
            ).toBe('ok\n');
            expect(await fs.readFile(path.join(src, 'code.ts'), 'utf8')).toBe('new\n');
            const st = await fs.stat(path.join(src, 'created.ts'));
            expect([st.uid, st.gid]).toEqual([hostUid, hostGid]);
            // HOME is writable, and the image home (what the build and spec.files put there)
            // belongs to the running user and can be modified
            const owner = `${hostUid}:${hostGid}\n`;
            expect(
              (
                await run(
                  s,
                  'exec 2>&1; touch ~/new && echo more >> /home/dev/.cache/seed && touch /home/dev/.cache/new2 && ' +
                    'cat /home/dev/.cache/seed && stat -c "%u:%g" /home/dev/.cache /home/dev/.cache/seed /home/dev/.config/tool/secret && cat /home/dev/.config/tool/secret',
                )
              ).stdout,
            ).toBe(`old\nmore\n${owner.repeat(3)}s3cret`);
            if (!readonlyRootfs) {
              // the home directory itself too (on a read-only rootfs its volume root can not be re-owned)
              expect((await run(s, 'stat -c "%u:%g" /home/dev')).stdout).toBe(owner);
            }
            // not root, no extra rights
            expect(
              (
                await run(
                  s,
                  '{ echo x > /etc/abox-x; } 2>&1; echo rc=$?; cat /proc/self/status | grep CapEff',
                )
              ).stdout,
            ).toMatch(/rc=1[\s\S]*CapEff:\s+0+\n/);
          });
        }

        it('rw extra mount alone also maps; ro-only binds and copy delivery keep the template user', async () => {
          const extra = await fs.mkdtemp(path.join(tmp, 'extra-map-'));
          const m = await msb({
            mounts: [{ hostPath: extra, sandboxPath: '/mnt/rw', access: 'rw' }],
          });
          expect((await run(m, 'id -u; echo y > /mnt/rw/f && echo ok')).stdout).toBe(
            `${hostUid}\nok\n`,
          );

          const src = await fs.mkdtemp(path.join(tmp, 'ws-map-ro-'));
          const ro = await msb({
            workspace: { kind: 'bind', hostPath: src, sandboxPath: '/workspace', access: 'ro' },
            mounts: [{ hostPath: extra, sandboxPath: '/mnt/ro', access: 'ro' }],
          });
          expect((await inspectRaw(ro)).Config.User).toBe(`${tUid}:${tUid}`);
          expect((await run(ro, 'id -u')).stdout).toBe(`${tUid}\n`);

          const cp = await msb({
            workspace: { kind: 'copy', hostPath: src, sandboxPath: '/workspace' },
          });
          expect((await inspectRaw(cp)).Config.User).toBe(`${tUid}:${tUid}`);
          expect((await run(cp, 'stat -c "%u:%g" . ~; id -un')).stdout).toBe(
            `${tUid}:${tUid}\n${tUid}:${tUid}\ndev\n`,
          );
        });

        it('refuses a writable bind when abox itself runs as root (uid or gid 0)', async () => {
          const src = await fs.mkdtemp(path.join(tmp, 'ws-map-root-'));
          const bindSpec = makeSpec(mapped, mappedImage.ref, {
            workspace: { kind: 'bind', hostPath: src, sandboxPath: '/workspace', access: 'rw' },
          });
          const uidSpy = vi.spyOn(process, 'getuid').mockReturnValue(0);
          try {
            await expect(provider.create(bindSpec)).rejects.toMatchObject({ code: 'unsupported' });
          } finally {
            uidSpy.mockRestore();
          }
          const gidSpy = vi.spyOn(process, 'getgid').mockReturnValue(0);
          try {
            await expect(provider.create(bindSpec)).rejects.toMatchObject({ code: 'unsupported' });
          } finally {
            gidSpy.mockRestore();
          }
          await expect(provider.inspect(bindSpec.id)).rejects.toMatchObject({ code: 'not_found' });
        });
      },
    );

    it('a workspace symlink to a host secret is not readable through a bind mount', async () => {
      const secretDir = await fs.mkdtemp(path.join(tmp, 'ssh-'));
      await fs.writeFile(path.join(secretDir, 'id_rsa'), 'PRIVATE KEY');
      const src = path.join(tmp, 'ws-bind-link');
      await fs.mkdir(src);
      await fs.symlink(path.join(secretDir, 'id_rsa'), path.join(src, 'key'));
      const s = await sb({
        workspace: { kind: 'bind', hostPath: src, sandboxPath: '/workspace', access: 'rw' },
      });
      expect((await run(s, 'cat key 2>&1; true')).stdout).not.toContain('PRIVATE KEY');
    });

    it('spec.files: mode, ownership, CA dir stays root-owned; /tmp rejected', async () => {
      const s = await sb({
        files: [
          {
            sandboxPath: '/home/dev/.config/tool/secret',
            content: Buffer.from('s3cret'),
            mode: 0o600,
          },
          {
            sandboxPath: '/usr/local/share/abox/extra.crt',
            content: Buffer.from('crt'),
            mode: 0o644,
          },
        ],
      });
      expect(
        (
          await run(
            s,
            'stat -c "%U %a" /home/dev/.config/tool/secret /usr/local/share/abox/extra.crt; cat /home/dev/.config/tool/secret',
          )
        ).stdout,
      ).toBe('dev 600\nroot 644\ns3cret');
      expect(
        (await run(s, '{ echo x >> /usr/local/share/abox/extra.crt; } 2>&1; echo rc=$?')).stdout,
      ).toMatch(/denied[\s\S]*rc=1/);
      await expect(
        provider.create(
          spec({ files: [{ sandboxPath: '/tmp', content: Buffer.from('x'), mode: 0o644 }] }),
        ),
      ).rejects.toMatchObject({ code: 'invalid_input' });
    });

    for (const readonlyRootfs of [false, true]) {
      it(`spec.files under /tmp (a tmpfs) appear at every start (read-only rootfs: ${readonlyRootfs})`, async () => {
        const t = readonlyRootfs
          ? makeTemplate({ ...template, labels: { 'abox.readonly-rootfs': 'true' } })
          : template;
        const s = spec({
          template: t,
          labels: readonlyRootfs ? { 'abox.readonly-rootfs': 'true' } : {},
          files: [
            { sandboxPath: '/tmp/top.txt', content: Buffer.from('top'), mode: 0o644 },
            { sandboxPath: '/tmp/d/e/secret', content: Buffer.from('s3cret'), mode: 0o600 },
          ],
        });
        await track.create(s, false);
        // nothing is visible before the start, and nothing lands on the rootfs /tmp
        expect((await inspectRaw(s)).Config.Labels['abox.tmp-files']).toBe('1');
        const check = async (): Promise<void> => {
          expect(
            (await run(s, 'cat /tmp/top.txt /tmp/d/e/secret; stat -c "%a %U" /tmp/d/e/secret'))
              .stdout,
          ).toBe('tops3cret600 dev\n');
          expect((await run(s, 'mount | grep " /tmp " | cut -d" " -f1')).stdout).toBe('tmpfs\n');
        };
        await provider.start(s.id);
        await check();
        // the file API sees the tmpfs of a running sandbox
        await provider.writeFile(s.id, '/tmp/w/new.txt', Buffer.from('written'), 0o600);
        const back = await provider.readFile(s.id, '/tmp/w/new.txt', 100);
        expect(back.data.toString()).toBe('written');
        expect((await run(s, 'stat -c "%a %U" /tmp/w/new.txt')).stdout).toBe('600 dev\n');
        expect((await provider.readFile(s.id, '/tmp/d/e/secret', 2)).truncated).toBe(true);
        await expect(provider.readFile(s.id, '/tmp/nope', 10)).rejects.toMatchObject({
          code: 'not_found',
        });
        await expect(provider.readFile(s.id, '/tmp/d', 10)).rejects.toMatchObject({
          code: 'invalid_input',
        });
        await provider.stop(s.id);
        await provider.start(s.id);
        await check();
      });
    }
  });

  // -------------------------------------------------------------------------
  describe('ttl', () => {
    it('labels carry created/expires and the main process exits at expiry', async () => {
      const now = Date.now();
      const s = await sb({ createdAt: now, expiresAt: now + 4000 }, false);
      const info = await provider.inspect(s.id);
      expect(info.expiresAt).toBe(s.expiresAt);
      expect(info.createdAt).toBe(now);
      const raw1 = await inspectRaw(s);
      expect(raw1.Config.Labels['abox.expires']).toBe(String(s.expiresAt));
      await provider.start(s.id);
      expect((await provider.inspect(s.id)).state).toBe('running');
      await new Promise((r) => setTimeout(r, 6500));
      const after = await inspectRaw(s);
      expect(after.State.Running).toBe(false);
      expect(after.State.ExitCode).toBe(0);
      expect((await provider.inspect(s.id)).state).toBe('expired');
      expect((await provider.list({ state: 'expired' })).map((i) => i.id)).toContain(s.id);
      await expect(provider.start(s.id)).rejects.toMatchObject({ code: 'conflict' });
      expect((await inspectRaw(s)).State.Running).toBe(false);
      await provider.remove(s.id);
    }, 30_000);

    it('a restarted sandbox exits at the original expiry, not later', async () => {
      const now = Date.now();
      const s = await sb({ createdAt: now, expiresAt: now + 6000 }, true);
      await provider.stop(s.id);
      await new Promise((r) => setTimeout(r, 2000));
      await provider.start(s.id);
      // Poll instead of a fixed sleep: slow CI runners need a few seconds of slack,
      // but the container must still exit close to the ORIGINAL expiry (not a fresh TTL).
      const deadline = now + 6000 + 5000;
      let running = true;
      while (Date.now() < deadline) {
        running = (await inspectRaw(s)).State.Running;
        if (!running) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      expect(running).toBe(false);
    }, 30_000);

    it('creating with an expiry in the past succeeds; the sandbox is expired and can not start', async () => {
      const s = spec({ expiresAt: Date.now() - 1000 });
      await track.create(s, false);
      expect((await provider.inspect(s.id)).state).toBe('expired');
      expect((await provider.list({ state: 'expired' })).map((i) => i.id)).toContain(s.id);
      await expect(provider.start(s.id)).rejects.toMatchObject({ code: 'conflict' });
    });

    describe('updateResources', () => {
      it('updates the live container: cpu, memory and swap together, kept across a restart', async () => {
        const s = await sb();
        const before = (await inspectRaw(s)).HostConfig;
        await provider.updateResources!(s.id, { cpus: 0.5, memoryBytes: 300 * MiB });
        const hc = (await inspectRaw(s)).HostConfig;
        expect(hc.NanoCpus).toBe(500_000_000);
        expect(hc.Memory).toBe(300 * MiB);
        expect(hc.MemorySwap).toBe(300 * MiB); // still no swap
        expect(hc.PidsLimit).toBe(before.PidsLimit); // untouched
        const info = await provider.inspect(s.id);
        expect(info.effective).toMatchObject({ cpus: 0.5, memoryBytes: 300 * MiB });
        // the cgroup the sandbox sees moved too
        const mem = await run(
          s,
          'cat /sys/fs/cgroup/memory.max 2>/dev/null || cat /sys/fs/cgroup/memory/memory.limit_in_bytes',
        );
        expect(Number(mem.stdout.trim())).toBe(300 * MiB);
        // raising it above the old limit works (swap moves together with memory)
        await provider.updateResources!(s.id, { memoryBytes: 600 * MiB });
        expect((await inspectRaw(s)).HostConfig.Memory).toBe(600 * MiB);
        expect((await inspectRaw(s)).HostConfig.MemorySwap).toBe(600 * MiB);
        await provider.stop(s.id);
        await provider.updateResources!(s.id, { cpus: 1.5 }); // a stopped sandbox too
        await provider.start(s.id);
        const again = (await inspectRaw(s)).HostConfig;
        expect(again.NanoCpus).toBe(1_500_000_000);
        expect(again.Memory).toBe(600 * MiB);
        expect((await run(s, 'echo ok')).stdout).toBe('ok\n');
      }, 60_000);
    });

    describe('extendExpiry', () => {
      const EXPIRY_PATH = '/usr/local/share/abox/expires';
      const roTemplate = (): ResolvedTemplate =>
        makeTemplate({ ...template, labels: { 'abox.readonly-rootfs': 'true' } });

      for (const readonlyRootfs of [false, true]) {
        it(`moves the in-container deadline (${readonlyRootfs ? 'read-only' : 'writable'} rootfs), survives stop/start and reads back`, async () => {
          const now = Date.now();
          const s = await sb(
            {
              createdAt: now,
              expiresAt: now + 5000,
              ...(readonlyRootfs
                ? { template: roTemplate(), labels: { 'abox.readonly-rootfs': 'true' } }
                : {}),
            },
            true,
          );
          const moved = now + 60_000;
          await provider.extendExpiry!(s.id, moved);
          // the label is immutable, the stored deadline is what inspect / list report now
          expect((await inspectRaw(s)).Config.Labels['abox.expires']).toBe(String(s.expiresAt));
          const info = await provider.inspect(s.id);
          expect(info.expiresAt).toBeGreaterThanOrEqual(moved);
          expect(info.expiresAt).toBeLessThan(moved + 1000);
          expect((await provider.list()).find((i) => i.id === s.id)?.expiresAt).toBe(
            info.expiresAt,
          );
          // the sandbox user can not move it itself
          const w = await run(s, `echo 9999999999 > ${EXPIRY_PATH}; echo rc=$?`);
          expect(w.stdout).toMatch(/rc=[1-9]/);
          // well past the original deadline
          await new Promise((r) => setTimeout(r, Math.max(0, s.expiresAt - Date.now()) + 3000));
          expect((await inspectRaw(s)).State.Running).toBe(true);
          expect((await provider.inspect(s.id)).state).toBe('running');
          expect((await run(s, 'echo alive')).stdout).toBe('alive\n');
          // a restart honours the moved deadline (the label's is over)
          await provider.stop(s.id);
          await provider.start(s.id);
          expect((await run(s, 'echo again')).stdout).toBe('again\n');
          // never earlier than the current one; an equal one is a no-op
          await expect(provider.extendExpiry!(s.id, s.expiresAt + 1000)).rejects.toMatchObject({
            code: 'invalid_input',
          });
          await provider.extendExpiry!(s.id, info.expiresAt);
        }, 60_000);
      }

      it('the sandbox file APIs never write abox-internal paths', async () => {
        const now = Date.now();
        const s = await sb({ createdAt: now, expiresAt: now + 60_000 }, true);
        const forged = Buffer.from(`${Math.ceil(now / 1000) + 99_999}\n`);
        const denied = { code: 'policy_denied' };
        await expect(provider.writeFile(s.id, EXPIRY_PATH, forged)).rejects.toMatchObject(denied);
        await expect(
          provider.writeFile(s.id, '/usr/local/share/../share/abox/./expires', forged),
        ).rejects.toMatchObject(denied);
        await expect(
          provider.writeFile(s.id, '/usr/local/share/abox/ca.crt', forged),
        ).rejects.toMatchObject(denied);
        await expect(
          provider.writeFile(s.id, '/usr/local/share/abox/new/dir/x', forged),
        ).rejects.toMatchObject(denied);
        const src = path.join(tmp, 'internal-src');
        await fs.mkdir(path.join(src, 'abox'), { recursive: true });
        await fs.writeFile(path.join(src, 'abox', 'expires'), forged);
        await fs.writeFile(path.join(src, 'expires'), forged);
        for (const dest of [
          EXPIRY_PATH,
          '/usr/local/share/abox',
          '/usr/local/share/abox/sub',
          '/usr/local/share',
          '/usr/local',
        ]) {
          await expect(provider.copyIn(s.id, src, dest)).rejects.toMatchObject(denied);
        }
        // nothing arrived, and nothing else is affected
        expect((await run(s, `cat ${EXPIRY_PATH} 2>&1; echo rc=$?`)).stdout).toMatch(/rc=1/);
        expect(await provider.extendExpiry!(s.id, now + 120_000)).toBeUndefined();
        await provider.writeFile(s.id, '/workspace/ok.txt', Buffer.from('fine'));
        await provider.copyIn(s.id, path.join(src, 'expires'), '/workspace/copied');
        expect((await run(s, 'cat /workspace/ok.txt /workspace/copied')).stdout).toContain('fine');
        expect((await provider.inspect(s.id)).expiresAt).toBeLessThan(now + 121_000);
      }, 60_000);

      it('a deadline file the sandbox smuggled in through a symlink is ignored', async () => {
        const now = Date.now();
        const s = await sb({ createdAt: now, expiresAt: now + 4000 }, true);
        // The lexical check cannot see this; the file ends up owned by the sandbox user.
        await run(s, 'ln -s /usr/local/share/abox /workspace/link');
        const forged = Buffer.from(`${Math.ceil(now / 1000) + 99_999}\n`);
        await provider.writeFile(s.id, '/workspace/link/expires', forged).catch(() => undefined);
        const seen = await run(s, `stat -c '%u %a' ${EXPIRY_PATH} 2>&1 || true`);
        // the engine follows the link (the file is there, owned by the sandbox user): the entrypoint and the backend ignore it
        expect(seen.exitCode).toBe(0);
        for (let i = 0; i < 30 && (await inspectRaw(s)).State.Running; i++)
          await new Promise((r) => setTimeout(r, 500));
        const after = await inspectRaw(s);
        expect(after.State.Running).toBe(false);
        expect(after.State.ExitCode).toBe(0);
        expect(Date.parse(after.State.FinishedAt)).toBeLessThan(now + 12_000);
        expect((await provider.inspect(s.id)).state).toBe('expired');
        expect((await provider.inspect(s.id)).expiresAt).toBe(s.expiresAt);
      }, 40_000);

      it('exits at the moved deadline and not at the original one', async () => {
        const now = Date.now();
        const s = await sb({ createdAt: now, expiresAt: now + 4000 }, true);
        await provider.extendExpiry!(s.id, now + 9000);
        await new Promise((r) => setTimeout(r, 6500));
        expect((await inspectRaw(s)).State.Running).toBe(true);
        for (let i = 0; i < 20 && (await inspectRaw(s)).State.Running; i++)
          await new Promise((r) => setTimeout(r, 500));
        const after = await inspectRaw(s);
        expect(after.State.Running).toBe(false);
        expect(after.State.ExitCode).toBe(0);
        expect(Date.parse(after.State.FinishedAt)).toBeGreaterThanOrEqual(now + 8500);
        expect((await provider.inspect(s.id)).state).toBe('expired');
      }, 40_000);

      it('works on a stopped sandbox and survives a snapshot restore', async () => {
        const now = Date.now();
        const s = await sb({ createdAt: now, expiresAt: now + 5000 }, true);
        const snap = await provider.snapshot!(s.id, 'before-extend');
        await provider.stop(s.id);
        await provider.extendExpiry!(s.id, now + 60_000);
        await provider.start(s.id);
        await provider.restore!(s.id, snap); // the snapshot holds the old deadline
        await new Promise((r) => setTimeout(r, Math.max(0, s.expiresAt - Date.now()) + 3000));
        expect((await inspectRaw(s)).State.Running).toBe(true);
        expect((await run(s, 'echo alive')).stdout).toBe('alive\n');
      }, 60_000);

      it('rejects an expired sandbox, bad values and unknown ids', async () => {
        const s = spec({ expiresAt: Date.now() - 1000 });
        await track.create(s, false);
        await expect(provider.extendExpiry!(s.id, Date.now() + 60_000)).rejects.toMatchObject({
          code: 'conflict',
        });
        const live = await sb({}, false);
        await expect(provider.extendExpiry!(live.id, Number.NaN)).rejects.toMatchObject({
          code: 'invalid_input',
        });
        await expect(
          provider.extendExpiry!('local/doesnotexist', Date.now() + 60_000),
        ).rejects.toMatchObject({ code: 'not_found' });
      });
    });
  });

  // -------------------------------------------------------------------------
  describe('snapshots', () => {
    it('snapshot + restore returns filesystem state and keeps hardening/labels', async () => {
      const s = await sb();
      await run(s, 'echo v1 > /home/dev/state.txt');
      const snap = await provider.snapshot!(s.id, 'before');
      expect(snap).toBe(`abox-snap/${s.id.split('/')[1]}:before`);
      await run(s, 'echo v2 > /home/dev/state.txt; echo extra > /home/dev/extra.txt');
      const idBefore = (await inspectRaw(s)).Id;
      await provider.restore!(s.id, snap);
      expect((await inspectRaw(s)).Id).not.toBe(idBefore);
      expect((await provider.inspect(s.id)).state).toBe('running');
      expect((await run(s, 'cat /home/dev/state.txt; ls /home/dev/extra.txt 2>&1')).stdout).toMatch(
        /^v1\n[\s\S]*No such file/,
      );
      const c = await inspectRaw(s);
      expect(c.HostConfig.CapDrop).toEqual(['ALL']);
      expect(c.HostConfig.SecurityOpt).toEqual(['no-new-privileges:true']);
      expect(c.Config.User).toBe('1000:1000');
      expect(c.Config.Labels['abox.id']).toBe(s.id);
      expect(c.Config.Labels['abox.expires']).toBe(String(s.expiresAt));
      expect(c.Config.Env).toContain('FOO=bar');
      // stopped sandboxes stay stopped after restore
      await provider.stop(s.id);
      await provider.restore!(s.id, snap);
      expect((await provider.inspect(s.id)).state).toBe('created');
      await provider.start(s.id);
      expect((await run(s, 'cat /home/dev/state.txt')).stdout).toBe('v1\n');
      await expect(provider.restore!(s.id, 'abox-snap/other:x')).rejects.toMatchObject({
        code: 'not_found',
      });
      await expect(provider.snapshot!(s.id, 'Bad Name')).rejects.toMatchObject({
        code: 'invalid_input',
      });
      // remove deletes the snapshot images
      await provider.remove(s.id);
      await expect(raw.getImage(snap).inspect()).rejects.toMatchObject({ statusCode: 404 });
    }, 60_000);
  });

  describe('logs', () => {
    it('returns the main process output (empty for the TTL sleeper) without failing', async () => {
      const s = await sb();
      expect(typeof (await provider.logs!(s.id, { tail: 10 }))).toBe('string');
    });
  });
});

// ---------------------------------------------------------------------------
// The shared provider contract, against real Docker. Declared in this file (not its own) so that
// it runs after the suite above: both clean up by label. The provider has an instance id of its own, so the
// gc tests only ever delete images that this very suite built, however busy the shared engine is.
defineProviderContract({
  name: 'docker',
  skip: !dockerEnabled,
  gc: true,
  timeoutMs: 120_000,
  createProvider: () => newProvider({ instanceId: `${TEST_INSTANCE}c` }),
  template: () =>
    makeTestTemplate({
      name: 'abox-test-contract',
      backend: 'docker',
      isolation: 'container',
      base: { os: 'alpine:3.22', osFamily: 'alpine' },
    }),
  async dispose() {
    await sweepTestObjects();
  },
});
