import type {
  BackendKind,
  BackendStatus,
  DirEntry,
  ExecEvent,
  ExecRequest,
  ExecResult,
  ForeignResource,
  HostConnection,
  IsolationLevel,
  NetworkEvent,
  NetworkSpec,
  PreparedImage,
  PrepareOptions,
  ProviderCapabilities,
  ResolvedTemplate,
  SandboxFilter,
  SandboxId,
  SandboxInfo,
  SandboxSpec,
  TtyOptions,
  TtySession,
} from './types.js';

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
  /** Copy a sandbox file or directory (recursively) to the host. */
  copyOut(id: SandboxId, sandboxPath: string, hostPath: string): Promise<void>;
  readFile(
    id: SandboxId,
    sandboxPath: string,
    maxBytes: number,
  ): Promise<{ data: Buffer; truncated: boolean; size: number }>;
  writeFile(id: SandboxId, sandboxPath: string, data: Buffer, mode?: number): Promise<void>;
  listDir(id: SandboxId, sandboxPath: string): Promise<DirEntry[]>;

  snapshot?(id: SandboxId, name: string): Promise<string>;
  restore?(id: SandboxId, snapshotId: string): Promise<void>;

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

  /** Egress decisions recorded by the proxy since `sinceTs` (allowlist mode only). */
  networkEvents?(id: SandboxId, sinceTs?: number): Promise<NetworkEvent[]>;
  /** Combined stdout/stderr of the sandbox main process, if any. */
  logs?(id: SandboxId, opts?: { tail?: number; sinceTs?: number }): Promise<string>;
}

export type ProviderFactory = (host: HostConnection) => SandboxProvider;
