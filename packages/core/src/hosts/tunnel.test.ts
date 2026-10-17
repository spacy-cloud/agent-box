import { type ChildProcess, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HostProfile } from './model.js';
import { hostsEnvFromPaths, type HostsEnv } from './ssh-args.js';
import {
  TUNNEL_SUPERVISOR,
  TunnelManager,
  openEngineTunnel,
  sweepStaleTunnels,
  tunnelSocketPath,
} from './tunnel.js';

/**
 * The tunnel machinery against a fake `ssh` (__tests__/fake-ssh.mjs): no sshd, no docker. The
 * fake serves /_ping and /info on the forwarded socket, like an engine behind a real tunnel.
 */
const FAKE_SSH = fileURLToPath(new URL('./__tests__/fake-ssh.mjs', import.meta.url));
const REGISTER = fileURLToPath(
  new URL('../manager/__tests__/register-manager.mjs', import.meta.url),
);
const CHILD = fileURLToPath(new URL('./__tests__/tunnel-child.ts', import.meta.url));
const REMOTE = '/run/user/1000/podman/podman.sock';

const profile: HostProfile = {
  id: 'x',
  kind: 'ssh',
  hostname: 'x.example.org',
  zone: 'lab',
  backends: ['docker'],
  tags: [],
  favorite: false,
  portForwards: [],
};

let root: string;
let env: HostsEnv;
let log: string;
const spawned: ChildProcess[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function calls(): string[][] {
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as string[]);
}
const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function waitFor(cond: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await sleep(50);
  }
}
/** A harmless process whose command line mentions ssh and `socket`, like a stale tunnel's. */
function lookalike(socket: string): ChildProcess {
  const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'ssh', socket], {
    stdio: 'ignore',
  });
  spawned.push(c);
  return c;
}
async function deadPid(): Promise<number> {
  const c = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  await new Promise((r) => c.once('exit', r));
  return c.pid!;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'abox-tun-'));
  log = join(root, 'ssh.log');
  process.env['FAKE_SSH_LOG'] = log;
  env = hostsEnvFromPaths(
    { configDir: join(root, 'config'), runtimeDir: join(root, 'run') },
    { sshConfigFile: null, sshBinary: FAKE_SSH, connectTimeoutSec: 2 },
  );
});
afterEach(() => {
  for (const c of spawned.splice(0)) c.kill('SIGKILL');
  for (const k of ['FAKE_SSH_LOG', 'FAKE_SSH_G', 'FAKE_SSH_INFO'] as const) delete process.env[k];
  rmSync(root, { recursive: true, force: true });
});

describe('engine tunnel process management', () => {
  it('runs ssh below the supervisor and records "<ssh pid> <owner pid>"', async () => {
    const t = await openEngineTunnel(profile, env, { remoteSocket: REMOTE });
    try {
      expect(t.state).toBe('open');
      const pidFile = `${t.localSocket}.pid`;
      expect(statSync(pidFile).mode & 0o777).toBe(0o600);
      const [sshPid, owner] = readFileSync(pidFile, 'utf8').trim().split(/\s+/).map(Number);
      expect(owner).toBe(process.pid);
      expect(isAlive(sshPid!)).toBe(true);
      expect(sshPid).not.toBe(process.pid);
      // the ssh command line is exactly the hardened tunnel line, forwarding only the engine socket
      const tunnel = calls().find((c) => c.includes('-N'))!;
      expect(tunnel).toContain('-L');
      expect(tunnel[tunnel.indexOf('-L') + 1]).toBe(`${t.localSocket}:${REMOTE}`);
      expect(tunnel).toContain('ExitOnForwardFailure=yes');
      expect(tunnel.slice(-2)).toEqual(['--', 'x.example.org']);
      await t.close();
      await waitFor(() => !isAlive(sshPid!));
      expect(existsSync(t.localSocket)).toBe(false);
      expect(existsSync(pidFile)).toBe(false);
    } finally {
      await t.close();
    }
  });

  it('asks ssh what it would forward and refuses forwards from the ssh config', async () => {
    process.env['FAKE_SSH_G'] = 'remoteforward 9000 [localhost]:22\n';
    const err = await openEngineTunnel(profile, env, { remoteSocket: REMOTE }).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({
      code: 'invalid_input',
      details: { reason: 'config_forwards', host: 'x' },
    });
    expect((err as Error).message).toMatch(/remoteforward 9000/);
    // ssh -G ran, the tunnel itself never started
    expect(calls().every((c) => c.includes('-G'))).toBe(true);
    expect(existsSync(tunnelSocketPath(env, 'x'))).toBe(false);
  });

  it('accepts the forwardings ssh prints for the engine -L itself', async () => {
    const sock = tunnelSocketPath(env, 'x');
    process.env['FAKE_SSH_G'] = `localforward ${sock} ${REMOTE}\ndynamicforward ${sock}\n`;
    const t = await openEngineTunnel(profile, env, { remoteSocket: REMOTE });
    await t.close();
  });

  it('does not set ClearAllForwardings on the tunnel (ssh would drop the engine -L too)', async () => {
    const t = await openEngineTunnel(profile, env, { remoteSocket: REMOTE });
    try {
      const tunnel = calls().find((c) => c.includes('-N'))!;
      expect(tunnel.join(' ')).not.toMatch(/ClearAllForwardings=yes/);
    } finally {
      await t.close();
    }
  });

  it('leaves the tunnel of another live abox process alone and uses its own socket', async () => {
    const dflt = tunnelSocketPath(env, 'x');
    mkdirSync(join(root, 'run', 'tunnels'), { recursive: true, mode: 0o700 });
    const other = lookalike(dflt);
    writeFileSync(`${dflt}.pid`, `${other.pid} ${process.ppid}\n`);
    const t = await openEngineTunnel(profile, env, { remoteSocket: REMOTE });
    try {
      expect(t.localSocket).toBe(join(root, 'run', 'tunnels', `x.${process.pid}.sock`));
      expect(isAlive(other.pid!)).toBe(true);
      expect(readFileSync(`${dflt}.pid`, 'utf8')).toContain(String(other.pid));
    } finally {
      await t.close();
    }
  });

  it('sweeps tunnels of dead abox processes and keeps those of live ones', async () => {
    const dir = join(root, 'run', 'tunnels');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stale = join(dir, 'stale.sock');
    const livePath = join(dir, 'live.sock');
    const orphan = lookalike(stale);
    const owned = lookalike(livePath);
    writeFileSync(stale, '');
    writeFileSync(`${stale}.pid`, `${orphan.pid} ${await deadPid()}\n`);
    writeFileSync(livePath, '');
    writeFileSync(`${livePath}.pid`, `${owned.pid} ${process.ppid}\n`);
    // a pid file whose process is gone: only the files go
    const gone = join(dir, 'gone.sock');
    writeFileSync(gone, '');
    writeFileSync(`${gone}.pid`, `${await deadPid()} ${await deadPid()}\n`);

    expect(sweepStaleTunnels(env).sort()).toEqual([gone, stale]);
    await waitFor(() => !isAlive(orphan.pid!));
    expect(isAlive(owned.pid!)).toBe(true);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(`${stale}.pid`)).toBe(false);
    expect(existsSync(gone)).toBe(false);
    expect(existsSync(livePath)).toBe(true);
    expect(existsSync(`${livePath}.pid`)).toBe(true);
  });

  it('a TunnelManager sweeps stale tunnels on its first use', async () => {
    const dir = join(root, 'run', 'tunnels');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stale = join(dir, 'old.sock');
    const orphan = lookalike(stale);
    writeFileSync(`${stale}.pid`, `${orphan.pid} ${await deadPid()}\n`);
    const tunnels = new TunnelManager(env);
    try {
      await tunnels.get(profile, { remoteSocket: REMOTE });
      await waitFor(() => !isAlive(orphan.pid!));
    } finally {
      await tunnels.closeAll();
    }
  });
});

describe('the supervisor takes ssh down when its owner is gone', () => {
  it('kills ssh within seconds after the owner was killed with SIGKILL', async () => {
    const owner = lookalike('owner');
    const dir = join(root, 'run', 'tunnels');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const sock = join(dir, 'sup.sock');
    const sup = spawn(
      '/bin/sh',
      [
        '-c',
        TUNNEL_SUPERVISOR,
        'abox-tunnel',
        String(owner.pid),
        `${sock}.pid`,
        FAKE_SSH,
        '-N',
        '-L',
        `${sock}:${REMOTE}`,
      ],
      { stdio: 'ignore' },
    );
    spawned.push(sup);
    await waitFor(() => existsSync(sock));
    const [sshPid, ownerPid] = readFileSync(`${sock}.pid`, 'utf8').trim().split(/\s+/).map(Number);
    expect(ownerPid).toBe(owner.pid);
    expect(isAlive(sshPid!)).toBe(true);
    owner.kill('SIGKILL');
    await waitFor(() => !isAlive(sshPid!), 10_000);
    await new Promise((r) => (sup.exitCode !== null ? r(null) : sup.once('exit', r)));
  });

  it('forwards SIGTERM to ssh (a normal close)', async () => {
    const dir = join(root, 'run', 'tunnels');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const sock = join(dir, 'term.sock');
    const sup = spawn(
      '/bin/sh',
      [
        '-c',
        TUNNEL_SUPERVISOR,
        'abox-tunnel',
        String(process.pid),
        `${sock}.pid`,
        FAKE_SSH,
        '-N',
        '-L',
        `${sock}:${REMOTE}`,
      ],
      { stdio: 'ignore' },
    );
    spawned.push(sup);
    await waitFor(() => existsSync(sock));
    const sshPid = Number(readFileSync(`${sock}.pid`, 'utf8').split(' ')[0]);
    sup.kill('SIGTERM');
    await waitFor(() => !isAlive(sshPid));
    await new Promise((r) => (sup.exitCode !== null ? r(null) : sup.once('exit', r)));
  });

  it('kill -9 of the abox process: the tunnel goes away by itself, the next start finds nothing stale', async () => {
    const marker = join(root, 'marker.json');
    const child = spawn(
      process.execPath,
      ['--import', REGISTER, CHILD, join(root, 'run'), FAKE_SSH, marker],
      { stdio: ['ignore', 'inherit', 'pipe'], env: { ...process.env, FAKE_SSH_LOG: log } },
    );
    spawned.push(child);
    let stderr = '';
    child.stderr!.on('data', (d: Buffer) => (stderr += d.toString()));
    await waitFor(() => existsSync(marker) || child.exitCode !== null, 25_000);
    if (!existsSync(marker)) throw new Error(`child failed: ${stderr}`);
    const { sshPid, socket } = JSON.parse(readFileSync(marker, 'utf8')) as {
      sshPid: number;
      socket: string;
    };
    expect(isAlive(sshPid)).toBe(true);
    child.kill('SIGKILL');
    await waitFor(() => !isAlive(sshPid), 10_000);
    // whatever the dead process left (pid file, socket) is cleaned by the next abox
    sweepStaleTunnels(env);
    expect(existsSync(socket)).toBe(false);
    expect(existsSync(`${socket}.pid`)).toBe(false);
  }, 60_000);
});
