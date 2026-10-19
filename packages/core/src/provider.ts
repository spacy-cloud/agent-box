import type {
  BackendKind,
  BackendStatus,
  CacheVolume,
  DirEntry,
  DiskSpace,
  ExecEvent,
  ExecRequest,
  ExecResult,
  ForeignResource,
  HostConnection,
  ImageStatus,
  IsolationLevel,
  NetworkEvent,
  NetworkSpec,
  SandboxPortForward,
  PortForwardRequest,
  PreparedImage,
  PrepareOptions,
  ProviderCapabilities,
  ProviderSnapshot,
  ResourceUsage,
  ResolvedTemplate,
  SandboxFilter,
  SandboxId,
  SandboxInfo,
  SandboxSpec,
  TtyOptions,
  TtySession,
} from './types.js';

export interface CopyOutOptions {
  /**
   * `'refuse'` (default): a symlink with an absolute, empty or escaping target aborts the copy.
   * `'preserve'`: such links are recreated as links. Only for a private scratch tree that abox
   * merely inspects (lstat/readlink, never followed, executed or handed to the user), as the
   * export does to compare the tree with its baseline. Entries are still never written through
   * a link, and a backend that copies links verbatim anyway may ignore the option.
   */
  symlinks?: 'refuse' | 'preserve';
  /**
   * Called for every archive entry the backend leaves out instead of copying (a name that cannot
   * be written safely to the host, a link that does not stay inside the copy, …); `path` is
   * relative to the copied tree. A backend that leaves entries out must report them here (when
   * given) rather than fail the whole copy for them in `'preserve'` mode, where the export needs a
   * tree even when a hostile sandbox plants awkward names.
   */
  onSkip?: (path: string, reason: string) => void;
}

/**
 * Backend interface. Every backend (docker, podman, process, python, vm)
 * implements this and must pass the shared contract suite in
 * `@abox/contract-tests`.
 *
 * Rules:
 * - Unsupported features are reported by `capabilities()` and rejected with
 *   `AboxError('unsupported', …)` — never silently ignored.
 * - The provider never makes policy decisions; the core has already checked
 *   everything. The provider must still apply all hardening it can.
 * - The backend is the source of truth for existence: `list()` reflects what
 *   really exists (labels/markers), not a cached registry.
 * - All methods taking a `SandboxId` throw `AboxError('not_found', …)` for
 *   unknown ids.
 */
export interface SandboxProvider {
  readonly kind: BackendKind;
  readonly isolation: IsolationLevel;
  readonly host: HostConnection;

  capabilities(): ProviderCapabilities;
  /** Health check for `abox doctor`. Must not throw; report problems in the result. */
  status(): Promise<BackendStatus>;

  /** Build or fetch the environment image for a template (cached by `template.hash`). */
  prepare(template: ResolvedTemplate, opts?: PrepareOptions): Promise<PreparedImage>;
  /**
   * Read-only look at the environment image `prepare(template)` would use: does it exist, how big is
   * it, and (when it does not) is the base image there. Must not build, pull or download anything: it
   * is one or two engine API `inspect` calls, so `abox doctor --for <template>` can run it any time.
   * Optional; absent = the backend has no image to look at.
   */
  imageStatus?(template: ResolvedTemplate): Promise<ImageStatus>;
  /**
   * Free and total space of the file system that holds this backend's images and sandboxes, as far as
   * it can be measured from here (a local engine's storage root). `undefined` when it cannot be (a remote
   * engine, a storage root that is not visible). Read-only. Optional; absent = unknown.
   */
  diskSpace?(): Promise<DiskSpace | undefined>;
  /** Remove cached environment images not in `keep` (template hashes). Returns removed refs. */
  gcImages(keep: string[]): Promise<string[]>;

  /** Create the sandbox (not started). Must be atomic: on failure, leave nothing behind. */
  create(spec: SandboxSpec): Promise<SandboxInfo>;
  start(id: SandboxId): Promise<void>;
  stop(id: SandboxId): Promise<void>;
  /** Remove sandbox and all its backend resources (networks, sidecars, dirs). Idempotent. */
  remove(id: SandboxId): Promise<void>;

  exec(id: SandboxId, req: ExecRequest): Promise<ExecResult>;
  /** Streaming execution. The iterable ends after the `exit` event. */
  spawn(id: SandboxId, req: ExecRequest): AsyncIterable<ExecEvent>;
  /** Interactive terminal. Throws `unsupported` if `capabilities().tty` is false. */
  attach(id: SandboxId, tty: TtyOptions): Promise<TtySession>;

  /** Copy a host file or directory (recursively) into the sandbox. */
  copyIn(id: SandboxId, hostPath: string, sandboxPath: string): Promise<void>;
  /**
   * Copy a sandbox file or directory (recursively) to the host. By default a symlink must stay
   * inside the copied tree (an absolute, empty or escaping target is refused), because the result
   * may be handed to the user.
   */
  copyOut(
    id: SandboxId,
    sandboxPath: string,
    hostPath: string,
    opts?: CopyOutOptions,
  ): Promise<void>;
  readFile(
    id: SandboxId,
    sandboxPath: string,
    maxBytes: number,
  ): Promise<{ data: Buffer; truncated: boolean; size: number }>;
  writeFile(id: SandboxId, sandboxPath: string, data: Buffer, mode?: number): Promise<void>;
  listDir(id: SandboxId, sandboxPath: string): Promise<DirEntry[]>;

  snapshot?(id: SandboxId, name: string): Promise<string>;
  restore?(id: SandboxId, snapshotId: string): Promise<void>;
  /**
   * Every snapshot this provider's installation holds, also those of sandboxes that no longer
   * exist (the backend keeps the data, not the registry). With `sandboxId` only those of that
   * sandbox. Newest last. Optional; absent = the manager can only list what it recorded itself.
   */
  listSnapshots?(opts?: { sandboxId?: SandboxId }): Promise<ProviderSnapshot[]>;
  /**
   * Delete one snapshot of `sandboxId`. Must refuse an id that belongs to another sandbox or
   * installation (`not_found`); a snapshot that is already gone is not an error. Other snapshots
   * and the sandbox itself are not touched. Optional; absent = `unsupported`.
   */
  deleteSnapshot?(sandboxId: SandboxId, snapshotId: string): Promise<void>;

  inspect(id: SandboxId): Promise<SandboxInfo>;
  list(filter?: SandboxFilter): Promise<SandboxInfo[]>;

  /**
   * Replace the network rules of an existing sandbox (e.g. after an approved
   * `access_request` kind=network). Optional; absent = `unsupported`.
   * Must not change the network mode (none ↔ allowlist ↔ open).
   */
  updateNetwork?(id: SandboxId, network: NetworkSpec): Promise<void>;

  /**
   * Objects of the backend that carry abox labels but belong to another installation or to none
   * (the `abox.instance` label differs from this provider's, or is empty / missing). `list()` and
   * every other method never see them; this is how `abox gc --orphans` finds what a deleted data
   * directory left behind. Never returns objects without an abox label, objects of this instance, or
   * infrastructure shared by all instances. Optional; absent = `unsupported`.
   */
  listForeign?(): Promise<ForeignResource[]>;
  /**
   * Remove one object returned by `listForeign`. Must re-check the object (still abox-labelled and
   * still not of this instance) and refuse otherwise; a vanished object is not an error.
   */
  removeForeign?(resource: ForeignResource): Promise<void>;

  /**
   * Move the deadline at which the backend itself ends the sandbox to `expiresAt` (epoch ms) and
   * make `inspect()` / `list()` / `start()` report and honour the new one. Called by the manager
   * *before* it records the new expiry, so a backend that cannot move its deadline fails the
   * extension instead of letting the sandbox die at the old time while the registry shows time
   * left. Only ever extends: an `expiresAt` earlier than the current deadline is `invalid_input`,
   * an equal one a no-op; an already expired sandbox is `conflict`. Optional (see
   * `capabilities().extendExpiry`); absent = `unsupported`, as is a sandbox whose deadline cannot
   * be moved (e.g. created by an older version).
   */
  extendExpiry?(id: SandboxId, expiresAt: number): Promise<void>;

  /**
   * Change the cpu and/or memory limit of an existing sandbox, running or stopped, to exactly
   * these values (`access_request` kind=resources). Only the given fields change, and the change
   * is permanent (a restart keeps it). The manager has already checked the values against the
   * profile; a backend that refuses (e.g. a memory limit below what the sandbox uses now) fails
   * and leaves the old limits. Optional (see `capabilities().updateResources`); absent =
   * `unsupported`.
   */
  updateResources?(id: SandboxId, limits: { cpus?: number; memoryBytes?: number }): Promise<void>;

  /**
   * One sample of the live resource usage of a running sandbox (cpu %, memory, pids). Takes about a
   * second on engines that need two readings for the cpu rate. A sandbox that is not running is
   * `conflict`. Optional (see `capabilities().stats`); absent = `unsupported`.
   */
  stats?(id: SandboxId): Promise<ResourceUsage>;

  /**
   * The package cache volumes of this installation on the engine (`SandboxSpec.caches`), with their
   * size when `opts.size` is set (it can take a moment) and whether a sandbox still references them.
   * Only volumes with this provider's `abox.instance` are returned. Optional (see
   * `capabilities().caches`); absent = `unsupported`.
   */
  listCaches?(opts?: { size?: boolean }): Promise<CacheVolume[]>;
  /**
   * Remove the volume(s) of cache `key`. A cache that a sandbox still references is `conflict`, a
   * missing one is not an error (`removed: false`). Optional; absent = `unsupported`.
   */
  removeCache?(key: string): Promise<{ removed: boolean }>;

  /**
   * Publish a TCP port of a running sandbox on `127.0.0.1` of the machine running abox (never on
   * another address), without giving the sandbox any new way out. The forward must keep working
   * after the calling process ended (the CLI is short-lived) and ends with the sandbox: `stop`,
   * `remove` and the deadline close it. A second forward for the same `sandboxPort` is `conflict`;
   * a `hostPort` that is taken is `conflict`; a sandbox that is not running is `conflict`; a
   * network mode that has no way to the host is `unsupported`. Optional (see
   * `capabilities().portForward`); absent = `unsupported`.
   */
  addPortForward?(id: SandboxId, req: PortForwardRequest): Promise<SandboxPortForward>;
  /** The open forwards of a sandbox, ordered by sandbox port. */
  listPortForwards?(id: SandboxId): Promise<SandboxPortForward[]>;
  /**
   * Close the forward of `sandboxPort`. Returns it as it was just before (with its connection
   * counts), or `undefined` when there was none (not an error).
   */
  removePortForward?(id: SandboxId, sandboxPort: number): Promise<SandboxPortForward | undefined>;

  /**
   * Total cpus and memory of the machine the engine runs on (Docker / Podman `info`: `NCPU`, `MemTotal`),
   * which is the capacity sandboxes there share. `undefined` when the engine does not say. Optional;
   * absent = the manager asks the host itself (`/proc`) or reports the capacity as unknown.
   */
  hostResources?(): Promise<{ cpus: number; memoryBytes: number } | undefined>;

  /** Egress decisions recorded by the proxy since `sinceTs` (allowlist mode only). */
  networkEvents?(id: SandboxId, sinceTs?: number): Promise<NetworkEvent[]>;
  /** Combined stdout/stderr of the sandbox main process, if any. */
  logs?(id: SandboxId, opts?: { tail?: number; sinceTs?: number }): Promise<string>;
}

export type ProviderFactory = (host: HostConnection) => SandboxProvider;
