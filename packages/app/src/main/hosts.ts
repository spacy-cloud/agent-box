/**
 * Hosts and SSH back end of the GUI (human only).
 *
 * The GUI is the human: it uses the hosts module of @abox/core directly. These handlers are never wired to MCP,
 * and the renderer-facing schemas contain no field for a password, passphrase or key material - a profile only
 * stores the PATH of an identity file. Passphrases and FIDO touches are handled by the system `ssh` inside the
 * terminal tab.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import {
  AboxError,
  checkHostKey,
  closeSshConnection,
  forgetHostKey,
  importSshConfig,
  portForwardArgs,
  resolveProfile,
  sshBinary,
  testHost,
  trustHostKey,
} from '@abox/core';
import type {
  HostCache,
  HostCacheEntry,
  HostProfile,
  HostProfileInput,
  HostProfilePatch,
  HostRegistry,
  HostTestResult,
  HostsEnv,
} from '@abox/core';
import type {
  ForwardState,
  HostRow,
  HostStatus,
  HostTestOutcome,
  ImportPreview,
  HostKeyView,
} from '../shared/types';

export interface HostsRuntime {
  hostRegistry: HostRegistry;
  hostsEnv: HostsEnv;
  hostCache: HostCache;
}

/** What the GUI stores next to the manager's own cache fields (`HostCacheInfo`). */
interface GuiHostInfo {
  lastOkAt?: number;
  lastError?: string;
  lastErrorAt?: number;
  gui?: {
    latencyMs?: number;
    hostKey?: HostStatus['hostKey'];
    authOk?: boolean;
    remoteUser?: string;
    backends?: HostStatus['backends'];
    warnings?: string[];
  };
}

const STALE_AFTER_MS = 5 * 60_000;

export function statusFor(
  profile: HostProfile,
  entry: HostCacheEntry | undefined,
  now: number,
): HostStatus {
  const empty: HostStatus = {
    state: 'unknown',
    checkedAt: null,
    lastOkAt: null,
    latencyMs: null,
    stale: false,
    error: null,
    hostKey: null,
    authOk: null,
    remoteUser: null,
    backends: [],
    warnings: [],
  };
  if (profile.kind === 'local') return { ...empty, state: 'local' };
  if (!entry) return empty;
  const info = (entry.info ?? {}) as GuiHostInfo;
  return {
    state: entry.ok ? 'reachable' : 'unreachable',
    checkedAt: entry.ts,
    lastOkAt: info.lastOkAt ?? (entry.ok ? entry.ts : null),
    latencyMs: info.gui?.latencyMs ?? null,
    stale: now - entry.ts > STALE_AFTER_MS,
    error: entry.ok ? null : (info.lastError ?? null),
    hostKey: info.gui?.hostKey ?? null,
    authOk: info.gui?.authOk ?? null,
    remoteUser: info.gui?.remoteUser ?? null,
    backends: info.gui?.backends ?? [],
    warnings: info.gui?.warnings ?? [],
  };
}

/** Runs saved port forwards as `ssh -N` child processes. They end with the app. */
export class ForwardManager {
  private readonly procs = new Map<string, { proc: ChildProcess; state: ForwardState }>();
  private readonly failed = new Map<string, ForwardState>();

  constructor(private readonly env: HostsEnv) {}

  private key(host: string, name: string): string {
    return `${host}\0${name}`;
  }

  list(): ForwardState[] {
    return [
      ...[...this.procs.values()].map((p) => ({ ...p.state })),
      ...[...this.failed.values()].map((s) => ({ ...s })),
    ];
  }

  runningCount(host: string): number {
    return [...this.procs.values()].filter((p) => p.state.host === host).length;
  }

  start(profile: HostProfile, name: string): ForwardState {
    const k = this.key(profile.id, name);
    const existing = this.procs.get(k);
    if (existing) return { ...existing.state };
    // Throws for an unknown forward name or a profile without a destination.
    const args = portForwardArgs(profile, this.env, name);
    const proc = spawn(sshBinary(this.env), args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const state: ForwardState = {
      host: profile.id,
      name,
      state: 'running',
      pid: proc.pid ?? null,
      error: null,
    };
    this.failed.delete(k);
    this.procs.set(k, { proc, state });
    let stderr = '';
    proc.stderr?.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString('utf8')).slice(-2000);
    });
    const finish = (code: number | null, err?: Error): void => {
      if (this.procs.get(k)?.proc !== proc) return;
      this.procs.delete(k);
      if (!stopping.has(proc)) {
        const last = stderr.trim().split('\n').slice(-1)[0] ?? '';
        this.failed.set(k, {
          host: profile.id,
          name,
          state: 'failed',
          pid: null,
          error: err?.message ?? (last || `ssh exited with ${code}`),
        });
      }
    };
    proc.on('error', (e) => finish(null, e));
    proc.on('exit', (code) => finish(code));
    this.env.audit?.('host.forward.start', { host: profile.id, forward: name });
    return { ...state };
  }

  stop(host: string, name: string): ForwardState {
    const k = this.key(host, name);
    const entry = this.procs.get(k);
    this.failed.delete(k);
    if (entry) {
      stopping.add(entry.proc);
      entry.proc.kill();
      this.procs.delete(k);
      this.env.audit?.('host.forward.stop', { host, forward: name });
    }
    return { host, name, state: 'stopped', pid: null, error: null };
  }

  stopHost(host: string): void {
    for (const p of [...this.procs.values()]) if (p.state.host === host) this.stop(host, p.state.name);
    for (const [k, s] of [...this.failed]) if (s.host === host) this.failed.delete(k);
  }

  stopAll(): void {
    for (const p of [...this.procs.values()]) this.stop(p.state.host, p.state.name);
  }
}

const stopping = new WeakSet<ChildProcess>();

export interface HostsService {
  list(): HostRow[];
  add(input: HostProfileInput): HostRow;
  update(id: string, patch: HostProfilePatch): HostRow;
  remove(id: string): Promise<{ removed: boolean }>;
  test(id: string): Promise<HostTestOutcome>;
  importPreview(): Promise<ImportPreview>;
  importApply(ids: string[]): Promise<{ added: string[] }>;
  keyCheck(id: string): Promise<HostKeyView>;
  keyTrust(id: string, fingerprint: string): Promise<{ added: boolean; fingerprint: string }>;
  keyForget(id: string): Promise<{ removed: boolean }>;
  forwards(): ForwardState[];
  forwardStart(id: string, name: string): Promise<ForwardState>;
  forwardStop(id: string, name: string): ForwardState;
  shutdown(): void;
}

export function createHostsService(
  rt: HostsRuntime,
  opts: { now?: () => number; test?: typeof testHost } = {},
): HostsService {
  const { hostRegistry: registry, hostsEnv: env, hostCache: cache } = rt;
  const now = opts.now ?? Date.now;
  const runTest = opts.test ?? testHost;
  const forwards = new ForwardManager(env);

  const row = (profile: HostProfile): HostRow => {
    const resolved = resolveProfile(profile);
    return {
      profile,
      minIsolation: resolved.minIsolation,
      requiresApproval: resolved.requiresApproval,
      status: statusFor(profile, cache.get(profile.id, Number.POSITIVE_INFINITY), now()),
      forwardsRunning: forwards.runningCount(profile.id),
    };
  };
  const requireRemote = (id: string): HostProfile => {
    const p = registry.require(id);
    if (p.kind !== 'ssh') {
      throw new AboxError('invalid_input', `"${id}" is the local host, not an ssh host`);
    }
    return p;
  };

  function record(profile: HostProfile, r: HostTestResult): void {
    const prev = (cache.get(profile.id, Number.POSITIVE_INFINITY)?.info ?? {}) as GuiHostInfo;
    const ok = r.reachable && (r.hostKey !== 'trusted' || r.authOk);
    const t = now();
    const backends = (['docker', 'podman'] as const).flatMap((name) => {
      const b = r.backends[name];
      return b ? [{ name, ...b }] : [];
    });
    const info: GuiHostInfo = {
      ...prev,
      ...(ok ? { lastOkAt: t } : { lastError: r.error ?? r.warnings[0] ?? 'not reachable', lastErrorAt: t }),
      gui: {
        ...(r.latencyMs !== undefined ? { latencyMs: r.latencyMs } : {}),
        hostKey: r.hostKey,
        authOk: r.authOk,
        ...(r.remoteUser ? { remoteUser: r.remoteUser } : {}),
        backends,
        warnings: r.warnings,
      },
    };
    if (ok) {
      delete info.lastError;
      delete info.lastErrorAt;
    }
    cache.put(profile.id, info, ok, t);
  }

  async function preview(): Promise<ImportPreview> {
    const r = await importSshConfig({ registry, dryRun: true });
    return {
      path: r.path,
      hosts: r.hosts.map((h) => ({
        id: h.profile.id,
        alias: h.alias,
        hostname: h.effective.hostname ?? null,
        user: h.effective.user ?? null,
        port: h.effective.port ?? null,
        proxyJump: h.effective.proxyJump ?? null,
        identityFile: h.effective.identityFile ?? null,
        warnings: h.warnings,
      })),
      skipped: r.skipped,
      warnings: r.warnings,
    };
  }

  return {
    list: () => registry.list().map(row),
    add: (input) => row(registry.add(input)),
    update: (id, patch) => row(registry.update(id, patch)),

    async remove(id) {
      const p = registry.get(id);
      if (p && p.kind === 'ssh') {
        forwards.stopHost(id);
        await closeSshConnection(p, env).catch(() => false);
      }
      const removed = registry.remove(id);
      if (removed) cache.delete(id);
      return { removed };
    },

    async test(id) {
      const profile = requireRemote(id);
      const result = await runTest(profile, env);
      record(profile, result);
      return { row: row(profile), fingerprints: result.fingerprints };
    },

    importPreview: preview,

    async importApply(ids) {
      const wanted = new Set(ids);
      const r = await importSshConfig({ registry, dryRun: true });
      const added: string[] = [];
      const errors: string[] = [];
      for (const h of r.hosts) {
        if (!wanted.has(h.profile.id)) continue;
        try {
          registry.add(h.profile);
          added.push(h.profile.id);
        } catch (e) {
          errors.push(`${h.profile.id}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (added.length === 0 && errors.length > 0) {
        throw new AboxError('conflict', 'Nothing was imported', {
          issues: errors.map((message) => ({ message })),
        });
      }
      env.audit?.('host.import', { count: added.length });
      return { added };
    },

    async keyCheck(id) {
      const profile = requireRemote(id);
      const c = await checkHostKey(profile, env);
      return {
        id,
        status: c.status,
        hostSpec: c.hostSpec,
        keys: c.keys.map((k) => ({ type: k.type, fingerprint: k.fingerprint })),
        trusted: c.trusted.map((k) => ({ type: k.type, fingerprint: k.fingerprint })),
      };
    },

    async keyTrust(id, fingerprint) {
      const profile = requireRemote(id);
      const r = await trustHostKey(profile, fingerprint, env);
      return { added: r.added, fingerprint: r.fingerprint };
    },

    async keyForget(id) {
      const profile = requireRemote(id);
      // A live ControlMaster would skip the host key check of new connections.
      await closeSshConnection(profile, env).catch(() => false);
      return { removed: await forgetHostKey(profile, env) };
    },

    forwards: () => forwards.list(),

    async forwardStart(id, name) {
      const profile = requireRemote(id);
      const c = await checkHostKey(profile, env);
      if (c.status !== 'trusted') {
        throw new AboxError(
          'host_unreachable',
          `the host key of ${id} is ${c.status === 'changed' ? 'CHANGED' : 'not trusted yet'}`,
          { hint: 'Check and trust the host key in the Hosts view first.' },
        );
      }
      return forwards.start(profile, name);
    },
    forwardStop: (id, name) => forwards.stop(id, name),
    shutdown: () => forwards.stopAll(),
  };
}
