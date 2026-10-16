import { randomBytes } from 'node:crypto';
import { readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { AboxError, isAboxError } from '../errors.js';
import type { AuditEntry, AuditQuery } from '../state/audit-log.js';
import type { SandboxRecord } from '../state/sandbox-registry.js';
import { sha256Hex } from '../state/canonical.js';
import { parsePolicy } from '../policy/index.js';
import type { BackendKind, SandboxId, SandboxInfo } from '../types.js';
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
  GcReport,
  PolicyValidation,
  PolicyView,
  ReconcileEntry,
  ReconcileOptions,
  ReconcileReport,
  SetPolicyResult,
} from './types.js';
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

export async function setPolicy(
  I: Internals,
  caller: Caller,
  text: string,
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
  const groups = new Map<string, { host: string; backend: BackendKind }>();
  for (const r of recs) groups.set(`${r.host}|${r.backend}`, { host: r.host, backend: r.backend });
  try {
    const local = await I.resolveHost('local');
    for (const b of local.backends)
      if (I.providerFactories[b]) groups.set(`local|${b}`, { host: 'local', backend: b });
  } catch {
    /* no local host */
  }

  for (const g of groups.values()) {
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
  const add = (c: DoctorCheck): void => void checks.push(c);

  // Backends nobody needs (not the configured default, no template and no sandbox uses them) only
  // warn when they are unusable: a missing Podman must not make `abox doctor` fail for a Docker user.
  const needed = new Set<BackendKind>([I.config.backends.default]);
  try {
    const { templates } = await catalogFor(I, I.projectDir).listAll();
    // builtin templates exist for every backend; only the user's own templates say what is needed
    for (const t of templates) if (t.source.kind !== 'builtin') needed.add(t.backend);
  } catch {
    /* an unreadable template directory is reported by the template commands */
  }
  for (const r of I.state.sandboxes.list()) needed.add(r.backend);
  const unusableLevel = (kind: BackendKind): 'warn' | 'error' =>
    needed.has(kind) ? 'error' : 'warn';
  const optionalNote = (kind: BackendKind): string =>
    needed.has(kind)
      ? ''
      : ' (optional: it is not the default backend and no template of yours or sandbox uses it)';

  // backends
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
        level: 'error',
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
        add({
          id: `backend.${hostId}.${kind}`,
          level: status.ok ? (status.warnings.length > 0 ? 'warn' : 'ok') : unusableLevel(kind),
          title: `backend ${kind} on ${hostId}: ${status.ok ? 'ok' : `not usable${optionalNote(kind)}`}`,
          detail: [...status.details, ...status.warnings].join('; '),
        });
      } catch (e) {
        backends.push({ host: hostId, backend: kind, available: false, error: errMessage(e) });
        add({
          id: `backend.${hostId}.${kind}`,
          level: unusableLevel(kind),
          title: `backend ${kind} on ${hostId} failed${optionalNote(kind)}`,
          detail: errMessage(e),
        });
      }
    }
  }
  if (!backends.some((b) => b.available))
    add({
      id: 'backend.none',
      level: 'error',
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
    level: stateOk ? 'ok' : 'error',
    title: stateOk ? 'state database ok' : 'state database problem',
    ...(stateMessage ? { detail: stateMessage } : {}),
  });
  try {
    const m = statSync(I.paths.stateDb).mode;
    if ((m & 0o077) !== 0)
      add({
        id: 'state.perms',
        level: 'warn',
        title: `state database is accessible by others (mode ${modeString(m)})`,
        hint: `chmod 600 ${I.paths.stateDb}`,
      });
  } catch {
    /* in-memory or missing */
  }

  // policy file
  let fileMode: string | undefined;
  if (I.policy.source.kind === 'file') {
    try {
      const st = statSync(I.policy.source.path);
      fileMode = modeString(st.mode);
      const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
      if ((st.mode & 0o022) !== 0) {
        add({
          id: 'policy.perms',
          level: 'warn',
          title: `policy.yaml is writable by others (mode ${fileMode})`,
          hint: `chmod 600 ${I.policy.source.path}`,
          detail: 'Anyone who can write this file can widen agent rights.',
        });
      } else if (uid !== undefined && st.uid !== uid) {
        add({
          id: 'policy.owner',
          level: 'warn',
          title: 'policy.yaml is owned by another user',
          detail: `uid ${st.uid}`,
        });
      } else
        add({ id: 'policy.perms', level: 'ok', title: `policy.yaml present (mode ${fileMode})` });
    } catch (e) {
      add({
        id: 'policy.perms',
        level: 'warn',
        title: 'policy.yaml cannot be inspected',
        detail: errMessage(e),
      });
    }
    try {
      const dm = statSync(I.paths.configDir).mode;
      if ((dm & 0o022) !== 0)
        add({
          id: 'policy.dir',
          level: 'warn',
          title: `config directory is writable by others (mode ${modeString(dm)})`,
          hint: `chmod 700 ${I.paths.configDir}`,
        });
    } catch {
      /* ignore */
    }
  } else {
    add({
      id: 'policy.default',
      level: 'ok',
      title: 'no policy.yaml: the built-in default policy is active',
      hint: 'Create ~/.config/abox/policy.yaml to define agent rights.',
    });
  }

  // audit chain
  const audit = I.state.audit.verifyChain();
  add({
    id: 'audit',
    level: audit.ok ? 'ok' : 'error',
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
      level: 'warn',
      title: `${rec.orphans.length} orphaned backend sandbox(es)`,
      detail: rec.orphans.map((e) => e.id).join(', '),
      hint: '`abox reconcile --apply --remove-orphans` removes them (after you checked).',
    });
  if (rec.ghosts.length > 0)
    add({
      id: 'reconcile.ghosts',
      level: 'warn',
      title: `${rec.ghosts.length} registered sandbox(es) missing in the backend`,
      detail: rec.ghosts.map((e) => e.id).join(', '),
      hint: '`abox reconcile --apply` marks them removed.',
    });
  if (rec.interrupted.length > 0)
    add({
      id: 'reconcile.interrupted',
      level: 'warn',
      title: `${rec.interrupted.length} interrupted create(s)`,
      detail: rec.interrupted.map((e) => e.id).join(', '),
      hint: '`abox reconcile --apply` cleans up their leftovers.',
    });
  if (rec.expired.length > 0)
    add({
      id: 'reconcile.expired',
      level: 'warn',
      title: `${rec.expired.length} expired sandbox(es) not removed yet`,
      detail: rec.expired.map((e) => e.id).join(', '),
      hint: '`abox gc` removes them.',
    });
  for (const u of rec.unreachable)
    add({
      id: `reconcile.unreachable.${u.host}.${u.backend}`,
      level: 'warn',
      title: `could not list ${u.backend} on ${u.host}`,
      detail: u.error,
    });
  if (rec.pendingApprovals > 0)
    add({
      id: 'approvals.pending',
      level: 'warn',
      title: `${rec.pendingApprovals} pending approval(s)`,
      hint: '`abox approvals ls`',
    });
  if (
    rec.orphans.length +
      rec.ghosts.length +
      rec.interrupted.length +
      rec.expired.length +
      rec.unreachable.length +
      rec.pendingApprovals ===
    0
  ) {
    add({ id: 'reconcile', level: 'ok', title: 'registry and backends agree' });
  }

  return {
    ok: !checks.some((c) => c.level === 'error'),
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

export type { SandboxRecord };
