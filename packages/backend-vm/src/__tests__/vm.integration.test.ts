import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTestSpec, randomId, sleep, waitFor } from '@abox/contract-tests';
import type {
  NetworkSpec,
  PreparedImage,
  ResolvedTemplate,
  SandboxProvider,
  SandboxSpec,
} from '@abox/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { VmProvider } from '../provider.js';
import { VM_TESTS, createTestProvider, disposeTestDirs, vmTemplate } from './env.js';

/**
 * Integration tests that boot real VMs (ABOX_TEST_VM=1). They reuse the prepared images in the
 * test cache, so only the first run pays for the download and the image builds.
 */

const T = 240_000;
const CURL_STEP = {
  name: 'apt: curl dnsutils iproute2',
  script:
    'set -eu\nexport DEBIAN_FRONTEND=noninteractive\napt-get update\napt-get install -y --no-install-recommends curl dnsutils iproute2 ca-certificates\nrm -rf /var/lib/apt/lists/*\n',
};

function qemuProcessesFor(dir: string): string[] {
  const out = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
  return out.split('\n').filter((l) => l.includes('qemu-system') && l.includes(dir));
}

async function hostOnline(): Promise<boolean> {
  try {
    const r = await fetch('https://example.com/', { signal: AbortSignal.timeout(8000) });
    return r.ok;
  } catch {
    return false;
  }
}

describe.skipIf(!VM_TESTS)('vm backend (real VMs)', () => {
  let p: VmProvider;
  let template: ResolvedTemplate;
  let image: PreparedImage;
  let dataDir: string;
  const created: string[] = [];

  async function spec(over: Partial<SandboxSpec> = {}): Promise<SandboxSpec> {
    const s = await makeTestSpec(p, template, { image, ...over });
    created.push(s.id);
    return s;
  }
  async function boot(over: Partial<SandboxSpec> = {}): Promise<SandboxSpec> {
    const s = await spec(over);
    await p.create(s);
    await p.start(s.id);
    return s;
  }
  const sh = (id: string, command: string, extra = {}) =>
    p.exec(id, { command, timeoutMs: 60_000, ...extra });
  const allow = (hosts: string[], extra: Partial<NetworkSpec> = {}): NetworkSpec => ({
    mode: 'allowlist',
    allow: hosts,
    blockPrivate: true,
    privateExceptions: [],
    injections: [],
    ...extra,
  });

  beforeAll(async () => {
    p = await createTestProvider();
    dataDir = (p as unknown as { layout: { base: string } }).layout.base;
    template = vmTemplate({ build: [CURL_STEP] });
    image = await p.prepare(template, {
      onProgress: (l) => process.stderr.write(`    build: ${l.slice(0, 140)}\n`),
    });
  }, 20 * 60_000);

  afterAll(async () => {
    for (const id of created) {
      await p.remove(id).catch(() => undefined);
    }
    // Nothing of ours may keep running.
    expect(qemuProcessesFor(dataDir)).toEqual([]);
    await disposeTestDirs();
  }, 120_000);

  it('prepare is cached the second time and pins the base image', async () => {
    const again = await p.prepare(template);
    expect(again.cached).toBe(true);
    expect(again.ref).toBe(image.ref);
    expect(again.pinnedBase).toMatch(/^debian-12@sha512:[0-9a-f]{128}$/);
  });

  it(
    'runs commands as the non-root template user, in its own kernel',
    async () => {
      const s = await boot();
      const r = await sh(
        s.id,
        'id -u; id -un; uname -r; echo $HOME; pwd; sudo -n true 2>&1; echo rc=$?',
      );
      const lines = r.stdout.split('\n');
      expect(lines[0]).toBe('1000');
      expect(lines[1]).toBe('agent');
      const hostKernel = execFileSync('uname', ['-r'], { encoding: 'utf8' }).trim();
      expect(lines[2]).not.toBe(hostKernel);
      expect(lines[2]).toMatch(/cloud/);
      expect(lines[3]).toBe('/home/agent');
      expect(lines[4]).toBe('/workspace');
      // no sudo for this template
      expect(r.stdout).not.toMatch(/rc=0/);
      // root is available for internal use only
      const root = await p.exec(s.id, { argv: ['id', '-u'], user: 'root' });
      expect(root.stdout.trim()).toBe('0');
      const info = await p.inspect(s.id);
      expect(info.backend).toBe('vm');
      expect(info.isolation).toBe('vm');
      expect(info.effective).toMatchObject({ cpus: 1, memoryMiB: 512, networkMode: 'none' });
    },
    T,
  );

  it(
    'state survives stop/start: files stay, env and expiry are re-applied',
    async () => {
      const s = await boot({ env: { KEEP: 'yes' } });
      await p.writeFile(s.id, '/home/agent/keep.txt', Buffer.from('persist'));
      await p.stop(s.id);
      expect((await p.inspect(s.id)).state).toBe('stopped');
      await p.start(s.id);
      expect((await p.readFile(s.id, '/home/agent/keep.txt', 100)).data.toString()).toBe('persist');
      expect((await sh(s.id, 'echo $KEEP')).stdout).toBe('yes\n');
      const ttl = await p.exec(s.id, {
        command: 'systemctl list-timers abox-ttl.timer --no-legend | wc -l',
        user: 'root',
      });
      expect(ttl.stdout.trim()).toBe('1');
    },
    T,
  );

  describe('network', () => {
    it(
      'mode none: no NIC, no route, no DNS',
      async () => {
        const s = await boot();
        const r = await sh(
          s.id,
          'ls /sys/class/net; ip -4 route | wc -l; getent hosts example.com; echo dns=$?; curl -sS -m 4 http://93.184.216.34/ ; echo curl=$?',
        );
        expect(r.stdout.split('\n')[0]).toBe('lo');
        expect(r.stdout).toContain('\n0\n');
        expect(r.stdout).toMatch(/dns=2/);
        expect(r.stdout).toMatch(/curl=(7|28|6)/);
      },
      T,
    );

    it(
      'mode allowlist: allowed host works through the proxy, others and direct access are denied',
      async (ctx) => {
        if (!(await hostOnline())) return ctx.skip();
        const s = await boot({ network: allow(['example.com']) });
        const env = await sh(s.id, 'echo $HTTPS_PROXY; echo $NO_PROXY');
        expect(env.stdout).toBe('http://10.0.2.100:3128\nlocalhost,127.0.0.1,::1\n');
        const ok = await sh(
          s.id,
          'curl -sS -m 20 -o /dev/null -w "%{http_code}" https://example.com/',
        );
        expect(ok.stdout).toBe('200');
        const plain = await sh(
          s.id,
          'curl -sS -m 20 -o /dev/null -w "%{http_code}" http://example.com/',
        );
        expect(plain.stdout).toBe('200');
        const denied = await sh(
          s.id,
          'curl -sS -m 20 -o /dev/null -w "%{http_code}" https://example.org/ ; echo rc=$?',
        );
        expect(denied.stdout + denied.stderr).toMatch(/rc=(56|35|7|22|0)|403|CONNECT/);
        expect(denied.stdout).not.toMatch(/^200/);
        // no way around the proxy: no default route, no DNS, no direct connections
        const direct = await sh(
          s.id,
          'ip -4 route | grep -c default; getent hosts example.com >/dev/null; echo dns=$?; curl --noproxy "*" -sS -m 5 -o /dev/null https://93.184.216.34/; echo direct=$?; dig +time=2 +tries=1 @10.0.2.3 example.com +short; echo dig=$?',
        );
        expect(direct.stdout).toMatch(/^0\n/);
        expect(direct.stdout).toMatch(/dns=2/);
        expect(direct.stdout).toMatch(/direct=(7|28)/);
        expect(direct.stdout).not.toMatch(/\d+\.\d+\.\d+\.\d+\ndig=0/);
        // audit trail
        const ev = await p.networkEvents(s.id);
        expect(ev.some((e) => e.host === 'example.com' && e.decision === 'allow')).toBe(true);
        expect(ev.some((e) => e.host === 'example.org' && e.decision === 'deny')).toBe(true);
        // runtime rule change (access_request network): example.org becomes reachable without a restart
        await p.updateNetwork(s.id, allow(['example.com', 'example.org']));
        const now = await sh(
          s.id,
          'curl -sS -m 20 -o /dev/null -w "%{http_code}" https://example.org/',
        );
        expect(now.stdout).toBe('200');
        // private addresses are blocked by the proxy even for allowlisted names
        const priv = await sh(
          s.id,
          'curl -sS -m 10 -o /dev/null -w "%{http_code}" http://10.0.2.2/ ; echo rc=$?',
        );
        expect(priv.stdout).not.toMatch(/^200/);
      },
      T,
    );

    it(
      'mode allowlist: stopping the sandbox stops its proxy; start brings it back',
      async (ctx) => {
        if (!(await hostOnline())) return ctx.skip();
        const s = await boot({ network: allow(['example.com']) });
        const proxyPid = Number(
          (
            await readFile(
              join(dataDir, 'sandboxes', s.id.split('/')[1] as string, 'proxy', 'proxy.pid'),
              'utf8',
            )
          ).trim(),
        );
        expect(() => process.kill(proxyPid, 0)).not.toThrow();
        await p.stop(s.id);
        await expect(
          waitFor(() => {
            try {
              process.kill(proxyPid, 0);
              return false;
            } catch {
              return true;
            }
          }, 5000),
        ).resolves.toBe(true);
        await p.start(s.id);
        const ok = await sh(
          s.id,
          'curl -sS -m 20 -o /dev/null -w "%{http_code}" https://example.com/',
        );
        expect(ok.stdout).toBe('200');
      },
      T,
    );

    it(
      'mode open: NAT access to the internet',
      async (ctx) => {
        if (!(await hostOnline())) return ctx.skip();
        const s = await boot({
          network: {
            mode: 'open',
            allow: [],
            blockPrivate: true,
            privateExceptions: [],
            injections: [],
          },
        });
        const r = await sh(
          s.id,
          'curl -sS -m 20 -o /dev/null -w "%{http_code}" https://example.com/',
        );
        expect(r.stdout).toBe('200');
      },
      T,
    );

    it(
      'proxy injections: the CA is installed and the secret never enters the guest',
      async (ctx) => {
        if (!(await hostOnline())) return ctx.skip();
        const s = await boot({
          network: allow(['example.com'], {
            injections: [{ host: 'example.com', header: 'X-Abox-Test', value: 'secret-value-123' }],
          }),
        });
        const r = await sh(
          s.id,
          'echo $SSL_CERT_FILE; test -s /usr/local/share/abox/ca.crt && echo ca-ok; grep -c "BEGIN CERTIFICATE" /usr/local/share/abox/ca-bundle.crt',
        );
        expect(r.stdout).toContain('/usr/local/share/abox/ca-bundle.crt');
        expect(r.stdout).toContain('ca-ok');
        const ok = await sh(
          s.id,
          'curl -sS -m 20 -o /dev/null -w "%{http_code}" https://example.com/',
        );
        expect(ok.stdout).toBe('200'); // TLS terminated by the proxy with the per-sandbox CA, verified by the guest
        const leak = await p.exec(s.id, {
          command:
            'grep -rl secret-value-123 / --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev 2>/dev/null | head -3',
          user: 'root',
          timeoutMs: 60_000,
        });
        expect(leak.stdout.trim()).toBe('');
        const ev = await p.networkEvents(s.id);
        expect(ev.some((e) => e.host === 'example.com' && e.decision === 'allow')).toBe(true);
      },
      T,
    );
  });

  describe('lifecycle and limits', () => {
    it(
      'the guest powers itself off at expiry (host-side kill is the backstop)',
      async () => {
        const s = await spec({ expiresAt: Date.now() + 20_000 });
        await p.create(s);
        await p.start(s.id);
        const short = s.id.split('/')[1] as string;
        const pidOf = (): Promise<number | undefined> =>
          (p as unknown as { qemuPid(s: string): Promise<number | undefined> }).qemuPid(short);
        expect(await pidOf()).toBeDefined();
        const t0 = Date.now();
        await expect(waitFor(async () => (await pidOf()) === undefined, 60_000, 500)).resolves.toBe(
          true,
        );
        const dt = Date.now() - t0;
        // started ~4 s into the 20 s TTL: the VM must be gone around expiry, not much earlier and clearly before the 30 s kill backstop
        expect(dt).toBeGreaterThan(8_000);
        expect(dt).toBeLessThan(40_000);
        expect((await p.inspect(s.id)).state).toBe('expired');
      },
      T,
    );

    it(
      'extendExpiry moves both the guest timer and the host kill time',
      async () => {
        const s = await spec({ expiresAt: Date.now() + 22_000 });
        await p.create(s);
        await p.start(s.id);
        const moved = Date.now() + 180_000;
        await p.extendExpiry(s.id, moved);
        expect((await p.inspect(s.id)).expiresAt).toBe(moved);
        const short = s.id.split('/')[1] as string;
        const limit = (p as unknown as { layout: { hardLimitFile(s: string): string } }).layout;
        const killAt = Number((await readFile(limit.hardLimitFile(short), 'utf8')).trim());
        expect(killAt).toBeGreaterThanOrEqual(Math.ceil(moved / 1000) + 30);
        // past the original expiry AND the original kill time (expiry + 30 s)
        await new Promise((r) => setTimeout(r, Math.max(0, s.expiresAt + 36_000 - Date.now())));
        expect((await p.inspect(s.id)).state).toBe('running');
        expect((await sh(s.id, 'echo alive')).stdout).toBe('alive\n');
        await p.stop(s.id);
        await p.start(s.id);
        expect((await sh(s.id, 'echo again')).stdout).toBe('again\n');
        await expect(p.extendExpiry(s.id, s.expiresAt)).rejects.toMatchObject({
          code: 'invalid_input',
        });
      },
      T,
    );

    it('expired sandboxes can not be started or used', async () => {
      const s = await spec({ expiresAt: Date.now() - 1000 });
      await p.create(s);
      await expect(p.start(s.id)).rejects.toMatchObject({ code: 'conflict' });
    });

    it(
      'applies cpu and memory limits to the VM',
      async () => {
        const s = await boot({
          resources: { ...template.resources, cpus: 2, memoryBytes: 768 * 1024 * 1024 },
        });
        const r = await sh(s.id, 'nproc; grep MemTotal /proc/meminfo');
        expect(r.stdout.split('\n')[0]).toBe('2');
        const kb = Number(/MemTotal:\s+(\d+)/.exec(r.stdout)?.[1]);
        expect(kb).toBeGreaterThan(600_000);
        expect(kb).toBeLessThan(800_000);
      },
      T,
    );

    it(
      'enforces the pids limit inside the guest',
      async () => {
        const s = await boot({ resources: { ...template.resources, pids: 48 } });
        // python3 ships with the cloud images (cloud-init needs it); a shell would die on the first failed fork
        const r = await sh(
          s.id,
          `python3 -c "
import subprocess
ok = 0
for i in range(120):
    try:
        subprocess.Popen(['sleep', '5'])
        ok += 1
    except OSError:
        break
print(ok)"`,
        );
        const alive = Number(r.stdout.trim().split('\n').pop());
        expect(alive).toBeGreaterThan(10);
        expect(alive).toBeLessThan(60);
        // internal control (root, outside the limited cgroup) is not affected while the limit is exhausted
        expect((await p.exec(s.id, { argv: ['echo', 'root-ok'], user: 'root' })).stdout).toBe(
          'root-ok\n',
        );
        // and the sandbox user can work again once the processes are gone
        await sleep(6000);
        expect((await sh(s.id, 'echo still-ok')).stdout).toBe('still-ok\n');
      },
      T,
    );

    it(
      'grows the root file system to the requested disk size',
      async () => {
        const s = await boot({ resources: { ...template.resources, diskBytes: 12 * 1024 ** 3 } });
        const r = await sh(s.id, 'df -BG --output=size / | tail -1');
        expect(Number(r.stdout.trim().replace('G', ''))).toBeGreaterThanOrEqual(11);
      },
      T,
    );

    it(
      'snapshot/restore also works for a stopped sandbox (boots straight into the snapshot)',
      async () => {
        const s = await boot();
        await p.writeFile(s.id, '/workspace/snap.txt', Buffer.from('v1'));
        await sh(s.id, 'sleep 300 >/dev/null 2>&1 </dev/null & echo $! > bg.pid');
        const snap = await p.snapshot!(s.id, 'before');
        await expect(p.snapshot!(s.id, 'before')).rejects.toMatchObject({ code: 'conflict' });
        await p.writeFile(s.id, '/workspace/snap.txt', Buffer.from('v2'));
        await p.stop(s.id);
        const t = Date.now();
        await p.restore!(s.id, snap);
        expect(Date.now() - t).toBeLessThan(30_000);
        expect((await p.inspect(s.id)).state).toBe('running');
        expect((await p.readFile(s.id, '/workspace/snap.txt', 10)).data.toString()).toBe('v1');
        // a full-VM snapshot keeps processes alive
        const pid = (await p.readFile(s.id, '/workspace/bg.pid', 20)).data.toString().trim();
        expect((await p.exec(s.id, { argv: ['kill', '-0', pid] })).exitCode).toBe(0);
        await expect(p.restore!(s.id, 'nope')).rejects.toMatchObject({ code: 'not_found' });
      },
      T,
    );
  });

  describe('terminal', () => {
    it(
      'attach: pty with window size, resize, Ctrl-C and the exit code',
      async () => {
        const s = await boot();
        const session = await p.attach(s.id, {
          cols: 80,
          rows: 24,
          argv: ['/bin/bash', '--norc', '-i'],
        });
        let out = '';
        session.stream.on('data', (d: Buffer | string) => {
          out += d.toString();
        });
        const waitOut = async (re: RegExp): Promise<boolean> => {
          const ok = await waitFor(() => re.test(out), 15_000, 50);
          if (!ok)
            process.stderr.write(
              `    terminal output while waiting for ${String(re)}: ${JSON.stringify(out)}\n`,
            );
          return ok;
        };
        expect(await waitOut(/bash-[\d.]+\$ /)).toBe(true);
        session.stream.write("PS1='READY> '\n");
        expect(await waitOut(/READY> $/)).toBe(true);
        session.stream.write('stty size; echo user=$(id -un) term=$TERM\n');
        expect(await waitOut(/24 80\r?\n/)).toBe(true);
        expect(out).toContain('user=agent term=xterm-256color');
        await session.resize(120, 40);
        session.stream.write('stty size\n');
        expect(await waitOut(/40 120\r?\n/)).toBe(true);
        out = '';
        session.stream.write('sleep 100\n');
        await sleep(500);
        session.stream.write('\x03');
        session.stream.write('echo after-interrupt\n');
        expect(await waitOut(/after-interrupt\r?\n/)).toBe(true);
        session.stream.write('exit 7\n');
        expect(await session.wait()).toBe(7);
        await session.close();
        // the sandbox is clean afterwards
        const leftover = await p.exec(s.id, {
          command: 'ls /run/abox/x | grep -c tty- || true',
          user: 'root',
        });
        expect(leftover.stdout.trim()).toBe('0');
      },
      T,
    );

    it(
      'attach: closing the session ends the shell',
      async () => {
        const s = await boot();
        const session = await p.attach(s.id, { cols: 100, rows: 30 });
        session.stream.on('data', () => undefined);
        await sleep(1000);
        const t = Date.now();
        await session.close();
        expect(Date.now() - t).toBeLessThan(10_000);
        const left = await p.exec(s.id, {
          command: 'ps -eo args | grep -c "[s]cript -qefc"',
          user: 'root',
        });
        expect(left.stdout.trim()).toBe('0');
      },
      T,
    );
  });

  describe('files and workspace', () => {
    it(
      'copyOut of a directory (the export path) preserves content, and hostile archives can not escape',
      async () => {
        const s = await boot();
        await sh(
          s.id,
          'mkdir -p out/sub && echo hello > out/sub/a.txt && ln -s /etc/passwd out/abs-link && ln -s ../../../../etc/shadow out/escape-link && ln -s sub/a.txt out/ok-link && mkfifo out/fifo && chmod 4755 out/sub/a.txt',
        );
        const dest = await mkdtemp(join(tmpdir(), 'abox-vm-out-'));
        try {
          await p.copyOut(s.id, 'out', join(dest, 'result'));
          expect(await readFile(join(dest, 'result', 'sub', 'a.txt'), 'utf8')).toBe('hello\n');
          const names = (await readdir(join(dest, 'result'))).sort();
          expect(names).toEqual(['ok-link', 'sub']); // absolute/escaping symlinks and the fifo are dropped
          expect((await stat(join(dest, 'result', 'sub', 'a.txt'))).mode & 0o7000).toBe(0); // no setuid on the host
        } finally {
          await rm(dest, { recursive: true, force: true });
        }
      },
      T,
    );

    it(
      'transfers a large file in both directions',
      async () => {
        const s = await boot();
        const dir = await mkdtemp(join(tmpdir(), 'abox-vm-big-'));
        try {
          const big = Buffer.alloc(24 * 1024 * 1024);
          for (let i = 0; i < big.length; i += 4096) big.writeUInt32BE(i, i);
          await writeFile(join(dir, 'big.bin'), big);
          let t = Date.now();
          await p.copyIn(s.id, join(dir, 'big.bin'), '/home/agent/big.bin');
          const up = Date.now() - t;
          const sum = await sh(s.id, 'sha256sum big.bin | cut -d" " -f1', { cwd: '/home/agent' });
          const { createHash } = await import('node:crypto');
          expect(sum.stdout.trim()).toBe(createHash('sha256').update(big).digest('hex'));
          t = Date.now();
          await p.copyOut(s.id, '/home/agent/big.bin', join(dir, 'back.bin'));
          const down = Date.now() - t;
          expect((await readFile(join(dir, 'back.bin'))).equals(big)).toBe(true);
          process.stderr.write(`    24 MiB: copyIn ${up} ms, copyOut ${down} ms\n`);
          // writeFile/readFile above the inline limit
          await p.writeFile(s.id, '/home/agent/w.bin', big.subarray(0, 3 * 1024 * 1024));
          const rd = await p.readFile(s.id, '/home/agent/w.bin', 10 * 1024 * 1024);
          expect(rd.data.equals(big.subarray(0, 3 * 1024 * 1024))).toBe(true);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      },
      T,
    );

    it(
      'copy delivery keeps symlinks as symlinks and applies excludes; stdin larger than the inline limit works',
      async () => {
        const src = await mkdtemp(join(tmpdir(), 'abox-vm-ws-'));
        try {
          await mkdir(join(src, 'keep'));
          await mkdir(join(src, 'skip'));
          await writeFile(join(src, 'keep', 'f.txt'), 'f');
          await writeFile(join(src, 'skip', 'g.txt'), 'g');
          await symlink('keep/f.txt', join(src, 'link'));
          const s = await boot({
            workspace: {
              kind: 'copy',
              hostPath: src,
              sandboxPath: '/workspace',
              exclude: ['skip'],
            },
          });
          const r = await sh(s.id, 'ls; readlink link; stat -c %U keep/f.txt');
          expect(r.stdout).toBe('keep\nlink\nkeep/f.txt\nagent\n');
          const big = Buffer.alloc(700 * 1024, 'x');
          const out = await p.exec(s.id, { command: 'wc -c', stdin: big });
          expect(out.stdout.trim()).toBe(String(big.length));
        } finally {
          await rm(src, { recursive: true, force: true });
        }
      },
      T,
    );

    it('rejects bind delivery and mounts without leaving anything behind', async () => {
      const bind = await spec({
        workspace: { kind: 'bind', hostPath: tmpdir(), sandboxPath: '/workspace', access: 'rw' },
      });
      await expect(p.create(bind)).rejects.toMatchObject({ code: 'unsupported' });
      const mount = await spec({
        mounts: [{ hostPath: tmpdir(), sandboxPath: '/mnt/x', access: 'ro' }],
      });
      await expect(p.create(mount)).rejects.toMatchObject({ code: 'unsupported' });
      expect((await p.list()).map((i) => i.id)).not.toContain(bind.id);
      expect((await p.list()).map((i) => i.id)).not.toContain(mount.id);
    });
  });

  describe('images', () => {
    it('unknown base images are unsupported', async () => {
      await expect(
        p.prepare(
          vmTemplate({ base: { os: 'alpine:3.20', osFamily: 'debian' }, hash: 'x'.repeat(8) }),
        ),
      ).rejects.toMatchObject({ code: 'unsupported' });
      await expect(
        p.prepare(
          vmTemplate({ base: { os: 'debian-12', osFamily: 'alpine' }, hash: 'y'.repeat(8) }),
        ),
      ).rejects.toMatchObject({ code: 'unsupported' });
      await expect(
        p.prepare(
          vmTemplate({
            base: { dockerfile: 'Dockerfile', osFamily: 'debian' },
            hash: 'z'.repeat(8),
          }),
        ),
      ).rejects.toMatchObject({ code: 'unsupported' });
    });

    it(
      'a failing build step fails the prepare with the log tail and leaves no image',
      async () => {
        const bad = vmTemplate({
          build: [{ name: 'setup #1', script: 'set -eu\necho about-to-fail\nfalse\n' }],
          hash: `bad${randomId('', 4)}`,
        });
        const err = await p.prepare(bad).catch((e: unknown) => e);
        expect((err as { code?: string }).code).toBe('backend_error');
        expect(String((err as Error).message)).toMatch(/step 1/);
        expect(JSON.stringify((err as { details?: unknown }).details)).toContain('about-to-fail');
        const again = await p.prepare(
          vmTemplate({
            build: [{ name: 'ok', script: 'set -eu\ntrue\n' }],
            hash: `ok${randomId('', 4)}`,
          }),
        );
        expect(again.cached).toBe(false);
      },
      10 * 60_000,
    );
  });

  it(
    'cleanup: removed sandboxes leave no qemu process and no files',
    async () => {
      const s = await boot();
      const short = s.id.split('/')[1] as string;
      expect(qemuProcessesFor(dataDir).length).toBeGreaterThan(0);
      await p.remove(s.id);
      await sleep(300);
      expect((await p.list()).map((i) => i.id)).not.toContain(s.id);
      await expect(stat(join(dataDir, 'sandboxes', short))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(qemuProcessesFor(join(dataDir, 'sandboxes', short))).toEqual([]);
    },
    T,
  );
});

export type { SandboxProvider };
