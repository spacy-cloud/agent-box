import type { AuditDecision, AuditEntry, ChainVerification } from '../state/audit-log.js';
import type { AgentContext, ApprovalItem, HostInfo, ResolvedProfile } from '../policy/index.js';
import type { ErrorIssue } from '../errors.js';
import type {
  AccessMode,
  BackendKind,
  BuildContextInfo,
  DirEntry,
  ForeignResource,
  HostConnection,
  IsolationLevel,
  NetworkMode,
  PreparedImage,
  ProviderCapabilities,
  ResolvedTemplate,
  ResourceUsage,
  SandboxId,
  SandboxPortForward,
  SandboxState,
  TemplateSourceKind,
  WorkspaceMode,
  BackendStatus,
} from '../types.js';
import type {
  ChangeBadge,
  ChangeFile,
  ChangeSelection,
  ExportFormat,
  ExportResult,
  FileStatus,
  ProgressInfo,
} from '../workspace/index.js';

/**
 * Who is calling. `contextId` comes from the surface configuration (CLI: `human`; MCP:
 * `--agent <id>` or the HTTP token mapping) and never from a field the agent controls.
 */
export interface Caller {
  contextId: string;
  /**
   * Human only: the human has explicitly confirmed all approval items of this request
   * (CLI `--yes`, GUI dialog). Ignored for agent contexts. Never overrides a deny.
   */
  humanConfirmed?: boolean;
}

export const HUMAN: Caller = { contextId: 'human' };

/** Result of `HostResolver`: how to reach a host and what the policy needs to know about it. */
export interface ResolvedHost {
  connection: HostConnection;
  zone: HostInfo['zone'];
  minIsolation?: IsolationLevel;
  limits?: HostInfo['limits'];
  /** Backends that exist on this host. */
  backends: BackendKind[];
}
export type HostResolver = (hostId: string) => Promise<ResolvedHost>;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type AboxEventType =
  | 'sandbox.created'
  | 'sandbox.state'
  | 'sandbox.expired'
  | 'sandbox.removed'
  /** A port forward of the sandbox was opened or closed (`data.action`: `add` | `remove`). */
  | 'sandbox.ports'
  | 'approval.created'
  | 'approval.decided'
  | 'approval.expired'
  | 'policy.changed'
  | 'policy.reload_failed';

/** In-process notification. GUIs may also poll `queryAudit({afterSeq})`. */
export interface AboxEvent {
  type: AboxEventType;
  ts: number;
  sandboxId?: SandboxId;
  approvalId?: string;
  owner?: string;
  data?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface TemplateListEntry {
  name: string;
  description: string;
  useFor?: string;
  backend: BackendKind;
  isolation: IsolationLevel;
  networkMode: NetworkMode;
  source: { kind: TemplateSourceKind; path: string };
  /**
   * Set when this template hides lower-precedence ones of the same name: a project template
   * that shadows a user or builtin template (`shadows: [{kind: 'builtin', ...}]`). Creating from
   * this name then uses the project version, not the one the name normally stands for.
   */
  shadows?: Array<{ kind: TemplateSourceKind; path: string }>;
  /** Project templates: true only when this exact content hash was approved. Others: always true. */
  trusted: boolean;
  /** The caller's profile allows creating sandboxes from this template. */
  allowed: boolean;
  /** A provider for the template's backend is registered in this abox instance. */
  backendAvailable: boolean;
  /**
   * A create from this template can work here: the backend is usable and the template passes
   * validation (security rules, backend capabilities). Policy and approvals are separate (`allowed`).
   */
  ready: boolean;
  /** Why `ready` is false (the first problem; `abox template validate` lists all). */
  notReadyReason?: string;
  contentHash: string;
  hash: string;
}

export interface TemplateProblemView {
  kind: TemplateSourceKind;
  path: string;
  message: string;
  issues: ErrorIssue[];
}

export interface TemplateList {
  templates: TemplateListEntry[];
  /** Files that could not be loaded (humans only; agents get an empty list). */
  problems: TemplateProblemView[];
}

export interface EffectiveLimits {
  cpus: number;
  memoryBytes: number;
  ttlMs: number;
  pids: number;
  /** The template asks for more than the profile allows (a create without overrides would be denied). */
  exceedsProfile: string[];
  profile: string;
  sandboxes: number;
}

export interface TemplateDetails {
  template: ResolvedTemplate;
  /** Lower-precedence templates of the same name that this one hides (see `TemplateListEntry`). */
  shadows?: Array<{ kind: TemplateSourceKind; path: string }>;
  trusted: boolean;
  allowed: boolean;
  backendAvailable: boolean;
  capabilities?: ProviderCapabilities;
  effectiveLimits: EffectiveLimits;
  warnings: string[];
}

/**
 * What an approver should see before a project template is trusted: the resolved template as a
 * unified diff against its previously trusted version, the template it extends or shadows, or nothing,
 * plus the risky points in plain words.
 */
export interface TemplateReview {
  template: string;
  source: { kind: TemplateSourceKind; path?: string };
  contentHash: string;
  /** Whether this exact content is trusted already. */
  trusted: boolean;
  /**
   * What the diff compares against, in this order: the last trusted version of the same template,
   * the template it extends, the user or builtin template of the same name that it shadows, or
   * nothing (the full content).
   */
  against: { kind: 'previous' | 'extends' | 'shadows' | 'none'; label: string; template?: string };
  /** Lower-precedence templates of the same name that this one hides (a project template shadowing a builtin). */
  shadows?: Array<{ kind: TemplateSourceKind; path: string }>;
  /** Unified diff of the resolved template (`+` lines are the new content); empty when nothing differs. */
  diff: string;
  /** The risky points of the template as sentences. */
  risks: string[];
  /**
   * Templates with their own Dockerfile: the Dockerfile text and the files of its build context
   * (the diff above covers the same, compared with the last trusted version).
   */
  buildContext?: BuildContextInfo;
  /** Set when `expectedContentHash` was passed and the file no longer has that content. */
  changedSinceRequest?: boolean;
}

export type TemplateIssueKind = 'schema' | 'invalid' | 'unsupported' | 'policy';

export interface TemplateValidationIssue extends ErrorIssue {
  kind: TemplateIssueKind;
}

export interface TemplateValidation {
  /** No schema/security/capability problem and the policy does not deny the template. */
  ok: boolean;
  name?: string;
  source?: { kind: TemplateSourceKind; path?: string };
  issues: TemplateValidationIssue[];
  warnings: string[];
  /** What a `createSandbox` with the template's own defaults would get from the policy. */
  policy?: { decision: 'allow' | 'deny' | 'approval'; reasons: string[]; hint?: string };
}

export interface BuildTemplateOptions {
  /** Ignore the pinned base and the cache (`--update`). */
  update?: boolean;
  onProgress?: (line: string) => void;
  projectDir?: string;
  signal?: AbortSignal;
}

export interface BuildResult {
  template: string;
  templateHash: string;
  backend: BackendKind;
  image: PreparedImage;
  cached: boolean;
  durationMs: number;
  pinnedBase?: string;
}

export interface GcImagesResult {
  removed: Array<{ backend: BackendKind; host: string; refs: string[] }>;
  kept: string[];
}

// -- sandboxes ---------------------------------------------------------------

export interface WorkspaceRequest {
  mode?: WorkspaceMode;
  /** Host path of the project (not needed for mode `empty`). Relative paths resolve against the project dir. */
  path?: string;
  ref?: string;
  access?: AccessMode;
  /** Exclude patterns for copy/sync. */
  exclude?: string[];
  /**
   * copy/sync: leave out what the project's `.gitignore` files ignore (default: the template's
   * `workspace.gitignore`, else true). Giving it for another mode is an error.
   */
  gitignore?: boolean;
}

export interface CreateOverrides {
  cpus?: number;
  /** `4g`, `512m` or bytes. */
  memory?: string | number;
  /** TTL of this sandbox: `2h`, `30m` or milliseconds. */
  ttl?: string | number;
  network?: {
    mode?: NetworkMode;
    /** Extra destinations (on top of the template's); with `mode: 'none'` ignored. */
    allow?: string[];
    /** Network presets (`npm`, `pypi`, …) expanded to destinations. */
    presets?: string[];
    /** Exceptions to the private-address block (always needs approval). */
    privateExceptions?: string[];
  };
  /** Additional host mounts (on top of the template's). */
  mounts?: Array<{ source: string; target: string; access?: AccessMode }>;
}

export interface CreateSandboxRequest {
  template: string;
  name?: string;
  /** Host id, default `local`. Agents may only use hosts their context allows. */
  host?: string;
  workspace?: WorkspaceRequest;
  overrides?: CreateOverrides;
  /** Idempotency key (per owner): the same key returns the same sandbox. */
  requestId?: string;
  /** Directory with `.sandbox/*.yaml` project templates; default: workspace path, then the abox project dir. */
  projectDir?: string;
  /**
   * `false`: do not mount the package caches of the template for this sandbox (a fresh install).
   * `true` / absent: use them when the policy, the backend and the workspace allow it. Never
   * overrides a policy that switched the caches off.
   */
  cache?: boolean;
}

export interface CreateOptions {
  /** Max wait for a human decision in ms; default `config.limits.approvalWaitMs`. */
  waitForApprovalMs?: number;
  signal?: AbortSignal;
  /**
   * Progress lines: image build output, scanning and copying of a `copy` workspace. `info` carries the
   * numbers behind a workspace line (bytes done / total) for surfaces that draw a bar.
   */
  onProgress?: (line: string, info?: ProgressInfo) => void;
}

export interface PendingApproval {
  status: 'pending_approval';
  approvalId: string;
  kind: string;
  /** Kinds of the policy findings behind the request (e.g. `image_registry`, `mount`). */
  kinds: string[];
  reasons: string[];
  risks: string[];
  /** Deadline for the decision; after it the request counts as denied. */
  expiresAt: number;
  /** What the caller should do next. */
  message: string;
}

/** Humans only: approval items exist and `caller.humanConfirmed` was not set. Nothing was queued. */
export interface ConfirmationRequired {
  status: 'confirmation_required';
  reasons: string[];
  risks: string[];
  items: ApprovalItem[];
  message: string;
}

export interface SandboxWorkspaceView {
  mode: WorkspaceMode;
  sandboxPath: string;
  access: AccessMode;
  ref?: string;
  /** Host directory the workspace came from. */
  source?: string;
  branch?: string;
  remote: boolean;
}

export interface SandboxView {
  id: SandboxId;
  name: string;
  host: string;
  owner: string;
  template: string;
  templateHash: string;
  backend: BackendKind;
  isolation: IsolationLevel;
  state: SandboxState;
  createdAt: number;
  expiresAt: number;
  /** Milliseconds until expiry (0 when expired, negative never). */
  ttlRemainingMs: number;
  expired: boolean;
  /** The backend did not report this sandbox at the last check (or the host is unreachable). */
  stale: boolean;
  /** Registry knows it, backend does not (ghost). */
  missingInBackend: boolean;
  hostReachable: boolean;
  lastSeenAt: number | null;
  error: string | null;
  workspace: SandboxWorkspaceView | null;
  network: { mode: NetworkMode; allow: string[] };
  mounts: Array<{ hostPath: string; target: string; access: AccessMode }>;
  resources: { cpus: number; memoryBytes: number; ttlMs: number; pids?: number };
  /** Secret references and how they are injected (never values). */
  secretRefs: Array<{ ref: string; inject: string; hosts: string[] }>;
  /** Effective options as applied: `policy` (what the policy engine granted) and `provider` (what the backend reports). */
  effective: Record<string, unknown> | null;
  requestId: string | null;
  /**
   * Present while a human holds an interactive terminal in this sandbox (GUI / `abox shell`) that an
   * agent owns: the agent's exec, process and file-write tools answer `conflict` ("paused") until it ends.
   */
  humanAttached?: HumanAttachedView;
}

/** A human terminal in an agent's sandbox (see `SandboxView.humanAttached`). */
export interface HumanAttachedView {
  /** Open human terminals in the sandbox (at least 1). */
  sessions: number;
  /** When the oldest of them was opened (epoch ms). */
  since: number;
  /** Who: the context of the human (`human`). */
  actor: string;
}

/** Live resource usage per sandbox id; sandboxes without data (not running, no backend support) are absent. */
export interface SandboxStatsResult {
  usage: Record<SandboxId, ResourceUsage>;
}

export interface CreatedResult {
  status: 'created';
  sandbox: SandboxView;
  /** True when an earlier call with the same `requestId` had already created it. */
  idempotent: boolean;
  warnings: string[];
}
export type CreateResult = CreatedResult | PendingApproval | ConfirmationRequired;

export interface OrphanView {
  id: SandboxId;
  name: string;
  host: string;
  backend: BackendKind;
  template: string;
  owner: string;
  state: SandboxState;
  createdAt: number;
}

export interface SandboxFilterInput {
  state?: SandboxState | SandboxState[];
  template?: string;
  host?: string;
  /** Humans only: filter by owner (`human`, `agent:<id>`). */
  owner?: string;
  includeRemoved?: boolean;
}

export interface SandboxList {
  sandboxes: SandboxView[];
  /** Backend sandboxes unknown to the registry (humans only). */
  orphans: OrphanView[];
  /** Hosts that could not be reached; their sandboxes are listed from the registry as `stale`. */
  unreachableHosts: string[];
  /** Why a host is in `unreachableHosts` (resolution error or "no usable backend"), by host id. */
  hostProblems?: Record<string, string>;
}

export interface InspectResult extends SandboxView {
  processes: ProcessView[];
  /** Open port forwards (`127.0.0.1` on this machine to a port in the sandbox); empty when none or unknown. */
  ports: SandboxPortForward[];
  pendingApprovals: number;
}

// -- exec / processes / files -------------------------------------------------

export interface ExecParams {
  argv?: string[];
  /** Shell command line (`/bin/sh -c`). Either `argv` or `command`. */
  command?: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  stdin?: string;
  maxOutputBytes?: number;
}

export interface ExecCompleted {
  status: 'completed';
  exitCode: number;
  /** Masked (known secret values replaced by `***`) and capped. */
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
  /** Reference for `readLog` (full masked output, rotating retention). */
  logRef: string;
  /**
   * Set when the egress proxy denied requests while the command ran (allowlist sandboxes only): the agent
   * and the human learn about it without reading the audit log. Absent when nothing was denied.
   */
  network?: NetworkDenials;
}
export type ExecOutcome = ExecCompleted | PendingApproval | ConfirmationRequired;

/** Requests the egress proxy denied during one operation, per destination (most frequent first, at most 5). */
export interface NetworkDenials {
  /** Number of denied requests. */
  denied: number;
  hosts: Array<{ host: string; port: number; count: number }>;
  /** Destinations beyond `hosts`. */
  moreHosts: number;
}

export interface ExecCallOptions {
  waitForApprovalMs?: number;
  signal?: AbortSignal;
}

export interface ProcessView {
  id: string;
  sandboxId: SandboxId;
  command: string;
  status: 'running' | 'exited' | 'failed' | 'killed' | 'lost';
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
}

export type StartProcessResult =
  { status: 'started'; process: ProcessView } | PendingApproval | ConfirmationRequired;

export interface ProcessLogsOptions {
  /** Last N lines. */
  tail?: number;
  /** Start at this byte offset (from `nextOffset` of a previous call). */
  sinceBytes?: number;
  maxBytes?: number;
}

export interface ProcessLogsResult {
  process: ProcessView;
  content: string;
  /** Offset to pass as `sinceBytes` next time. */
  nextOffset: number;
  size: number;
  truncated: boolean;
}

export interface ReadFileResult {
  path: string;
  size: number;
  truncated: boolean;
  encoding: 'utf8' | 'base64';
  content: string;
}

export interface ReadLogOptions {
  tail?: number;
  maxBytes?: number;
}

/** `attach` options (same shape as the provider's `TtyOptions` minus `env`, which the manager never passes). */
export interface AttachOptions {
  cols: number;
  rows: number;
  /** Program to run instead of the default login shell. */
  argv?: string[];
}

export interface SandboxLogsOptions {
  /** Last N lines. */
  tail?: number;
  /** Only output since this time (epoch ms). */
  sinceTs?: number;
}

export interface SnapshotView {
  /** What `restore` takes. */
  id: string;
  name: string;
  createdAt: number;
}

export interface PolicyRevisionSummary {
  rev: number;
  ts: number;
  /** Who changed the file: `human`, `external-edit`, `system` (first import). */
  actor: string;
  contentHash: string;
}

export interface PolicyRevisionDetail extends PolicyRevisionSummary {
  content: string;
}

export interface ExportParams {
  format: ExportFormat;
  paths?: string[];
  /** `files` format: host directory (humans; agents always get an abox-owned directory). */
  outDir?: string;
  branchName?: string;
  /** Overwrite an existing export branch (humans only). */
  force?: boolean;
}

export interface ExportSandboxResult extends ExportResult {
  sandboxId: SandboxId;
  /** `files` format: the host directory the files were written to (`written` is relative to it). */
  outDir?: string;
}

// -- reviewing and applying a sandbox's changes (human only) ---------------------

/** Where the changes would go: the project the sandbox was created from. */
export interface ChangesTarget {
  /**
   * `git`: a repository (uncommitted changes in affected files are detected and refuse the apply).
   * `plain`: a directory without its own repository (needs an extra confirmation).
   * `unavailable`: nothing can be applied (see `reason`).
   */
  kind: 'git' | 'plain' | 'unavailable';
  path?: string;
  reason?: 'mount' | 'no_source' | 'missing' | 'not_allowed';
  message?: string;
  /** Affected paths that have uncommitted changes in the project (git targets). */
  dirtyPaths: string[];
}

export interface ChangesView {
  sandboxId: SandboxId;
  /** Digest of the exact diff shown here; an apply or a patch must name it. */
  digest: string;
  files: ChangeFile[];
  /** Flagged paths that are not changed files (tampered `.git`, entries that were not exported…). */
  notices: Array<{ path: string; reason: string }>;
  stats: { filesChanged: number; insertions: number; deletions: number };
  /** Entries `.gitignore` rules of the workspace kept out of the comparison. */
  ignored?: { count: number; paths: string[] };
  warnings: string[];
  target: ChangesTarget;
}

export interface ApplyChangesParams {
  digest: string;
  selection: ChangeSelection[];
  acknowledgeFlagged?: string[];
  allowNonGit?: boolean;
  dryRun?: boolean;
}

export interface ChangesSelectionParams {
  digest: string;
  selection: ChangeSelection[];
}

export interface ApplyPlanFile {
  path: string;
  oldPath?: string;
  status: FileStatus;
  /** Hunks that are applied / that the file has. */
  hunks: number;
  totalHunks: number;
  insertions: number;
  deletions: number;
  badges: ChangeBadge[];
  flagged: boolean;
}

export interface ApplyPlan {
  target: string;
  targetKind: 'git' | 'plain';
  files: ApplyPlanFile[];
  insertions: number;
  deletions: number;
  hunks: number;
  /** Selected files that needed the extra confirmation. */
  flaggedPaths: string[];
}

export interface ApplyChangesResult {
  status: 'applied' | 'dry_run';
  sandboxId: SandboxId;
  digest: string;
  plan: ApplyPlan;
  message: string;
}

/** Everything checked, nothing written: the human must confirm the plan (repeat with `humanConfirmed`). */
export interface ApplyConfirmationRequired extends ConfirmationRequired {
  plan: ApplyPlan;
}

export interface ChangesPatchResult {
  sandboxId: SandboxId;
  digest: string;
  /** Byte-exact `git apply` patch of the selection. */
  patch: Buffer;
  plan: Omit<ApplyPlan, 'target' | 'targetKind'>;
}

// -- access requests / approvals -------------------------------------------------

export type AccessKind = 'network' | 'mount' | 'resources' | 'ttl' | 'port';

export type AccessDetails =
  | {
      kind: 'network';
      details: {
        mode?: NetworkMode;
        domains?: string[];
        presets?: string[];
        privateExceptions?: string[];
      };
    }
  | { kind: 'mount'; details: { source: string; target: string; access?: AccessMode } }
  | { kind: 'resources'; details: { cpus?: number; memory?: string | number } }
  /** `ttl` = how much longer the sandbox should live, counted from its current expiry. */
  | { kind: 'ttl'; details: { ttl: string | number } }
  /**
   * Publish TCP port `port` of the sandbox on `127.0.0.1` of this machine. `hostPort` fixes the
   * host side (1024..65535, humans only); without it a free one is picked.
   */
  | { kind: 'port'; details: { port: number; hostPort?: number } };

export type AccessRequestInput = AccessDetails & { reason?: string };

export interface AccessApplied {
  status: 'applied';
  kind: AccessKind;
  sandbox: SandboxView;
  message: string;
  /** `kind` port: the forward that is open now. */
  port?: SandboxPortForward;
}
export type AccessResult = AccessApplied | PendingApproval | ConfirmationRequired;

export interface ApprovalBase {
  /** Image reference (`base.os`). */
  os?: string;
  /** Dockerfile marker (`base.dockerfile`); the images it builds on cannot be checked. */
  dockerfile?: string;
  /** Registry host `os` points to (`docker.io` for Docker Hub names). */
  registry?: string;
}

export interface ApprovalView {
  id: string;
  kind: string;
  requester: string;
  sandboxId: string | null;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  /** Written by the agent: UNTRUSTED, render as plain text. */
  reason: string;
  /** Computed by abox (trusted). */
  risks: string[];
  /**
   * Why approval is needed, as the policy engine reported it (computed by abox, trusted): one entry
   * per finding. Empty for approvals stored by a version that did not record them.
   */
  items: ApprovalItem[];
  /** Distinct kinds of `items` (e.g. `image_registry`, `template_trust`, `mount`). */
  kinds: string[];
  /** The `reason` of each item. */
  reasons: string[];
  /**
   * Base of the template a create / template-trust request is about, as bound into the request:
   * image reference and/or Dockerfile marker and the registry the image maps to. Null for other requests
   * and for approvals created before the base was part of the request.
   */
  base: ApprovalBase | null;
  /** The exact request the decision applies to (no secret values). */
  request: unknown;
  createdAt: number;
  expiresAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
  decisionNote: string | null;
  usedAt: number | null;
}

export interface ApprovalDecision {
  approval: ApprovalView;
  /** For approved access requests: the outcome of applying them. */
  applied?: { ok: boolean; message: string };
}

// -- policy / audit / tokens ---------------------------------------------------------

export interface PolicyView {
  contextId: string;
  owner: string;
  kind: 'human' | 'agent';
  profile: ResolvedProfile;
  allowedHosts: string[];
  policy: {
    contentHash: string;
    revision: number | null;
    source: 'default' | 'file';
    path?: string;
    /**
     * Humans only: policy.yaml on disk is invalid, so the manager is in degraded mode until the
     * file is valid again: this (older, `last_valid`; or the restrictive `built_in`, when no valid
     * one was ever recorded) policy only serves to look at things and clean up, sandbox creation,
     * access grants, approvals and every agent are refused. Absent while the file is fine.
     */
    reloadError?: {
      message: string;
      detectedAt: number;
      issues: ErrorIssue[];
      fallback: 'last_valid' | 'built_in';
    };
  };
  /** Humans only: every profile and context of the policy. */
  profiles?: Record<string, ResolvedProfile>;
  contexts?: Record<string, { profile: string; hosts?: string[] }>;
}

export interface PolicyValidation {
  ok: boolean;
  contentHash: string;
  issues: ErrorIssue[];
}

export interface SetPolicyResult {
  revision: number;
  changed: boolean;
  contentHash: string;
}

export interface AuditFilter {
  sandboxId?: string;
  actor?: string;
  action?: string | string[];
  decision?: AuditDecision;
  since?: number;
  until?: number;
  afterSeq?: number;
  limit?: number;
  order?: 'asc' | 'desc';
}

export type { AuditEntry, ChainVerification };

export interface AgentTokenView {
  id: string;
  contextId: string;
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

// -- maintenance --------------------------------------------------------------------

/** How much a doctor check matters. `info` is an advisory note about something that works. */
export type DoctorSeverity = 'ok' | 'info' | 'warning' | 'error';

/** One advisory or warning attached to a check (for a backend: one line of `BackendStatus.warnings`). */
export interface DoctorNote {
  severity: 'info' | 'warning';
  message: string;
}

export interface DoctorCheck {
  id: string;
  /**
   * Coarse legacy level, kept for older readers: `ok` also covers `info`, `warn` is `warning`.
   * `severity` is authoritative.
   */
  level: 'ok' | 'warn' | 'error';
  severity: DoctorSeverity;
  title: string;
  /** Everything about the check in one string (the `details` joined with `; `). */
  detail?: string;
  /** The same, as separate short lines. */
  details?: string[];
  /** Advisories and warnings of an otherwise working component. */
  notes?: DoctorNote[];
  hint?: string;
}

export interface BackendReport {
  host: string;
  backend: BackendKind;
  available: boolean;
  status?: BackendStatus;
  capabilities?: ProviderCapabilities;
  error?: string;
}

export interface ReconcileEntry {
  id: SandboxId;
  host: string;
  backend: BackendKind;
  detail: string;
}

export interface ReconcileReport {
  /** In the backend but not in the registry. */
  orphans: ReconcileEntry[];
  /** In the registry (running/stopped/…) but not in the backend. */
  ghosts: ReconcileEntry[];
  /** Registry rows stuck in `preparing` whose creating process is gone (e.g. `kill -9`). */
  interrupted: ReconcileEntry[];
  /** Past their TTL and not removed yet. */
  expired: ReconcileEntry[];
  /** Hosts/backends that could not be queried, so nothing is concluded for them. */
  unreachable: Array<{ host: string; backend: BackendKind; error: string }>;
  pendingApprovals: number;
  applied: {
    removed: SandboxId[];
    markedFailed: SandboxId[];
    markedStale: SandboxId[];
    orphansRemoved: SandboxId[];
  };
}

export interface ReconcileOptions {
  /** Repair: clean up interrupted creates and mark ghosts removed. Default: report only. */
  apply?: boolean;
  /** With `apply`: also remove backend sandboxes unknown to the registry. */
  removeOrphans?: boolean;
}

export interface DoctorReport {
  /** False when any check has severity `error`. Warnings and info never change it. */
  ok: boolean;
  /** Number of checks per severity. */
  summary: Record<DoctorSeverity, number>;
  checks: DoctorCheck[];
  backends: BackendReport[];
  state: { path: string; ok: boolean; message?: string };
  policy: {
    source: 'default' | 'file';
    path?: string;
    contentHash: string;
    revision: number | null;
    fileMode?: string;
  };
  audit: ChainVerification;
  reconcile: ReconcileReport;
  /** Package caches on all reachable hosts (sizes best effort). */
  caches?: { count: number; totalBytes: number | null };
}

/** One package cache volume (`abox cache ls`). */
export interface CacheView {
  host: string;
  /** Cache key; `abox cache rm <key>` removes it. */
  key: string;
  /** Cache name from the template (`pnpm-store`). */
  name: string;
  /** Canonical project path the cache belongs to. */
  project: string;
  /** Template name the cache belongs to (the stack). */
  stack: string;
  /** `human` or `agent:<context>`. */
  owner: string;
  /** Bytes on disk; `null` when the engine cannot tell. */
  sizeBytes: number | null;
  createdAt: number;
  /** When a sandbox last mounted it (creation time when abox has no record). */
  lastUsedAt: number;
  /** A sandbox (running or stopped) still references it; it cannot be removed. */
  inUse: boolean;
}

export interface CacheList {
  caches: CacheView[];
  /** Sum of the known sizes. */
  totalBytes: number;
  /** Hosts that could not be asked. */
  unreachable: Array<{ host: string; error: string }>;
}

/** What `removeCaches` removes: exactly one of `keys`, `project` or `all`. */
export interface CacheSelector {
  /** Keys or unique prefixes (at least 4 characters). */
  keys?: string[];
  /** Project path: all caches of that project. */
  project?: string;
  all?: boolean;
  /** Limit to one host (default: every host with caches). */
  host?: string;
}

export interface CacheRemoveResult {
  removed: CacheView[];
  /** Selected caches left alone (in use by a sandbox). */
  skipped: Array<{ cache: CacheView; reason: string }>;
  errors: string[];
}

export interface GcOptions {
  dryRun?: boolean;
}

/** A package cache `abox gc` removed (or would remove). */
export interface GcCacheEntry {
  host: string;
  key: string;
  name: string;
  project: string;
  stack: string;
  owner: string;
  sizeBytes: number | null;
  /** `age`: unused for longer than `caches.max_age`; `cap`: the project's caches were above `cache_max_bytes`. */
  reason: 'age' | 'cap';
}

export interface GcReport {
  dryRun: boolean;
  sandboxes: SandboxId[];
  workspaces: string[];
  images: GcImagesResult['removed'];
  /** Package caches removed for age or size. */
  caches: GcCacheEntry[];
  logs: { files: number; bytes: number };
  approvalsExpired: number;
  errors: string[];
}

/** A backend object with abox labels that belongs to another abox installation or to none. */
export interface OrphanResource extends ForeignResource {
  host: string;
  /** Backend through which it was found. */
  backend: BackendKind;
  /**
   * Set when `gc --orphans` will not remove it: its instance (or the resource itself, when it has
   * no `abox.instance` label) is running or was created or started less than an hour ago, so it
   * probably belongs to another abox home in use. Absent: stale, would be removed.
   */
  skip?: string;
}

/** The orphan resources of one `abox.instance` value (`''`: no or empty label). */
export interface OrphanInstanceGroup {
  instance: string;
  /** Number of resources found. */
  resources: number;
  /** How many of them are running containers. */
  running: number;
  /** Newest creation or start time (ms since the epoch) of any of them. */
  newestAt?: number;
  /**
   * Running or recently (< 1 h) created or started resources. For `instance: ''` this is true when
   * at least one resource is active; the others are still judged one by one.
   */
  active: boolean;
  /** Resources that are (or, in a dry run, would be) removed; the rest has a `skip` reason. */
  selected: number;
  /** Why `resources - selected` resources are skipped; absent when none is. */
  skipReason?: string;
}

export interface GcOrphansOptions {
  /** Remove what is found. Default: only list. */
  remove?: boolean;
  /** Only objects whose `abox.instance` label has exactly this value. Naming an instance also selects it when it looks active. */
  instance?: string;
  /** Also select resources of instances that are running or were created or started within the last hour. */
  includeActive?: boolean;
}

export interface GcOrphansReport {
  /** True when nothing was removed (the default). */
  dryRun: boolean;
  /** Time of the check (ms since the epoch); ages are relative to it. */
  now: number;
  /** Everything found: abox-labelled objects whose instance is not this installation's. */
  resources: OrphanResource[];
  /** `resources` by instance, stale ones first. */
  instances: OrphanInstanceGroup[];
  removed: OrphanResource[];
  /** Backends that could not be searched (not supported, or the engine is unreachable). */
  skipped: Array<{ host: string; backend: BackendKind; reason: string }>;
  errors: string[];
}

export type { AgentContext, DirEntry };

// -- workspace estimate --------------------------------------------------------------------------

export interface WorkspaceEstimateInput {
  /** Host path of the folder (relative paths resolve against the project dir). */
  path: string;
  /** Workspace mode the folder would be used with; only `copy` and `sync` copy it (default `copy`). */
  mode?: WorkspaceMode;
  /** Exclude patterns of the workspace (as for a create). */
  exclude?: string[];
  /** Apply `.gitignore` rules (default true), as the create would. */
  gitignore?: boolean;
}

export interface WorkspaceEstimateLimits {
  bytes: number;
  entries: number;
}

/**
 * Result of the read-only pre-scan of a workspace folder (`estimateWorkspace`): what a copy would
 * move, without opening any file. `truncated` = the scan stopped at the hard limit, so the numbers
 * are lower bounds ("more than").
 */
export interface WorkspaceEstimate {
  /** Canonical path that was measured. */
  path: string;
  mode: WorkspaceMode;
  /** False for modes that do not copy the folder (`mount`, `worktree`, `clone`, `empty`): nothing was measured. */
  applicable: boolean;
  bytes: number;
  entries: number;
  files: number;
  truncated: boolean;
  /** Entries left out by `.gitignore` (a directory counts once). Absent when `.gitignore` was not applied. */
  ignored?: number;
  /** What lies below them (files and bytes); `partial` = measuring stopped at its bound, so "at least". */
  ignoredTotals?: { files: number; bytes: number; partial: boolean };
  /** Above the profile's `workspace.max_copy_bytes` / `max_copy_entries`: a human has to confirm, agents are denied. */
  overSoftLimit: boolean;
  /** Above the hard copy limit: the create fails. */
  overHardLimit: boolean;
  soft: WorkspaceEstimateLimits;
  hard: WorkspaceEstimateLimits;
  durationMs: number;
}

// -- network log -----------------------------------------------------------------------------------------

/** Why the proxy decided as it did, in a form surfaces can act on (the proxy's wording is in `reason`). */
export type NetworkReasonKind =
  | 'not_in_allowlist'
  | 'port_not_allowed'
  | 'ip_literal'
  | 'blocked_address'
  | 'dns_failed'
  | 'plain_http_injection'
  | 'method_not_allowed'
  | 'connect_failed'
  | 'invalid_request'
  | 'other';

/** Whether a destination of the log can be allowed with one decision, and how. */
export interface NetworkAllowAdvice {
  /** A decision can add it to this sandbox. */
  possible: boolean;
  /** The exact destination to allow (`host`, or `host:port` for a port other than 80 / 443). */
  pattern?: string;
  /** The wildcard that covers the parent domain: an explicit choice with a warning, never the default. */
  wildcard?: string;
  /** Why it can not be allowed (when `possible` is false). */
  why?: string;
}

/** All requests to one destination (host and port), newest decision first. */
export interface NetworkLogEntry {
  /** Host as the proxy saw it (lower case); empty when the request could not even be parsed. */
  host: string;
  port: number;
  /** Decision of the most recent request. */
  decision: 'allow' | 'deny';
  allowed: number;
  denied: number;
  /** `allowed + denied`. */
  count: number;
  firstSeen: number;
  lastSeen: number;
  /** Reason of the most recent denial (the proxy's text, no headers or paths). */
  reason?: string;
  reasonKind?: NetworkReasonKind;
  /** Request methods seen, `CONNECT` for https tunnels (at most 8). */
  methods: string[];
  /** Requests that are only known through an overflow summary (counted, without time and method). */
  summarized: number;
  /** The sandbox's allowlist covers this destination now. */
  allowedNow: boolean;
  /** For entries with denials that are not allowed now. */
  allow?: NetworkAllowAdvice;
}

export interface NetworkLogOptions {
  /** Only requests at or after this time (ms since epoch). */
  since?: number;
  /** Only denied requests. */
  denied?: boolean;
  /** At most this many destinations (default 200, at most 1000), most recently seen first. */
  limit?: number;
}

export interface NetworkLogView {
  sandboxId: string;
  /** `allowlist`: the proxy decides and logs. `none`: no network at all. `open`: no proxy, nothing is logged. */
  mode: NetworkMode;
  entries: NetworkLogEntry[];
  totals: { allowed: number; denied: number; destinations: number };
  /** Older requests exist that are not part of the result (event cap or `limit`). */
  truncated: boolean;
  /** Most requests the log looks at per sandbox. */
  maxEvents: number;
}

export interface NetworkAllowInput {
  /** `host`, `host:port` or `*.host`. */
  destinations: string[];
}

/** Human only: the change of `policy.yaml` that makes the destinations part of the owner's profile. */
export interface NetworkPolicyProposal {
  /** Context of the sandbox owner and the profile the change is made in. */
  context: string;
  profile: string;
  /** Contexts that use the profile (the change applies to all of them). */
  usedBy: string[];
  /** Destinations the profile does not allow yet (what the change adds). */
  added: string[];
  /** Destinations the profile allows already. */
  alreadyAllowed: string[];
  /** Hash of the policy the proposal was made from (a changed file is refused on save). */
  baseHash: string;
  /** Current text of `policy.yaml` (the built-in default when there is no file). */
  current: string;
  /** The text with the change; `null` when there is nothing to add. */
  proposed: string | null;
}

// -- host capacity and fit estimate --------------------------------------------------------------

/** A configured host limit and how much of it the sandboxes on the host reserve. */
export interface HostLimitUse {
  limit: number;
  reserved: number;
}

/**
 * What a host can run and how busy it is (`hostCapacity`). Human only. Every number that could not be
 * measured is `null` / `available: false`: nothing is guessed. `reserved` is what the sandboxes were
 * created with (their cpu and memory limits), not what they use; `live` is the whole machine (everything
 * running there, abox or not); `abox.usage` is what abox's own running sandboxes use right now.
 */
export interface HostCapacity {
  host: string;
  /** When the measured parts (capacity, live, abox.usage) were taken (epoch ms); cached for a few seconds. */
  ts: number;
  /** Total cpus and memory of the machine the engine runs on. */
  capacity: {
    cpus: number | null;
    memoryBytes: number | null;
    /** `engine` = Docker/Podman `info`, `proc` = `/proc` of the host, `os` = this machine's `os` module. */
    source: 'engine' | 'proc' | 'os' | 'unknown';
  };
  live: {
    available: boolean;
    /** Why `available` is false. */
    reason?: string;
    /** Share of all cpus that was busy during a short sample (0..100). */
    cpuPercent: number | null;
    load: { m1: number; m5: number; m15: number } | null;
    memoryTotalBytes: number | null;
    memoryAvailableBytes: number | null;
    /** `MemTotal - MemAvailable`. */
    memoryUsedBytes: number | null;
    /** How the numbers were read: directly on this machine, or over ssh. */
    source: 'local' | 'ssh' | null;
  };
  abox: {
    /** Sandboxes that count against the host limits (being created, created, running, stopped). */
    sandboxes: number;
    running: number;
    /** Sum of the cpu and memory limits those sandboxes were created with. */
    reserved: { cpus: number; memoryBytes: number };
    /** Summed live use of the running sandboxes that reported one; null when none did. */
    usage: { cpuPercent: number; memoryBytes: number; sampled: number } | null;
  };
  /** The limits of the host profile (hosts.yaml `limits`) that are set. */
  limits: {
    sandboxes?: HostLimitUse;
    cpus?: HostLimitUse;
    memoryBytes?: HostLimitUse;
  };
}

export interface EstimateFitInput {
  /** Host to place the sandbox on (default `local`). */
  hostId?: string;
  template: string;
  /** The resources the sandbox would get instead of the template's. */
  overrides?: { cpus?: number; memory?: string | number };
  /** Project folder / workspace a project template may live in (as for a create). */
  projectDir?: string;
  workspacePath?: string;
}

/** One ceiling on how many sandboxes of the planned size fit. */
export interface FitBound {
  /** `limit` = host limit of hosts.yaml, `profile` = the policy profile, `reservation` = reserved vs the machine, `live` = free right now. */
  source: 'limit' | 'profile' | 'reservation' | 'live';
  resource: 'sandboxes' | 'cpu' | 'memory';
  /** Sandboxes of this size that fit under this ceiling, the planned one included (0 = it does not fit). */
  count: number;
  /**
   * Shown but not counted in `fits` / `limitedBy`: how busy the cpus are right now says little about
   * whether a sandbox fits (cpus are shared in time), so it only raises a warning.
   */
  advisory?: boolean;
}

export interface FitBlock {
  kind: 'host_limit' | 'profile_limit';
  field: 'sandboxes' | 'cpus' | 'memory';
  reason: string;
  hint?: string;
}

export type FitWarningCode =
  | 'memory_overcommit'
  | 'cpu_overcommit'
  | 'memory_high'
  | 'memory_not_free'
  | 'cpu_busy'
  | 'capacity_unknown';

export interface FitWarning {
  code: FitWarningCode;
  message: string;
}

/**
 * Answer to "does this sandbox fit on that host, and how often?" (`estimateFit`). Human only, read-only.
 *
 * It is a ceiling derived from limits and reservations, NOT a performance prediction: a sandbox that
 * "fits" can still be slow when the host is busy, and cpu / memory limits that are reserved are not use.
 */
export interface FitEstimate {
  host: string;
  ts: number;
  request: { template: string; cpus: number; memoryBytes: number };
  /**
   * Sandboxes of this size that fit, the planned one included: the smallest of all ceilings in `bounds`.
   * 0 = it does not fit; null = nothing is known that bounds it (no limits, capacity unknown).
   */
  fits: number | null;
  /** The ceiling that is reached first. */
  limitedBy: FitBound | null;
  bounds: FitBound[];
  /** What the host looks like once the planned sandbox is there. Percent values are whole numbers; null = unknown. */
  projection: {
    /** Reserved (limits of all sandboxes incl. this one) against the machine's cpus and memory. */
    reservedPercent: { cpu: number | null; memory: number | null };
    /** The same against the host limits of hosts.yaml, for the limits that are set. */
    limitPercent: { sandboxes?: number; cpu?: number; memory?: number };
    /** What the whole machine uses right now (live, before the planned sandbox). */
    usedPercent: { cpu: number | null; memory: number | null };
  };
  /** Host or profile limits the create would exceed: it is refused (`policy_denied`). */
  blocked: FitBlock[];
  warnings: FitWarning[];
  /** `error` = refused, `warn` = allowed but over-committed / nearly full, `info` otherwise. */
  tone: 'info' | 'warn' | 'error';
  /** The host numbers this estimate is based on. */
  capacity: HostCapacity;
}
