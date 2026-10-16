import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Docker from 'dockerode';
import { AboxError } from '@abox/core';
import type { ExecEvent, PreparedImage, ResolvedTemplate, SandboxSpec } from '@abox/core';
import { createDockerProvider, type DockerProvider } from './index.js';
import { MiB, makeSpec, makeTemplate } from './__tests__/helpers.js';
import { dockerEnabled, newProvider, sweepTestObjects, Tracker } from './__tests__/harness.js';
import { defaultProxyAssets } from './proxy.js';
import { existsSync } from 'node:fs';

const SOCK = '/var/run/docker.sock';
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
        labels: { 'abox.test': '1', note: 'x' },
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
        { extraLabels: { 'abox.test': '1' } },
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
      // 6 processes are the sandbox's own (init, main sleep, wrapper, watchdog + its sleep, shell): fill the rest
      const s = await sb({ resources: { ...template.resources, pids: 30 } });
      const r = await run(s, 'i=0; while [ $i -lt 24 ]; do sleep 100 & i=$((i+1)); done; wait', {
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
          spec({ files: [{ sandboxPath: '/tmp/x', content: Buffer.from('x'), mode: 0o644 }] }),
        ),
      ).rejects.toMatchObject({ code: 'unsupported' });
    });
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
      await new Promise((r) => setTimeout(r, 5000));
      expect((await inspectRaw(s)).State.Running).toBe(false);
    }, 30_000);

    it('creating with an expiry in the past is invalid', async () => {
      await expect(provider.create(spec({ expiresAt: Date.now() - 1 }))).rejects.toMatchObject({
        code: 'invalid_input',
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
