import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { AboxError } from '../../errors.js';
import type { SandboxProvider } from '../../provider.js';
import type {
  BackendStatus,
  CacheVolume,
  DirEntry,
  ExecEvent,
  ExecRequest,
  ExecResult,
  ForeignResource,
  HostConnection,
  NetworkEvent,
  NetworkMode,
  PreparedImage,
  PrepareOptions,
  ProviderCapabilities,
  ResolvedTemplate,
  ResourceUsage,
  SandboxFilter,
  SandboxId,
  SandboxInfo,
  SandboxPortForward,
  SandboxSpec,
  TtySession,
} from '../../types.js';

interface FakeSandbox {
  spec: SandboxSpec;
  state: 'created' | 'running' | 'stopped';
  files: Map<string, Buffer>;
  snapshots: Map<string, Map<string, Buffer>>;
}

export interface FakeOptions {
  kind?: SandboxProvider['kind'];
  capabilities?: Partial<ProviderCapabilities>;
  updateNetwork?: boolean;
  /** Called for every exec; return a partial result. */
  execHandler?: (
    id: SandboxId,
    req: ExecRequest,
  ) => Partial<ExecResult> | Promise<Partial<ExecResult>>;
  /** Provide `networkEvents` (the proxy's egress decisions): push events to `fake.netEvents`. */
  networkEvents?: boolean;
  /** Provide `logs`; the handler returns the sandbox's main process output. */
  logs?: (id: SandboxId, opts: { tail?: number; sinceTs?: number }) => string;
  /** Provide `listForeign` / `removeForeign` with these objects of other abox instances. */
  foreign?: ForeignResource[];
  /** `removeForeign` fails for the object with this `ref`. */
  failForeignRemove?: string;
  /** The backend cannot move its deadline: no `extendExpiry` (default: it can). */
  noExtendExpiry?: boolean;
  /** `extendExpiry` fails with this message (the backend refuses to move its deadline). */
  failExtendExpiry?: string;
  /** The backend can change cpu / memory limits of an existing sandbox: provides `updateResources`. */
  updateResources?: boolean;
  /** `updateResources` fails with this message (e.g. memory below what the sandbox uses). */
  failUpdateResources?: string;
  /** Provide `stats`: the sample for a running sandbox (default: a fixed one); a sandbox that is not running is `conflict`. */
  stats?: boolean | ((id: SandboxId) => ResourceUsage);
  /** Provide package cache volumes (`capabilities().caches`, `listCaches`, `removeCache`). */
  caches?: boolean;
  /** Provide port forwards for these network modes (`true` = allowlist and open, like the container backends). */
  portForward?: boolean | NetworkMode[];
  /** Provide `hostResources` (cpus and memory of the machine the engine runs on). */
  hostResources?: { cpus: number; memoryBytes: number };
  failCreate?: boolean;
  failStart?: boolean;
  failPrepare?: boolean;
  now?: () => number;
}

/** In-memory container-like backend for policy/approval/network/secret flow tests. Records every spec. */
export class FakeProvider implements SandboxProvider {
  readonly kind: SandboxProvider['kind'];
  readonly isolation = 'container' as const;
  readonly host: HostConnection;
  readonly sandboxes = new Map<SandboxId, FakeSandbox>();
  readonly specs: SandboxSpec[] = [];
  readonly execCalls: Array<{ id: SandboxId; req: ExecRequest }> = [];
  readonly prepareCalls: Array<{ hash: string; opts: PrepareOptions }> = [];
  readonly networkUpdates: Array<{ id: SandboxId; allow: string[]; injections: number }> = [];
  readonly gcCalls: string[][] = [];
  /** Every `extendExpiry` call that was accepted. */
  readonly expiryUpdates: Array<{ id: SandboxId; expiresAt: number }> = [];
  /** Open port forwards per sandbox (closed again by `stop` / `remove`, like a real backend does). */
  readonly portForwards = new Map<SandboxId, SandboxPortForward[]>();
  /** Every `stats` call. */
  readonly statsCalls: SandboxId[] = [];
  /** Every `updateResources` call that was accepted. */
  readonly resourceUpdates: Array<{ id: SandboxId; cpus?: number; memoryBytes?: number }> = [];
  /** Foreign objects that are still there / the refs `removeForeign` deleted. */
  readonly foreignResources: ForeignResource[] = [];
  readonly foreignRemoved: string[] = [];
  /** Cache volumes created by `create` (key -> volume) and the sizes tests give them. */
  readonly cacheVolumes = new Map<string, Omit<CacheVolume, 'inUse' | 'sizeBytes'>>();
  readonly cacheSizes = new Map<string, number>();
  readonly cacheRemoved: string[] = [];
  /** Egress events the fake proxy "recorded" per sandbox (`networkEvents` returns those with `ts >= since`). */
  readonly netEvents = new Map<SandboxId, NetworkEvent[]>();
  readonly networkEventCalls: Array<{ id: SandboxId; sinceTs: number | undefined }> = [];
  readonly copyCalls: Array<{ dir: 'in' | 'out'; id: SandboxId; host: string; sandbox: string }> =
    [];
  readonly ttyCalls: Array<{ id: SandboxId; cols: number; rows: number; argv?: string[] }> = [];
  /** Exit handlers of the open fake terminals (call to end the session with a code). */
  readonly ttyExits: Array<(code: number) => void> = [];
  private readonly seenHashes = new Set<string>();
  private pinCounter = 0;
  private snapCounter = 0;
  readonly opts: FakeOptions;
  private readonly caps: ProviderCapabilities;
  updateNetwork?: SandboxProvider['updateNetwork'];
  extendExpiry?: SandboxProvider['extendExpiry'];
  updateResources?: SandboxProvider['updateResources'];
  stats?: SandboxProvider['stats'];
  addPortForward?: SandboxProvider['addPortForward'];
  listPortForwards?: SandboxProvider['listPortForwards'];
  removePortForward?: SandboxProvider['removePortForward'];
  hostResources?: SandboxProvider['hostResources'];
  /** Every `hostResources` call. */
  hostResourcesCalls = 0;
  snapshot?: SandboxProvider['snapshot'];
  restore?: SandboxProvider['restore'];
  networkEvents?: SandboxProvider['networkEvents'];
  logs?: SandboxProvider['logs'];
  listForeign?: SandboxProvider['listForeign'];
  removeForeign?: SandboxProvider['removeForeign'];
  listCaches?: SandboxProvider['listCaches'];
  removeCache?: SandboxProvider['removeCache'];

  constructor(host: HostConnection, opts: FakeOptions = {}) {
    this.host = host;
    this.opts = opts;
    this.kind = opts.kind ?? 'docker';
    this.caps = {
      isolation: 'container',
      networkModes: ['none', 'allowlist', 'open'],
      networkFilter: true,
      workspaceDelivery: ['none', 'copy', 'bind'],
      mounts: true,
      snapshots: false,
      tty: false,
      limits: { cpus: true, memory: true, pids: true, disk: true },
      nonRootUser: true,
      secretInjection: ['proxy', 'env', 'file'],
      osFamilies: ['debian', 'alpine', 'fedora', 'arch', 'unknown'],
      remote: false,
      ...opts.capabilities,
    };
    if (opts.foreign) {
      this.foreignResources.push(...opts.foreign);
      this.listForeign = () => Promise.resolve(this.foreignResources.map((r) => ({ ...r })));
      this.removeForeign = (r) => {
        if (r.ref === opts.failForeignRemove)
          return Promise.reject(new AboxError('backend_error', `cannot remove ${r.name} (fake)`));
        const i = this.foreignResources.findIndex((x) => x.ref === r.ref);
        if (i >= 0) {
          this.foreignResources.splice(i, 1);
          this.foreignRemoved.push(r.ref);
        }
        return Promise.resolve();
      };
    }
    if (opts.caches) {
      this.caps.caches = true;
      const inUse = (key: string): boolean =>
        [...this.sandboxes.values()].some((sb) => sb.spec.caches?.some((c) => c.key === key));
      this.listCaches = (o) =>
        Promise.resolve(
          [...this.cacheVolumes.values()].map((v) => ({
            ...v,
            inUse: inUse(v.key),
            sizeBytes: o?.size ? (this.cacheSizes.get(v.key) ?? 0) : null,
          })),
        );
      this.removeCache = (key) => {
        if (inUse(key)) return Promise.reject(new AboxError('conflict', `cache ${key} is in use`));
        const had = this.cacheVolumes.delete(key);
        if (had) this.cacheRemoved.push(key);
        return Promise.resolve({ removed: had });
      };
    }
    if (!opts.noExtendExpiry) {
      this.caps.extendExpiry = true;
      this.extendExpiry = (id, expiresAt) => {
        const sb = this.get(id);
        if (this.opts.failExtendExpiry)
          return Promise.reject(new AboxError('backend_error', this.opts.failExtendExpiry));
        // a new object: `specs` keeps the spec the sandbox was created with
        sb.spec = { ...sb.spec, expiresAt };
        this.expiryUpdates.push({ id, expiresAt });
        return Promise.resolve();
      };
    }
    if (opts.updateResources) {
      this.caps.updateResources = true;
      this.updateResources = (id, limits) => {
        const sb = this.get(id);
        if (this.opts.failUpdateResources)
          return Promise.reject(new AboxError('backend_error', this.opts.failUpdateResources));
        sb.spec = { ...sb.spec, resources: { ...sb.spec.resources, ...limits } };
        this.resourceUpdates.push({ id, ...limits });
        return Promise.resolve();
      };
    }
    if (opts.stats) {
      this.caps.stats = true;
      const sample = typeof opts.stats === 'function' ? opts.stats : undefined;
      this.stats = (id) => {
        const sb = this.get(id);
        this.statsCalls.push(id);
        if (sb.state !== 'running')
          return Promise.reject(new AboxError('conflict', `sandbox ${id} is not running`));
        return Promise.resolve(
          sample?.(id) ?? {
            ts: Date.now(),
            cpuPercent: 12.5,
            memoryBytes: 64 * 1024 * 1024,
            memoryLimitBytes: 256 * 1024 * 1024,
            pids: 3,
          },
        );
      };
    }
    if (opts.portForward) {
      this.caps.portForward = Array.isArray(opts.portForward)
        ? opts.portForward
        : ['allowlist', 'open'];
      let nextHostPort = 40_000;
      this.addPortForward = (id, req) => {
        const sb = this.get(id);
        if (sb.state !== 'running')
          return Promise.reject(new AboxError('conflict', `sandbox ${id} is not running`));
        const open = this.portForwards.get(id) ?? [];
        if (open.some((p) => p.sandboxPort === req.sandboxPort))
          return Promise.reject(new AboxError('conflict', 'already forwarded'));
        const hostPort = req.hostPort ?? nextHostPort++;
        const fwd: SandboxPortForward = {
          sandboxPort: req.sandboxPort,
          hostAddress: '127.0.0.1',
          hostPort,
          url: `http://127.0.0.1:${hostPort}/`,
          createdAt: this.now(),
          target: 'unknown',
          connections: 0,
        };
        this.portForwards.set(id, [...open, fwd]);
        return Promise.resolve({ ...fwd });
      };
      this.listPortForwards = (id) => {
        this.get(id);
        return Promise.resolve(
          [...(this.portForwards.get(id) ?? [])]
            .sort((a, b) => a.sandboxPort - b.sandboxPort)
            .map((p) => ({ ...p })),
        );
      };
      this.removePortForward = (id, sandboxPort) => {
        this.get(id);
        const open = this.portForwards.get(id) ?? [];
        const gone = open.find((p) => p.sandboxPort === sandboxPort);
        this.portForwards.set(
          id,
          open.filter((p) => p !== gone),
        );
        return Promise.resolve(gone ? { ...gone } : undefined);
      };
    }
    if (opts.hostResources) {
      const r = opts.hostResources;
      this.hostResources = () => {
        this.hostResourcesCalls++;
        return Promise.resolve({ ...r });
      };
    }
    if (opts.updateNetwork) {
      this.updateNetwork = (id, network) => {
        this.get(id).spec.network = network;
        this.networkUpdates.push({
          id,
          allow: [...network.allow],
          injections: network.injections.length,
        });
        return Promise.resolve();
      };
    }
    if (opts.networkEvents) {
      this.networkEvents = (id, sinceTs) => {
        this.get(id);
        this.networkEventCalls.push({ id, sinceTs });
        return Promise.resolve(
          (this.netEvents.get(id) ?? []).filter((e) => e.ts >= (sinceTs ?? 0)),
        );
      };
    }
    if (opts.logs) {
      const h = opts.logs;
      this.logs = (id, o) => {
        this.get(id);
        return Promise.resolve(h(id, o ?? {}));
      };
    }
    if (this.caps.snapshots) {
      this.snapshot = (id, name) => {
        const sb = this.get(id);
        // like the Docker backend: the id is not the name
        const snapshotId = `snap-${++this.snapCounter}-${name}`;
        sb.snapshots.set(snapshotId, new Map(sb.files));
        return Promise.resolve(snapshotId);
      };
      this.restore = (id, snap) => {
        const sb = this.get(id);
        const s = sb.snapshots.get(snap);
        if (!s) throw new AboxError('not_found', `snapshot '${snap}' not found`);
        sb.files = new Map(s);
        return Promise.resolve();
      };
    }
  }

  addNetEvents(id: SandboxId, ...events: NetworkEvent[]): void {
    this.netEvents.set(id, [...(this.netEvents.get(id) ?? []), ...events]);
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private get(id: SandboxId): FakeSandbox {
    const sb = this.sandboxes.get(id);
    if (!sb) throw new AboxError('not_found', `sandbox '${id}' not found`);
    return sb;
  }

  capabilities(): ProviderCapabilities {
    return this.caps;
  }

  status(): Promise<BackendStatus> {
    return Promise.resolve({ ok: true, version: 'fake', details: ['in-memory'], warnings: [] });
  }

  prepare(template: ResolvedTemplate, opts: PrepareOptions = {}): Promise<PreparedImage> {
    this.prepareCalls.push({ hash: template.hash, opts });
    if (this.opts.failPrepare)
      return Promise.reject(new AboxError('backend_error', 'prepare failed (fake)'));
    const cached = this.seenHashes.has(template.hash) && !opts.update;
    this.seenHashes.add(template.hash);
    const pinnedBase = opts.update
      ? `ubuntu@sha256:updated${++this.pinCounter}`
      : (opts.pinnedBase ?? `ubuntu@sha256:${template.hash.slice(0, 16)}`);
    return Promise.resolve({
      ref: `fake/${template.name}:${template.hash.slice(0, 12)}`,
      templateHash: template.hash,
      cached,
      pinnedBase,
    });
  }

  gcImages(keep: string[]): Promise<string[]> {
    this.gcCalls.push(keep);
    const removed = [...this.seenHashes].filter((h) => !keep.includes(h));
    for (const h of removed) this.seenHashes.delete(h);
    return Promise.resolve(removed.map((h) => `fake/${h.slice(0, 12)}`));
  }

  create(spec: SandboxSpec): Promise<SandboxInfo> {
    if (this.opts.failCreate)
      return Promise.reject(new AboxError('backend_error', 'create failed (fake)'));
    if (this.sandboxes.has(spec.id)) return Promise.reject(new AboxError('conflict', 'exists'));
    this.specs.push(spec);
    for (const c of spec.caches ?? [])
      if (!this.cacheVolumes.has(c.key))
        this.cacheVolumes.set(c.key, {
          key: c.key,
          name: c.name,
          project: c.project,
          stack: c.stack,
          owner: c.owner,
          createdAt: this.now(),
          engine: 'docker',
        });
    this.sandboxes.set(spec.id, { spec, state: 'created', files: new Map(), snapshots: new Map() });
    return Promise.resolve(this.info(this.get(spec.id)));
  }

  start(id: SandboxId): Promise<void> {
    const sb = this.get(id);
    if (this.opts.failStart)
      return Promise.reject(new AboxError('backend_error', 'start failed (fake)'));
    if (sb.spec.expiresAt <= this.now())
      return Promise.reject(new AboxError('conflict', `sandbox '${id}' has expired`));
    sb.state = 'running';
    return Promise.resolve();
  }

  stop(id: SandboxId): Promise<void> {
    this.get(id).state = 'stopped';
    this.portForwards.delete(id);
    return Promise.resolve();
  }

  remove(id: SandboxId): Promise<void> {
    this.sandboxes.delete(id);
    this.portForwards.delete(id);
    return Promise.resolve();
  }

  async exec(id: SandboxId, req: ExecRequest): Promise<ExecResult> {
    const sb = this.get(id);
    if (sb.state !== 'running')
      throw new AboxError('conflict', `sandbox '${id}' is ${sb.state}, not running`);
    this.execCalls.push({ id, req });
    const r = (await this.opts.execHandler?.(id, req)) ?? {};
    return {
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false,
      durationMs: 1,
      ...r,
    };
  }

  // eslint-disable-next-line require-yield
  async *spawn(_id: SandboxId, _req: ExecRequest): AsyncIterable<ExecEvent> {
    throw new AboxError('unsupported', 'spawn not supported by the fake');
  }

  attach(id: SandboxId, tty: { cols: number; rows: number; argv?: string[] }): Promise<TtySession> {
    this.get(id);
    if (!this.caps.tty)
      return Promise.reject(new AboxError('unsupported', 'tty not supported by the fake'));
    this.ttyCalls.push({
      id,
      cols: tty.cols,
      rows: tty.rows,
      ...(tty.argv ? { argv: tty.argv } : {}),
    });
    const stream = new PassThrough();
    let exit!: (code: number) => void;
    const done = new Promise<number>((r) => (exit = r));
    this.ttyExits.push(exit);
    return Promise.resolve({
      stream,
      resize: () => Promise.resolve(),
      wait: () => done,
      close: () => {
        exit(130);
        return Promise.resolve();
      },
    });
  }

  copyIn(id: SandboxId, hostPath: string, sandboxPath: string): Promise<void> {
    this.get(id);
    this.copyCalls.push({ dir: 'in', id, host: hostPath, sandbox: sandboxPath });
    return Promise.resolve();
  }
  /** Writes a small file at the destination (like a real copy) and records the call. */
  copyOut(id: SandboxId, sandboxPath: string, hostPath: string): Promise<void> {
    this.get(id);
    this.copyCalls.push({ dir: 'out', id, host: hostPath, sandbox: sandboxPath });
    let target = hostPath;
    try {
      if (statSync(hostPath).isDirectory()) target = join(hostPath, 'copied-out.txt');
    } catch {
      /* destination does not exist yet */
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, 'copied out of the sandbox\n');
    return Promise.resolve();
  }

  readFile(
    id: SandboxId,
    path: string,
    maxBytes: number,
  ): Promise<{ data: Buffer; truncated: boolean; size: number }> {
    const f = this.get(id).files.get(path);
    if (!f) return Promise.reject(new AboxError('not_found', `no such file ${path}`));
    return Promise.resolve({
      data: f.subarray(0, maxBytes),
      truncated: f.length > maxBytes,
      size: f.length,
    });
  }

  writeFile(id: SandboxId, path: string, data: Buffer): Promise<void> {
    this.get(id).files.set(path, Buffer.from(data));
    return Promise.resolve();
  }

  listDir(id: SandboxId, path: string): Promise<DirEntry[]> {
    const prefix = path.endsWith('/') ? path : `${path}/`;
    const out: DirEntry[] = [];
    for (const [p, d] of this.get(id).files) {
      if (p.startsWith(prefix) && !p.slice(prefix.length).includes('/')) {
        out.push({
          name: p.slice(prefix.length),
          type: 'file',
          size: d.length,
          mode: 0o644,
          mtimeMs: 0,
        });
      }
    }
    return Promise.resolve(out);
  }

  private info(sb: FakeSandbox): SandboxInfo {
    const s = sb.spec;
    return {
      id: s.id,
      host: s.host,
      name: s.name,
      state: sb.state,
      backend: this.kind,
      isolation: 'container',
      template: s.template.name,
      templateHash: s.template.hash,
      owner: s.owner,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      labels: { ...s.labels },
      backendRef: `fake:${s.id}`,
      effective: { fake: true, network: s.network.mode, nonRoot: true },
    };
  }

  inspect(id: SandboxId): Promise<SandboxInfo> {
    return Promise.resolve(this.info(this.get(id)));
  }

  list(filter: SandboxFilter = {}): Promise<SandboxInfo[]> {
    return Promise.resolve(
      [...this.sandboxes.values()]
        .map((s) => this.info(s))
        .filter(
          (i) =>
            (!filter.owner || i.owner === filter.owner) &&
            (!filter.state || i.state === filter.state),
        ),
    );
  }
}
