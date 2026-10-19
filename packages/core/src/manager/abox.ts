import type { AboxPaths } from '../config/paths.js';
import type { ClientStatus, SetupPlan, SetupRequest, SetupResult } from '../setup/types.js';
import type { AboxConfig } from '../config/config.js';
import type { DirEntry, SandboxPortForward, TtySession } from '../types.js';
import {
  accessRequest,
  applyApprovedAccess,
  applyApprovedAccessInternal,
  extendTtl,
} from './access.js';
import {
  doctor,
  exportAudit,
  gc,
  gcOrphans,
  listAgentTokens,
  createAgentToken,
  queryAudit,
  reconcile,
  reconcileInternal,
  revokeAgentToken,
  setPolicy,
  auditUnknownTool,
  showPolicy,
  validatePolicyText,
  verifyAgentToken,
  verifyAudit,
} from './admin.js';
import { approve, deny, expireApprovals, getApproval, listApprovals } from './approvals.js';
import { doctorFor } from './doctor-for.js';
import {
  execCommand,
  exportSandbox,
  listProcesses,
  listSandboxDir,
  processLogs,
  readLog,
  readSandboxFile,
  restoreSandbox,
  snapshotSandbox,
  startProcess,
  stopProcess,
  writeSandboxFile,
} from './exec.js';
import {
  attachSandbox,
  copyIn,
  copyOut,
  getPolicyRevision,
  listPolicyRevisions,
  listSnapshots,
  sandboxLogs,
} from './interactive.js';
import { listCaches, removeCaches } from './caches.js';
import { estimateFit, hostCapacity } from './capacity.js';
import { estimateWorkspace } from './estimate.js';
import { suggestTemplate } from './suggest.js';
import { activity, recentActivity } from './activity.js';
import { allowNetwork, networkLog, proposeNetworkPolicy } from './network-log.js';
import { listPortForwards, removePortForward } from './ports.js';
import { Internals } from './internals.js';
import type { AboxOptions } from './internals.js';
import {
  createSandbox,
  inspectSandbox,
  listSandboxes,
  removeSandbox,
  startSandbox,
  stopSandbox,
} from './lifecycle.js';
import {
  buildTemplate,
  gcImages,
  listTemplates,
  reviewTemplate,
  showTemplate,
  validateTemplateOp,
} from './templates.js';
import { setupApply, setupDetect, setupPlan } from './setup.js';
import { sandboxStats } from './usage.js';
import type {
  AboxEvent,
  AccessResult,
  AccessRequestInput,
  AgentTokenView,
  ApprovalDecision,
  ApprovalView,
  AttachOptions,
  AuditEntry,
  AuditFilter,
  BuildResult,
  BuildTemplateOptions,
  CacheList,
  CacheRemoveResult,
  CacheSelector,
  Caller,
  ChainVerification,
  CreateOptions,
  CreateSandboxRequest,
  CreateResult,
  DoctorForInput,
  DoctorReport,
  EstimateFitInput,
  ExecCallOptions,
  ExecParams,
  ExecOutcome,
  ExportParams,
  ExportSandboxResult,
  FitEstimate,
  GcImagesResult,
  GcOptions,
  GcOrphansOptions,
  GcOrphansReport,
  GcReport,
  HostCapacity,
  InspectResult,
  NetworkAllowInput,
  ActivityOptions,
  ActivityView,
  RecentActivityOptions,
  RecentActivityView,
  NetworkLogOptions,
  NetworkLogView,
  NetworkPolicyProposal,
  PolicyRevisionDetail,
  PolicyRevisionSummary,
  PolicyValidation,
  PolicyView,
  ProcessLogsOptions,
  ProcessLogsResult,
  ProcessView,
  ReadFileResult,
  ReadLogOptions,
  ReconcileOptions,
  ReconcileReport,
  ScopedDoctorReport,
  SandboxFilterInput,
  SandboxList,
  SandboxLogsOptions,
  SandboxStatsResult,
  SandboxView,
  SetPolicyResult,
  SnapshotView,
  StartProcessResult,
  TemplateDetails,
  TemplateList,
  TemplateReview,
  TemplateValidation,
  WorkspaceEstimate,
  TemplateSuggestion,
  TemplateSuggestionInput,
  WorkspaceEstimateInput,
} from './types.js';
import type { ProgressInfo } from '../workspace/index.js';

/** How often `startTtlWatcher` enforces deadlines by default. */
export const DEFAULT_TTL_WATCH_MS = 15_000;

export interface AboxOpenOptions extends AboxOptions {
  /** Run the light reconcile (TTL sweep, ghost/stale marking; nothing is deleted) on open. Default true. */
  reconcileOnOpen?: boolean;
}

/**
 * The manager facade. Every surface (CLI, MCP, GUI, Orca plugin) calls only this class, so policy,
 * approval and audit enforcement happens in exactly one place. See docs/internal/manager-api.md.
 *
 * Every operation takes a {@link Caller}; unknown contexts get `policy_denied`; agents only ever
 * see and affect their own sandboxes (everything else is `not_found`).
 */
export class Abox {
  private constructor(private readonly I: Internals) {}

  static async open(opts: AboxOpenOptions): Promise<Abox> {
    const I = Internals.open(opts);
    const abox = new Abox(I);
    if (opts.reconcileOnOpen !== false) {
      try {
        await I.sweepTtl(true);
        await reconcileInternal(I, {}, 'system');
      } catch (e) {
        I.audit('system', 'reconcile', {
          decision: 'error',
          details: { message: e instanceof Error ? e.message : String(e), phase: 'open' },
        });
      }
    }
    return abox;
  }

  close(): void {
    this.I.close();
  }

  get paths(): AboxPaths {
    return this.I.paths;
  }
  get config(): AboxConfig {
    return this.I.config;
  }
  get policyHash(): string {
    this.I.refreshPolicy();
    return this.I.policy.contentHash;
  }

  /** In-process events (sandbox created/removed/state, approvals, policy). Returns an unsubscribe function. */
  onEvent(listener: (e: AboxEvent) => void): () => void {
    return this.I.onEvent(listener);
  }

  // -- templates -------------------------------------------------------------------------------------
  /**
   * `workspacePath`: the workspace a create would use; its `.sandbox` templates are listed too
   * (agents: only below their workspace roots, otherwise `policy_denied`).
   */
  listTemplates(
    caller: Caller,
    o: { projectDir?: string; workspacePath?: string } = {},
  ): Promise<TemplateList> {
    return listTemplates(this.I, caller, o);
  }
  showTemplate(
    caller: Caller,
    name: string,
    o: { projectDir?: string; workspacePath?: string } = {},
  ): Promise<TemplateDetails> {
    return showTemplate(this.I, caller, name, o);
  }
  /**
   * Review material for trusting a project template: the resolved template as a diff against what
   * it extends (or its last trusted version), and its risks. `expectedContentHash` (from an
   * approval request) flags a file that changed since.
   */
  reviewTemplate(
    caller: Caller,
    name: string,
    o: { projectDir?: string; workspacePath?: string; expectedContentHash?: string } = {},
  ): Promise<TemplateReview> {
    return reviewTemplate(this.I, caller, name, o);
  }
  validateTemplate(
    caller: Caller,
    nameOrPath: string,
    o: { projectDir?: string } = {},
  ): Promise<TemplateValidation> {
    return validateTemplateOp(this.I, caller, nameOrPath, o);
  }
  buildTemplate(caller: Caller, name: string, o: BuildTemplateOptions = {}): Promise<BuildResult> {
    return buildTemplate(this.I, caller, name, o);
  }
  /**
   * Read-only. Which template fits a project folder: its own `.sandbox/*.yaml` templates first, then the
   * templates that marker files point to (`package.json` -> node-dev, ...), best first. Only file names are
   * looked at, bounded; nothing is executed. A template that does not exist or that the caller's policy does
   * not allow is never suggested; an agent may only ask about folders it could use as a workspace. Not offered
   * over MCP: choosing a template for a host folder is left to the human surfaces (CLI, GUI).
   */
  suggestTemplate(caller: Caller, input: TemplateSuggestionInput): Promise<TemplateSuggestion> {
    return suggestTemplate(this.I, caller, input);
  }
  /** Human only. */
  gcImages(caller: Caller, o: { projectDir?: string } = {}): Promise<GcImagesResult> {
    return gcImages(this.I, caller, o);
  }

  // -- sandboxes ---------------------------------------------------------------------------------------
  createSandbox(
    caller: Caller,
    req: CreateSandboxRequest,
    opts: CreateOptions = {},
  ): Promise<CreateResult> {
    return createSandbox(this.I, caller, req, opts);
  }
  /**
   * Human only. Fast read-only size check of a workspace folder (what a `copy` would move): the GUI
   * shows it when the folder is picked, before "Create".
   */
  estimateWorkspace(
    caller: Caller,
    input: WorkspaceEstimateInput,
    opts: { signal?: AbortSignal; onProgress?: (line: string, info?: ProgressInfo) => void } = {},
  ): Promise<WorkspaceEstimate> {
    return estimateWorkspace(this.I, caller, input, opts);
  }
  /**
   * Human only, read-only. Capacity of a host (cpus and memory of the machine the engine runs on), what the
   * whole machine uses right now (`/proc` numbers; over the hardened ssh connection for remote hosts), what
   * abox's sandboxes reserve and use there, and the host limits. Unknown parts are `null`; measured parts are
   * cached for a few seconds. Agents are refused.
   */
  hostCapacity(caller: Caller, hostId: string): Promise<HostCapacity> {
    return hostCapacity(this.I, caller, hostId);
  }
  /**
   * Human only, read-only. How many sandboxes of the planned size fit on a host (by limits, by reservations
   * against the machine, by what is free now), what the host looks like with it and whether a create would be
   * refused. A ceiling from limits, not a performance prediction.
   */
  estimateFit(caller: Caller, input: EstimateFitInput): Promise<FitEstimate> {
    return estimateFit(this.I, caller, input);
  }
  listSandboxes(caller: Caller, filter: SandboxFilterInput = {}): Promise<SandboxList> {
    return listSandboxes(this.I, caller, filter);
  }
  inspectSandbox(caller: Caller, id: string): Promise<InspectResult> {
    return inspectSandbox(this.I, caller, id);
  }
  /**
   * Live cpu / memory / pids of running sandboxes (human only, best effort): ids without data
   * (stopped, backend without `stats`, host unreachable) are left out of `usage`.
   */
  sandboxStats(caller: Caller, ids: string[]): Promise<SandboxStatsResult> {
    return sandboxStats(this.I, caller, ids);
  }
  startSandbox(caller: Caller, id: string): Promise<SandboxView> {
    return startSandbox(this.I, caller, id);
  }
  stopSandbox(caller: Caller, id: string): Promise<SandboxView> {
    return stopSandbox(this.I, caller, id);
  }
  removeSandbox(caller: Caller, id: string): Promise<{ id: string; removed: boolean }> {
    return removeSandbox(this.I, caller, id);
  }
  /** `ttl` = how much longer the sandbox may live, counted from its current expiry. */
  extendTtl(
    caller: Caller,
    id: string,
    ttl: string | number,
    o: ExecCallOptions = {},
  ): Promise<AccessResult> {
    return extendTtl(this.I, caller, id, ttl, o);
  }
  accessRequest(
    caller: Caller,
    id: string,
    req: AccessRequestInput,
    o: ExecCallOptions = {},
  ): Promise<AccessResult> {
    return accessRequest(this.I, caller, id, req, o);
  }
  /**
   * The open port forwards of a sandbox (`127.0.0.1` on this machine to a port in the sandbox;
   * owner or human). Opening one is `accessRequest` with `{ kind: 'port', details: { port } }`
   * (policy, approval and audit like every other access).
   */
  listPortForwards(caller: Caller, id: string): Promise<SandboxPortForward[]> {
    return listPortForwards(this.I, caller, id);
  }
  /** Closes the forward of `port` (owner or human; no approval, it only takes access away). */
  removePortForward(
    caller: Caller,
    id: string,
    port: number,
  ): Promise<{ removed: boolean; port?: SandboxPortForward }> {
    return removePortForward(this.I, caller, id, port);
  }
  /** Human only: apply an approved access request (`approve` already does this). */
  applyApprovedAccess(
    caller: Caller,
    approvalId: string,
  ): Promise<{ ok: boolean; message: string }> {
    return applyApprovedAccess(this.I, caller, approvalId);
  }

  // -- activity timeline -----------------------------------------------------------------------------------
  /**
   * What happened in a sandbox, newest first and one page at a time: commands, file writes, network decisions,
   * approvals and lifecycle steps, derived from the audit log (no storage of its own, so the audit log's masking
   * and retention rules hold; file content is never part of it). Owner or human; an agent never sees another
   * agent's sandbox. Not offered over MCP.
   */
  activity(caller: Caller, id: string, o: ActivityOptions = {}): Promise<ActivityView> {
    return activity(this.I, caller, id, o);
  }
  /** The newest activity across the sandboxes the caller may see (human: all, agent: its own), bounded. */
  recentActivity(caller: Caller, o: RecentActivityOptions = {}): Promise<RecentActivityView> {
    return recentActivity(this.I, caller, o);
  }

  // -- network log -----------------------------------------------------------------------------------------
  /**
   * What the egress proxy allowed and denied for a sandbox, grouped by destination (host and port) with counts,
   * first / last time, the reason of a denial and whether it can be allowed. A view of the audit log (retention
   * and secret rules are the audit log's). Owner or human; an agent never sees another agent's sandbox.
   */
  networkLog(caller: Caller, id: string, o: NetworkLogOptions = {}): Promise<NetworkLogView> {
    return networkLog(this.I, caller, id, o);
  }
  /**
   * Human only. "Allow once": add destinations (`host`, `host:port`, `*.host`) to the allowlist of this sandbox
   * only. policy.yaml stays as it is. Refuses IP addresses, internal names, metadata services, sandboxes without
   * an allowlist and everything the human's profile forbids; a wildcard needs `humanConfirmed`.
   */
  allowNetwork(caller: Caller, id: string, input: NetworkAllowInput): Promise<AccessResult> {
    return allowNetwork(this.I, caller, id, input);
  }
  /**
   * Human only. "Allow permanently": the proposed change of policy.yaml (text and base hash) that adds the
   * destinations to the profile of the sandbox owner. Writes nothing; save it with `setPolicy`.
   */
  proposeNetworkPolicy(
    caller: Caller,
    id: string,
    input: NetworkAllowInput,
  ): Promise<NetworkPolicyProposal> {
    return proposeNetworkPolicy(this.I, caller, id, input);
  }

  // -- exec, processes, files ---------------------------------------------------------------------------
  exec(
    caller: Caller,
    id: string,
    params: ExecParams,
    o: ExecCallOptions = {},
  ): Promise<ExecOutcome> {
    return execCommand(this.I, caller, id, params, o);
  }
  readLog(
    caller: Caller,
    logRef: string,
    o: ReadLogOptions = {},
  ): Promise<{ logRef: string; content: string; truncated: boolean; size: number }> {
    return readLog(this.I, caller, logRef, o);
  }
  startProcess(
    caller: Caller,
    id: string,
    params: Pick<ExecParams, 'argv' | 'command' | 'cwd' | 'env'>,
    o: ExecCallOptions = {},
  ): Promise<StartProcessResult> {
    return startProcess(this.I, caller, id, params, o);
  }
  listProcesses(caller: Caller, id: string): Promise<ProcessView[]> {
    return listProcesses(this.I, caller, id);
  }
  processLogs(
    caller: Caller,
    processId: string,
    o: ProcessLogsOptions = {},
  ): Promise<ProcessLogsResult> {
    return processLogs(this.I, caller, processId, o);
  }
  stopProcess(caller: Caller, processId: string): Promise<ProcessView> {
    return stopProcess(this.I, caller, processId);
  }
  readFile(
    caller: Caller,
    id: string,
    path: string,
    o: { maxBytes?: number } = {},
  ): Promise<ReadFileResult> {
    return readSandboxFile(this.I, caller, id, path, o);
  }
  writeFile(
    caller: Caller,
    id: string,
    path: string,
    content: string | Buffer,
    o: { mode?: number; encoding?: 'utf8' | 'base64' } = {},
  ): Promise<{ path: string; size: number }> {
    return writeSandboxFile(this.I, caller, id, path, content, o);
  }
  listDir(caller: Caller, id: string, path?: string): Promise<DirEntry[]> {
    return listSandboxDir(this.I, caller, id, path);
  }
  snapshot(caller: Caller, id: string, name: string): Promise<{ snapshotId: string }> {
    return snapshotSandbox(this.I, caller, id, name);
  }
  restore(caller: Caller, id: string, snapshotId: string): Promise<{ restored: string }> {
    return restoreSandbox(this.I, caller, id, snapshotId);
  }
  /** Snapshots taken through `snapshot`, oldest first (owner or human). */
  listSnapshots(caller: Caller, id: string): Promise<SnapshotView[]> {
    return listSnapshots(this.I, caller, id);
  }
  /**
   * Human only. Interactive terminal in a running sandbox; the audit log gets `sandbox.attach` and
   * `sandbox.attach.end` (duration, exit code), never the content. Agents get `policy_denied`.
   */
  attach(caller: Caller, id: string, opts: AttachOptions): Promise<TtySession> {
    return attachSandbox(this.I, caller, id, opts);
  }
  /** Human only. Host file/dir -> sandbox. The host path must not be a protected path (~/.ssh, ...). */
  copyIn(caller: Caller, id: string, hostPath: string, sandboxPath: string): Promise<void> {
    return copyIn(this.I, caller, id, hostPath, sandboxPath);
  }
  /** Human only. Sandbox file/dir -> host. The destination must not be an abox/protected path. */
  copyOut(caller: Caller, id: string, sandboxPath: string, hostPath: string): Promise<void> {
    return copyOut(this.I, caller, id, sandboxPath, hostPath);
  }
  /** Output of the sandbox's main process (owner or human), secrets masked. */
  sandboxLogs(caller: Caller, id: string, opts: SandboxLogsOptions = {}): Promise<string> {
    return sandboxLogs(this.I, caller, id, opts);
  }
  /** Produces diff/patch/branch/files; never applies anything to the original project. */
  exportSandbox(caller: Caller, id: string, params: ExportParams): Promise<ExportSandboxResult> {
    return exportSandbox(this.I, caller, id, params);
  }

  // -- approvals -----------------------------------------------------------------------------------------
  listApprovals(
    caller: Caller,
    filter: { status?: ApprovalView['status'] | ApprovalView['status'][]; limit?: number } = {},
  ): Promise<ApprovalView[]> {
    return listApprovals(this.I, caller, filter);
  }
  getApproval(caller: Caller, id: string): Promise<ApprovalView> {
    return getApproval(this.I, caller, id);
  }
  /** Human only. */
  approve(caller: Caller, approvalId: string, note?: string): Promise<ApprovalDecision> {
    return approve(this.I, caller, approvalId, note, async (aid) => {
      const ctx = await this.I.context(caller);
      return applyApprovedAccessInternal(this.I, ctx, aid);
    });
  }
  /** Human only. */
  deny(caller: Caller, approvalId: string, note?: string): Promise<ApprovalDecision> {
    return deny(this.I, caller, approvalId, note);
  }
  /** Human only: flip overdue pending approvals to `expired` (= denied). Returns their ids. */
  expireApprovals(caller: Caller): Promise<string[]> {
    return expireApprovals(this.I, caller);
  }

  // -- policy ---------------------------------------------------------------------------------------------
  showPolicy(caller: Caller): Promise<PolicyView> {
    return showPolicy(this.I, caller);
  }
  /** Pure syntax/semantic check; changes nothing. */
  validatePolicy(text: string): PolicyValidation {
    return validatePolicyText(text);
  }
  /** Human only. Revisions of policy.yaml, newest first. */
  listPolicyRevisions(caller: Caller): Promise<PolicyRevisionSummary[]> {
    return listPolicyRevisions(this.I, caller);
  }
  /** Human only. One revision with its full text. */
  getPolicyRevision(caller: Caller, rev: number): Promise<PolicyRevisionDetail> {
    return getPolicyRevision(this.I, caller, rev);
  }
  /**
   * Human only. An attempt by an agent is audited as `policy_change_denied`. `baseHash`: the policy hash the
   * edit started from; when the policy changed since, the save is refused with `conflict`.
   */
  setPolicy(caller: Caller, text: string, o: { baseHash?: string } = {}): Promise<SetPolicyResult> {
    return setPolicy(this.I, caller, text, o);
  }

  /**
   * For surfaces (MCP): an agent called a tool that does not exist. Audited as `mcp.unknown_tool`
   * (tool name, context, argument names only), rate limited. No-op for humans.
   */
  auditUnknownTool(
    caller: Caller,
    tool: string,
    argNames: readonly string[] = [],
  ): Promise<boolean> {
    return auditUnknownTool(this.I, caller, tool, argNames);
  }

  // -- audit ------------------------------------------------------------------------------------------------
  queryAudit(caller: Caller, filter: AuditFilter = {}): Promise<AuditEntry[]> {
    return queryAudit(this.I, caller, filter);
  }
  /** Human only. */
  verifyAudit(caller: Caller): Promise<ChainVerification> {
    return verifyAudit(this.I, caller);
  }
  /** Human only: JSON Lines to `writable`; returns the number of entries. */
  exportAudit(
    caller: Caller,
    filter: AuditFilter,
    writable: { write(chunk: string): unknown },
  ): Promise<number> {
    return exportAudit(this.I, caller, filter, writable);
  }

  // -- tokens (MCP HTTP) ------------------------------------------------------------------------------------
  /** Human only. The plaintext token is returned once. */
  createAgentToken(
    caller: Caller,
    contextId: string,
    label: string,
  ): Promise<AgentTokenView & { token: string }> {
    return createAgentToken(this.I, caller, contextId, label);
  }
  /** Maps a bearer token to its agent context id, or `undefined` (unknown, revoked, context removed). */
  verifyAgentToken(token: string): string | undefined {
    return verifyAgentToken(this.I, token);
  }
  revokeAgentToken(caller: Caller, id: string): Promise<boolean> {
    return revokeAgentToken(this.I, caller, id);
  }
  listAgentTokens(caller: Caller): Promise<AgentTokenView[]> {
    return listAgentTokens(this.I, caller);
  }

  // -- operations --------------------------------------------------------------------------------------------
  /** Human only. Never deletes anything. */
  doctor(caller: Caller): Promise<DoctorReport> {
    return doctor(this.I, caller);
  }
  /**
   * Human only. A scoped readiness check (`abox doctor --for`): can this template run on that host, or can
   * that host run sandboxes at all? Read-only; reports problems as checks, like `doctor`.
   */
  doctorFor(caller: Caller, input: DoctorForInput): Promise<ScopedDoctorReport> {
    return doctorFor(this.I, caller, input);
  }
  /** Human only. Report only unless `apply`. */
  reconcile(caller: Caller, o: ReconcileOptions = {}): Promise<ReconcileReport> {
    return reconcile(this.I, caller, o);
  }
  /** Human only. */
  gc(caller: Caller, o: GcOptions = {}): Promise<GcReport> {
    return gc(this.I, caller, o);
  }
  /**
   * Human only. Lists (and with `remove` deletes) abox-labelled backend objects of other abox
   * installations or of none, e.g. what is left after a data directory was deleted. They may belong
   * to a live installation: removal is explicit.
   */
  gcOrphans(caller: Caller, o: GcOrphansOptions = {}): Promise<GcOrphansReport> {
    return gcOrphans(this.I, caller, o);
  }
  /**
   * Human only. The package cache volumes on the hosts (all with a record, or `o.host`): project,
   * stack, size, last use and whether a sandbox holds them. `size: false` skips measuring (fast).
   */
  listCaches(caller: Caller, o: { host?: string; size?: boolean } = {}): Promise<CacheList> {
    return listCaches(this.I, caller, o);
  }
  /** Human only. Removes caches by key, project or all; caches in use by a sandbox are never removed. */
  removeCaches(caller: Caller, selector: CacheSelector): Promise<CacheRemoveResult> {
    return removeCaches(this.I, caller, selector);
  }
  /**
   * Human only. Which agents are on this machine and where abox is registered (reads config files,
   * writes nothing). The first step of `abox setup` and of the GUI wizard.
   */
  setupDetect(caller: Caller, o: { command?: string } = {}): Promise<ClientStatus[]> {
    return setupDetect(this.I, caller, o);
  }
  /**
   * Human only. The preview of `abox setup`: per file the exact path, the diff and whether a backup
   * is made; per program the argv. Writes nothing. `digest` binds the preview to `setupApply`.
   */
  setupPlan(caller: Caller, req: SetupRequest): Promise<SetupPlan> {
    return setupPlan(this.I, caller, req);
  }
  /**
   * Human only, and only with `caller.humanConfirmed`. Applies the plan whose `digest` the human saw;
   * refuses when the files changed since. Backs up first, writes atomically, verifies, audits.
   */
  setupApply(caller: Caller, req: SetupRequest, digest: string): Promise<SetupResult> {
    return setupApply(this.I, caller, req, digest);
  }
  /**
   * For long-running processes (`abox mcp serve`, the GUI): enforce sandbox deadlines in the
   * background, every `intervalMs` (default 15 s), so a sandbox is stopped on time even when no
   * other abox command runs. It stops what is overdue (as the sweep on every call does) and retries
   * stops that failed; removal stays with `gc`. Safe next to other abox processes on the same data
   * directory. The timer is unref'd and ends with `close()`; returns a function that stops it
   * earlier. `onError` is told about a failed round (the next one retries).
   */
  startTtlWatcher(o: { intervalMs?: number; onError?: (e: unknown) => void } = {}): () => void {
    return this.I.startTtlWatcher(o.intervalMs ?? DEFAULT_TTL_WATCH_MS, o.onError);
  }
  /** Run the TTL sweep now (it also runs, rate limited, on every call). Human only. */
  async sweepTtl(caller: Caller): Promise<string[]> {
    const ctx = await this.I.context(caller);
    this.I.requireHuman(ctx, 'ttl.sweep');
    return this.I.sweepTtl(true);
  }
}
