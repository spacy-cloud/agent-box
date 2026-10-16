import { AboxError } from '../errors.js';
import type { SandboxRecord } from '../state/sandbox-registry.js';
import {
  canonicalizePath,
  evaluateAccessRequest,
  normalizeDomainPattern,
  type AccessRequestSpec,
  type AgentContext,
} from '../policy/index.js';
import { domainCovered } from '../policy/domains.js';
import { tryParseSize } from '../policy/units.js';
import { buildProxyInjections } from '../secrets/inject.js';
import { expandNetworkPresets } from '../template/network-presets.js';
import type { NetworkMode, NetworkSpec, ResolvedTemplate } from '../types.js';
import { confirmationRequired, consumeApproval, gate } from './approvals.js';
import type { Internals, StoredEffective } from './internals.js';
import { toDuration, viewFor } from './lifecycle.js';
import { accessSchema } from './schemas.js';
import type { AccessResult, Caller, ExecCallOptions } from './types.js';
import type { AccessRequestInput } from './types.js';
import { errMessage, parseInput } from './util.js';

type ApplySpec =
  | {
      kind: 'network';
      mode: NetworkMode | undefined;
      domains: string[];
      privateExceptions: string[];
    }
  | { kind: 'ttl'; totalTtlMs: number }
  | { kind: 'mount' }
  | { kind: 'resources' };

function liveOrThrow(I: Internals, rec: SandboxRecord): void {
  if (rec.state === 'removed' || rec.state === 'failed' || rec.state === 'preparing') {
    throw new AboxError('conflict', `sandbox ${rec.id} is ${rec.state}`);
  }
  if (rec.state === 'expired' || rec.expiresAt <= I.now()) {
    throw new AboxError(
      'conflict',
      `sandbox ${rec.id} has expired; it cannot be changed any more`,
      {
        hint: 'Create a new sandbox.',
      },
    );
  }
}

function hostInfoOf(
  I: Internals,
  rec: SandboxRecord,
): Promise<ReturnType<Internals['hostInfo']> | undefined> {
  return I.resolveHost(rec.host).then(
    (h) => I.hostInfo(h, false),
    () => undefined,
  );
}

export async function accessRequest(
  I: Internals,
  caller: Caller,
  id: string,
  rawInput: AccessRequestInput,
  o: ExecCallOptions = {},
): Promise<AccessResult> {
  const ctx = await I.context(caller);
  const input = parseInput(accessSchema, rawInput, 'access request');
  const rec = I.lookup(ctx, id);
  liveOrThrow(I, rec);
  const eff = (rec.effective ?? {}) as Partial<StoredEffective>;
  const currentNet = eff.network ?? { mode: 'none', allow: [] };

  let spec: AccessRequestSpec;
  let apply: ApplySpec;
  let noop: string | undefined;

  switch (input.kind) {
    case 'network': {
      const d = input.details;
      const domains = [...(d.domains ?? []), ...expandNetworkPresets(d.presets ?? [])];
      const norm = [...new Set(domains.map((x) => normalizeDomainPattern(x) ?? x))];
      spec = {
        kind: 'network',
        details: {
          ...(d.mode ? { mode: d.mode } : {}),
          domains: norm,
          ...(d.privateExceptions ? { privateExceptions: d.privateExceptions } : {}),
        },
      };
      apply = {
        kind: 'network',
        mode: d.mode,
        domains: norm,
        privateExceptions: d.privateExceptions ?? [],
      };
      const sameMode = !d.mode || d.mode === currentNet.mode;
      if (
        sameMode &&
        currentNet.mode === 'allowlist' &&
        !d.privateExceptions?.length &&
        norm.length > 0 &&
        norm.every((x) => domainCovered(x, currentNet.allow))
      ) {
        noop = 'the sandbox already allows these destinations';
      }
      break;
    }
    case 'mount': {
      const d = input.details;
      const hostPath = canonicalizePath(d.source, { home: I.home, cwd: I.projectDir ?? I.home });
      spec = {
        kind: 'mount',
        details: {
          hostPath,
          target: d.target,
          access: d.access ?? 'ro',
          paths: { home: I.home, extraForbidden: I.forbiddenTrees() },
        },
      };
      apply = { kind: 'mount' };
      break;
    }
    case 'resources': {
      const d = input.details;
      const memoryBytes =
        d.memory !== undefined
          ? typeof d.memory === 'number'
            ? d.memory
            : tryParseSize(d.memory)
          : undefined;
      if (d.memory !== undefined && memoryBytes === undefined)
        throw new AboxError('invalid_input', `invalid memory ${JSON.stringify(d.memory)}`);
      spec = {
        kind: 'resources',
        details: {
          ...(d.cpus !== undefined ? { cpus: d.cpus } : {}),
          ...(memoryBytes !== undefined ? { memoryBytes } : {}),
        },
      };
      apply = { kind: 'resources' };
      break;
    }
    case 'ttl': {
      const by = toDuration(input.details.ttl, 'ttl');
      const total = Math.max(rec.expiresAt, I.now()) + by - rec.createdAt;
      spec = { kind: 'ttl', details: { ttlMs: Math.round(total / 1000) * 1000 } };
      apply = { kind: 'ttl', totalTtlMs: Math.round(total / 1000) * 1000 };
      break;
    }
  }

  const host = await hostInfoOf(I, rec);
  const ev = evaluateAccessRequest(
    ctx,
    {
      id: rec.id,
      owner: rec.owner,
      ...(host ? { host } : {}),
      isolation: rec.isolation,
      network: { mode: currentNet.mode as NetworkMode, allow: currentNet.allow },
    },
    spec,
    { ...(ctx.kind === 'human' && caller.humanConfirmed === true ? { humanConfirmed: true } : {}) },
  );
  const action = 'sandbox.access_request';
  const detailsForAudit = { kind: input.kind, request: ev.requestDigest['request'] };
  if (ev.decision === 'deny') {
    I.audit(ctx.owner, action, {
      sandboxId: rec.id,
      decision: 'deny',
      details: { ...detailsForAudit, reasons: ev.reasons },
    });
    throw new AboxError('policy_denied', ev.reasons.join('; '), {
      ...(ev.hint ? { hint: ev.hint } : {}),
      details: { reasons: ev.reasons },
    });
  }
  if (noop) {
    I.audit(ctx.owner, action, {
      sandboxId: rec.id,
      decision: 'allow',
      details: { ...detailsForAudit, noop },
    });
    return { status: 'applied', kind: input.kind, sandbox: await viewFor(I, rec), message: noop };
  }
  await assertApplicable(I, rec, apply);

  if (ev.decision === 'allow') {
    const message = await applyAccess(I, rec, apply, ctx.owner, undefined);
    return {
      status: 'applied',
      kind: input.kind,
      sandbox: await viewFor(I, I.state.sandboxes.get(rec.id)!),
      message,
    };
  }
  if (ctx.kind === 'human') return confirmationRequired(ev.reasons, ev.risks, ev.items);

  const g = await gate(I, {
    ctx,
    kind: 'access',
    sandboxId: rec.id,
    request: { ...ev.requestDigest, policy: I.policy.contentHash, apply },
    reasons: ev.reasons,
    risks: ev.risks,
    agentReason: input.reason,
    waitMs: Math.max(0, o.waitForApprovalMs ?? 0),
    signal: o.signal,
    action,
  });
  if (g.outcome === 'pending') return g.pending;
  // approved while we waited: the approver may already have applied it
  const fresh = I.state.approvals.get(g.approval.id);
  if (fresh?.usedAt) {
    return {
      status: 'applied',
      kind: input.kind,
      sandbox: await viewFor(I, I.state.sandboxes.get(rec.id)!),
      message: 'approved and applied',
    };
  }
  consumeApproval(I, g.approval);
  const message = await applyAccess(I, rec, apply, ctx.owner, g.approval.id);
  return {
    status: 'applied',
    kind: input.kind,
    sandbox: await viewFor(I, I.state.sandboxes.get(rec.id)!),
    message,
  };
}

/** Fail with `unsupported` before anything is queued when the backend cannot apply the change to a running sandbox. */
async function assertApplicable(I: Internals, rec: SandboxRecord, apply: ApplySpec): Promise<void> {
  const eff = (rec.effective ?? {}) as Partial<StoredEffective>;
  switch (apply.kind) {
    case 'mount':
      throw new AboxError('unsupported', 'mounts cannot be added to an existing sandbox', {
        hint: 'Create a new sandbox with overrides.mounts (a human has to approve additional mounts).',
      });
    case 'resources':
      throw new AboxError(
        'unsupported',
        'resource limits of an existing sandbox cannot be changed',
        {
          hint: 'Create a new sandbox with overrides.cpus / overrides.memory.',
        },
      );
    case 'network': {
      const provider = await I.providerForRecord(rec);
      const cur = eff.network?.mode ?? 'none';
      if (!provider.updateNetwork) {
        throw new AboxError(
          'unsupported',
          `backend '${rec.backend}' cannot change the network rules of a running sandbox`,
          {
            hint: 'Create a new sandbox with overrides.network (allow / presets).',
          },
        );
      }
      if ((apply.mode && apply.mode !== cur) || cur !== 'allowlist') {
        throw new AboxError(
          'unsupported',
          `the network mode of an existing sandbox cannot change (current: ${cur}); only the allowlist of an allowlist sandbox can be extended`,
          {
            hint: 'Create a new sandbox with the network mode you need.',
          },
        );
      }
      return;
    }
    case 'ttl':
      return;
  }
}

/** Apply an allowed/approved access change. Returns a human-readable summary. */
async function applyAccess(
  I: Internals,
  rec: SandboxRecord,
  apply: ApplySpec,
  actor: string,
  approvalId: string | undefined,
): Promise<string> {
  const fresh = I.state.sandboxes.get(rec.id) ?? rec;
  liveOrThrow(I, fresh);
  const eff = (fresh.effective ?? {}) as unknown as StoredEffective;
  try {
    let message: string;
    if (apply.kind === 'ttl') {
      const expiresAt = Math.max(fresh.expiresAt, fresh.createdAt + apply.totalTtlMs);
      I.state.sandboxes.setExpiresAt(fresh.id, expiresAt);
      I.state.sandboxes.setEffective(fresh.id, {
        ...eff,
        resources: { ...eff.resources, ttlMs: expiresAt - fresh.createdAt },
      });
      message = `expiry is now ${new Date(expiresAt).toISOString()}`;
    } else if (apply.kind === 'network') {
      await assertApplicable(I, fresh, apply);
      const provider = await I.providerForRecord(fresh);
      const allow = [...new Set([...(eff.network?.allow ?? []), ...apply.domains])];
      const decl = (eff.keyringRefs ?? []).map((s) => ({
        ref: s.ref,
        inject: s.inject as 'proxy' | 'env' | 'file',
        hosts: s.hosts,
        ...(s.path ? { path: s.path } : {}),
      })) as ResolvedTemplate['secrets'];
      const injections = await buildProxyInjections(decl, I.secretStore, I.config.secrets);
      I.noteSecrets(injections.map((i) => i.value));
      const privateExceptions = [
        ...new Set([...(eff.network?.privateExceptions ?? []), ...apply.privateExceptions]),
      ];
      const network: NetworkSpec = {
        mode: 'allowlist',
        allow,
        blockPrivate: true,
        privateExceptions,
        injections,
      };
      await provider.updateNetwork!(fresh.id, network);
      I.state.sandboxes.setEffective(fresh.id, {
        ...eff,
        network: { mode: 'allowlist', allow, privateExceptions },
      });
      message = `allowlist now has ${allow.length} destination(s)`;
    } else {
      await assertApplicable(I, fresh, apply);
      message = '';
    }
    I.audit(actor, 'sandbox.access_applied', {
      sandboxId: fresh.id,
      decision: approvalId ? 'approved' : 'allow',
      details: { kind: apply.kind, apply, approvalId, message },
    });
    return message;
  } catch (e) {
    I.audit(actor, 'sandbox.access_applied', {
      sandboxId: fresh.id,
      decision: 'error',
      details: { kind: apply.kind, approvalId, message: errMessage(e) },
    });
    throw e;
  }
}

/** Apply an approved `access` approval (called by `approve`; also usable by another process). */
export async function applyApprovedAccess(
  I: Internals,
  caller: Caller,
  approvalId: string,
): Promise<{ ok: boolean; message: string }> {
  const ctx = await I.context(caller);
  I.requireHuman(ctx, 'access.apply');
  return applyApprovedAccessInternal(I, ctx, approvalId);
}

export async function applyApprovedAccessInternal(
  I: Internals,
  ctx: AgentContext,
  approvalId: string,
): Promise<{ ok: boolean; message: string }> {
  const a = typeof approvalId === 'string' ? I.state.approvals.get(approvalId) : undefined;
  if (!a || a.kind !== 'access' || a.status !== 'approved') {
    throw new AboxError('not_found', 'no approved access request with this id');
  }
  const apply = (a.request as { apply?: ApplySpec } | null)?.apply;
  if (!apply || !a.sandboxId)
    throw new AboxError('invalid_input', 'the approval does not carry an applicable change');
  const rec = I.state.sandboxes.get(a.sandboxId);
  if (!rec) throw new AboxError('not_found', `sandbox ${a.sandboxId} no longer exists`);
  consumeApproval(I, a);
  const message = await applyAccess(I, rec, apply, ctx.owner, a.id);
  return { ok: true, message };
}

export async function extendTtl(
  I: Internals,
  caller: Caller,
  id: string,
  ttl: string | number,
  o: ExecCallOptions = {},
): Promise<AccessResult> {
  return accessRequest(I, caller, id, { kind: 'ttl', details: { ttl } }, o);
}
