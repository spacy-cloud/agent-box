/**
 * Backend-neutral domain model of abox.
 *
 * Rule (architecture principle 6): nothing in this file may use Docker vocabulary.
 * "Environment image" instead of Docker image, "sandbox" instead of container,
 * "isolation level" instead of runtime. Backend specifics live in the backend packages.
 */

/** Isolation levels, weakest first. See docs/security.md. */
export const ISOLATION_LEVELS = ['none', 'container', 'hardened', 'vm'] as const;
export type IsolationLevel = (typeof ISOLATION_LEVELS)[number];

/** Returns true when `actual` is at least as strong as `required`. */
export function isolationAtLeast(actual: IsolationLevel, required: IsolationLevel): boolean {
  return ISOLATION_LEVELS.indexOf(actual) >= ISOLATION_LEVELS.indexOf(required);
}

export const BACKEND_KINDS = ['docker', 'podman', 'process', 'python', 'vm'] as const;
export type BackendKind = (typeof BACKEND_KINDS)[number];

export const NETWORK_MODES = ['none', 'allowlist', 'open'] as const;
export type NetworkMode = (typeof NETWORK_MODES)[number];

export const WORKSPACE_MODES = ['mount', 'clone', 'worktree', 'copy', 'empty', 'sync'] as const;
export type WorkspaceMode = (typeof WORKSPACE_MODES)[number];

export type AccessMode = 'ro' | 'rw';

export const SANDBOX_STATES = [
  'requested',
  'preparing',
  'created',
  'running',
  'stopped',
  'failed',
  'expired',
  'removed',
] as const;
export type SandboxState = (typeof SANDBOX_STATES)[number];

export const PACKAGE_MANAGERS = ['apt', 'apk', 'dnf', 'pacman', 'pip', 'npm'] as const;
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

export type SecretInjection = 'proxy' | 'env' | 'file';

/** Host identifier, e.g. `local`, `vps`. `[a-z0-9-]+`. */
export type HostId = string;
/** Sandbox identifier including its host: `<host>/<short>`, e.g. `local/ab12cd34`. */
export type SandboxId = string;

export function makeSandboxId(host: HostId, short: string): SandboxId {
  return `${host}/${short}`;
}

export function parseSandboxId(id: SandboxId): { host: HostId; short: string } {
  const idx = id.indexOf('/');
  if (idx <= 0) return { host: 'local', short: id };
  return { host: id.slice(0, idx), short: id.slice(idx + 1) };
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

/**
 * Template as written by a user (YAML, apiVersion 1). The Zod schema in
 * `template/schema.ts` must produce exactly this type.
 */
export interface TemplateSpec {
  apiVersion: 1;
  name: string;
  description?: string;
  backend: BackendKind;
  /** Minimum isolation; the core rejects backends that deliver less. */
  isolation?: IsolationLevel;
  base: {
    /** Environment image reference, e.g. `ubuntu:24.04` (container) or a distro name (vm). */
    os?: string;
    /** Path to a build file relative to the template file (container backends). */
    dockerfile?: string;
  };
  packages?: Partial<Record<PackageManager, string[]>>;
  /** Tool presets such as `node@24`, `python@3.13`, `git`. */
  tools?: string[];
  setup?: Array<{ run: string }>;
  user?: { name?: string; uid?: number; sudo?: boolean };
  workspace?: {
    mode?: WorkspaceMode;
    path?: string;
    access?: AccessMode;
    ref?: string;
    /** `copy` / `sync`: leave out what `.gitignore` files ignore (default true). */
    gitignore?: boolean;
  };
  resources?: {
    cpus?: number;
    /** Size string like `4g`, `512m`. */
    memory?: string;
    disk?: string;
    pids?: number;
    /** Duration string like `2h`, `30m`. */
    ttl?: string;
  };
  network?: { mode?: NetworkMode; allow?: string[]; presets?: string[] };
  mounts?: Array<{ source: string; target: string; access?: AccessMode }>;
  env?: Record<string, string>;
  secrets?: Array<{ ref: string; inject?: SecretInjection; hosts?: string[]; path?: string }>;
  labels?: Record<string, string>;
  extends?: string;
  /** Python backend specifics (phase 5). */
  python?: { version?: string; project?: string };
  /** VM backend specifics (phase 5). */
  vm?: { image?: string; cloudInit?: string; diskSize?: string };
  /**
   * Package caches abox keeps per project (see `docs/templates.md`). Each entry is one directory of
   * the sandbox that outlives the sandbox, merged by `name` on `extends`.
   */
  caches?: CacheDeclaration[];
}

/** One package cache of a template: where a tool keeps its downloads, and how to point it there. */
export interface CacheDeclaration {
  /** Short name of the cache, unique per template: `pnpm-store`, `cargo-registry`. */
  name: string;
  /** Absolute path inside the sandbox, or `~/...` (the home directory of the template user). */
  path: string;
  /** Environment variables set while the cache is mounted; `${path}` stands for the cache path. */
  env?: Record<string, string>;
}

/** A cache of a resolved template: `~` and `${path}` are expanded. */
export interface TemplateCache {
  name: string;
  path: string;
  env: Record<string, string>;
}

export type TemplateSourceKind = 'builtin' | 'user' | 'project';

/** One build step, already rendered for the target OS family. */
export interface BuildStep {
  /** Short label for logs, e.g. `apt: git curl`, `tool: node@24`, `setup #1`. */
  name: string;
  /** POSIX shell script executed as root during environment preparation. */
  script: string;
}

export type OsFamily = 'debian' | 'alpine' | 'fedora' | 'arch' | 'unknown';

/**
 * Template after `extends` merge, defaults and validation. Everything a backend
 * needs to prepare an environment image is in here.
 */
export interface ResolvedTemplate {
  name: string;
  description: string;
  backend: BackendKind;
  /** Required minimum isolation (defaults to the backend's natural level). */
  isolation: IsolationLevel;
  base: { os?: string; dockerfile?: string; osFamily: OsFamily };
  /** Rendered build steps: packages, tool presets, setup commands (in that order). */
  build: BuildStep[];
  /** Tool presets with their verification command (used by `template test`). */
  tools: Array<{ name: string; version?: string; check: string }>;
  user: { name: string; uid: number; sudo: boolean };
  workspace: {
    mode: WorkspaceMode;
    path: string;
    access: AccessMode;
    ref?: string;
    /** Only present when the template sets it; the default for `copy` / `sync` is true. */
    gitignore?: boolean;
  };
  resources: {
    cpus: number;
    memoryBytes: number;
    diskBytes?: number;
    pids: number;
    ttlMs: number;
  };
  network: { mode: NetworkMode; allow: string[] };
  mounts: Array<{ source: string; target: string; access: AccessMode }>;
  env: Record<string, string>;
  secrets: Array<{ ref: string; inject: SecretInjection; hosts: string[]; path?: string }>;
  labels: Record<string, string>;
  python?: { version: string; project?: string };
  vm?: { image: string; cloudInit?: string; diskSize?: string };
  /** Package caches the template declares (they are only mounted when a project is shared). */
  caches: TemplateCache[];
  source: { kind: TemplateSourceKind; path?: string };
  /**
   * Templates with `base.dockerfile`: the Dockerfile and the build context it can `COPY`, as
   * hashed. Read when the template is loaded from a catalog.
   */
  buildContext?: BuildContextInfo;
  /**
   * sha256 hex over the build-relevant fields (base, build steps, user) and, for a Dockerfile
   * base, the digest of its build context. Also the image cache key.
   */
  hash: string;
  /**
   * sha256 hex over the full original file content (used for project-template trust). It also
   * covers what the file pulls in: project templates it `extends` and the build context of its
   * Dockerfile, so a change there needs a new approval.
   */
  contentHash: string;
}

/** The build context of a Dockerfile base: everything the container engine receives. */
export interface BuildContextInfo {
  /** Directory that is sent to the engine (the directory of the Dockerfile). */
  dir: string;
  /** Name of the Dockerfile inside it. */
  dockerfile: string;
  /** sha256 hex over names, types, modes, link targets and content of everything in the context. */
  digest: string;
  /** Content of the Dockerfile (what a reviewer reads). */
  dockerfileText: string;
  /** Files of the context (sorted, at most the first 500) with size and content hash. */
  files: Array<{
    path: string;
    type: 'file' | 'symlink';
    size: number;
    sha256: string;
    /** Symlinks: where they point. */
    target?: string;
  }>;
  /** Number of files and symlinks in the whole context and their total size. */
  fileCount: number;
  totalBytes: number;
  /** `files` is cut off (the digest still covers all of them). */
  filesTruncated: boolean;
}

// ---------------------------------------------------------------------------
// Provider-facing specs
// ---------------------------------------------------------------------------

/** Result of `prepare()`: backend-specific reference to a cached environment image. */
export interface PreparedImage {
  /** Opaque backend reference (e.g. image tag, VM base disk path, venv dir). */
  ref: string;
  /** Template build hash this image was produced from. */
  templateHash: string;
  /** True when nothing had to be built. */
  cached: boolean;
  /** Pinned base reference (e.g. digest) if the backend supports pinning. */
  pinnedBase?: string;
}

export interface PrepareOptions {
  /** Ignore the cache and re-resolve the base (e.g. `--update`). */
  update?: boolean;
  /** Base reference pinned by an earlier build (e.g. `ubuntu@sha256:…`); used unless `update`. */
  pinnedBase?: string;
  /** Progress callback for build output lines. */
  onProgress?: (line: string) => void;
  signal?: AbortSignal;
}

/**
 * How the workspace reaches the sandbox. The core maps the user-facing
 * workspace modes (mount, clone, worktree, copy, empty, sync) onto these
 * three delivery kinds, doing all host-side preparation (git clone,
 * worktree creation) itself.
 */
export type WorkspaceDelivery =
  | { kind: 'none'; sandboxPath: string }
  | {
      kind: 'bind';
      hostPath: string;
      sandboxPath: string;
      access: AccessMode;
      readonlySubpaths?: string[];
    }
  | { kind: 'copy'; hostPath: string; sandboxPath: string; exclude?: string[] };

/** A secret injected by the egress proxy. The value never enters the sandbox. */
export interface ProxyInjection {
  /** Destination host the header is added for (exact match). */
  host: string;
  header: string;
  value: string;
}

export interface NetworkSpec {
  mode: NetworkMode;
  /** Domain allowlist (`example.org`, `*.example.org`). Only for `allowlist`. */
  allow: string[];
  /** Block RFC1918, loopback, link-local, CGNAT, ULA, metadata addresses (resolved IP). Default true. */
  blockPrivate: boolean;
  /** Explicit exceptions to `blockPrivate` (CIDR or IP), only with approval. */
  privateExceptions: string[];
  /** Header injections performed by the proxy (`inject: proxy`). */
  injections: ProxyInjection[];
}

/**
 * A package cache volume to mount into one sandbox. The `key` identifies the cache (project, owner,
 * template stack, cache name and user id, see `deriveCacheKey`), the rest is metadata the provider
 * stores as labels on the volume so that `abox cache ls` can show it.
 */
export interface CacheMount {
  /** Cache key (lowercase hex). The provider names the volume after it. */
  key: string;
  /** Cache name from the template (`pnpm-store`). */
  name: string;
  /** Mount path inside the sandbox (absolute, resolved). */
  path: string;
  /** Canonical source path of the project the cache belongs to. */
  project: string;
  /** Template name (the stack) the cache belongs to. */
  stack: string;
  /** Owner of the sandboxes that use it: `human` or `agent:<context>`. */
  owner: string;
}

/** A cache volume as the backend reports it (`SandboxProvider.listCaches`). */
export interface CacheVolume {
  key: string;
  /** Cache name from the template. */
  name: string;
  project: string;
  stack: string;
  owner: string;
  /** Creation time in ms since the epoch (0 when the engine does not say). */
  createdAt: number;
  /** Bytes used on disk; `null` when the engine cannot tell (or `size` was not requested). */
  sizeBytes: number | null;
  /** A sandbox (running or not) references the volume, so it cannot be removed. */
  inUse: boolean;
  /** Engine the volume lives on (`docker` | `podman`); one engine can be reached through several backends. */
  engine: string;
}

/** Everything a provider needs to create one sandbox. Never persisted as-is (contains secrets). */
export interface SandboxSpec {
  id: SandboxId;
  host: HostId;
  name: string;
  /** Owner: `human` or an agent context id, e.g. `agent:claude-code/default`. */
  owner: string;
  template: ResolvedTemplate;
  image: PreparedImage;
  workspace: WorkspaceDelivery;
  /** Additional mounts, host paths already canonicalized and policy-checked. */
  mounts: Array<{ hostPath: string; sandboxPath: string; access: AccessMode }>;
  resources: ResolvedTemplate['resources'];
  network: NetworkSpec;
  /** Plain env (no secrets except approved `inject: env` ones). */
  env: Record<string, string>;
  /** Files to place into the sandbox at creation (e.g. approved `inject: file` secrets, CA bundle). */
  files: Array<{ sandboxPath: string; content: Buffer; mode: number }>;
  user: ResolvedTemplate['user'];
  createdAt: number;
  expiresAt: number;
  labels: Record<string, string>;
  /**
   * Package cache volumes to mount (read-write, at their own paths only). Absent or empty: none.
   * A provider without `capabilities().caches` rejects a non-empty list with `unsupported`.
   */
  caches?: CacheMount[];
}

/** Live sandbox information, as reported by the backend (source of truth for existence). */
export interface SandboxInfo {
  id: SandboxId;
  host: HostId;
  name: string;
  state: SandboxState;
  backend: BackendKind;
  isolation: IsolationLevel;
  template: string;
  templateHash: string;
  owner: string;
  createdAt: number;
  expiresAt: number;
  labels: Record<string, string>;
  /** Backend-internal reference (container id, VM name, directory). */
  backendRef: string;
  /** Effective options actually applied (for audit and `inspect`). */
  effective?: Record<string, unknown>;
}

export interface SandboxFilter {
  owner?: string;
  state?: SandboxState;
  template?: string;
}

export const FOREIGN_RESOURCE_KINDS = ['container', 'network', 'volume'] as const;
export type ForeignResourceKind = (typeof FOREIGN_RESOURCE_KINDS)[number];

/**
 * A backend object that carries abox labels but belongs to another abox installation (or to none:
 * the `abox.instance` label is empty or missing). `SandboxProvider.listForeign` reports them,
 * `removeForeign` deletes one. Used by `abox gc --orphans` after the data directory of an
 * installation was deleted.
 */
export interface ForeignResource {
  kind: ForeignResourceKind;
  /** Backend reference (engine id), passed back to `removeForeign`. */
  ref: string;
  /** Name of the object on the engine. */
  name: string;
  /** Value of the `abox.instance` label; empty when the label is missing or empty. */
  instance: string;
  /** The `abox.name` label (name the owner gave the sandbox), if any. */
  aboxName?: string;
  /** The `abox.id` label (sandbox id) if any. */
  sandboxId?: string;
  /** `sandbox` | `proxy` | `network` ... (the `abox.role` label), if any. */
  role?: string;
  /** Container state (`running`, `exited`, ...); absent for networks and volumes. */
  state?: string;
  /** Creation time in ms since the epoch, when the engine reports it. */
  createdAt?: number;
  /** Last start time of a container in ms since the epoch; absent when it never ran or is unknown. */
  startedAt?: number;
  /** Which engine holds it (`docker` | `podman`); the same engine can be reached through several backends. */
  engine: string;
}

export interface ExecRequest {
  /** argv form (preferred). Either `argv` or `command` must be set. */
  argv?: string[];
  /** Shell command line, run via `/bin/sh -c`. */
  command?: string;
  cwd?: string;
  env?: Record<string, string>;
  /** Timeout in ms; on expiry the process is killed and `timedOut` is true. */
  timeoutMs?: number;
  stdin?: string | Buffer;
  /** Per-stream output cap in bytes; excess is dropped and `truncated` is true. */
  maxOutputBytes?: number;
  /** Run as this user instead of the sandbox default (only `root` for internal use). */
  user?: string;
  signal?: AbortSignal;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True when stdout or stderr exceeded `maxOutputBytes`. */
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
}

export type ExecEvent =
  | { type: 'stdout' | 'stderr'; data: Buffer }
  | { type: 'exit'; exitCode: number; timedOut: boolean };

export interface TtyOptions {
  cols: number;
  rows: number;
  /** Command to run, default: the user's login shell. */
  argv?: string[];
  env?: Record<string, string>;
}

export interface TtySession {
  /** Bidirectional terminal stream. */
  stream: NodeJS.ReadWriteStream;
  resize(cols: number, rows: number): Promise<void>;
  /** Resolves with the exit code when the session ends. */
  wait(): Promise<number>;
  close(): Promise<void>;
}

/**
 * Live resource usage of a running sandbox, as one sample (`SandboxProvider.stats`). Used by the GUI
 * for the CPU / memory columns; the configured limits live in `SandboxView.resources`.
 */
export interface ResourceUsage {
  /** When the sample was taken (epoch ms). */
  ts: number;
  /** CPU use as a percentage of one core (100 = one core fully busy, 250 = two and a half cores). */
  cpuPercent: number;
  /** Memory in use in bytes (without reclaimable page cache). */
  memoryBytes: number;
  /** Memory limit in bytes the sandbox runs under; null when unlimited or unknown. */
  memoryLimitBytes: number | null;
  /** Number of processes / threads in the sandbox; null when the backend does not report it. */
  pids: number | null;
}

export interface DirEntry {
  name: string;
  type: 'file' | 'dir' | 'symlink' | 'other';
  size: number;
  mode: number;
  mtimeMs: number;
}

/** Lowest and highest host port abox binds for a port forward (privileged ports are refused). */
export const PORT_FORWARD_MIN_HOST_PORT = 1024;
export const PORT_FORWARD_MAX_PORT = 65535;
/** The only host address a port forward binds to. */
export const PORT_FORWARD_HOST_ADDRESS = '127.0.0.1';

/** What a provider needs to open a port forward of a running sandbox. */
export interface PortForwardRequest {
  /** TCP port inside the sandbox (1..65535). */
  sandboxPort: number;
  /** Port on `127.0.0.1` of the machine running abox (1024..65535); absent = pick a free one. */
  hostPort?: number;
  /**
   * Deadline (epoch ms) of the sandbox. A backend that holds the forward in a helper that outlives
   * abox (a sidecar container) makes the helper end itself then.
   */
  expiresAt: number;
}

/**
 * Whether anything in the sandbox answers on the forwarded port: `up` (the last connection to it
 * worked), `down` (refused: no server, or it listens on 127.0.0.1 only), `unknown` (not tried yet or
 * the backend cannot tell).
 */
export type PortForwardTarget = 'up' | 'down' | 'unknown';

/** One TCP forward from `127.0.0.1:<hostPort>` on the abox machine to a port inside a sandbox. */
export interface SandboxPortForward {
  sandboxPort: number;
  hostAddress: typeof PORT_FORWARD_HOST_ADDRESS;
  hostPort: number;
  /** `http://127.0.0.1:<hostPort>/`: what the "open preview" action opens. */
  url: string;
  createdAt: number;
  target: PortForwardTarget;
  /** Connections accepted / refused by the host check / that could not reach the sandbox; only where the backend counts them. */
  connections?: number;
  rejected?: number;
  failed?: number;
}

/** One egress decision made by the proxy (for the audit log). */
export interface NetworkEvent {
  ts: number;
  host: string;
  port: number;
  ip?: string;
  method: string;
  decision: 'allow' | 'deny';
  reason?: string;
}

export interface ProviderCapabilities {
  /** Isolation level this provider delivers. */
  isolation: IsolationLevel;
  networkModes: NetworkMode[];
  /** Can enforce a domain allowlist (requires the proxy). */
  networkFilter: boolean;
  /** Supported workspace delivery kinds. */
  workspaceDelivery: Array<WorkspaceDelivery['kind']>;
  /** Additional host mounts possible. */
  mounts: boolean;
  snapshots: boolean;
  tty: boolean;
  /**
   * `extendExpiry` can move the deadline of a live sandbox (`abox extend`, `access_request`
   * kind=ttl). Absent / false: the deadline is fixed at creation and extending is `unsupported`.
   */
  extendExpiry?: boolean;
  /**
   * `updateResources` can change the cpu and memory limits of an existing sandbox, running or not
   * (`access_request` kind=resources). Absent / false: the limits are fixed at creation and
   * changing them is `unsupported`.
   */
  updateResources?: boolean;
  /**
   * `stats` returns live cpu / memory / pids usage of a running sandbox (see `ResourceUsage`).
   * Absent / false: the GUI shows the configured values only.
   */
  stats?: boolean;
  /**
   * Network modes of a running sandbox that `addPortForward` can publish a port for (the host side
   * is always `127.0.0.1`). Absent / empty: the backend has no port forwarding, e.g. because the
   * sandbox shares the host network anyway (`process`) or runs on a remote host.
   */
  portForward?: NetworkMode[];
  /** Which resource limits are actually enforced. */
  limits: { cpus: boolean; memory: boolean; pids: boolean; disk: boolean };
  /** Can run as a non-root user inside the sandbox. */
  nonRootUser: boolean;
  secretInjection: SecretInjection[];
  /** Base OS families the provider can prepare. */
  osFamilies: OsFamily[];
  /** Runs on a remote host (workspace `bind` impossible). */
  remote: boolean;
  /**
   * Can mount per-project package cache volumes (`SandboxSpec.caches`, `listCaches`, `removeCache`).
   * Absent / false: the manager creates sandboxes without caches and says so.
   */
  caches?: boolean;
}

export interface BackendStatus {
  ok: boolean;
  version?: string;
  /** e.g. daemon runs rootless. */
  rootless?: boolean;
  details: string[];
  /**
   * Everything worth knowing that is not a plain detail. Includes the `advisories`, which stay in
   * this list for older readers.
   */
  warnings: string[];
  /**
   * The subset of `warnings` that are advisory notes about a working component (rootful engine, no
   * disk quota, a mode without isolation, ...): nothing is broken and the user need not act. Doctor
   * reports them as `info`; every other warning counts as a real `warning`.
   */
  advisories?: string[];
}

/** How a host is reached; passed to provider factories. */
export interface HostConnection {
  host: HostId;
  kind: 'local' | 'ssh';
  /** Engine endpoint for container backends (unix socket path), possibly a forwarded socket. */
  engineSocket?: string;
  /** Working directory root on that host for backend data (process/vm backends). */
  dataDir?: string;
  /**
   * Stronger OCI runtime of the engine on THIS host (`runsc`, `kata`), per engine, from the host
   * profile. The container backends report `hardened` only when the engine really lists it.
   */
  runtimes?: { docker?: string; podman?: string };
}
