import type { AboxPaths } from '../config/paths.js';
import type { AboxConfig } from '../config/config.js';
import type { DirEntry, TtySession } from '../types.js';
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
  showTemplate,
  validateTemplateOp,
} from './templates.js';
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
  Caller,
  ChainVerification,
  CreateOptions,
  CreateSandboxRequest,
  CreateResult,
  DoctorReport,
  ExecCallOptions,
  ExecParams,
  ExecOutcome,
  ExportParams,
  ExportSandboxResult,
  GcImagesResult,
  GcOptions,
  GcOrphansOptions,
  GcOrphansReport,
  GcReport,
  InspectResult,
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
  SandboxFilterInput,
  SandboxList,
  SandboxLogsOptions,
  SandboxView,
  SetPolicyResult,
  SnapshotView,
  StartProcessResult,
  TemplateDetails,
  TemplateList,
  TemplateValidation,
} from './types.js';

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
  listTemplates(caller: Caller, o: { projectDir?: string } = {}): Promise<TemplateList> {
    return listTemplates(this.I, caller, o);
  }
  showTemplate(
    caller: Caller,
    name: string,
    o: { projectDir?: string } = {},
  ): Promise<TemplateDetails> {
    return showTemplate(this.I, caller, name, o);
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
  listSandboxes(caller: Caller, filter: SandboxFilterInput = {}): Promise<SandboxList> {
    return listSandboxes(this.I, caller, filter);
  }
  inspectSandbox(caller: Caller, id: string): Promise<InspectResult> {
    return inspectSandbox(this.I, caller, id);
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
  /** Human only: apply an approved access request (`approve` already does this). */
  applyApprovedAccess(
    caller: Caller,
    approvalId: string,
  ): Promise<{ ok: boolean; message: string }> {
    return applyApprovedAccess(this.I, caller, approvalId);
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
  /** Human only. An attempt by an agent is audited as `policy_change_denied`. */
  setPolicy(caller: Caller, text: string): Promise<SetPolicyResult> {
    return setPolicy(this.I, caller, text);
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
  /** Run the TTL sweep now (it also runs, rate limited, on every call). Human only. */
  async sweepTtl(caller: Caller): Promise<string[]> {
    const ctx = await this.I.context(caller);
    this.I.requireHuman(ctx, 'ttl.sweep');
    return this.I.sweepTtl(true);
  }
}
