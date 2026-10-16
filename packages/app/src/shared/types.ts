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
  DoctorReport,
  ExportSandboxResult,
  InspectResult,
  PolicyValidation,
  PolicyView,
  ProcessLogsResult,
  ProcessView,
  ReconcileReport,
  SandboxList,
  SandboxView,
  TemplateDetails,
  TemplateList,
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
  DoctorReport,
  ExportSandboxResult,
  InspectResult,
  PolicyValidation,
  PolicyView,
  ProcessLogsResult,
  ProcessView,
  ReconcileReport,
  SandboxList,
  SandboxView,
  TemplateDetails,
  TemplateList,
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

export interface PolicyRevisionInfo {
  seq: number;
  ts: number;
  actor: string;
  action: string;
  revision: number | null;
  newHash: string | null;
  oldHash: string | null;
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

export interface TokenCreated {
  token: string;
  view: AgentTokenView | null;
}

export interface SaveResult {
  saved: string | null;
  count?: number;
}

export interface Outputs {
  'app:info': AppInfo;
  'app:setLocale': void;
  'app:copy': void;
  'dialog:pickDirectory': string | null;
  'sandboxes:list': SandboxList;
  'sandboxes:inspect': InspectResult;
  'sandboxes:start': SandboxView;
  'sandboxes:stop': SandboxView;
  'sandboxes:remove': { id: string; removed: boolean };
  'sandboxes:extend': AccessResult;
  'sandboxes:create': CreateResult;
  'templates:list': TemplateList;
  'templates:show': TemplateDetails;
  'files:list': DirEntry[];
  'export:run': ExportSandboxResult;
  'export:save': SaveResult;
  'processes:list': ProcessView[];
  'processes:logs': ProcessLogsResult;
  'snapshots:create': { snapshotId: string };
  'snapshots:restore': { restored: string };
  'approvals:list': ApprovalView[];
  'approvals:approve': ApprovalDecision;
  'approvals:deny': ApprovalDecision;
  'audit:query': AuditEntry[];
  'audit:exportSave': SaveResult;
  'audit:verify': ChainVerification;
  'policy:get': PolicyDocument;
  'policy:validate': PolicyValidation;
  'policy:set': { revision: number; changed: boolean; contentHash: string };
  'policy:revisions': PolicyRevisionInfo[];
  'doctor:run': DoctorReport;
  'reconcile:run': ReconcileReport;
  'tokens:list': AgentTokenView[];
  'tokens:create': TokenCreated;
  'tokens:revoke': boolean;
  'mcp:config': McpConfig;
}

export type IpcOutput<C extends IpcChannel> = Outputs[C];

/** The API the preload script exposes as `window.abox` (results are plain data; the renderer unwraps them). */
export interface AboxBridge {
  invoke<C extends IpcChannel>(channel: C, input?: IpcInput<C>): Promise<IpcResult<IpcOutput<C>>>;
  on<E extends EventChannel>(channel: E, listener: (payload: EventPayloads[E]) => void): () => void;
}
