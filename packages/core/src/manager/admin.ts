import { randomBytes } from 'node:crypto';
import { readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { AboxError, isAboxError } from '../errors.js';
import type { SandboxProvider } from '../provider.js';
import type { AuditEntry, AuditQuery } from '../state/audit-log.js';
import type { SandboxRecord } from '../state/sandbox-registry.js';
import { sha256Hex } from '../state/canonical.js';
import { parsePolicy } from '../policy/index.js';
import type { BackendKind, ForeignResource, SandboxId, SandboxInfo } from '../types.js';
import type { WorkspaceRecord } from '../workspace/index.js';
import { cleanupWorkspace } from '../workspace/index.js';
import { expireApprovals as expireApprovalsOp } from './approvals.js';
import type { Internals } from './internals.js';
import { destroySandbox } from './lifecycle.js';
import { collectAllNetworkEvents, collectNetworkEvents } from './network-audit.js';
import { rotateLogs } from './exec.js';
import { catalogFor, gcImagesInternal } from './templates.js';
import type {
  AgentTokenView,
  AuditFilter,
  BackendReport,
  Caller,
  ChainVerification,
  DoctorCheck,
  DoctorReport,
  GcOptions,
  GcOrphansOptions,
  GcOrphansReport,
  GcReport,
  OrphanResource,
  PolicyValidation,
  PolicyView,
  ReconcileEntry,
  ReconcileOptions,
  ReconcileReport,
  SetPolicyResult,
} from './types.js';
import {
  classifyWorkingBackend,
  legacyLevel,
  startHint,
  summarizeChecks,
} from './doctor-severity.js';
import { errMessage } from './util.js';

const MAX_POLICY_BYTES = 256 * 1024;

// ---------------------------------------------------------------------------
// policy
// ---------------------------------------------------------------------------

export async function showPolicy(I: Internals, caller: Caller): Promise<PolicyView> {
  const ctx = await I.context(caller);
  const rev = I.state.policyRevisions.latest()?.rev ?? null;
  const view: PolicyView = {
    contextId: ctx.id,
    owner: ctx.owner,
    kind: ctx.kind,
    profile: ctx.profile,
    allowedHosts: ctx.allowedHosts,
    policy: {
      contentHash: I.policy.contentHash,
      revision: rev,
      source: I.policy.source.kind,
      ...(I.policy.source.kind === 'file' ? { path: I.policy.source.path } : {}),
    },
  };
  if (ctx.kind === 'human') {
    if (I.policyProblem) view.policy.reloadError = { ...I.policyProblem };
    view.profiles = { ...I.policy.profiles };
    view.contexts = Object.fromEntries(
      Object.entries(I.policy.contexts).map(([k, v]) => [
        k,
        { profile: v.profile, ...(v.hosts ? { hosts: v.hosts } : {}) },
      ]),
    );
  }
  return view;
}

export function validatePolicyText(text: string): PolicyValidation {
  const contentHash = sha256Hex(typeof text === 'string' ? text : '');
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_POLICY_BYTES) {
    return {
      ok: false,
      contentHash,
      issues: [{ message: `policy must be text of at most ${MAX_POLICY_BYTES} bytes` }],
    };
  }
  try {
    parsePolicy(text, { kind: 'file', path: 'policy.yaml' });
    return { ok: true, contentHash, issues: [] };
  } catch (e) {
    if (isAboxError(e))
      return {
        ok: false,
        contentHash,
        issues: e.issues.length > 0 ? e.issues : [{ message: e.message }],
      };
    throw e;
  }
}

const UNKNOWN_TOOL_WINDOW_MS = 60_000;
const UNKNOWN_TOOL_BUDGET = 10;
const unknownToolBudgets = new WeakMap<
  Internals,
  Map<string, { start: number; used: number; suppressed: number }>
>();

/** Strips control, zero-width and bidi characters and cuts the text: attacker-controlled names go into the audit log. */
function cleanLabel(v: unknown, max: number): string {
  const t = typeof v === 'string' ? v : String(v);
  let clean = '';
  for (const ch of t) {
    const c = ch.codePointAt(0)!;
    const bad =
      c < 0x20 ||
      (c >= 0x7f && c <= 0x9f) ||
      (c >= 0x200b && c <= 0x200f) ||
      (c >= 0x202a && c <= 0x202e) ||
      (c >= 0x2066 && c <= 0x2069) ||
      c === 0xfeff;
    clean += bad ? '?' : ch;
  }
  return clean.length > max ? `${clean.slice(0, max)}...` : clean;
}

/**
 * MCP surfaces report a tool call for a tool that does not exist (an agent probing for `policy_set`,
 * `approve`, `ssh_exec`, ...). Recorded as `mcp.unknown_tool` with the tool name, the context and the
 * names (never the values) of the arguments. Rate limited per agent owner (same tool once a minute,
 * at most 10 entries a minute; the entry after a burst carries `suppressed`), so probing cannot flood the log.
 * Humans are ignored. Returns whether an entry was written.
 */
export async function auditUnknownTool(
  I: Internals,
  caller: Caller,
  tool: string,
  argNames: readonly string[] = [],
): Promise<boolean> {
  const ctx = await I.context(caller);
  if (ctx.kind === 'human') return false;
  const name = cleanLabel(tool, 64);
  const now = Date.now();
  let budgets = unknownToolBudgets.get(I);
  if (!budgets) unknownToolBudgets.set(I, (budgets = new Map()));
  if (budgets.size > 1000) budgets.clear();
  let b = budgets.get(ctx.owner);
  if (!b || now - b.start >= UNKNOWN_TOOL_WINDOW_MS) {
    b = { start: now, used: 0, suppressed: b?.suppressed ?? 0 };
    budgets.set(ctx.owner, b);
  }
  if (!I.firstWithin(`unknown-tool|${ctx.owner}|${name}`, UNKNOWN_TOOL_WINDOW_MS)) return false;
  if (b.used >= UNKNOWN_TOOL_BUDGET) {
    b.suppressed++;
    return false;
  }
  b.used++;
  const suppressed = b.suppressed;
  b.suppressed = 0;
  I.audit(ctx.owner, 'mcp.unknown_tool', {
    decision: 'deny',
    details: {
      tool: name,
      context: ctx.id,
      argNames: argNames.slice(0, 10).map((a) => cleanLabel(a, 40)),
      ...(suppressed > 0 ? { suppressed } : {}),
    },
  });
  return true;
}

export async function setPolicy(
  I: Internals,
  caller: Caller,
  text: string,
  o: { baseHash?: string } = {},
): Promise<SetPolicyResult> {
  const ctx = await I.context(caller);
  if (ctx.kind !== 'human') {
    I.audit(ctx.owner, 'policy_change_denied', {
      decision: 'deny',
      details: {
        attempt: 'setPolicy',
        proposedHash: typeof text === 'string' ? sha256Hex(text) : undefined,
        bytes: typeof text === 'string' ? Buffer.byteLength(text) : undefined,
      },
    });
    throw new AboxError('policy_denied', 'only a human can change the policy', {
      hint: 'The policy is edited by the human (`abox policy edit` / GUI). Request the rights you need with access_request instead.',
    });
  }
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_POLICY_BYTES) {
    throw new AboxError(
      'invalid_input',
      `policy must be text of at most ${MAX_POLICY_BYTES} bytes`,
    );
  }
  if (o.baseHash !== undefined) I.refreshPolicy(true); // the file as it is now, not as polled up to 0.5 s ago
  if (o.baseHash !== undefined && I.policy.contentHash !== o.baseHash) {
    throw new AboxError('conflict', 'policy.yaml changed while it was being edited', {
      hint: 'Reload the policy, redo your change on the current version, and save again.',
    });
  }
  const policy = parsePolicy(text, { kind: 'file', path: I.paths.policyFile });
  const tmp = join(I.paths.configDir, `.policy.${randomBytes(4).toString('hex')}.tmp`);
  await writeFile(tmp, text, { mode: 0o600 });
  await rename(tmp, I.paths.policyFile);
  const oldHash = I.policy.contentHash;
  I.adoptPolicy(policy, text);
  const rec = I.state.policyRevisions.record({
    contentHash: policy.contentHash,
    content: text,
    actor: ctx.owner,
  });
  I.audit(ctx.owner, 'policy.set', {
    decision: 'allow',
    details: {
      oldHash,
      newHash: policy.contentHash,
      revision: rec.rev,
      changed: rec.changed,
      bytes: Buffer.byteLength(text),
    },
  });
  I.emit('policy.changed', { data: { contentHash: policy.contentHash } });
  return { revision: rec.rev, changed: rec.changed, contentHash: policy.contentHash };
}

// ---------------------------------------------------------------------------
// audit
// ---------------------------------------------------------------------------

export async function queryAudit(
  I: Internals,
  caller: Caller,
  filter: AuditFilter = {},
): Promise<AuditEntry[]> {
  const ctx = await I.context(caller);
  const q: AuditQuery = {
    ...(filter.sandboxId ? { sandboxId: filter.sandboxId } : {}),
    ...(filter.actor ? { actor: filter.actor } : {}),
    ...(filter.action ? { action: filter.action } : {}),
    ...(filter.decision ? { decision: filter.decision } : {}),
    ...(filter.since !== undefined ? { since: filter.since } : {}),
    ...(filter.until !== undefined ? { until: filter.until } : {}),
    ...(filter.afterSeq !== undefined ? { afterSeq: filter.afterSeq } : {}),
    limit: Math.min(Math.max(1, Math.trunc(filter.limit ?? 100)), 5000),
    ...(filter.order ? { order: filter.order } : {}),
  };
  // Proxy egress decisions reach the audit log lazily; pull in what is new before looking.
  if (filter.sandboxId) {
    const target = I.state.sandboxes.get(filter.sandboxId);
    if (target && (ctx.kind === 'human' || target.owner === ctx.owner))
      await collectNetworkEvents(I, target, { throttleMs: 1000 });
  } else {
    await collectAllNetworkEvents(I, ctx.kind === 'human' ? undefined : ctx.owner, 5000);
  }
  if (ctx.kind === 'human') return I.state.audit.query(q);

  // Agents: their own actions, plus everything that happened to their own sandboxes.
  const owned = I.state.sandboxes.list({ owner: ctx.owner, includeRemoved: true }).map((r) => r.id);
  if (filter.sandboxId) return owned.includes(filter.sandboxId) ? I.state.audit.query(q) : [];
  const parts: AuditEntry[][] = [];
  if (!filter.actor || filter.actor === ctx.owner)
    parts.push(I.state.audit.query({ ...q, actor: ctx.owner }));
  for (const sid of owned.slice(-200)) parts.push(I.state.audit.query({ ...q, sandboxId: sid }));
  const bySeq = new Map<number, AuditEntry>();
  for (const e of parts.flat()) bySeq.set(e.seq, e);
  const merged = [...bySeq.values()].sort((a, b) =>
    filter.order === 'asc' ? a.seq - b.seq : b.seq - a.seq,
  );
  return merged.slice(0, q.limit);
}

export async function verifyAudit(I: Internals, caller: Caller): Promise<ChainVerification> {
  const ctx = await I.context(caller);
  I.requireHuman(ctx, 'audit.verify');
  return I.state.audit.verifyChain();
}

export async function exportAudit(
  I: Internals,
  caller: Caller,
  filter: AuditFilter,
  writable: { write(chunk: string): unknown },
): Promise<number> {
  const ctx = await I.context(caller);
  I.requireHuman(ctx, 'audit.export');
  const { order: _o, limit, ...rest } = filter;
  const n = I.state.audit.exportJsonl(writable, { ...rest, ...(limit ? { limit } : {}) });
  I.audit(ctx.owner, 'audit.export', { decision: 'allow', details: { entries: n } });
  return n;
}

// ---------------------------------------------------------------------------
// tokens
// ---------------------------------------------------------------------------

export async function createAgentToken(
  I: Internals,
  caller: Caller,
  contextId: string,
  label: string,
): Promise<AgentTokenView & { token: string }> {
  const ctx = await I.context(caller);
  I.requireHuman(ctx, 'token.create');
  I.requirePolicyValid(ctx, 'token.create', 'creating agent tokens');
  if (
    typeof contextId !== 'string' ||
    contextId === 'human' ||
    !Object.hasOwn(I.policy.contexts, contextId)
  ) {
    throw new AboxError(
      'invalid_input',
      `context '${String(contextId).slice(0, 64)}' is not an agent context of the policy`,
      {
        hint: 'Define the agent context in policy.yaml (contexts:) first. The human context never gets a token.',
      },
    );
  }
  if (typeof label !== 'string' || label.length === 0 || label.length > 100)
    throw new AboxError('invalid_input', 'a label (max 100 characters) is required');
  const t = I.state.agentTokens.create(contextId, label);
  I.audit(ctx.owner, 'token.create', {
    decision: 'allow',
    details: { contextId, label, handle: t.id },
  });
  return t;
}

/** Entry point of the HTTP transport: maps a bearer token to its context id (still defined in the policy). */
export function verifyAgentToken(I: Internals, token: string): string | undefined {
  I.refreshPolicy();
  const contextId = I.state.agentTokens.verify(token);
  if (!contextId || contextId === 'human' || !Object.hasOwn(I.policy.contexts, contextId))
    return undefined;
  return contextId;
}

export async function revokeAgentToken(I: Internals, caller: Caller, id: string): Promise<boolean> {
  const ctx = await I.context(caller);
  I.requireHuman(ctx, 'token.revoke');
  const ok = I.state.agentTokens.revoke(String(id));
  I.audit(ctx.owner, 'token.revoke', {
    decision: ok ? 'allow' : 'info',
    details: { handle: String(id).slice(0, 64), revoked: ok },
  });
  return ok;
}

export async function listAgentTokens(I: Internals, caller: Caller): Promise<AgentTokenView[]> {
  const ctx = await I.context(caller);
  I.requireHuman(ctx, 'token.list');
  return I.state.agentTokens.list();
}

// ---------------------------------------------------------------------------
// reconcile
// ---------------------------------------------------------------------------

const LIVE = ['created', 'running', 'stopped', 'expired'] as const;

function entry(
  r: { id: SandboxId; host: string },
  backend: BackendKind,
  detail: string,
): ReconcileEntry {
  return { id: r.id, host: r.host, backend, detail };
}

/** Every (host, backend) pair worth asking: the ones with registry rows and the local host's backends. */
async function backendGroups(
  I: Internals,
  recs: Array<{ host: string; backend: BackendKind }>,
): Promise<Array<{ host: string; backend: BackendKind }>> {
  const groups = new Map<string, { host: string; backend: BackendKind }>();
  for (const r of recs) groups.set(`${r.host}|${r.backend}`, { host: r.host, backend: r.backend });
  try {
    const local = await I.resolveHost('local');
    for (const b of local.backends)
      if (I.providerFactories[b]) groups.set(`local|${b}`, { host: 'local', backend: b });
  } catch {
    /* no local host */
  }
  return [...groups.values()];
}

export async function reconcileInternal(
  I: Internals,
  o: ReconcileOptions,
  actor: string,
): Promise<ReconcileReport> {
  const report: ReconcileReport = {
    orphans: [],
    ghosts: [],
    interrupted: [],
    expired: [],
    unreachable: [],
    pendingApprovals: 0,
    applied: { removed: [], markedFailed: [], markedStale: [], orphansRemoved: [] },
  };
  const recs = I.state.sandboxes.list();
  const groups = await backendGroups(I, recs);

  for (const g of groups) {
    let infos: SandboxInfo[];
    let provider;
    try {
      const host = await I.resolveHost(g.host);
      provider = I.providerFor(host, g.backend);
      infos = await provider.list();
    } catch (e) {
      report.unreachable.push({ host: g.host, backend: g.backend, error: errMessage(e) });
      continue;
    }
    const byId = new Map(infos.map((i) => [i.id, i]));
    const mine = recs.filter((r) => r.host === g.host && r.backend === g.backend);

    for (const r of mine) {
      const info = byId.get(r.id);
      if (r.state === 'preparing') {
        if (I.isInterrupted(r)) {
          report.interrupted.push(
            entry(
              r,
              g.backend,
              info
                ? 'create was interrupted; the backend sandbox exists but was never registered as usable'
                : 'create was interrupted before the backend sandbox existed (workspace leftovers possible)',
            ),
          );
          if (o.apply) {
            try {
              if (
                I.state.sandboxes.transition(r.id, ['preparing'], 'failed', {
                  error: 'create interrupted: the creating process is gone',
                })
              ) {
                I.state.sandboxes.releaseRequestId(r.id);
                const fresh = I.state.sandboxes.get(r.id)!;
                await destroySandbox(I, fresh, actor, 'sandbox.reconcile_interrupted', {
                  markRemoved: false,
                });
                report.applied.markedFailed.push(r.id);
              }
            } catch (e) {
              I.audit(actor, 'sandbox.reconcile_interrupted', {
                sandboxId: r.id,
                decision: 'error',
                details: { message: errMessage(e) },
              });
            }
          }
        }
        continue;
      }
      if (!(LIVE as readonly string[]).includes(r.state)) continue;
      if (info) {
        I.state.sandboxes.markSeen(r.id);
        if (r.expiresAt <= I.now())
          report.expired.push(
            entry(r, g.backend, `expired ${new Date(r.expiresAt).toISOString()}`),
          );
        continue;
      }
      report.ghosts.push(entry(r, g.backend, 'in the registry but not in the backend'));
      if (!r.stale) {
        I.state.sandboxes.markStale(r.id);
        report.applied.markedStale.push(r.id);
      }
      if (o.apply) {
        try {
          await destroySandbox(I, I.state.sandboxes.get(r.id)!, actor, 'sandbox.reconcile_ghost');
          report.applied.removed.push(r.id);
        } catch (e) {
          I.audit(actor, 'sandbox.reconcile_ghost', {
            sandboxId: r.id,
            decision: 'error',
            details: { message: errMessage(e) },
          });
        }
      }
    }

    for (const info of infos) {
      const known = I.state.sandboxes.get(info.id);
      if (known && known.state !== 'removed' && known.state !== 'failed') continue;
      // 'preparing' rows were handled above; failed/removed rows with a live backend sandbox are leftovers
      report.orphans.push({
        id: info.id,
        host: g.host,
        backend: g.backend,
        detail: known
          ? `registry says ${known.state}, backend still has it`
          : 'in the backend but not in the registry',
      });
      if (o.apply && o.removeOrphans) {
        try {
          await provider.remove(info.id);
          report.applied.orphansRemoved.push(info.id);
          I.audit(actor, 'sandbox.reconcile_orphan', {
            sandboxId: info.id,
            decision: 'allow',
            details: { backend: g.backend },
          });
        } catch (e) {
          I.audit(actor, 'sandbox.reconcile_orphan', {
            sandboxId: info.id,
            decision: 'error',
            details: { message: errMessage(e) },
          });
        }
      }
    }
  }
  report.pendingApprovals = I.state.approvals.list({ status: 'pending' }).length;
  return report;
}

export async function reconcile(
  I: Internals,
  caller: Caller,
  o: ReconcileOptions = {},
): Promise<ReconcileReport> {
  const ctx = await I.context(caller);
  I.requireHuman(ctx, 'reconcile');
  const report = await reconcileInternal(I, o, ctx.owner);
  I.audit(ctx.owner, 'reconcile', {
    decision: 'info',
    details: {
      apply: o.apply === true,
      orphans: report.orphans.length,
      ghosts: report.ghosts.length,
      interrupted: report.interrupted.length,
      expired: report.expired.length,
      applied: report.applied,
    },
  });
  return report;
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

function modeString(mode: number): string {
  return (mode & 0o777).toString(8).padStart(3, '0');
}

export async function doctor(I: Internals, caller: Caller): Promise<DoctorReport> {
  const ctx = await I.context(caller);
  I.requireHuman(ctx, 'doctor');
  const checks: DoctorCheck[] = [];
  const backends: BackendReport[] = [];
  const add = (c: Omit<DoctorCheck, 'level'>): void =>
    void checks.push({ ...c, level: legacyLevel(c.severity) });

  // Backends nobody needs (no template of the user's and no sandbox uses them) are only an `info` when
  // they are not installed or not running: a missing Podman must not worry a Docker user (and a missing
  // Docker not a Podman user). Exception: with no container engine at all the Docker check is an error,
  // because most builtin templates need one.
  const needed = new Set<BackendKind>();
  try {
    const { templates } = await catalogFor(I, I.projectDir).listAll();
    // builtin templates exist for every backend; only the user's own templates say what is needed
    for (const t of templates) if (t.source.kind !== 'builtin') needed.add(t.backend);
  } catch {
    /* an unreadable template directory is reported by the template commands */
  }
  for (const r of I.state.sandboxes.list()) needed.add(r.backend);
  const unusableCheck = (
    hostId: string,
    kind: BackendKind,
    details: string[],
  ): Omit<DoctorCheck, 'level'> => {
    const base = {
      id: `backend.${hostId}.${kind}`,
      ...(details.length > 0 ? { detail: details.join('; '), details } : {}),
    };
    return needed.has(kind)
      ? {
          ...base,
          severity: 'error',
          title: `backend ${kind} on ${hostId}: not usable`,
        }
      : {
          ...base,
          severity: 'info',
          title: `backend ${kind} on ${hostId}: not installed or not running (optional)`,
          hint: startHint(kind),
        };
  };

  // backends
  // The python backend repeats the notes of the engine and of the process backend it is built on:
  // an advisory is shown once per host, with the first backend that reports it.
  const notesShown = new Map<string, Set<string>>();
  const hostIds = new Set<string>(['local']);
  for (const r of I.state.sandboxes.list()) hostIds.add(r.host);
  for (const hostId of hostIds) {
    let host;
    try {
      host = await I.resolveHost(hostId);
    } catch (e) {
      backends.push({
        host: hostId,
        backend: 'docker',
        available: false,
        error: `host unreachable: ${errMessage(e)}`,
      });
      add({
        id: `host.${hostId}`,
        severity: 'error',
        title: `host ${hostId} cannot be reached`,
        detail: errMessage(e),
      });
      continue;
    }
    for (const kind of Object.keys(I.providerFactories) as BackendKind[]) {
      if (!host.backends.includes(kind)) continue;
      try {
        const p = I.providerFor(host, kind);
        const status = await p.status();
        backends.push({
          host: hostId,
          backend: kind,
          available: status.ok,
          status,
          capabilities: p.capabilities(),
        });
        if (status.ok) {
          const classified = classifyWorkingBackend(status);
          const shown = notesShown.get(hostId) ?? new Set<string>();
          notesShown.set(hostId, shown);
          // only advisories are folded; a warning is always shown with the check that is a warning
          const notes = classified.notes.filter(
            (n) => n.severity === 'warning' || !shown.has(n.message),
          );
          for (const n of notes) shown.add(n.message);
          const { severity } = classified;
          add({
            id: `backend.${hostId}.${kind}`,
            severity,
            title: `backend ${kind} on ${hostId}: ok`,
            detail: [...status.details, ...status.warnings].join('; '),
            details: status.details,
            ...(notes.length > 0 ? { notes } : {}),
          });
        } else {
          add(unusableCheck(hostId, kind, [...status.details, ...status.warnings]));
        }
      } catch (e) {
        backends.push({ host: hostId, backend: kind, available: false, error: errMessage(e) });
        add(unusableCheck(hostId, kind, [errMessage(e)]));
      }
    }
  }
  const engineUsable = backends.some(
    (b) => (b.backend === 'docker' || b.backend === 'podman') && b.available,
  );
  if (!engineUsable) {
    for (const c of checks) {
      if (c.severity === 'info' && c.id.startsWith('backend.') && c.id.endsWith('.docker')) {
        c.severity = 'error';
        c.level = 'error';
        c.title = c.title.replace(/: not installed or not running \(optional\)$/, ': not usable');
        c.hint =
          'Install and start Docker or Podman (the builtin templates need a container engine).';
      }
    }
  }
  if (!backends.some((b) => b.available))
    add({
      id: 'backend.none',
      severity: 'error',
      title: 'no usable backend',
      hint: 'Install and start Docker/Podman, or use the process backend.',
    });

  // state db
  let stateOk = true;
  let stateMessage: string | undefined;
  try {
    const row = I.state.db.prepare('PRAGMA integrity_check').get() as
      { integrity_check?: string } | undefined;
    if (row?.integrity_check !== 'ok') {
      stateOk = false;
      stateMessage = String(row?.integrity_check);
    }
  } catch (e) {
    stateOk = false;
    stateMessage = errMessage(e);
  }
  add({
    id: 'state',
    severity: stateOk ? 'ok' : 'error',
    title: stateOk ? 'state database ok' : 'state database problem',
    ...(stateMessage ? { detail: stateMessage } : {}),
  });
  try {
    const m = statSync(I.paths.stateDb).mode;
    if ((m & 0o077) !== 0)
      add({
        id: 'state.perms',
        severity: 'warning',
        title: `state database is accessible by others (mode ${modeString(m)})`,
        hint: `chmod 600 ${I.paths.stateDb}`,
      });
  } catch {
    /* in-memory or missing */
  }

  // policy file
  if (I.policyProblem) {
    const p = I.policyProblem;
    add({
      id: 'policy.invalid',
      severity: 'error',
      title:
        'policy.yaml is invalid: creating sandboxes, granting access, approving and every agent are refused',
      detail: [
        p.message,
        ...p.issues
          .slice(0, 10)
          .map(
            (i) => `${i.line ? `line ${i.line}: ` : ''}${i.path ? `${i.path}: ` : ''}${i.message}`,
          ),
      ].join('\n'),
      hint: `\`abox policy validate\` shows all problems, \`abox policy edit\` repairs the file. Until then ${p.fallback === 'last_valid' ? 'the last valid policy is only used to look at things and clean up' : 'no valid policy was ever recorded, only the human context exists'}.`,
    });
  }
  let fileMode: string | undefined;
  if (I.policy.source.kind === 'file') {
    try {
      const st = statSync(I.policy.source.path);
      fileMode = modeString(st.mode);
      const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
      if ((st.mode & 0o022) !== 0) {
        add({
          id: 'policy.perms',
          severity: 'warning',
          title: `policy.yaml is writable by others (mode ${fileMode})`,
          hint: `chmod 600 ${I.policy.source.path}`,
          detail: 'Anyone who can write this file can widen agent rights.',
        });
      } else if (uid !== undefined && st.uid !== uid) {
        add({
          id: 'policy.owner',
          severity: 'warning',
          title: 'policy.yaml is owned by another user',
          detail: `uid ${st.uid}`,
        });
      } else
        add({
          id: 'policy.perms',
          severity: 'ok',
          title: `policy.yaml present (mode ${fileMode})`,
        });
    } catch (e) {
      add({
        id: 'policy.perms',
        severity: 'warning',
        title: 'policy.yaml cannot be inspected',
        detail: errMessage(e),
      });
    }
    try {
      const dm = statSync(I.paths.configDir).mode;
      if ((dm & 0o022) !== 0)
        add({
          id: 'policy.dir',
          severity: 'warning',
          title: `config directory is writable by others (mode ${modeString(dm)})`,
          hint: `chmod 700 ${I.paths.configDir}`,
        });
    } catch {
      /* ignore */
    }
  } else {
    add({
      id: 'policy.default',
      severity: 'info',
      title: 'no policy.yaml: the built-in default policy is active',
      hint: `Create ${I.paths.policyFile} (for example with "abox policy edit") to define agent rights.`,
    });
  }

  // audit chain
  const audit = I.state.audit.verifyChain();
  add({
    id: 'audit',
    severity: audit.ok ? 'ok' : 'error',
    title: audit.ok
      ? `audit chain intact (${audit.checked} entries)`
      : `audit chain broken at entry ${audit.brokenAt}`,
    ...(audit.reason ? { detail: audit.reason } : {}),
  });

  // reconcile (report only)
  const rec = await reconcileInternal(I, {}, 'system');
  if (rec.orphans.length > 0)
    add({
      id: 'reconcile.orphans',
      severity: 'warning',
      title: `${rec.orphans.length} orphaned backend sandbox(es)`,
      detail: rec.orphans.map((e) => e.id).join(', '),
      hint: '`abox reconcile --apply --remove-orphans` removes them (after you checked).',
    });
  if (rec.ghosts.length > 0)
    add({
      id: 'reconcile.ghosts',
      severity: 'warning',
      title: `${rec.ghosts.length} registered sandbox(es) missing in the backend`,
      detail: rec.ghosts.map((e) => e.id).join(', '),
      hint: '`abox reconcile --apply` marks them removed.',
    });
  if (rec.interrupted.length > 0)
    add({
      id: 'reconcile.interrupted',
      severity: 'warning',
      title: `${rec.interrupted.length} interrupted create(s)`,
      detail: rec.interrupted.map((e) => e.id).join(', '),
      hint: '`abox reconcile --apply` cleans up their leftovers.',
    });
  if (rec.expired.length > 0)
    add({
      id: 'reconcile.expired',
      severity: 'warning',
      title: `${rec.expired.length} expired sandbox(es) not removed yet`,
      detail: rec.expired.map((e) => e.id).join(', '),
      hint: '`abox gc` removes them.',
    });
  // A backend that is already reported as unavailable and optional (nothing of yours uses it) is not
  // reported a second time as "could not list": that is the same fact. If something uses it, the list
  // failure stays a warning because the registry could not be compared with the backend.
  const alreadyReported = (u: { host: string; backend: BackendKind }): boolean =>
    !needed.has(u.backend) &&
    backends.some((b) => b.host === u.host && b.backend === u.backend && !b.available);
  const unreachable = rec.unreachable.filter((u) => !alreadyReported(u));
  for (const u of unreachable)
    add({
      id: `reconcile.unreachable.${u.host}.${u.backend}`,
      severity: 'warning',
      title: `could not list ${u.backend} on ${u.host}`,
      detail: u.error,
    });
  if (rec.pendingApprovals > 0)
    add({
      id: 'approvals.pending',
      severity: 'warning',
      title: `${rec.pendingApprovals} pending approval(s)`,
      hint: '`abox approvals ls`',
    });
  if (
    rec.orphans.length +
      rec.ghosts.length +
      rec.interrupted.length +
      rec.expired.length +
      unreachable.length +
      rec.pendingApprovals ===
    0
  ) {
    add({
      id: 'reconcile',
      severity: 'ok',
      title:
        unreachable.length < rec.unreachable.length
          ? 'registry and available backends agree'
          : 'registry and backends agree',
    });
  }

  return {
    ok: !checks.some((c) => c.severity === 'error'),
    summary: summarizeChecks(checks),
    checks,
    backends,
    state: {
      path: I.paths.stateDb,
      ok: stateOk,
      ...(stateMessage ? { message: stateMessage } : {}),
    },
    policy: {
      source: I.policy.source.kind,
      ...(I.policy.source.kind === 'file' ? { path: I.policy.source.path } : {}),
      contentHash: I.policy.contentHash,
      revision: I.state.policyRevisions.latest()?.rev ?? null,
      ...(fileMode ? { fileMode } : {}),
    },
    audit,
    reconcile: rec,
  };
}

// ---------------------------------------------------------------------------
// gc
// ---------------------------------------------------------------------------

export async function gc(I: Internals, caller: Caller, o: GcOptions = {}): Promise<GcReport> {
  const ctx = await I.context(caller);
  I.requireHuman(ctx, 'gc');
  const dryRun = o.dryRun === true;
  const report: GcReport = {
    dryRun,
    sandboxes: [],
    workspaces: [],
    images: [],
    logs: { files: 0, bytes: 0 },
    approvalsExpired: 0,
    errors: [],
  };
  const now = I.now();

  // 1. expired sandboxes
  for (const r of I.state.sandboxes.list({ state: ['created', 'running', 'stopped', 'expired'] })) {
    if (r.state !== 'expired' && r.expiresAt > now) continue;
    report.sandboxes.push(r.id);
    if (dryRun) continue;
    try {
      await destroySandbox(I, I.state.sandboxes.get(r.id) ?? r, ctx.owner, 'sandbox.gc');
    } catch (e) {
      report.errors.push(`${r.id}: ${errMessage(e)}`);
    }
  }

  // 2. stale workspace directories (no live registry row refers to them)
  const active = new Set(
    I.state.sandboxes
      .list({ state: ['preparing', 'created', 'running', 'stopped', 'expired'] })
      .map((r) => r.id.slice(r.id.indexOf('/') + 1)),
  );
  const root = join(I.paths.dataDir, 'sandboxes');
  let names: string[] = [];
  try {
    names = await readdir(root);
  } catch {
    /* none yet */
  }
  for (const n of names) {
    if (!/^[0-9a-f]{8}$/.test(n) || active.has(n)) continue;
    const dir = join(root, n);
    try {
      if (!(await stat(dir)).isDirectory()) continue;
      report.workspaces.push(dir);
      if (dryRun) continue;
      const failed = I.state.sandboxes
        .list({ state: ['failed', 'removed'], includeRemoved: true })
        .find((r) => r.id.endsWith(`/${n}`));
      const ws = failed?.workspace as WorkspaceRecord | null | undefined;
      if (ws && ws.version === 1) await cleanupWorkspace(ws).catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
      I.audit(ctx.owner, 'workspace.gc', { decision: 'allow', details: { dir } });
    } catch (e) {
      report.errors.push(`${dir}: ${errMessage(e)}`);
    }
  }

  // 3. images no template or sandbox refers to
  if (!dryRun) {
    try {
      report.images = (await gcImagesInternal(I, ctx.owner)).removed;
    } catch (e) {
      report.errors.push(`images: ${errMessage(e)}`);
    }
  }

  // 4. logs past retention, 5. approvals
  report.logs = await rotateLogs(I, dryRun);
  if (!dryRun) report.approvalsExpired = (await expireApprovalsOp(I, caller)).length;
  I.audit(ctx.owner, 'gc', {
    decision: 'info',
    details: {
      dryRun,
      sandboxes: report.sandboxes.length,
      workspaces: report.workspaces.length,
      images: report.images.flatMap((i) => i.refs).length,
      logFiles: report.logs.files,
      errors: report.errors.length,
    },
  });
  return report;
}

// ---------------------------------------------------------------------------
// gc --orphans
// ---------------------------------------------------------------------------

const ORPHAN_KIND_ORDER = ['container', 'network', 'volume'] as const;

/** Resources created or started less than this long ago count as in use. */
const ORPHAN_ACTIVE_WINDOW_MS = 3_600_000;

function ageText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h${String(m % 60).padStart(2, '0')}m` : `${Math.floor(h / 24)}d`;
}

const newestOf = (r: ForeignResource): number | undefined => {
  const t = Math.max(r.createdAt ?? 0, r.startedAt ?? 0);
  return t > 0 ? t : undefined;
};
const isRunning = (r: ForeignResource): boolean =>
  r.state === 'running' || r.state === 'restarting';

/**
 * Finds (and with `remove` deletes) backend objects that carry abox labels but whose `abox.instance`
 * is not this installation's. Instances are separated on purpose: these may belong to another abox
 * home on the same machine that is alive, so nothing is removed unless the caller asks for it, and
 * objects without abox labels are never listed. Needed when a data directory was deleted: its
 * instance id is gone and no manager sees its containers any more.
 *
 * Resources of an instance that has a running container or anything created or started within the
 * last hour are listed but not selected for removal (`skip`), because that is what another live
 * abox home looks like; only `includeActive` or naming the instance selects them. Resources
 * without an instance label are judged one by one.
 */
export async function gcOrphans(
  I: Internals,
  caller: Caller,
  o: GcOrphansOptions = {},
): Promise<GcOrphansReport> {
  const ctx = await I.context(caller);
  I.requireHuman(ctx, 'gc.orphans');
  const remove = o.remove === true;
  const now = I.now();
  const report: GcOrphansReport = {
    dryRun: !remove,
    now,
    resources: [],
    instances: [],
    removed: [],
    skipped: [],
    errors: [],
  };
  const seen = new Set<string>();
  const providers = new Map<OrphanResource, SandboxProvider>();
  for (const g of await backendGroups(I, I.state.sandboxes.list())) {
    let provider: SandboxProvider;
    try {
      provider = I.providerFor(await I.resolveHost(g.host), g.backend);
    } catch (e) {
      report.skipped.push({ host: g.host, backend: g.backend, reason: errMessage(e) });
      continue;
    }
    if (!provider.listForeign || !provider.removeForeign) {
      report.skipped.push({ host: g.host, backend: g.backend, reason: 'not supported' });
      continue;
    }
    let found;
    try {
      found = await provider.listForeign();
    } catch (e) {
      report.skipped.push({ host: g.host, backend: g.backend, reason: errMessage(e) });
      continue;
    }
    for (const f of found) {
      if (o.instance !== undefined && f.instance !== o.instance) continue;
      // One engine can be reached through several backends (docker and python): list it once.
      const key = `${g.host}|${f.engine}|${f.kind}|${f.ref}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const r: OrphanResource = { ...f, host: g.host, backend: g.backend };
      report.resources.push(r);
      providers.set(r, provider);
    }
  }
  const order = (r: OrphanResource): number => ORPHAN_KIND_ORDER.indexOf(r.kind);
  report.resources.sort(
    (a, b) =>
      order(a) - order(b) || (a.createdAt ?? 0) - (b.createdAt ?? 0) || (a.name < b.name ? -1 : 1),
  );

  // Per instance: how much of it runs, how new it is, and whether it is selected.
  const explicit = o.includeActive === true || o.instance !== undefined;
  const activity = (list: OrphanResource[]): { running: number; newestAt?: number } => {
    const times = list.map(newestOf).filter((t): t is number => t !== undefined);
    return {
      running: list.filter(isRunning).length,
      ...(times.length ? { newestAt: Math.max(...times) } : {}),
    };
  };
  const looksActive = (a: { running: number; newestAt?: number }): boolean =>
    a.running > 0 || (a.newestAt !== undefined && now - a.newestAt < ORPHAN_ACTIVE_WINDOW_MS);
  const describe = (a: { running: number; newestAt?: number }): string =>
    `${a.running} running${a.newestAt === undefined ? '' : `, newest ${ageText(now - a.newestAt)} ago`}`;
  const byInstance = new Map<string, OrphanResource[]>();
  for (const r of report.resources) {
    const list = byInstance.get(r.instance) ?? [];
    list.push(r);
    byInstance.set(r.instance, list);
  }
  for (const [instance, list] of byInstance) {
    const whole = activity(list);
    let skipReason: string | undefined;
    for (const r of list) {
      // Without an instance label nothing ties the resources together: each counts by its own state.
      const a = instance === '' ? activity([r]) : whole;
      if (explicit || !looksActive(a)) continue;
      r.skip =
        instance === ''
          ? `${r.kind} ${r.name} looks active (${describe(a)}) - probably another abox home in use`
          : `instance ${instance} looks active (${describe(a)}) - probably another abox home in use`;
      skipReason ??= r.skip;
    }
    const skippedCount = list.filter((r) => r.skip !== undefined).length;
    report.instances.push({
      instance,
      resources: list.length,
      running: whole.running,
      ...(whole.newestAt !== undefined ? { newestAt: whole.newestAt } : {}),
      active: looksActive(whole),
      selected: list.length - skippedCount,
      ...(skipReason !== undefined ? { skipReason } : {}),
    });
  }
  // Stale instances first, then the oldest: the order of the confirmation prompt.
  report.instances.sort(
    (a, b) =>
      Number(a.active) - Number(b.active) ||
      (a.newestAt ?? 0) - (b.newestAt ?? 0) ||
      (a.instance < b.instance ? -1 : 1),
  );

  if (remove) {
    for (const r of report.resources) {
      if (r.skip !== undefined) continue;
      const details = {
        kind: r.kind,
        name: r.name,
        ref: r.ref,
        instance: r.instance,
        aboxName: r.aboxName ?? null,
        sandboxId: r.sandboxId ?? null,
        host: r.host,
        backend: r.backend,
      };
      try {
        await providers.get(r)!.removeForeign!(r);
        report.removed.push(r);
        I.audit(ctx.owner, 'resource.gc_orphan', { decision: 'allow', details });
      } catch (e) {
        report.errors.push(`${r.kind} ${r.name}: ${errMessage(e)}`);
        I.audit(ctx.owner, 'resource.gc_orphan', {
          decision: 'error',
          details: { ...details, message: errMessage(e) },
        });
      }
    }
  }
  I.audit(ctx.owner, 'gc.orphans', {
    decision: 'info',
    details: {
      remove,
      instance: o.instance ?? null,
      includeActive: o.includeActive === true,
      found: report.resources.length,
      activeSkipped: report.resources.filter((r) => r.skip !== undefined).length,
      removed: report.removed.length,
      skipped: report.skipped.length,
      errors: report.errors.length,
    },
  });
  return report;
}

export type { SandboxRecord };
