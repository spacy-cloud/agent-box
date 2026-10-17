/**
 * Result types of the IPC channels. Core view types are imported as types only (erased at build time),
 * so the renderer never loads manager code.
 */
import type {
  AccessApplied,
  AccessResult,
  AgentTokenView,
  ApprovalDecision,
  ApprovalView,
  AuditEntry,
  ChainVerification,
  CreateResult,
  DirEntry,
  BackendReport,
  DoctorCheck,
  DoctorReport,
  DoctorSeverity,
  ExportSandboxResult,
  InspectResult,
  PolicyRevisionDetail,
  PolicyRevisionSummary,
  PolicyValidation,
  PolicyView,
  ProcessLogsResult,
  ProcessView,
  ReconcileReport,
  SandboxList,
  SandboxStatsResult,
  SandboxView,
  SnapshotView,
  TemplateDetails,
  TemplateList,
  TemplateReview,
  TemplateValidation,
  BuildResult,
  HostProfile,
  HostKeyStatus,
  PortForward,
} from '@abox/core';
import type { EventChannel, EventPayloads, IpcChannel, IpcInput, IpcResult, Locale } from './ipc';

export type {
  AccessApplied,
  AccessResult,
  AgentTokenView,
  ApprovalDecision,
  ApprovalView,
  AuditEntry,
  ChainVerification,
  CreateResult,
  DirEntry,
  BackendReport,
  DoctorCheck,
  DoctorReport,
  DoctorSeverity,
  ExportSandboxResult,
  InspectResult,
  PolicyValidation,
  PolicyView,
  ProcessLogsResult,
  ProcessView,
  ReconcileReport,
  SandboxList,
  SandboxStatsResult,
  SandboxView,
  SnapshotView,
  TemplateDetails,
  TemplateList,
  TemplateReview,
  TemplateValidation,
  BuildResult,
  HostProfile,
  HostKeyStatus,
  PortForward,
  PolicyRevisionDetail,
  PolicyRevisionSummary,
};

export interface AppInfo {
  version: string;
  platform: string;
  /** Context the GUI acts as (always `human`). */
  contextId: string;
  locale: Locale;
  /** Where the manager keeps its data (for the diagnostics view). */
  paths: { configDir: string; dataDir: string; stateDb: string; policyFile: string } | null;
  trayAvailable: boolean;
  notificationsAvailable: boolean;
  /** Setting: closing the window hides it to the tray instead of quitting (default off). */
  closeToTray: boolean;
  /** The manager could not be opened (message shown by the start screen). */
  managerError: string | null;
}

export interface PolicyDocument {
  view: PolicyView;
  text: string;
  /** `default` = built-in policy (no policy.yaml yet). */
  source: 'default' | 'file';
  path: string | null;
}

export interface McpConfig {
  agent: string;
  /** `claude mcp add …` line. */
  claudeCommand: string;
  /** JSON for `.mcp.json` / other clients. */
  json: string;
  /** Known agent contexts from the policy (for the selector). */
  contexts: string[];
}

/** What the settings view shows about MCP (derived from the policy, the token table and the audit log). */
export interface McpContextStatus {
  /** Agent context id (what `abox mcp serve --agent <id>` and a token are bound to). */
  id: string;
  profile: string;
  /** Last audited action of this agent (null: none yet). */
  lastActivityAt: number | null;
  lastAction: string | null;
  lastDecision: string | null;
  activeTokens: number;
  /** Last time one of its HTTP tokens authenticated a request. */
  lastTokenUseAt: number | null;
}
export interface McpStatus {
  contexts: McpContextStatus[];
  tokens: { active: number; revoked: number; lastUsedAt: number | null };
  /** Newest audited agent action across all contexts. */
  lastActivityAt: number | null;
}

export interface TokenCreated {
  token: string;
  view: AgentTokenView | null;
}

/** A project folder as the main process resolved it, with the recent folders after remembering it. */
export interface ProjectFolder {
  /** Canonical path of the folder. */
  dir: string;
  recent: string[];
}

export interface SaveResult {
  saved: string | null;
  count?: number;
}

/**
 * The base of a template as shown to an approver: the image, the registry it comes from and whether the
 * profile's image allowlist (`images.registries`) covers it. Explains the policy decision, never makes one.
 */
export interface ImageUse {
  /** Image reference, or the Dockerfile path for `base.dockerfile`. */
  ref: string;
  source: 'image' | 'dockerfile';
  /** Registry host (`docker.io` for Docker Hub names); null for a Dockerfile or a malformed name. */
  registry: string | null;
  repository: string | null;
  /** `images.registries` of the profile; null when the profile is unknown. */
  registries: string[] | null;
  /** Not covered by the allowlist (a Dockerfile base cannot be checked and counts as outside); null when unknown. */
  outside: boolean | null;
}

// -- terminals ------------------------------------------------------------------------------------------------

export interface TtyOpened {
  sessionId: string;
  kind: 'sandbox' | 'ssh';
  /** Short label for the tab / header, e.g. `abox@server.example.org:22`. */
  label: string;
  /** Initial size actually used. */
  cols: number;
  rows: number;
}

// -- templates ----------------------------------------------------------------------------------------------------

export type OsFamily = 'debian' | 'alpine' | 'fedora' | 'arch' | 'unknown';

export interface BaseImageInfo {
  ref: string;
  family: OsFamily;
  /** Backends this base is meant for. */
  backends: string[];
  note?: string;
}
export interface ToolInfo {
  name: string;
  summary: string;
  version: 'required' | 'optional' | 'none';
  versionHint?: string;
  /** OS families a preset exists for. */
  os: OsFamily[];
}
export interface TemplateCatalogInfo {
  baseImages: BaseImageInfo[];
  tools: ToolInfo[];
  networkPresets: Array<{ name: string; domains: string[] }>;
  /** Where "save as user template" writes. */
  userDir: string;
}
export interface TemplateSourceDoc {
  name: string;
  yaml: string;
  source: { kind: 'builtin' | 'user' | 'project'; path: string | null };
  /** Builtin and project templates are not edited in place (duplicate them). */
  readOnly: boolean;
}
export interface TemplateSaved {
  name: string;
  path: string;
  /** A template with the same name from a lower-precedence source is now hidden by this one. */
  shadows: Array<'builtin'>;
}
export interface ToolCheckResult {
  name: string;
  version?: string;
  check: string;
  ok: boolean;
  exitCode: number | null;
  /** Combined stdout/stderr, truncated. Plain text only. */
  output: string;
  durationMs: number;
}
export type TemplateTestOutcome =
  | { status: 'confirmation_required'; reasons: string[]; risks: string[] }
  | { status: 'pending_approval'; message: string }
  | {
      status: 'done';
      /** The sandbox could be created and started. */
      created: boolean;
      removed: boolean;
      tools: ToolCheckResult[];
      error?: string;
      durationMs: number;
    };

// -- hosts and ssh --------------------------------------------------------------------------------------------------

export interface HostBackendStatus {
  name: 'docker' | 'podman';
  ok: boolean;
  version?: string;
  rootless?: boolean;
  error?: string;
}
export interface HostStatus {
  /** `local` is always available; remote hosts are `unknown` until tested or used. */
  state: 'local' | 'reachable' | 'unreachable' | 'unknown';
  /** When this was observed (epoch ms). */
  checkedAt: number | null;
  lastOkAt: number | null;
  latencyMs: number | null;
  /** Older than five minutes: shown as "last known". */
  stale: boolean;
  error: string | null;
  hostKey: HostKeyStatus | 'unavailable' | null;
  authOk: boolean | null;
  remoteUser: string | null;
  backends: HostBackendStatus[];
  /** What the engine behind the profile's `engine_socket` reports about itself (null: not asked or no answer). */
  engine: { rootless: boolean; runtimes: string[] } | null;
  /** The `runtimes` of the profile and whether the engine of the host knows each of them. */
  runtimes: Array<{ engine: 'docker' | 'podman'; runtime: string; available: boolean }>;
  warnings: string[];
}
export interface HostRow {
  profile: HostProfile;
  minIsolation: string;
  requiresApproval: boolean;
  status: HostStatus;
  /** Number of port forwards currently running. */
  forwardsRunning: number;
}
export interface HostTestOutcome {
  row: HostRow;
  fingerprints: string[];
}
export interface HostKeyView {
  id: string;
  status: HostKeyStatus;
  hostSpec: string;
  keys: Array<{ type: string; fingerprint: string }>;
  trusted: Array<{ type: string; fingerprint: string }>;
}
export interface ImportCandidate {
  id: string;
  alias: string;
  hostname: string | null;
  user: string | null;
  port: number | null;
  proxyJump: string | null;
  identityFile: string | null;
  warnings: string[];
}
export interface ImportPreview {
  path: string;
  hosts: ImportCandidate[];
  skipped: Array<{ pattern: string; reason: string }>;
  warnings: string[];
}
export interface ForwardState {
  host: string;
  name: string;
  state: 'running' | 'stopped' | 'failed';
  pid: number | null;
  /** Last line ssh printed when it failed. */
  error: string | null;
}

export interface Outputs {
  'app:info': AppInfo;
  'app:setLocale': void;
  'app:copy': void;
  'app:settings': { closeToTray: boolean };
  'dialog:pickDirectory': string | null;
  'askpass:answer': void;
  'sandboxes:list': SandboxList;
  'sandboxes:inspect': InspectResult;
  'sandboxes:stats': SandboxStatsResult;
  'sandboxes:start': SandboxView;
  'sandboxes:stop': SandboxView;
  'sandboxes:remove': { id: string; removed: boolean };
  'sandboxes:extend': AccessResult;
  'sandboxes:create': CreateResult;
  'templates:list': TemplateList;
  'templates:show': TemplateDetails;
  'templates:review': TemplateReview;
  'projects:recent': string[];
  'projects:remember': ProjectFolder;
  'files:list': DirEntry[];
  'files:copyIn': { copied: string | null };
  'files:copyOut': { copied: string | null };
  'export:run': ExportSandboxResult;
  'export:save': SaveResult;
  'processes:list': ProcessView[];
  'processes:logs': ProcessLogsResult;
  'sandboxes:logs': { content: string };
  'snapshots:list': SnapshotView[];
  'snapshots:create': { snapshotId: string };
  'snapshots:restore': { restored: string };
  'approvals:list': ApprovalView[];
  'approvals:approve': ApprovalDecision;
  'approvals:deny': ApprovalDecision;
  'approvals:templateReview': TemplateReview;
  'approvals:image': ImageUse | null;
  'audit:query': AuditEntry[];
  'audit:exportSave': SaveResult;
  'audit:verify': ChainVerification;
  'policy:get': PolicyDocument;
  'policy:validate': PolicyValidation;
  'policy:set': { revision: number; changed: boolean; contentHash: string };
  'policy:revisions': PolicyRevisionSummary[];
  'policy:revision': PolicyRevisionDetail;
  'doctor:run': DoctorReport;
  'reconcile:run': ReconcileReport;
  'tokens:list': AgentTokenView[];
  'tokens:create': TokenCreated;
  'tokens:revoke': boolean;
  'mcp:config': McpConfig;
  'mcp:status': McpStatus;
  'tty:open': TtyOpened;
  'tty:input': void;
  'tty:resize': void;
  'tty:close': void;
  'templates:catalog': TemplateCatalogInfo;
  'templates:source': TemplateSourceDoc;
  'templates:validate': TemplateValidation;
  'templates:save': TemplateSaved;
  'templates:build': BuildResult;
  'templates:test': TemplateTestOutcome;
  'templates:export': SaveResult;
  'hosts:list': HostRow[];
  'hosts:add': HostRow;
  'hosts:update': HostRow;
  'hosts:remove': { removed: boolean };
  'hosts:test': HostTestOutcome;
  'hosts:importPreview': ImportPreview;
  'hosts:importApply': { added: string[] };
  'hosts:keyCheck': HostKeyView;
  'hosts:keyTrust': { added: boolean; fingerprint: string };
  'hosts:keyForget': { removed: boolean };
  'hosts:forwards': ForwardState[];
  'hosts:forwardStart': ForwardState;
  'hosts:forwardStop': ForwardState;
}

export type IpcOutput<C extends IpcChannel> = Outputs[C];

/** The API the preload script exposes as `window.abox` (results are plain data; the renderer unwraps them). */
export interface AboxBridge {
  invoke<C extends IpcChannel>(channel: C, input?: IpcInput<C>): Promise<IpcResult<IpcOutput<C>>>;
  on<E extends EventChannel>(channel: E, listener: (payload: EventPayloads[E]) => void): () => void;
}
