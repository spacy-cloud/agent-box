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
  workspace?: { mode?: WorkspaceMode; path?: string; access?: AccessMode; ref?: string };
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
  workspace: { mode: WorkspaceMode; path: string; access: AccessMode; ref?: string };
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
  source: { kind: TemplateSourceKind; path?: string };
  /** sha256 hex over the build-relevant fields (base, build steps, user). */
  hash: string;
  /** sha256 hex over the full original file content (used for project-template trust). */
  contentHash: string;
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

export interface DirEntry {
  name: string;
  type: 'file' | 'dir' | 'symlink' | 'other';
  size: number;
  mode: number;
  mtimeMs: number;
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
  /** Which resource limits are actually enforced. */
  limits: { cpus: boolean; memory: boolean; pids: boolean; disk: boolean };
  /** Can run as a non-root user inside the sandbox. */
  nonRootUser: boolean;
  secretInjection: SecretInjection[];
  /** Base OS families the provider can prepare. */
  osFamilies: OsFamily[];
  /** Runs on a remote host (workspace `bind` impossible). */
  remote: boolean;
}

export interface BackendStatus {
  ok: boolean;
  version?: string;
  /** e.g. daemon runs rootless. */
  rootless?: boolean;
  details: string[];
  warnings: string[];
}

/** How a host is reached; passed to provider factories. */
export interface HostConnection {
  host: HostId;
  kind: 'local' | 'ssh';
  /** Engine endpoint for container backends (unix socket path), possibly a forwarded socket. */
  engineSocket?: string;
  /** Working directory root on that host for backend data (process/vm backends). */
  dataDir?: string;
}
