import { type ChildProcess, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAboxError } from '../errors.js';
import { HostCache } from '../state/host-cache.js';
import { openDatabase } from '../state/db.js';
import { closeSshConnection } from './control.js';
import { run } from './exec.js';
import type { HostProfile } from './model.js';
import { checkHostKey, forgetHostKey, scanHostKey, trustHostKey } from './known-hosts.js';
import { parseSshG } from './effective.js';
import { HostRegistry } from './registry.js';
import { createHostResolver } from './resolver.js';
import { buildSshArgs, sshBinary, sshSessionArgs, type HostsEnv } from './ssh-args.js';
import { readRemoteLive } from './live.js';
import { testHost } from './test-host.js';
import { getEngineInfo } from './engine-info.js';
import { TUNNEL_SUPERVISOR, TunnelManager, openEngineTunnel } from './tunnel.js';

/**
 * Integration tests against a REAL sshd in a throw-away alpine container (label abox.test=1),
 * reachable on 127.0.0.1:<random port>. They use a temporary key pair, a temporary
 * known_hosts and an empty ssh config (-F): nothing under ~/.ssh or ~/.config/abox is touched.
 * Run with ABOX_TEST_DOCKER=1.
 */
const DOCKER = process.env.ABOX_TEST_DOCKER === '1';
const IMAGE = 'abox-test-sshd:1';
const FAKE_SOCK = '/tmp/fake-engine.sock';

const ROOTLESS_INFO =
  '{"SecurityOptions":["name=seccomp","name=rootless"],"Runtimes":{"runc":{},"runsc":{}}}';
const ROOTFUL_INFO = '{"SecurityOptions":["name=seccomp,profile=builtin"],"Runtimes":{"runc":{}}}';
const FAKE_SOCK_ROOTFUL = '/tmp/fake-rootful.sock';

/** A tiny HTTP responder (run by socat per connection) that answers like an engine: /_ping, /version, /info. */
const fakeEngine = (info: string) => `#!/bin/sh
read -r line
while read -r h; do
  [ -z "$h" ] && break
  [ "$h" = "$(printf '\\r')" ] && break
done
case "$line" in
  "GET /_ping"*) body="OK" ;;
  "GET /version"*) body='{"Version":"fake-1.0"}' ;;
  "GET /info"*) body='${info}' ;;
  *) body="pong" ;;
esac
printf 'HTTP/1.1 200 OK\\r\\nContent-Type: text/plain\\r\\nContent-Length: %s\\r\\nConnection: close\\r\\n\\r\\n%s' "\${#body}" "$body"
`;

const DOCKERFILE = `FROM alpine:3.22
LABEL abox.test=1
RUN apk add --no-cache openssh-server socat \\
 && adduser -D -s /bin/sh tester && sed -i 's/^tester:!/tester:*/' /etc/shadow \\
 && mkdir -p /home/tester/.ssh /root/.ssh && chown tester:tester /home/tester/.ssh && chmod 700 /home/tester/.ssh /root/.ssh \\
 && printf 'PasswordAuthentication no\\nPermitRootLogin prohibit-password\\nAllowTcpForwarding yes\\nAllowStreamLocalForwarding yes\\nAllowAgentForwarding yes\\nAcceptEnv MYVAR\\nLogLevel VERBOSE\\nPerSourcePenalties no\\n' > /etc/ssh/sshd_config
COPY fake-engine.sh fake-engine-rootful.sh /usr/local/bin/
RUN chmod 755 /usr/local/bin/fake-engine.sh /usr/local/bin/fake-engine-rootful.sh
`;

async function sh(file: string, args: string[], opts: { input?: string; timeoutMs?: number } = {}) {
  return run(file, args, {
    timeoutMs: opts.timeoutMs ?? 120_000,
    ...(opts.input !== undefined ? { input: opts.input } : {}),
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

function httpGet(socketPath: string, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method: 'GET', timeout: 5000 }, (res) => {
      let body = '';
      res.setEncoding('utf8').on('data', (d: string) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!DOCKER)('hosts against a real sshd (docker)', () => {
  let tmp: string;
  let container = '';
  let port = 0;
  let env: HostsEnv;
  let profile: HostProfile;
  let agent: ChildProcess | undefined;
  const audits: Array<{ action: string; details: Record<string, unknown> }> = [];
  const keyPath = () => join(tmp, 'id_test');

  const base = (over: Partial<HostProfile> = {}): HostProfile => ({
    id: 'sbx',
    kind: 'ssh',
    hostname: '127.0.0.1',
    port,
    user: 'tester',
    identityFile: keyPath(),
    zone: 'lab',
    backends: ['docker'],
    engineSocket: FAKE_SOCK,
    tags: [],
    favorite: false,
    portForwards: [],
    ...over,
  });

  const dockerExec = (args: string[], opts: { user?: string } = {}) =>
    sh('docker', ['exec', ...(opts.user ? ['-u', opts.user] : []), container, ...args]);

  async function waitForSshd(): Promise<void> {
    for (let i = 0; i < 80; i++) {
      const r = await run(
        'ssh-keyscan',
        ['-T', '2', '-p', String(port), '-t', 'ed25519', '127.0.0.1'],
        { timeoutMs: 5000 },
      );
      if (r.stdout.includes('ssh-ed25519')) return;
      await sleep(250);
    }
    throw new Error('sshd did not come up');
  }

  async function hostKeyFingerprint(): Promise<string> {
    const pub = await dockerExec(['cat', '/etc/ssh/ssh_host_ed25519_key.pub']);
    const fp = await sh('ssh-keygen', ['-l', '-E', 'sha256', '-f', '-'], { input: pub.stdout });
    return fp.stdout.trim().split(/\s+/)[1]!;
  }

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'abox-h-'));
    mkdirSync(join(tmp, 'ctx'));
    writeFileSync(join(tmp, 'ctx', 'Dockerfile'), DOCKERFILE);
    writeFileSync(join(tmp, 'ctx', 'fake-engine.sh'), fakeEngine(ROOTLESS_INFO));
    writeFileSync(join(tmp, 'ctx', 'fake-engine-rootful.sh'), fakeEngine(ROOTFUL_INFO));
    const build = await sh('docker', ['build', '-q', '-t', IMAGE, join(tmp, 'ctx')]);
    if (build.code !== 0) throw new Error(`docker build failed: ${build.stderr}`);

    // key pairs: `id_test` is authorized, `id_other` is not
    for (const k of ['id_test', 'id_other']) {
      const r = await sh('ssh-keygen', [
        '-q',
        '-t',
        'ed25519',
        '-N',
        '',
        '-C',
        'abox-test',
        '-f',
        join(tmp, k),
      ]);
      if (r.code !== 0) throw new Error(r.stderr);
    }
    // an empty ssh config keeps the tests independent of the real ~/.ssh/config; jump hops do
    // not inherit -i, so the ProxyJump tests use a config that names the identity
    writeFileSync(join(tmp, 'ssh_config'), '');
    writeFileSync(
      join(tmp, 'ssh_jump_config'),
      `IdentityFile ${join(tmp, 'id_test')}\nIdentitiesOnly yes\n`,
    );

    port = await freePort();
    container = `abox-test-sshd-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
    const started = await sh('docker', [
      'run',
      '-d',
      '--name',
      container,
      '--label',
      'abox.test=1',
      '-p',
      `127.0.0.1:${port}:22`,
      IMAGE,
      'sh',
      '-c',
      'ssh-keygen -A && exec /usr/sbin/sshd -D -e',
    ]);
    if (started.code !== 0) throw new Error(`docker run failed: ${started.stderr}`);
    const pub = readFileSync(join(tmp, 'id_test.pub'), 'utf8');
    for (const [user, home] of [
      ['tester', '/home/tester'],
      ['root', '/root'],
    ] as const) {
      await sh('docker', [
        'cp',
        join(tmp, 'id_test.pub'),
        `${container}:${home}/.ssh/authorized_keys`,
      ]);
      await dockerExec(['chown', `${user}:${user}`, `${home}/.ssh/authorized_keys`]);
      await dockerExec(['chmod', '600', `${home}/.ssh/authorized_keys`]);
    }
    expect(pub).toContain('ssh-ed25519');
    await waitForSshd();

    env = {
      knownHostsFile: join(tmp, 'config', 'known_hosts'),
      runtimeDir: join(tmp, 'run'),
      sshConfigFile: join(tmp, 'ssh_config'),
      connectTimeoutSec: 5,
      audit: (action, details) => audits.push({ action, details }),
    };
    mkdirSync(join(tmp, 'config'), { recursive: true, mode: 0o700 });
    mkdirSync(join(tmp, 'run', 'ssh'), { recursive: true, mode: 0o700 });
    profile = base();
  }, 180_000);

  afterAll(async () => {
    try {
      if (env && profile) await closeSshConnection(profile, env).catch(() => undefined);
    } catch {
      /* ignore */
    }
    agent?.kill('SIGTERM');
    if (container) await sh('docker', ['rm', '-f', container]).catch(() => undefined);
    await sh('docker', ['rmi', '-f', IMAGE]).catch(() => undefined);
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }, 60_000);

  // -- host keys ----------------------------------------------------------------------------

  it('unknown host key: scan shows the real fingerprint, checkHostKey = unknown, nothing is written', async () => {
    const scan = await scanHostKey(profile, env);
    expect(scan.via).toBe('ssh-keyscan');
    expect(scan.hostSpec).toBe(`[127.0.0.1]:${port}`);
    const ed = scan.keys.find((k) => k.type === 'ssh-ed25519')!;
    expect(ed.fingerprint).toBe(await hostKeyFingerprint());

    const check = await checkHostKey(profile, env);
    expect(check.status).toBe('unknown');
    expect(existsSync(env.knownHostsFile)).toBe(false);
  });

  it('testHost refuses to log in while the key is unknown', async () => {
    const res = await testHost(profile, env);
    expect(res).toMatchObject({ reachable: true, hostKey: 'unknown', authOk: false });
    expect(res.fingerprints.length).toBeGreaterThan(0);
    expect(res.warnings.join(' ')).toMatch(/not trusted/);
    const logs = await sh('docker', ['logs', container]);
    expect(logs.stdout + logs.stderr).not.toMatch(/Accepted publickey/);
  });

  it('ssh itself refuses an unknown host key (StrictHostKeyChecking=yes)', async () => {
    const args = buildSshArgs(profile, env, { mode: 'batch', remoteCommand: 'true' });
    const res = await run(sshBinary(env), args, { timeoutMs: 20_000 });
    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/Host key verification failed/);
  });

  it('trustHostKey refuses a wrong or malformed fingerprint and writes nothing', async () => {
    const wrong = 'SHA256:' + 'A'.repeat(43);
    await expect(trustHostKey(profile, wrong, env)).rejects.toMatchObject({
      code: 'host_unreachable',
      details: { reason: 'fingerprint_mismatch' },
    });
    await expect(trustHostKey(profile, 'nonsense', env)).rejects.toMatchObject({
      code: 'invalid_input',
    });
    expect(existsSync(env.knownHostsFile)).toBe(false);
  });

  it('trustHostKey with the confirmed fingerprint stores exactly that key (0600), idempotently', async () => {
    const fp = await hostKeyFingerprint();
    const r = await trustHostKey(profile, fp, env);
    expect(r).toMatchObject({ added: true, fingerprint: fp, hostSpec: `[127.0.0.1]:${port}` });
    expect(statSync(env.knownHostsFile).mode & 0o777).toBe(0o600);
    const lines = readFileSync(env.knownHostsFile, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      new RegExp(`^\\[127\\.0\\.0\\.1\\]:${port} ssh-ed25519 [A-Za-z0-9+/=]+ abox:sbx `),
    );
    expect((await checkHostKey(profile, env)).status).toBe('trusted');
    expect((await trustHostKey(profile, fp, env)).added).toBe(false);
    expect(readFileSync(env.knownHostsFile, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(
      audits.some((a) => a.action === 'host.key.trust' && a.details['fingerprint'] === fp),
    ).toBe(true);
  });

  // -- testHost -----------------------------------------------------------------------------

  it('testHost: reachable, latency, trusted key, auth ok, unprivileged user, no engine on the box', async () => {
    const res = await testHost(profile, env);
    expect(res).toMatchObject({
      reachable: true,
      hostKey: 'trusted',
      authOk: true,
      remoteUser: 'tester',
    });
    expect(res.latencyMs).toBeGreaterThan(0);
    expect(res.uid).toBeGreaterThan(0);
    expect(res.backends).toEqual({});
    expect(res.engineSocket).toEqual({ path: FAKE_SOCK, exists: false });
    expect(res.warnings.join(' ')).toMatch(/engine_socket .* does not exist/);
    expect(res.warnings.join(' ')).toMatch(/"docker" is configured but not usable/);
    expect(res.warnings.join(' ')).not.toMatch(/root/);
    expect(
      audits.some(
        (a) =>
          a.action === 'host.test' && a.details['host'] === 'sbx' && a.details['authOk'] === true,
      ),
    ).toBe(true);
  });

  it('readRemoteLive: the fixed command returns the real /proc numbers of the server over the hardened connection', async () => {
    const r = await readRemoteLive(profile, env);
    expect(r.ok, r.ok ? '' : r.reason).toBe(true);
    if (!r.ok) return;
    const u = r.usage;
    expect(u.source).toBe('ssh');
    // two stat samples half a second apart (busybox sleep takes fractions) give a real percentage
    expect(u.cpuPercent).not.toBeNull();
    expect(u.cpuPercent!).toBeGreaterThanOrEqual(0);
    expect(u.cpuPercent!).toBeLessThanOrEqual(100);
    expect(u.load).not.toBeNull();
    // the same numbers the kernel shows inside the container (/proc is the host's)
    const mem = await dockerExec(['sh', '-c', 'grep -E "^MemTotal:" /proc/meminfo']);
    const totalKib = Number(/MemTotal:\s+(\d+)/.exec(mem.stdout)![1]);
    expect(u.memoryTotalBytes).toBe(totalKib * 1024);
    expect(u.memoryAvailableBytes).toBeGreaterThan(0);
    expect(u.memoryAvailableBytes!).toBeLessThanOrEqual(u.memoryTotalBytes!);
    const cpus = await dockerExec(['sh', '-c', 'grep -c "^processor" /proc/cpuinfo']);
    expect(u.cpus).toBe(Number(cpus.stdout.trim()));
  });

  it('readRemoteLive: a key the server does not know is a reason, not an exception; an untrusted host key is refused', async () => {
    expect(await readRemoteLive(base({ identityFile: join(tmp, 'id_other') }), env)).toEqual({
      ok: false,
      reason: 'login failed',
    });
    // a live ssh master would skip the host key check of a new connection (see the hosts README): end it first
    await closeSshConnection(profile, env);
    const strangers: HostsEnv = {
      ...env,
      knownHostsFile: join(tmp, 'config', 'empty_known_hosts'),
    };
    expect(await readRemoteLive(profile, strangers)).toEqual({
      ok: false,
      reason: 'host key not trusted',
    });
  });

  it('testHost: a key the server does not know fails authentication, still reachable', async () => {
    const res = await testHost(base({ identityFile: join(tmp, 'id_other') }), env);
    expect(res).toMatchObject({ reachable: true, hostKey: 'trusted', authOk: false });
    expect(res.error).toMatch(/Permission denied/);
    expect(res.warnings.join(' ')).toMatch(/Authentication failed/);
  });

  it('testHost: closed port is unreachable (no throw)', async () => {
    const closed = await freePort();
    const res = await testHost(base({ port: closed }), env);
    expect(res).toMatchObject({ reachable: false, authOk: false });
    expect(res.error).toBeTruthy();
  });

  it('testHost warns about root and docker-group users', async () => {
    const rootRes = await testHost(base({ user: 'root' }), env);
    expect(rootRes.authOk).toBe(true);
    expect(rootRes.uid).toBe(0);
    expect(rootRes.warnings.join(' ')).toMatch(/user is root/);

    await dockerExec(['addgroup', 'docker']);
    await dockerExec(['addgroup', 'tester', 'docker']);
    await closeSshConnection(profile, env);
    const res = await testHost(profile, env);
    expect(res.warnings.join(' ')).toMatch(/"docker" group/);
  });

  it('reuses one connection through ControlMaster and can close it', async () => {
    await testHost(profile, env);
    const dir = join(env.runtimeDir, 'ssh');
    const sockets = existsSync(dir)
      ? (await sh('ls', [dir])).stdout.trim().split('\n').filter(Boolean)
      : [];
    expect(sockets.length).toBeGreaterThan(0);
    expect(await closeSshConnection(profile, env)).toBe(true);
    expect(await closeSshConnection(profile, env)).toBe(false);
  });

  // -- no agent forwarding ---------------------------------------------------------------------

  it('the local ssh-agent is not reachable in the remote session (control: -A would forward it)', async () => {
    const sock = join(tmp, 'agent.sock');
    agent = spawn('ssh-agent', ['-D', '-a', sock], { stdio: 'ignore' });
    for (let i = 0; i < 40 && !existsSync(sock); i++) await sleep(50);
    expect(existsSync(sock)).toBe(true);
    const cmd = 'sh -c \'echo "AGENT=${SSH_AUTH_SOCK:-none}"\'';

    const args = buildSshArgs(
      profile,
      { ...env, multiplex: false },
      { mode: 'batch', remoteCommand: cmd },
    );
    const res = await run(sshBinary(env), args, {
      timeoutMs: 20_000,
      env: { SSH_AUTH_SOCK: sock },
    });
    expect(res.stdout.trim()).toBe('AGENT=none');

    // control: the same server hands out an agent socket when the client asks for forwarding
    const ctl = await run(
      'ssh',
      [
        '-F',
        join(tmp, 'ssh_config'),
        '-A',
        '-p',
        String(port),
        '-l',
        'tester',
        '-i',
        keyPath(),
        '-o',
        'BatchMode=yes',
        '-o',
        'StrictHostKeyChecking=yes',
        '-o',
        `UserKnownHostsFile=${env.knownHostsFile}`,
        '-o',
        'GlobalKnownHostsFile=/dev/null',
        '--',
        '127.0.0.1',
        cmd,
      ],
      { timeoutMs: 20_000, env: { SSH_AUTH_SOCK: sock } },
    );
    expect(ctl.stdout.trim()).toMatch(/^AGENT=\/tmp\/ssh-/);
  });

  // -- engine socket tunnel --------------------------------------------------------------------

  describe('engine socket tunnel', () => {
    beforeAll(async () => {
      for (const [sock, script] of [
        [FAKE_SOCK, 'fake-engine.sh'],
        [FAKE_SOCK_ROOTFUL, 'fake-engine-rootful.sh'],
      ] as const) {
        const r = await sh('docker', [
          'exec',
          '-d',
          '-u',
          'tester',
          container,
          'socat',
          `UNIX-LISTEN:${sock},fork`,
          `EXEC:/usr/local/bin/${script}`,
        ]);
        expect(r.code).toBe(0);
        let up = false;
        for (let i = 0; i < 40 && !up; i++) {
          up = (await dockerExec(['test', '-S', sock])).code === 0;
          if (!up) await sleep(100);
        }
        if (!up) throw new Error(`fake engine ${sock} did not start`);
      }
    });

    it('forwards the remote unix socket; requests through the local socket reach it; close() cleans up', async () => {
      const t = await openEngineTunnel(profile, env, { remoteSocket: FAKE_SOCK });
      try {
        expect(t.state).toBe('open');
        expect(t.connection).toMatchObject({
          host: 'sbx',
          kind: 'ssh',
          engineSocket: join(env.runtimeDir, 'tunnels', 'sbx.sock'),
        });
        expect(statSync(t.localSocket).mode & 0o777).toBe(0o600);
        expect(statSync(join(env.runtimeDir, 'tunnels')).mode & 0o777).toBe(0o700);
        const ver = await httpGet(t.localSocket, '/version');
        expect(ver).toEqual({ status: 200, body: '{"Version":"fake-1.0"}' });
        expect((await httpGet(t.localSocket, '/anything')).body).toBe('pong');
        expect(await t.health()).toBe(true);
      } finally {
        await t.close();
      }
      expect(existsSync(t.localSocket)).toBe(false);
      expect(t.state).toBe('closed');
      const open = audits.find(
        (a) => a.action === 'host.connection.open' && a.details['kind'] === 'engine-tunnel',
      );
      const close = audits.find(
        (a) => a.action === 'host.connection.close' && a.details['kind'] === 'engine-tunnel',
      );
      expect(open?.details).toMatchObject({ host: 'sbx', user: 'tester', remoteSocket: FAKE_SOCK });
      expect(typeof close?.details['durationMs']).toBe('number');
      // no session content in audit records
      expect(JSON.stringify(audits)).not.toMatch(/fake-1\.0/);
    });

    it('reconnect() restarts the ssh process; autoReconnect recovers from a killed ssh', async () => {
      const t = await openEngineTunnel(profile, env, {
        remoteSocket: FAKE_SOCK,
        autoReconnect: { delayMs: 100 },
      });
      try {
        await t.reconnect();
        expect((await httpGet(t.localSocket, '/version')).status).toBe(200);

        const pid = Number(readFileSync(`${t.localSocket}.pid`, 'utf8').split(' ')[0]); // "<ssh pid> <owner pid>"
        const states: string[] = [];
        t.on('state', (s) => states.push(s));
        process.kill(pid, 'SIGKILL');
        for (
          let i = 0;
          i < 100 && !(states.includes('connecting') && states.at(-1) === 'open');
          i++
        )
          await sleep(100);
        expect(states).toContain('connecting');
        expect(states.at(-1)).toBe('open');
        expect((await httpGet(t.localSocket, '/version')).status).toBe(200);
      } finally {
        await t.close();
      }
      expect(existsSync(t.localSocket)).toBe(false);
    }, 40_000);

    it('fails with a clear error and cleans up when the remote engine socket does not exist', async () => {
      const err = await openEngineTunnel(profile, env, {
        remoteSocket: '/tmp/no-such-engine.sock',
        readyTimeoutMs: 8000,
      }).catch((e: unknown) => e);
      expect(isAboxError(err) && err.code).toBe('host_unreachable');
      expect(isAboxError(err) && err.message).toMatch(/engine did not answer/);
      expect(existsSync(join(env.runtimeDir, 'tunnels', 'sbx.sock'))).toBe(false);
      const ps = await sh('pgrep', ['-f', join(env.runtimeDir, 'tunnels')]);
      expect(ps.stdout.trim()).toBe('');
    }, 40_000);

    it('asks the engine behind the tunnel: rootless mode and runtimes (the same path sandboxes use)', async () => {
      const t = await openEngineTunnel(profile, env, { remoteSocket: FAKE_SOCK });
      try {
        expect(await getEngineInfo(t.localSocket)).toEqual({
          rootless: true,
          runtimes: ['runc', 'runsc'],
        });
      } finally {
        await t.close();
      }
      const rootful = await openEngineTunnel(profile, env, { remoteSocket: FAKE_SOCK_ROOTFUL });
      try {
        expect(await getEngineInfo(rootful.localSocket)).toEqual({
          rootless: false,
          runtimes: ['runc'],
        });
      } finally {
        await rootful.close();
      }
    });

    it('a forward in the ssh config is refused: the tunnel carries only the engine socket (RemoteForward would reach back here)', async () => {
      writeFileSync(
        join(tmp, 'ssh_fwd_config'),
        'Host *\n  RemoteForward 9999 127.0.0.1:22\n  LocalForward 9998 127.0.0.1:22\n',
      );
      const err = await openEngineTunnel(
        profile,
        { ...env, sshConfigFile: join(tmp, 'ssh_fwd_config') },
        { remoteSocket: FAKE_SOCK },
      ).catch((e: unknown) => e);
      expect(isAboxError(err) && err.details?.['reason']).toBe('config_forwards');
      expect(existsSync(join(env.runtimeDir, 'tunnels', 'sbx.sock'))).toBe(false);
    });

    it('stops the forwarded socket when its owner dies without cleaning up (kill -9 of abox)', async () => {
      const owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore',
      });
      const local = join(env.runtimeDir, 'tunnels', 'orphan.sock');
      const args = buildSshArgs(profile, env, {
        mode: 'tunnel',
        rawForwards: [{ flag: '-L', spec: `${local}:${FAKE_SOCK}` }],
      });
      const sup = spawn(
        '/bin/sh',
        [
          '-c',
          TUNNEL_SUPERVISOR,
          'abox-tunnel',
          String(owner.pid),
          `${local}.pid`,
          sshBinary(env),
          ...args,
        ],
        { stdio: 'ignore' },
      );
      try {
        for (let i = 0; i < 100 && !existsSync(local); i++) await sleep(100);
        expect((await httpGet(local, '/version')).status).toBe(200);
        const sshPid = Number(readFileSync(`${local}.pid`, 'utf8').split(' ')[0]);
        owner.kill('SIGKILL');
        let alive = true;
        for (let i = 0; i < 100 && alive; i++) {
          try {
            process.kill(sshPid, 0);
            await sleep(100);
          } catch {
            alive = false;
          }
        }
        expect(alive).toBe(false);
      } finally {
        owner.kill('SIGKILL');
        sup.kill('SIGKILL');
        rmSync(local, { force: true });
        rmSync(`${local}.pid`, { force: true });
      }
    }, 30_000);

    it('rejects unsafe socket paths before running anything', async () => {
      await expect(
        openEngineTunnel(profile, env, { remoteSocket: '/tmp/x;id' }),
      ).rejects.toMatchObject({ code: 'invalid_input' });
      await expect(
        openEngineTunnel(profile, env, { remoteSocket: 'relative.sock' }),
      ).rejects.toMatchObject({ code: 'invalid_input' });
    });
  });

  // -- host resolver ---------------------------------------------------------------------------

  describe('host resolver', () => {
    it('resolves local without I/O, ssh hosts with tunnel, zone and limits; caches the outcome', async () => {
      const db = openDatabase(':memory:');
      const cache = new HostCache({ db, now: () => Date.now() });
      const registry = new HostRegistry({ file: join(tmp, 'config', 'hosts.yaml') });
      registry.add({
        ...profile,
        zone: 'shared',
        limits: { cpus: 1, memory: '2g', sandboxes: 2 },
        runtimes: { docker: 'runsc' },
      });
      const tunnels = new TunnelManager(env);
      const resolve = createHostResolver(registry, tunnels, { cache });
      try {
        const local = await resolve('local');
        expect(local).toMatchObject({
          connection: { host: 'local', kind: 'local' },
          zone: 'workstation',
          backends: ['docker', 'podman', 'process', 'python', 'vm'],
        });
        await expect(resolve('nope')).rejects.toMatchObject({ code: 'not_found' });

        const r = await resolve('sbx');
        expect(r).toMatchObject({
          connection: { host: 'sbx', kind: 'ssh' },
          zone: 'shared',
          minIsolation: 'hardened',
          requiresApproval: true,
          backends: ['docker'],
          limits: { cpus: 1, memory: '2g', sandboxes: 2 },
        });
        expect(r.connection.runtimes).toEqual({ docker: 'runsc' });
        expect(r.engine).toEqual({ rootless: true, runtimes: ['runc', 'runsc'] });
        expect((await httpGet(r.connection.engineSocket!, '/version')).status).toBe(200);
        const again = await resolve('sbx');
        expect(again.connection.engineSocket).toBe(r.connection.engineSocket);

        const entry = cache.get('sbx')!;
        expect(entry.ok).toBe(true);
        expect(entry.stale).toBe(false);
        expect((entry.info as { lastOkAt: number }).lastOkAt).toBeGreaterThan(0);
      } finally {
        await tunnels.closeAll();
      }
    }, 60_000);

    it('a shared host needs a rootless engine: the engine itself is asked and a rootful one refused (roadmap 4b.8)', async () => {
      const registry = new HostRegistry({ file: join(tmp, 'config', 'hosts-rootful.yaml') });
      registry.add({ ...profile, id: 'rootful', zone: 'shared', engineSocket: FAKE_SOCK_ROOTFUL });
      registry.add({
        ...profile,
        id: 'optin',
        zone: 'shared',
        engineSocket: FAKE_SOCK_ROOTFUL,
        allowRootful: true,
      });
      registry.add({ ...profile, id: 'labbox', zone: 'lab', engineSocket: FAKE_SOCK_ROOTFUL });
      registry.add({
        ...profile,
        id: 'system',
        zone: 'shared',
        engineSocket: '/var/run/docker.sock',
      });
      const tunnels = new TunnelManager(env);
      const resolve = createHostResolver(registry, tunnels);
      try {
        const err = await resolve('rootful').catch((e: unknown) => e);
        expect(isAboxError(err) && err.code).toBe('policy_denied');
        expect(isAboxError(err) && err.details?.['reason']).toBe('engine_rootful');
        expect(tunnels.peek('rootful')).toBeUndefined();
        expect(existsSync(join(env.runtimeDir, 'tunnels', 'sbx.sock'))).toBe(false);
        // the obvious mistake is refused before a connection is made
        await expect(resolve('system')).rejects.toMatchObject({
          code: 'policy_denied',
          details: { reason: 'engine_rootful' },
        });
        expect((await resolve('optin')).engine?.rootless).toBe(false);
        expect((await resolve('labbox')).engine?.rootless).toBe(false);
      } finally {
        await tunnels.closeAll();
      }
    }, 60_000);

    it('an ssh-only host (no backends) is reported as unsupported', async () => {
      const registry = new HostRegistry({ file: join(tmp, 'config', 'hosts2.yaml') });
      registry.add({ ...profile, id: 'plain', backends: [], engineSocket: undefined });
      const resolve = createHostResolver(registry, new TunnelManager(env));
      await expect(resolve('plain')).rejects.toMatchObject({ code: 'unsupported' });
    });
  });

  // -- host test: what the engine itself says ------------------------------------------------------

  describe('engine checks of host test', () => {
    it('reports rootless mode and which configured runtimes the engine really has', async () => {
      const ok = await testHost(
        base({ zone: 'shared', engineSocket: FAKE_SOCK, runtimes: { docker: 'runsc' } }),
        env,
      );
      expect(ok.engine).toEqual({ rootless: true, runtimes: ['runc', 'runsc'] });
      expect(ok.runtimes).toEqual([{ engine: 'docker', runtime: 'runsc', available: true }]);
      expect(ok.warnings.join(' ')).not.toMatch(/not rootless|Runtime "/);

      const missing = await testHost(
        base({ zone: 'shared', engineSocket: FAKE_SOCK, runtimes: { docker: 'kata' } }),
        env,
      );
      expect(missing.runtimes).toEqual([{ engine: 'docker', runtime: 'kata', available: false }]);
      expect(missing.warnings.join(' ')).toMatch(
        /Runtime "kata" \(runtimes\.docker\) is not installed.*runc, runsc/,
      );
    });

    it('warns about a rootful engine; for shared hosts it says that abox refuses it', async () => {
      const shared = await testHost(base({ zone: 'shared', engineSocket: FAKE_SOCK_ROOTFUL }), env);
      expect(shared.engine?.rootless).toBe(false);
      expect(shared.warnings.join(' ')).toMatch(/is not rootless; abox refuses it for zone shared/);
      const optIn = await testHost(
        base({ zone: 'shared', engineSocket: FAKE_SOCK_ROOTFUL, allowRootful: true }),
        env,
      );
      expect(optIn.warnings.join(' ')).toMatch(/is not rootless: access to it is root-equivalent/);
      expect(optIn.warnings.join(' ')).not.toMatch(/refuses/);
      const lab = await testHost(base({ zone: 'lab', engineSocket: FAKE_SOCK_ROOTFUL }), env);
      expect(lab.warnings.join(' ')).toMatch(/is not rootless: access to it is root-equivalent/);
    });

    it('flags a system-wide engine socket as the engine_socket', async () => {
      const res = await testHost(
        base({ zone: 'shared', engineSocket: '/var/run/docker.sock' }),
        env,
      );
      expect(res.warnings.join(' ')).toMatch(/system-wide engine.*abox refuses it for zone shared/);
    });
  });

  // -- abox ssh <host> -- <command>, and what the session may take along --------------------------

  describe('ssh sessions', () => {
    const sessionEnv = (): HostsEnv => ({ ...env, multiplex: false });

    it('runs the typed command: the arguments follow the destination, a second `--` would break it', async () => {
      const good = await run(
        sshBinary(env),
        sshSessionArgs(profile, sessionEnv(), { command: ['echo', 'hi', '-a'] }),
        { timeoutMs: 20_000 },
      );
      expect(good.code, good.stderr).toBe(0);
      expect(good.stdout.trim()).toBe('hi -a');
      // the old argv (`... -- host -- echo hi -a`): the remote shell gets the second `--` as its command
      const broken = [...sshSessionArgs(profile, sessionEnv()), '--', 'echo', 'hi', '-a'];
      const bad = await run(sshBinary(env), broken, { timeoutMs: 20_000 });
      expect(bad.stdout.trim()).not.toBe('hi -a');
      expect(bad.code).not.toBe(0);
    });

    it('does not hand local environment variables to the server, whatever the ssh config says', async () => {
      writeFileSync(join(tmp, 'ssh_sendenv_config'), 'Host *\n  SendEnv MYVAR\n');
      const probe = 'sh -c \'echo "V=${MYVAR:-none}"\'';
      const withConfig: HostsEnv = {
        ...sessionEnv(),
        sshConfigFile: join(tmp, 'ssh_sendenv_config'),
      };
      const secret = { MYVAR: 'leaked' };
      // control: the same config with a plain ssh does send it (the server accepts MYVAR)
      const ctl = await run(
        'ssh',
        [
          '-F',
          join(tmp, 'ssh_sendenv_config'),
          '-p',
          String(port),
          '-l',
          'tester',
          '-i',
          keyPath(),
          '-o',
          'BatchMode=yes',
          '-o',
          'StrictHostKeyChecking=yes',
          '-o',
          `UserKnownHostsFile=${env.knownHostsFile}`,
          '-o',
          'GlobalKnownHostsFile=/dev/null',
          '--',
          '127.0.0.1',
          probe,
        ],
        { timeoutMs: 20_000, env: secret },
      );
      expect(ctl.stdout.trim()).toBe('V=leaked');
      for (const mode of ['batch', 'interactive'] as const) {
        const res = await run(
          sshBinary(env),
          buildSshArgs(profile, withConfig, { mode, remoteCommand: probe }),
          { timeoutMs: 20_000, env: secret },
        );
        expect(res.stdout.trim(), mode).toBe('V=none');
      }
    });
  });

  // -- ProxyJump --------------------------------------------------------------------------------

  describe('ProxyJump', () => {
    // jump = the container's published port; target = sshd inside the container (127.0.0.1:22)
    const viaJump = () =>
      base({
        id: 'behind',
        port: undefined,
        proxyJump: `tester@localhost:${port}`,
        backends: [],
        engineSocket: undefined,
      });

    it('refuses to scan behind a jump host that is not trusted yet', async () => {
      const fresh = {
        ...env,
        sshConfigFile: join(tmp, 'ssh_jump_config'),
        knownHostsFile: join(tmp, 'config', 'fresh_known_hosts'),
      };
      await expect(scanHostKey(viaJump(), fresh)).rejects.toMatchObject({
        code: 'host_unreachable',
        details: { reason: 'host_key_unknown' },
      });
      expect(existsSync(fresh.knownHostsFile)).toBe(false);
    });

    it('scans, trusts and tests a host behind a trusted jump host', async () => {
      const p = viaJump();
      const jenv = { ...env, sshConfigFile: join(tmp, 'ssh_jump_config') };
      const fp = await hostKeyFingerprint();
      // the hop (reached as "localhost", so it has its own known_hosts identity) must be trusted first
      const hop = base({ id: 'hop', hostname: 'localhost', backends: [], engineSocket: undefined });
      await trustHostKey(hop, fp, jenv);
      const scan = await scanHostKey(p, jenv);
      expect(scan).toMatchObject({ via: 'ssh', hostname: '127.0.0.1', hostSpec: '127.0.0.1' });
      expect(scan.keys.some((k) => k.fingerprint === fp)).toBe(true);
      expect((await checkHostKey(p, jenv)).status).toBe('unknown');
      await trustHostKey(p, fp, jenv);
      expect((await checkHostKey(p, jenv)).status).toBe('trusted');
      const res = await testHost(p, jenv);
      expect(res).toMatchObject({
        reachable: true,
        hostKey: 'trusted',
        authOk: true,
        remoteUser: 'tester',
      });
      await closeSshConnection(p, jenv);

      // Hardening reaches the jump hop too: a permissive user config (StrictHostKeyChecking no)
      // must not weaken the hop. Known hosts with the target but WITHOUT the hop -> blocked.
      writeFileSync(
        join(tmp, 'ssh_permissive'),
        `StrictHostKeyChecking no\nUserKnownHostsFile /dev/null\nForwardAgent yes\nIdentityFile ${keyPath()}\nIdentitiesOnly yes\n`,
      );
      const all = readFileSync(env.knownHostsFile, 'utf8').trim().split('\n');
      const targetOnly = all.filter((l) => l.startsWith('127.0.0.1 '));
      expect(all.some((l) => l.startsWith(`[localhost]:${port} `))).toBe(true); // the hop was trusted first
      expect(targetOnly).toHaveLength(1);
      const strictEnv = {
        ...env,
        sshConfigFile: join(tmp, 'ssh_permissive'),
        knownHostsFile: join(tmp, 'config', 'target_only_known_hosts'),
        multiplex: false,
      };
      writeFileSync(strictEnv.knownHostsFile, `${targetOnly.join('\n')}\n`, { mode: 0o600 });
      const blocked = await run(
        sshBinary(strictEnv),
        buildSshArgs(p, strictEnv, { mode: 'batch', remoteCommand: 'true' }),
        { timeoutMs: 20_000 },
      );
      expect(blocked.code).not.toBe(0);
      expect(blocked.stderr).toMatch(/Host key verification failed/);
      writeFileSync(strictEnv.knownHostsFile, `${all.join('\n')}\n`, { mode: 0o600 });
      const allowed = await run(
        sshBinary(strictEnv),
        buildSshArgs(p, strictEnv, { mode: 'batch', remoteCommand: 'true' }),
        { timeoutMs: 20_000 },
      );
      expect(allowed.code).toBe(0);
      // clean up the extra entry so the next tests see a single host
      await forgetHostKey(p, jenv);
      await forgetHostKey(hop, jenv);
    }, 60_000);
  });

  // -- ProxyCommand -----------------------------------------------------------------------------

  describe('ProxyCommand', () => {
    // The host name does not resolve: only the ProxyCommand (which dials the container's published
    // port) can reach it, so a direct ssh-keyscan would find nothing, or the wrong machine.
    const viaCommand = () =>
      base({
        id: 'viapc',
        hostname: undefined,
        sshConfigAlias: 'viapc',
        port: undefined,
        identityFile: undefined,
        backends: [],
        engineSocket: undefined,
      });
    const pcEnv = (): HostsEnv => ({
      ...env,
      sshConfigFile: join(tmp, 'ssh_proxycmd_config'),
      knownHostsFile: join(tmp, 'config', 'proxycmd_known_hosts'),
      multiplex: false,
    });

    beforeAll(() => {
      const dial = `const s=require('net').connect(${port},'127.0.0.1');process.stdin.pipe(s);s.pipe(process.stdout)`;
      writeFileSync(
        join(tmp, 'ssh_proxycmd_config'),
        [
          'Host viapc',
          '  HostName behind.example.invalid',
          '  User tester',
          `  IdentityFile ${join(tmp, 'id_test')}`,
          '  IdentitiesOnly yes',
          `  ProxyCommand node -e "${dial}"`,
          '',
        ].join('\n'),
      );
    });

    it('the effective config carries the ProxyCommand', async () => {
      const g = await run('ssh', ['-G', '-F', join(tmp, 'ssh_proxycmd_config'), '--', 'viapc']);
      expect(parseSshG(g.stdout).proxyCommand).toMatch(/^node -e /);
    });

    it('scans, trusts and logs in through the ProxyCommand, never directly', async () => {
      const p = viaCommand();
      const e = pcEnv();
      const fp = await hostKeyFingerprint();
      const scan = await scanHostKey(p, e);
      expect(scan).toMatchObject({ via: 'ssh', hostname: 'behind.example.invalid' });
      expect(scan.keys.some((k) => k.fingerprint === fp)).toBe(true);
      expect((await checkHostKey(p, e)).status).toBe('unknown');
      await trustHostKey(p, fp, e);
      expect((await checkHostKey(p, e)).status).toBe('trusted');
      const res = await testHost(p, e);
      expect(res).toMatchObject({
        reachable: true,
        hostKey: 'trusted',
        authOk: true,
        remoteUser: 'tester',
      });
    }, 60_000);
  });

  // -- changed host key -------------------------------------------------------------------------

  describe('changed host key', () => {
    it('blocks everything, never auto-accepts, and needs an explicit forget + trust', async () => {
      await closeSshConnection(profile, env);
      const oldFp = await hostKeyFingerprint();
      await dockerExec(['sh', '-c', 'rm -f /etc/ssh/ssh_host_*']);
      const restart = await sh('docker', ['restart', '-t', '1', container]);
      expect(restart.code).toBe(0);
      await waitForSshd();
      const newFp = await hostKeyFingerprint();
      expect(newFp).not.toBe(oldFp);
      const knownBefore = readFileSync(env.knownHostsFile, 'utf8');

      const check = await checkHostKey(profile, env);
      expect(check.status).toBe('changed');
      expect(check.trusted.map((k) => k.fingerprint)).toContain(oldFp);

      const res = await testHost(profile, env);
      expect(res).toMatchObject({ reachable: true, hostKey: 'changed', authOk: false });
      expect(res.warnings.join(' ')).toMatch(/HOST KEY CHANGED/);

      // even the correct new fingerprint is refused: a change must be handled on purpose
      await expect(trustHostKey(profile, newFp, env)).rejects.toMatchObject({
        code: 'host_unreachable',
        details: { reason: 'host_key_changed' },
      });

      // ssh itself blocks as well
      const args = buildSshArgs(
        profile,
        { ...env, multiplex: false },
        { mode: 'batch', remoteCommand: 'true' },
      );
      const direct = await run(sshBinary(env), args, { timeoutMs: 20_000 });
      expect(direct.code).not.toBe(0);
      expect(direct.stderr).toMatch(
        /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/,
      );

      // the tunnel and the resolver are blocked too
      const db = openDatabase(':memory:');
      const cache = new HostCache({ db, now: () => Date.now() });
      cache.put('sbx', { lastOkAt: 1234 }, true, 1234);
      const registry = new HostRegistry({ file: join(tmp, 'config', 'hosts3.yaml') });
      registry.add(profile);
      const tunnels = new TunnelManager(env);
      const resolve = createHostResolver(registry, tunnels, { cache });
      const err = await resolve('sbx').catch((e: unknown) => e);
      expect(isAboxError(err) && err.code).toBe('host_unreachable');
      expect(isAboxError(err) && err.details?.['reason']).toBe('host_key_changed');
      expect(isAboxError(err) && err.message).toMatch(/last reachable 1970-01-01/);
      const entry = cache.get('sbx')!;
      expect(entry.ok).toBe(false);
      expect(entry.info).toMatchObject({ lastOkAt: 1234 });
      expect((entry.info as { lastError: string }).lastError).toMatch(/changed/);
      expect(existsSync(join(env.runtimeDir, 'tunnels', 'sbx.sock'))).toBe(false);
      await tunnels.closeAll();

      expect(readFileSync(env.knownHostsFile, 'utf8')).toBe(knownBefore);

      // after the human verified the new key out of band
      expect(await forgetHostKey(profile, env)).toBe(true);
      expect((await checkHostKey(profile, env)).status).toBe('unknown');
      await trustHostKey(profile, newFp, env);
      expect((await checkHostKey(profile, env)).status).toBe('trusted');
      expect((await testHost(profile, env)).authOk).toBe(true);
    }, 90_000);
  });

  it('keeps known_hosts and the temp dir private', () => {
    expect(statSync(env.knownHostsFile).mode & 0o777).toBe(0o600);
    chmodSync(tmp, 0o700);
  });
});
