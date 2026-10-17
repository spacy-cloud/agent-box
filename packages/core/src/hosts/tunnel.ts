import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { connect } from 'node:net';
import { join } from 'node:path';
import { AboxError } from '../errors.js';
import { verifyForwardings } from './forwardings.js';
import type { HostConnection } from '../types.js';
import type { HostProfile } from './model.js';
import { isSafeAbsPath } from './schema.js';
import { buildSshArgs, sshBinary, type HostsEnv } from './ssh-args.js';

/** Max length of a unix socket path (`sun_path` is 108 bytes on Linux, 104 on BSD/macOS). */
const SOCKET_PATH_MAX = 103;

/**
 * The tunnel's ssh runs below this tiny supervisor (`sh -c`, argv only, no user input in the
 * script). A hard kill of the abox process (`kill -9`, OOM, power button of the terminal) gives
 * Node no chance to stop its children, and an `ssh -N` would keep the engine socket forwarded for
 * ever. The supervisor polls its owner and takes ssh down once the owner is gone; it also records
 * `<ssh pid> <owner pid>` in the pid file so a later abox run can tell stale tunnels from the live
 * tunnels of another abox process (CLI and GUI share the runtime directory).
 *
 * Arguments: owner pid, pid file, then the ssh command line.
 */
export const TUNNEL_SUPERVISOR = [
  'umask 077',
  'owner=$1; pidfile=$2; shift 2',
  'child=',
  'trap \'kill "$child" 2>/dev/null\' TERM INT HUP',
  '"$@" &',
  'child=$!',
  'printf "%s %s\\n" "$child" "$owner" > "$pidfile"',
  '(',
  '  while kill -0 "$owner" 2>/dev/null && kill -0 "$child" 2>/dev/null; do sleep 1; done',
  '  kill "$child" 2>/dev/null',
  ') &',
  'guard=$!',
  'wait "$child"; status=$?',
  'if kill -0 "$child" 2>/dev/null; then wait "$child"; status=$?; fi',
  'kill "$guard" 2>/dev/null',
  'exit "$status"',
].join('\n');

export type HealthCheck = 'ping' | 'connect' | 'none' | ((socketPath: string) => Promise<boolean>);

export interface OpenTunnelOptions {
  /** Engine socket path ON THE HOST (`unix:` socket of rootless docker/podman). */
  remoteSocket: string;
  /** Override of the local socket path (default `<runtimeDir>/tunnels/<host>.sock`). */
  localSocket?: string;
  /**
   * `ping` (default): GET /_ping against the forwarded socket (Docker and Podman compat API).
   * `connect`: only check that the local socket accepts connections.
   */
  healthCheck?: HealthCheck;
  /** How long to wait for the tunnel to come up (ms, default 15000). */
  readyTimeoutMs?: number;
  /** Restart the ssh process automatically when it dies (default off). */
  autoReconnect?: { maxAttempts?: number; delayMs?: number };
}

export type TunnelState = 'connecting' | 'open' | 'closed' | 'failed';

export interface EngineTunnel extends EventEmitter {
  readonly connection: HostConnection;
  readonly localSocket: string;
  readonly state: TunnelState;
  /** Process alive and the local socket present. */
  isAlive(): boolean;
  /** Runs the configured health check against the forwarded socket. */
  health(): Promise<boolean>;
  /** Restarts the ssh process and waits until the socket is usable again. */
  reconnect(): Promise<void>;
  /** Stops ssh and removes the local socket. Idempotent. */
  close(): Promise<void>;
  on(event: 'state', fn: (s: TunnelState, reason?: string) => void): this;
}

const live = new Set<TunnelImpl>();
let exitHookInstalled = false;
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const t of live) t.killSync();
  });
}

/** `GET /_ping` over a unix socket; true on HTTP 200. */
export function pingEngine(socketPath: string, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request(
      { socketPath, path: '/_ping', method: 'GET', timeout: timeoutMs },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
    req.end();
  });
}

function canConnect(socketPath: string, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect(socketPath);
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

class TunnelImpl extends EventEmitter implements EngineTunnel {
  connection: HostConnection;
  state: TunnelState = 'connecting';
  private child?: ChildProcess;
  private stderrTail = '';
  private openedAt = 0;
  private closing = false;
  private attempts = 0;
  private readonly pidFile: string;

  constructor(
    private readonly profile: HostProfile,
    private readonly env: HostsEnv,
    private readonly opts: OpenTunnelOptions,
    readonly localSocket: string,
  ) {
    super();
    this.connection = {
      host: profile.id,
      kind: 'ssh',
      engineSocket: localSocket,
      ...(profile.dataDir ? { dataDir: profile.dataDir } : {}),
    };
    this.pidFile = `${localSocket}.pid`;
  }

  isAlive(): boolean {
    return (
      this.child !== undefined &&
      this.child.exitCode === null &&
      this.child.signalCode === null &&
      existsSync(this.localSocket)
    );
  }

  async health(): Promise<boolean> {
    if (!this.isAlive()) return false;
    const hc = this.opts.healthCheck ?? 'ping';
    if (hc === 'none') return true;
    if (hc === 'connect') return canConnect(this.localSocket);
    if (typeof hc === 'function') return hc(this.localSocket);
    return pingEngine(this.localSocket);
  }

  async start(): Promise<void> {
    installExitHook();
    live.add(this);
    this.closing = false;
    this.setState('connecting');
    killStale(this.pidFile, this.localSocket);
    rmSync(this.localSocket, { force: true });
    const rawForwards = [
      { flag: '-L' as const, spec: `${this.localSocket}:${this.opts.remoteSocket}` },
    ];
    const args = buildSshArgs(this.profile, this.env, { mode: 'tunnel', rawForwards });
    try {
      // `ClearAllForwardings=yes` would also drop our own -L, so the user's ssh config cannot be
      // neutralised that way: ask ssh what it would forward and refuse anything else.
      await verifyForwardings(sshBinary(this.env), args, rawForwards, this.profile.id);
    } catch (e) {
      live.delete(this);
      this.setState('failed', (e as Error).message);
      throw e;
    }
    const child = spawn(
      '/bin/sh',
      [
        '-c',
        TUNNEL_SUPERVISOR,
        'abox-tunnel',
        String(process.pid),
        this.pidFile,
        sshBinary(this.env),
        ...args,
      ],
      {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...process.env, LC_ALL: 'C' },
      },
    );
    this.child = child;
    this.stderrTail = '';
    child.stderr!.setEncoding('utf8').on('data', (d: string) => {
      this.stderrTail = (this.stderrTail + d).slice(-4000);
    });
    let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    child.on('exit', (code, signal) => {
      if (this.child !== child) return; // superseded by a restart
      exited = { code, signal };
      rmSync(this.localSocket, { force: true });
      rmSync(this.pidFile, { force: true });
      if (this.closing) return;
      const reason = this.explain();
      if (this.state === 'open' && this.shouldAutoReconnect()) {
        this.setState('connecting', reason);
        void this.autoReconnect();
      } else {
        this.setState('failed', reason);
      }
    });
    child.on('error', (e) => {
      if (this.child !== child) return;
      exited = { code: null, signal: null };
      this.stderrTail += String(e.message);
      this.setState('failed', e.message);
    });

    const deadline = Date.now() + (this.opts.readyTimeoutMs ?? 15_000);
    for (;;) {
      if (exited) throw this.failure(this.explain());
      if (existsSync(this.localSocket) && (await canConnect(this.localSocket))) break;
      if (Date.now() > deadline) {
        this.killSync();
        throw this.failure('timeout waiting for the forwarded socket');
      }
      await sleep(50);
    }
    try {
      chmodSync(this.localSocket, 0o600);
    } catch {
      /* socket vanished: handled by health */
    }
    // The local socket exists as soon as ssh listens; the channel to the remote socket is only
    // verified by a real request. Retry briefly: the remote end may need a moment.
    let healthy = false;
    for (let i = 0; i < 20 && !healthy; i++) {
      if (exited) throw this.failure(this.explain());
      healthy = await this.health();
      if (!healthy) await sleep(100);
    }
    if (!healthy) {
      this.killSync();
      throw this.failure(
        `the engine did not answer through the tunnel (${this.opts.remoteSocket})`,
      );
    }
    this.openedAt = Date.now();
    this.attempts = 0;
    this.setState('open');
    this.env.audit?.('host.connection.open', {
      host: this.profile.id,
      user: this.profile.user,
      kind: 'engine-tunnel',
      remoteSocket: this.opts.remoteSocket,
    });
  }

  private shouldAutoReconnect(): boolean {
    const ar = this.opts.autoReconnect;
    return ar !== undefined && this.attempts < (ar.maxAttempts ?? 5);
  }

  private async autoReconnect(): Promise<void> {
    this.attempts++;
    await sleep(this.opts.autoReconnect?.delayMs ?? 1000);
    if (this.closing) return;
    try {
      await this.start();
    } catch (e) {
      if (!this.closing) {
        this.setState('failed', (e as Error).message);
      }
    }
  }

  async reconnect(): Promise<void> {
    await this.stopChild();
    await this.start();
  }

  private async stopChild(): Promise<void> {
    this.closing = true;
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => child.kill('SIGKILL'), 3000);
        child.once('exit', () => {
          clearTimeout(t);
          resolve();
        });
        child.kill('SIGTERM');
      });
    }
    rmSync(this.localSocket, { force: true });
    rmSync(this.pidFile, { force: true });
  }

  async close(): Promise<void> {
    if (this.state === 'closed') return;
    await this.stopChild();
    live.delete(this);
    const wasOpen = this.openedAt > 0;
    this.setState('closed');
    if (wasOpen) {
      this.env.audit?.('host.connection.close', {
        host: this.profile.id,
        user: this.profile.user,
        kind: 'engine-tunnel',
        durationMs: Date.now() - this.openedAt,
      });
    }
  }

  killSync(): void {
    this.closing = true;
    try {
      this.child?.kill('SIGTERM');
    } catch {
      /* already gone */
    }
    try {
      rmSync(this.localSocket, { force: true });
      rmSync(this.pidFile, { force: true });
    } catch {
      /* ignore */
    }
  }

  private setState(s: TunnelState, reason?: string): void {
    this.state = s;
    this.emit('state', s, reason);
  }

  private explain(): string {
    const lines = this.stderrTail.trim().split('\n').filter(Boolean);
    return lines[lines.length - 1] ?? 'ssh exited';
  }

  private failure(reason: string): AboxError {
    this.setState('failed', reason);
    live.delete(this);
    const hostKey = /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(
      this.stderrTail,
    );
    const auth = /Permission denied/i.test(this.stderrTail);
    const refused = /open failed|administratively prohibited/i.test(this.stderrTail);
    return new AboxError(
      'host_unreachable',
      `cannot open the engine tunnel to ${this.profile.id}: ${reason}`,
      {
        hint: hostKey
          ? 'The host key is not trusted or has changed. Check it with "abox host test" and trust it explicitly.'
          : auth
            ? 'Authentication failed. Check identity_file / ssh-agent and the ssh user.'
            : refused
              ? 'The server refused to open the engine socket: it must exist for the ssh user, and sshd must allow stream-local forwarding for that user (AllowTcpForwarding yes|local and AllowStreamLocalForwarding yes|local).'
              : 'Check that the host is reachable, the user service for the engine socket is running, and engine_socket is correct.',
        details: {
          reason: hostKey ? 'host_key' : auth ? 'auth' : refused ? 'forward_refused' : 'tunnel',
          host: this.profile.id,
        },
      },
    );
  }
}

interface PidRecord {
  /** The ssh process. */
  pid: number;
  /** The abox process that opened the tunnel (absent in files of older versions). */
  owner?: number;
}

function readPidRecord(file: string): PidRecord | undefined {
  try {
    const [pid, owner] = readFileSync(file, 'utf8').trim().split(/\s+/).map(Number);
    if (!Number.isInteger(pid) || pid === undefined || pid <= 1) return undefined;
    return { pid, ...(Number.isInteger(owner) && owner! > 1 ? { owner: owner! } : {}) };
  } catch {
    return undefined;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Kills `rec.pid` when it still is the ssh of that socket (command line check, Linux only). */
function killIfTunnel(rec: PidRecord, socket: string): void {
  try {
    const cmdline = readFileSync(`/proc/${rec.pid}/cmdline`, 'utf8');
    if (cmdline.includes(socket) && cmdline.includes('ssh')) process.kill(rec.pid, 'SIGTERM');
  } catch {
    /* no such process, or no /proc */
  }
}

/**
 * Kills an ssh left behind by a crashed abox (pid file + command line check) and removes its files.
 * A tunnel whose owner is another LIVE abox process is not stale and is left alone.
 */
function killStale(pidFile: string, socket: string): void {
  const rec = readPidRecord(pidFile);
  if (rec && rec.owner !== undefined && rec.owner !== process.pid && isAlive(rec.owner)) return;
  if (rec) killIfTunnel(rec, socket);
  rmSync(pidFile, { force: true });
}

/**
 * Cleans up after abox processes that died without closing their tunnels (`kill -9`): ssh
 * processes of tunnels whose owner is gone are stopped, their sockets and pid files removed.
 * Tunnels of live abox processes (CLI, GUI and MCP server share the runtime directory) stay.
 * Returns the sockets that were cleaned.
 */
export function sweepStaleTunnels(env: Pick<HostsEnv, 'runtimeDir'>): string[] {
  const dir = join(env.runtimeDir, 'tunnels');
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.sock.pid'));
  } catch {
    return [];
  }
  const cleaned: string[] = [];
  for (const name of names) {
    const pidFile = join(dir, name);
    const socket = pidFile.slice(0, -'.pid'.length);
    const rec = readPidRecord(pidFile);
    if (rec?.owner !== undefined && isAlive(rec.owner)) continue;
    if (rec) killIfTunnel(rec, socket);
    rmSync(pidFile, { force: true });
    rmSync(socket, { force: true });
    cleaned.push(socket);
  }
  return cleaned;
}

export function tunnelSocketPath(env: HostsEnv, host: string): string {
  return join(env.runtimeDir, 'tunnels', `${host}.sock`);
}

/**
 * The default socket of a host, unless another live abox process owns a tunnel there: then this
 * process gets its own (`<host>.<pid>.sock`) instead of tearing the other one down.
 */
function freeTunnelSocket(env: HostsEnv, host: string): string {
  const dflt = tunnelSocketPath(env, host);
  const rec = readPidRecord(`${dflt}.pid`);
  if (rec?.owner !== undefined && rec.owner !== process.pid && isAlive(rec.owner)) {
    return join(env.runtimeDir, 'tunnels', `${host}.${process.pid}.sock`);
  }
  return dflt;
}

/**
 * Forwards the engine socket of an ssh host to a local unix socket
 * (`ssh -N -L <local.sock>:<remote.sock>`, M1) so the engine client talks to the remote engine
 * exactly like to a local one. Resolves when the engine answers through the tunnel; the
 * socket is mode 0600 inside a 0700 directory. Closing (or process exit) removes the socket.
 */
export async function openEngineTunnel(
  profile: HostProfile,
  env: HostsEnv,
  opts: OpenTunnelOptions,
): Promise<EngineTunnel> {
  if (!isSafeAbsPath(opts.remoteSocket)) {
    throw new AboxError(
      'invalid_input',
      `unsafe engine socket path: ${JSON.stringify(opts.remoteSocket)}`,
    );
  }
  const dir = join(env.runtimeDir, 'tunnels');
  mkdirSync(env.runtimeDir, { recursive: true, mode: 0o700 });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const local = opts.localSocket ?? freeTunnelSocket(env, profile.id);
  if (local.length > SOCKET_PATH_MAX) {
    throw new AboxError(
      'invalid_input',
      `tunnel socket path is too long (${local.length} > ${SOCKET_PATH_MAX}): ${local}`,
      {
        hint: 'Use a shorter XDG_RUNTIME_DIR / ABOX_HOME.',
      },
    );
  }
  if (!isSafeAbsPath(local)) {
    throw new AboxError(
      'invalid_input',
      `unsafe local tunnel socket path: ${JSON.stringify(local)}`,
      {
        hint: 'The runtime directory path may only contain letters, digits and ._-+=,@/ .',
      },
    );
  }
  const tunnel = new TunnelImpl(profile, env, opts, local);
  await tunnel.start();
  return tunnel;
}

/**
 * One tunnel per host, shared by all callers. Dead or unhealthy tunnels are restarted on the
 * next `get`. `closeAll` stops everything (call on shutdown).
 */
export class TunnelManager {
  private readonly tunnels = new Map<string, EngineTunnel>();
  private readonly pending = new Map<string, Promise<EngineTunnel>>();

  private swept = false;

  constructor(readonly env: HostsEnv) {}

  async get(profile: HostProfile, opts: OpenTunnelOptions): Promise<EngineTunnel> {
    if (!this.swept) {
      this.swept = true;
      sweepStaleTunnels(this.env);
    }
    const inflight = this.pending.get(profile.id);
    if (inflight) return inflight;
    const p = this.getInner(profile, opts).finally(() => this.pending.delete(profile.id));
    this.pending.set(profile.id, p);
    return p;
  }

  private async getInner(profile: HostProfile, opts: OpenTunnelOptions): Promise<EngineTunnel> {
    const existing = this.tunnels.get(profile.id);
    if (existing && existing.state !== 'closed') {
      if (await existing.health()) return existing;
      try {
        await existing.reconnect();
        return existing;
      } catch {
        await existing.close();
        this.tunnels.delete(profile.id);
      }
    }
    const t = await openEngineTunnel(profile, this.env, opts);
    this.tunnels.set(profile.id, t);
    return t;
  }

  peek(hostId: string): EngineTunnel | undefined {
    return this.tunnels.get(hostId);
  }

  async close(hostId: string): Promise<void> {
    const t = this.tunnels.get(hostId);
    this.tunnels.delete(hostId);
    await t?.close();
  }

  async closeAll(): Promise<void> {
    const all = [...this.tunnels.values()];
    this.tunnels.clear();
    await Promise.all(all.map((t) => t.close()));
  }
}
