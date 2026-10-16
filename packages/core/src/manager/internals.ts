import { chmodSync, existsSync, readFileSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { AboxError } from '../errors.js';
import type { AboxConfig } from '../config/config.js';
import { loadConfig } from '../config/config.js';
import { ensureDirs, resolvePaths } from '../config/paths.js';
import type { AboxPaths } from '../config/paths.js';
import type { ProviderFactory, SandboxProvider } from '../provider.js';
import { LibsecretStore } from '../secrets/libsecret.js';
import type { SecretStore } from '../secrets/store.js';
import { StateStore } from '../state/store.js';
import type { SandboxRecord } from '../state/sandbox-registry.js';
import type { AuditAppendInput, AuditEntry } from '../state/audit-log.js';
import { canonicalizePath, defaultPolicy, parsePolicy, resolveContext } from '../policy/index.js';
import type { AgentContext, HostInfo, Policy } from '../policy/index.js';
import { DEFAULT_POLICY_YAML } from '../policy/load.js';
import type { BackendKind, SandboxId, SandboxInfo, SandboxState } from '../types.js';
import type { WorkspaceRecord } from '../workspace/index.js';
import type {
  AboxEvent,
  AboxEventType,
  Caller,
  HostResolver,
  ResolvedHost,
  SandboxView,
  SandboxWorkspaceView,
} from './types.js';
import { collectNetworkEvents } from './network-audit.js';
import { errMessage, isPidAlive, SANDBOX_ID_RE } from './util.js';

export interface AboxOptions {
  /** Environment for path resolution (default `process.env`; `ABOX_HOME=<dir>` isolates everything). */
  env?: NodeJS.ProcessEnv;
  paths?: AboxPaths;
  /** One factory per backend kind; a backend without a factory is "not available". */
  providers: Partial<Record<BackendKind, ProviderFactory>>;
  /** Keyring access; default: libsecret (`secret-tool`), only touched when a template uses secrets. */
  secretStore?: SecretStore;
  /** Default: only host `local` (zone `workstation`) with every registered backend. */
  hostResolver?: HostResolver;
  now?: () => number;
  /** Project directory searched for `.sandbox/*.yaml` and used as the default workspace path. */
  projectDir?: string;
  /** Home directory for `~` expansion and the forbidden-path list (default `$HOME`). */
  home?: string;
  /** Minimum seconds between TTL sweeps (default 5). `0` sweeps on every call. */
  ttlCheckIntervalSec?: number;
  /** Override the loaded config (tests). */
  config?: AboxConfig;
  /** Use this policy text instead of reading `policy.yaml` (tests). */
  policyText?: string;
}

/** What the manager stores in `SandboxRecord.effective` (never any secret value). */
export interface StoredEffective {
  policy?: Record<string, unknown>;
  provider?: Record<string, unknown> | undefined;
  network: { mode: string; allow: string[]; privateExceptions?: string[] };
  mounts: Array<{ hostPath: string; target: string; access: string }>;
  resources: { cpus: number; memoryBytes: number; ttlMs: number; pids?: number };
  /** Named `keyringRefs` on purpose: a key called `secrets` would be redacted by the state layer. */
  keyringRefs: Array<{ ref: string; inject: string; hosts: string[]; path?: string }>;
  requestHash?: string;
  warnings?: string[];
  /** Present while the create is in flight; used to detect creators killed with `kill -9`. */
  creator?: { pid: number; host: string; startedAt: number };
  workspaceWarnings?: string[];
  /** Who/what created it, for `inspect`. */
  imageRef?: string;
}

const PREPARING_MAX_AGE_MS = 30 * 60_000;
const POLICY_POLL_MS = 500;

export class Internals {
  readonly paths: AboxPaths;
  config: AboxConfig;
  readonly state: StateStore;
  readonly now: () => number;
  readonly home: string;
  readonly projectDir: string | undefined;
  readonly env: NodeJS.ProcessEnv;
  readonly providerFactories: Partial<Record<BackendKind, ProviderFactory>>;
  readonly secretStore: SecretStore;
  readonly knownSecrets: Set<string>;
  policy: Policy;
  policyText: string;
  private readonly hostResolverFn: HostResolver | undefined;
  private readonly policyOverride: string | undefined;
  private policyStamp = '';
  private policyCheckedAt = 0;
  private readonly providerCache = new Map<string, SandboxProvider>();
  private readonly listeners = new Set<(e: AboxEvent) => void>();
  /** Per sandbox: when this process last asked the backend for proxy egress events (throttling). */
  readonly netPolledAt = new Map<string, number>();
  private readonly coalesced = new Map<string, number>();
  private lastTtlSweep = -Infinity;
  private sweeping = false;
  private readonly ttlIntervalMs: number;
  closed = false;

  private constructor(
    opts: AboxOptions,
    paths: AboxPaths,
    state: StateStore,
    config: AboxConfig,
    knownSecrets: Set<string>,
  ) {
    this.knownSecrets = knownSecrets;
    this.env = opts.env ?? process.env;
    this.paths = paths;
    this.state = state;
    this.config = config;
    this.now = opts.now ?? Date.now;
    this.home =
      opts.home ??
      (this.env['HOME'] && this.env['HOME'].startsWith('/')
        ? this.env['HOME']
        : (process.env['HOME'] ?? '/'));
    this.projectDir = opts.projectDir;
    this.providerFactories = opts.providers;
    this.secretStore = opts.secretStore ?? new LibsecretStore();
    this.hostResolverFn = opts.hostResolver;
    this.policyOverride = opts.policyText;
    this.ttlIntervalMs = Math.max(0, (opts.ttlCheckIntervalSec ?? 5) * 1000);
    const loaded = this.readPolicy();
    this.policy = loaded.policy;
    this.policyText = loaded.text;
    this.policyStamp = loaded.stamp;
  }

  static open(opts: AboxOptions): Internals {
    const env = opts.env ?? process.env;
    const paths = ensureDirs(opts.paths ?? resolvePaths(env));
    const config = opts.config ?? loadConfig(paths.configFile);
    const secretValues = new Set<string>();
    const now = opts.now ?? Date.now;
    const state = StateStore.open(paths.stateDb, {
      now,
      audit: { secretValues: () => secretValues },
    });
    let self: Internals;
    try {
      self = new Internals(opts, paths, state, config, secretValues);
    } catch (e) {
      state.close();
      throw e;
    }
    self.recordPolicyRevision('system');
    return self;
  }

  // -- policy ---------------------------------------------------------------------------------

  private readPolicy(): { policy: Policy; text: string; stamp: string } {
    if (this.policyOverride !== undefined) {
      return {
        policy: parsePolicy(this.policyOverride, { kind: 'default' }),
        text: this.policyOverride,
        stamp: 'override',
      };
    }
    const file = this.paths.policyFile;
    try {
      const st = statSync(file);
      const text = readFileSync(file, 'utf8');
      return {
        policy: parsePolicy(text, { kind: 'file', path: file }),
        text,
        stamp: `${st.mtimeMs}:${st.size}:${st.ino}`,
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return { policy: defaultPolicy(), text: DEFAULT_POLICY_YAML, stamp: 'none' };
      }
      if (e instanceof AboxError) throw e;
      throw new AboxError('invalid_input', `cannot read policy file ${file}: ${errMessage(e)}`, {
        hint: 'Check the file permissions of policy.yaml.',
        cause: e,
      });
    }
  }

  recordPolicyRevision(actor: string): number | null {
    const latest = this.state.policyRevisions.latest();
    if (latest && latest.contentHash === this.policy.contentHash) return latest.rev;
    return this.state.policyRevisions.record({
      contentHash: this.policy.contentHash,
      content: this.policyText,
      actor: latest ? 'external-edit' : actor,
    }).rev;
  }

  /** Pick up edits of policy.yaml made by a human in another process (cheap stat, at most every 500 ms). */
  refreshPolicy(force = false): void {
    if (this.policyOverride !== undefined) return;
    const t = Date.now();
    if (!force && t - this.policyCheckedAt < POLICY_POLL_MS) return;
    this.policyCheckedAt = t;
    let stamp = 'none';
    try {
      const st = statSync(this.paths.policyFile);
      stamp = `${st.mtimeMs}:${st.size}:${st.ino}`;
    } catch {
      /* missing file = default policy */
    }
    if (stamp === this.policyStamp) return;
    try {
      const loaded = this.readPolicy();
      const changed = loaded.policy.contentHash !== this.policy.contentHash;
      this.policy = loaded.policy;
      this.policyText = loaded.text;
      this.policyStamp = loaded.stamp;
      if (changed) {
        this.recordPolicyRevision('external-edit');
        this.audit('system', 'policy.reload', {
          decision: 'info',
          details: { contentHash: loaded.policy.contentHash },
        });
        this.emit('policy.changed', { data: { contentHash: loaded.policy.contentHash } });
      }
    } catch (e) {
      // Keep the last good policy; a broken edit must not silently widen or drop the rules.
      this.policyStamp = stamp;
      this.audit('system', 'policy.reload_failed', {
        decision: 'error',
        details: { message: errMessage(e) },
      });
    }
  }

  /** Replace the in-memory policy after `setPolicy` wrote the file. */
  adoptPolicy(policy: Policy, text: string): void {
    this.policy = policy;
    this.policyText = text;
    try {
      const st = statSync(this.paths.policyFile);
      this.policyStamp = `${st.mtimeMs}:${st.size}:${st.ino}`;
    } catch {
      this.policyStamp = 'none';
    }
  }

  // -- caller -----------------------------------------------------------------------------------

  /** Resolve the caller to a context (unknown -> `policy_denied`). Also runs the cheap periodic housekeeping. */
  async context(caller: Caller): Promise<AgentContext> {
    if (this.closed) throw new AboxError('internal', 'abox instance is closed');
    this.refreshPolicy();
    const id = (caller as { contextId?: unknown } | undefined)?.contextId;
    if (typeof id !== 'string' || id.length === 0 || id.length > 128) {
      throw new AboxError('policy_denied', 'a caller with a context id is required');
    }
    let ctx: AgentContext;
    try {
      ctx = resolveContext(this.policy, id, { home: this.home });
    } catch (e) {
      this.audit('unknown', 'context.resolve', {
        decision: 'deny',
        details: { contextId: id.slice(0, 64) },
      });
      throw e;
    }
    await this.sweepTtl();
    return ctx;
  }

  requireHuman(ctx: AgentContext, action: string, sandboxId?: string): void {
    if (ctx.kind === 'human') return;
    this.audit(ctx.owner, `${action}_denied`, {
      ...(sandboxId ? { sandboxId } : {}),
      decision: 'deny',
      details: { reason: 'human only' },
    });
    throw new AboxError(
      'policy_denied',
      `${action.replace(/[._]/g, ' ')} is only available to a human`,
      {
        hint: 'Agents cannot change policy, approvals, tokens or the manager itself; ask the human to do it (CLI or GUI).',
      },
    );
  }

  // -- audit & events ---------------------------------------------------------------------------

  audit(
    actor: string,
    action: string,
    o: Omit<AuditAppendInput, 'actor' | 'action'> = {},
  ): AuditEntry {
    return this.state.audit.append({ actor, action, ...o });
  }

  onEvent(listener: (e: AboxEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(type: AboxEventType, e: Partial<Omit<AboxEvent, 'type' | 'ts'>> = {}): void {
    const event: AboxEvent = { type, ts: this.now(), ...e };
    for (const l of [...this.listeners]) {
      try {
        l(event);
      } catch {
        /* listeners must not break the manager */
      }
    }
  }

  /**
   * True the first time `key` is seen within `windowMs`. Used for read-only operations that a surface
   * may poll (`abox logs -f`, a GUI log view): the first read of a burst is audited, the polls after it are not.
   */
  firstWithin(key: string, windowMs: number): boolean {
    const t = Date.now();
    const last = this.coalesced.get(key);
    if (last !== undefined && t - last < windowMs) return false;
    if (this.coalesced.size > 1000) this.coalesced.clear();
    this.coalesced.set(key, t);
    return true;
  }

  // -- hosts & providers --------------------------------------------------------------------------

  async resolveHost(hostId: string): Promise<ResolvedHost> {
    if (this.hostResolverFn) {
      const h = await this.hostResolverFn(hostId);
      const connection =
        h.connection.kind === 'local' && !h.connection.dataDir
          ? { ...h.connection, dataDir: this.paths.dataDir }
          : h.connection;
      return { ...h, connection };
    }
    if (hostId !== 'local') {
      throw new AboxError('not_found', `unknown host '${hostId}'`, {
        hint: 'Only host "local" is configured. Remote hosts need host profiles (hosts.yaml).',
      });
    }
    return {
      connection: { host: 'local', kind: 'local', dataDir: this.paths.dataDir },
      zone: 'workstation',
      backends: Object.keys(this.providerFactories).filter(
        (k) => this.providerFactories[k as BackendKind] !== undefined,
      ) as BackendKind[],
    };
  }

  hostInfo(h: ResolvedHost, remote: boolean): HostInfo {
    return {
      id: h.connection.host,
      zone: h.zone,
      ...(h.minIsolation ? { minIsolation: h.minIsolation } : {}),
      ...(h.limits ? { limits: h.limits } : {}),
      remote,
    };
  }

  providerFor(host: ResolvedHost, backend: BackendKind): SandboxProvider {
    const factory = this.providerFactories[backend];
    if (!factory || !host.backends.includes(backend)) {
      throw new AboxError(
        'backend_unavailable',
        `backend '${backend}' is not available on host '${host.connection.host}'`,
        {
          hint: 'Run `abox doctor` to see which backends are installed and reachable.',
        },
      );
    }
    const key = `${host.connection.host}|${backend}`;
    let p = this.providerCache.get(key);
    if (!p) {
      p = factory(host.connection);
      this.providerCache.set(key, p);
    }
    return p;
  }

  async providerForRecord(rec: SandboxRecord): Promise<SandboxProvider> {
    let host: ResolvedHost;
    try {
      host = await this.resolveHost(rec.host);
    } catch (e) {
      throw new AboxError(
        'host_unreachable',
        `host '${rec.host}' of sandbox ${rec.id} cannot be reached: ${errMessage(e)}`,
        {
          hint: 'The last known state is still listed; retry when the host is back.',
          cause: e,
        },
      );
    }
    return this.providerFor(host, rec.backend);
  }

  // -- sandboxes ----------------------------------------------------------------------------------------

  /**
   * Registry lookup with the visibility rule: agents only see their own sandboxes. Anything else
   * is `not_found` (never `policy_denied`), so the existence of foreign ids is not revealed.
   */
  lookup(ctx: AgentContext, id: unknown, o: { allowRemoved?: boolean } = {}): SandboxRecord {
    if (typeof id !== 'string' || !SANDBOX_ID_RE.test(id)) {
      throw new AboxError('not_found', `sandbox '${String(id).slice(0, 80)}' not found`);
    }
    const rec = this.state.sandboxes.get(id);
    const visible = rec && (ctx.kind === 'human' || rec.owner === ctx.owner);
    if (!rec || !visible || (rec.state === 'removed' && !o.allowRemoved)) {
      if (ctx.kind === 'agent') {
        // Probing is audited without the sandbox id column so the owner's audit view does not show it.
        this.audit(ctx.owner, 'sandbox.lookup', {
          decision: 'deny',
          details: { reason: 'not_found', requested: id },
        });
      }
      throw new AboxError('not_found', `sandbox '${id}' not found`, {
        hint: 'List your sandboxes with sandbox_list / `abox ls`.',
      });
    }
    return rec;
  }

  countActive(owner?: string): number {
    const states: SandboxState[] = ['preparing', 'created', 'running', 'stopped'];
    return this.state.sandboxes
      .list({ ...(owner ? { owner } : {}), state: states })
      .filter((r) => !r.stale && !this.isInterrupted(r)).length;
  }

  countActiveOnHost(host: string): number {
    const states: SandboxState[] = ['preparing', 'created', 'running', 'stopped'];
    return this.state.sandboxes
      .list({ host, state: states })
      .filter((r) => !r.stale && !this.isInterrupted(r)).length;
  }

  /** A `preparing` row whose creator process is gone (or that has been preparing for far too long). */
  isInterrupted(rec: SandboxRecord): boolean {
    if (rec.state !== 'preparing') return false;
    const creator = (rec.effective as StoredEffective | null)?.creator;
    if (creator && creator.host === hostname()) return !isPidAlive(creator.pid);
    return this.now() - rec.createdAt > PREPARING_MAX_AGE_MS;
  }

  creatorStamp(): NonNullable<StoredEffective['creator']> {
    return { pid: process.pid, host: hostname(), startedAt: this.now() };
  }

  sandboxDir(short: string): string {
    return `${this.paths.dataDir}/sandboxes/${short}`;
  }

  /** Canonical abox-owned trees that can never be a workspace or mount (config, data, cache, runtime, sandbox dirs). */
  forbiddenTrees(): string[] {
    const out = new Set<string>();
    const add = (p: string | undefined): void => {
      if (!p) return;
      try {
        out.add(canonicalizePath(p, { home: this.home, cwd: this.home }));
      } catch {
        /* unusable path: nothing to protect */
      }
    };
    for (const p of [
      this.paths.configDir,
      this.paths.dataDir,
      this.paths.cacheDir,
      this.paths.runtimeDir,
      this.paths.logsDir,
    ])
      add(p);
    for (const r of this.state.sandboxes.list({ includeRemoved: false })) {
      const ws = r.workspace as Partial<WorkspaceRecord> | null;
      add(ws?.sandboxDir);
      add(ws?.liveTree);
      add(ws?.worktree?.path);
    }
    return [...out];
  }

  // -- secrets -------------------------------------------------------------------------------------------

  /** Register secret values so audit entries, logs and exec output are masked from now on. */
  noteSecrets(values: Iterable<string>): void {
    for (const v of values) if (typeof v === 'string' && v.length >= 4) this.knownSecrets.add(v);
  }

  /** Values of the secrets referenced by a sandbox, fetched from the keyring (best effort, never throws). */
  async secretValuesOf(rec: SandboxRecord): Promise<string[]> {
    const refs = (rec.effective as StoredEffective | null)?.keyringRefs ?? [];
    if (refs.length === 0) return [...this.knownSecrets];
    const values: string[] = [];
    for (const r of refs) {
      try {
        const v = await this.secretStore.get(r.ref);
        if (v) values.push(v);
      } catch {
        /* keyring locked or unavailable: masking is best effort */
      }
    }
    this.noteSecrets(values);
    return [...new Set([...values, ...this.knownSecrets])];
  }

  // -- views ------------------------------------------------------------------------------------------------

  toView(
    rec: SandboxRecord,
    o: { info?: SandboxInfo | undefined; missing?: boolean; hostReachable?: boolean } = {},
  ): SandboxView {
    const eff = (rec.effective ?? null) as StoredEffective | null;
    const t = this.now();
    const live = rec.state !== 'removed' && rec.state !== 'failed' && rec.state !== 'preparing';
    const expired = live && (rec.state === 'expired' || rec.expiresAt <= t);
    const ws = rec.workspace as Partial<WorkspaceRecord> | null;
    const workspace: SandboxWorkspaceView | null = ws?.mode
      ? {
          mode: ws.mode,
          sandboxPath: ws.sandboxPath ?? '/workspace',
          access: ws.access ?? 'rw',
          ...(ws.ref ? { ref: ws.ref } : {}),
          ...(ws.source ? { source: ws.source } : {}),
          ...(ws.branch ? { branch: ws.branch } : {}),
          remote: ws.remote ?? false,
        }
      : null;
    const providerEffective = o.info?.effective ?? eff?.provider;
    return {
      id: rec.id,
      name: rec.name,
      host: rec.host,
      owner: rec.owner,
      template: rec.template,
      templateHash: rec.templateHash,
      backend: rec.backend,
      isolation: rec.isolation,
      state: expired
        ? 'expired'
        : o.info && live && o.info.state !== 'expired'
          ? o.info.state
          : rec.state,
      createdAt: rec.createdAt,
      expiresAt: rec.expiresAt,
      ttlRemainingMs: Math.max(0, rec.expiresAt - t),
      expired,
      stale: rec.stale || o.hostReachable === false,
      missingInBackend: o.missing ?? false,
      hostReachable: o.hostReachable ?? true,
      lastSeenAt: rec.lastSeenAt,
      error: rec.error,
      workspace,
      network: eff?.network
        ? {
            mode: eff.network.mode as SandboxView['network']['mode'],
            allow: [...eff.network.allow],
          }
        : { mode: 'none', allow: [] },
      mounts: (eff?.mounts ?? []).map((m) => ({
        hostPath: m.hostPath,
        target: m.target,
        access: m.access as 'ro' | 'rw',
      })),
      resources: eff?.resources ?? {
        cpus: 0,
        memoryBytes: 0,
        ttlMs: rec.expiresAt - rec.createdAt,
      },
      secretRefs: (eff?.keyringRefs ?? []).map((s) => ({
        ref: s.ref,
        inject: s.inject,
        hosts: s.hosts,
      })),
      effective: {
        ...(eff?.policy ? { policy: eff.policy } : {}),
        ...(providerEffective ? { provider: providerEffective } : {}),
      },
      requestId: rec.requestId,
    };
  }

  // -- TTL ---------------------------------------------------------------------------------------------------

  /** Mark overdue sandboxes as expired and stop them. Runs at most once per interval; removal is left to `gc`. */
  async sweepTtl(force = false): Promise<SandboxId[]> {
    const t = this.now();
    if (this.sweeping || (!force && t - this.lastTtlSweep < this.ttlIntervalMs)) return [];
    this.lastTtlSweep = t;
    this.sweeping = true;
    const done: SandboxId[] = [];
    try {
      for (const rec of this.state.sandboxes.list({ state: ['created', 'running', 'stopped'] })) {
        if (rec.expiresAt > t) continue;
        if (!this.state.sandboxes.transition(rec.id, ['created', 'running', 'stopped'], 'expired'))
          continue;
        done.push(rec.id);
        let stopError: string | undefined;
        await collectNetworkEvents(this, rec);
        try {
          const p = await this.providerForRecord(rec);
          await p.stop(rec.id);
        } catch (e) {
          if (!(e instanceof AboxError && e.code === 'not_found')) stopError = errMessage(e);
        }
        this.audit('system', 'sandbox.expired', {
          sandboxId: rec.id,
          decision: 'info',
          details: {
            owner: rec.owner,
            expiresAt: rec.expiresAt,
            ...(stopError ? { stopError } : {}),
          },
        });
        this.emit('sandbox.expired', { sandboxId: rec.id, owner: rec.owner });
      }
      const expiredApprovals = this.state.approvals.expireOverdue();
      for (const id of expiredApprovals) {
        this.audit('system', 'approval.expired', {
          decision: 'denied',
          details: { approvalId: id },
        });
        this.emit('approval.expired', { approvalId: id });
      }
    } finally {
      this.sweeping = false;
    }
    return done;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
    this.state.close();
  }
}

export function ensureMode(path: string, mode: number): void {
  try {
    if (existsSync(path)) chmodSync(path, mode);
  } catch {
    /* best effort */
  }
}
