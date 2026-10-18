import { AboxError } from '../errors.js';
import type { SandboxRecord } from '../state/sandbox-registry.js';
import {
  canonicalizePath,
  evaluateAccessRequest,
  hostQuotaViolations,
  normalizeDomainPattern,
  type AccessRequestSpec,
  type AgentContext,
} from '../policy/index.js';
import { domainCovered } from '../policy/domains.js';
import { formatSize, tryParseSize } from '../policy/units.js';
import { buildProxyInjections } from '../secrets/inject.js';
import { expandNetworkPresets } from '../template/network-presets.js';
import type { NetworkMode, NetworkSpec, ResolvedTemplate, SandboxPortForward } from '../types.js';
import { confirmationRequired, consumeApproval, gate } from './approvals.js';
import type { Internals, StoredEffective } from './internals.js';
import { toDuration, viewFor } from './lifecycle.js';
import { assertPortApplicable, portsOf, type PortApply } from './ports.js';
import { accessSchema } from './schemas.js';
import { requireNotTakenOver } from './takeover.js';
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
  | { kind: 'resources'; cpus?: number; memoryBytes?: number }
  | PortApply;

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
  I.requirePolicyValid(ctx, 'sandbox.access_request', 'granting access');
  const input = parseInput(accessSchema, rawInput, 'access request');
  const rec = I.lookup(ctx, id);
  requireNotTakenOver(I, ctx, rec, 'sandbox.access_request');
  liveOrThrow(I, rec);
  const eff = (rec.effective ?? {}) as Partial<StoredEffective>;
  const currentNet = eff.network ?? { mode: 'none', allow: [] };

  let spec: AccessRequestSpec;
  let apply: ApplySpec;
  let noop: string | undefined;
  let noopPort: SandboxPortForward | undefined;
  /** kind port: forwards the sandbox has open besides the one asked for (`ports.max` counts them). */
  let otherForwards: number | undefined;

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
      apply = {
        kind: 'resources',
        ...(d.cpus !== undefined ? { cpus: d.cpus } : {}),
        ...(memoryBytes !== undefined ? { memoryBytes } : {}),
      };
      const cur = eff.resources;
      if (
        cur &&
        (d.cpus === undefined || d.cpus === cur.cpus) &&
        (memoryBytes === undefined || memoryBytes === cur.memoryBytes)
      ) {
        noop = 'the sandbox already has these limits';
      }
      break;
    }
    case 'port': {
      const d = input.details;
      const open = await portsOf(I, rec);
      const same = open.find((p) => p.sandboxPort === d.port);
      otherForwards = open.length - (same ? 1 : 0);
      spec = {
        kind: 'port',
        details: {
          sandboxPort: d.port,
          ...(d.hostPort !== undefined ? { hostPort: d.hostPort } : {}),
        },
      };
      apply = {
        kind: 'port',
        sandboxPort: d.port,
        ...(d.hostPort !== undefined ? { hostPort: d.hostPort } : {}),
      };
      if (same && (d.hostPort === undefined || d.hostPort === same.hostPort)) {
        noop = `port ${d.port} is already forwarded to ${same.url}`;
        noopPort = same;
      }
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
      // what the other sandboxes of the host reserve: the host limits hold for all of them together
      hostUsage: I.hostUsage(rec.host, { exclude: rec.id }),
      ...(otherForwards !== undefined ? { portForwards: otherForwards } : {}),
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
    return {
      status: 'applied',
      kind: input.kind,
      sandbox: await viewFor(I, rec),
      message: noop,
      ...(noopPort ? { port: noopPort } : {}),
    };
  }
  await assertApplicable(I, rec, apply);

  if (ev.decision === 'allow') {
    const done = await applyAccess(I, rec, apply, ctx.owner, undefined);
    return {
      status: 'applied',
      kind: input.kind,
      sandbox: await viewFor(I, I.state.sandboxes.get(rec.id)!),
      message: done.message,
      ...(done.port ? { port: done.port } : {}),
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
    items: ev.items,
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
  const done = await applyAccess(I, rec, apply, ctx.owner, g.approval.id);
  return {
    status: 'applied',
    kind: input.kind,
    sandbox: await viewFor(I, I.state.sandboxes.get(rec.id)!),
    message: done.message,
    ...(done.port ? { port: done.port } : {}),
  };
}

/** Fail with `unsupported` before anything is queued when the backend cannot apply the change to a running sandbox. */
async function assertApplicable(I: Internals, rec: SandboxRecord, apply: ApplySpec): Promise<void> {
  const eff = (rec.effective ?? {}) as Partial<StoredEffective>;
  switch (apply.kind) {
    case 'port':
      return assertPortApplicable(I, rec);
    case 'mount':
      throw new AboxError('unsupported', 'mounts cannot be added to an existing sandbox', {
        hint: 'Create a new sandbox with overrides.mounts (a human has to approve additional mounts).',
      });
    case 'resources': {
      const provider = await I.providerForRecord(rec);
      if (!provider.updateResources) {
        throw new AboxError(
          'unsupported',
          `backend '${rec.backend}' cannot change the resource limits of an existing sandbox`,
          { hint: 'Create a new sandbox with overrides.cpus / overrides.memory.' },
        );
      }
      return;
    }
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
        // The proxy settings (HTTP_PROXY, CA bundle) are part of the container's environment and its
        // mode is fixed in its network wiring: only the destinations of an allowlist sandbox can move.
        throw new AboxError(
          'unsupported',
          `the network mode of an existing sandbox cannot change (current: ${cur}); only the allowlist of an allowlist sandbox can be extended`,
          {
            hint:
              cur === 'allowlist'
                ? 'Create a new sandbox with the network mode you need (overrides.network).'
                : `Create a new sandbox with overrides.network (mode allowlist with allow / presets${cur === 'open' ? ', or mode none' : ''}); a sandbox created with network mode ${cur} cannot get a different mode later.`,
          },
        );
      }
      return;
    }
    case 'ttl': {
      // Extending a deadline the backend cannot move would show time left that the sandbox does not have.
      const provider = await I.providerForRecord(rec);
      if (!provider.extendExpiry) throw ttlUnsupported(rec);
      return;
    }
  }
}

function ttlUnsupported(rec: SandboxRecord): AboxError {
  return new AboxError(
    'unsupported',
    `backend '${rec.backend}' cannot extend the lifetime of a running sandbox`,
    { hint: 'Create a new sandbox with a longer ttl (overrides.ttl).' },
  );
}

/** Apply an allowed/approved access change. Returns a human-readable summary. */
async function applyAccess(
  I: Internals,
  rec: SandboxRecord,
  apply: ApplySpec,
  actor: string,
  approvalId: string | undefined,
): Promise<{ message: string; port?: SandboxPortForward }> {
  const fresh = I.state.sandboxes.get(rec.id) ?? rec;
  liveOrThrow(I, fresh);
  const eff = (fresh.effective ?? {}) as unknown as StoredEffective;
  try {
    let message: string;
    let port: SandboxPortForward | undefined;
    if (apply.kind === 'port') {
      await assertApplicable(I, fresh, apply);
      const provider = await I.providerForRecord(fresh);
      port = await provider.addPortForward!(fresh.id, {
        sandboxPort: apply.sandboxPort,
        ...(apply.hostPort !== undefined ? { hostPort: apply.hostPort } : {}),
        expiresAt: fresh.expiresAt,
      });
      message = `port ${port.sandboxPort} of the sandbox is forwarded to ${port.url}${
        port.target === 'down'
          ? ' (nothing answers on that port in the sandbox yet; the server there must listen on 0.0.0.0, not only on 127.0.0.1)'
          : ''
      }`;
      I.audit(actor, 'sandbox.port.add', {
        sandboxId: fresh.id,
        decision: approvalId ? 'approved' : 'allow',
        details: {
          sandboxPort: port.sandboxPort,
          hostPort: port.hostPort,
          hostAddress: port.hostAddress,
          approvalId,
        },
      });
      I.emit('sandbox.ports', {
        sandboxId: fresh.id,
        owner: fresh.owner,
        data: { action: 'add', sandboxPort: port.sandboxPort, hostPort: port.hostPort },
      });
    } else if (apply.kind === 'ttl') {
      const expiresAt = Math.max(fresh.expiresAt, fresh.createdAt + apply.totalTtlMs);
      if (expiresAt > fresh.expiresAt) {
        // The backend enforces the deadline itself (container entrypoint, guest timer, ...): move
        // it first. If that fails the registry keeps the old expiry, so nothing claims time that
        // the sandbox will not get.
        const provider = await I.providerForRecord(fresh);
        if (!provider.extendExpiry) throw ttlUnsupported(fresh);
        await provider.extendExpiry(fresh.id, expiresAt);
      }
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
    } else if (apply.kind === 'resources') {
      await assertApplicable(I, fresh, apply);
      if (apply.cpus === undefined && apply.memoryBytes === undefined)
        throw new AboxError('invalid_input', 'the request names neither cpus nor memory');
      const provider = await I.providerForRecord(fresh);
      // The host limits hold for all sandboxes of the host together. Check against what the others
      // reserve right now and reserve the larger of old and new in the same transaction, so a create
      // or resize running in parallel (also in another process) sees it; the reservation is cut back
      // to what the backend really applied afterwards.
      const host = await hostInfoOf(I, fresh);
      const previous = I.state.sandboxes.atomic((registry) => {
        const now = registry.get(fresh.id);
        const cur = (now?.effective ?? {}) as Partial<StoredEffective>;
        if (!now || !cur.resources) return undefined;
        if (host) {
          const violations = hostQuotaViolations(
            host,
            I.hostUsage(fresh.host, { exclude: fresh.id, registry }),
            {
              ...(apply.cpus !== undefined ? { cpus: apply.cpus } : {}),
              ...(apply.memoryBytes !== undefined ? { memoryBytes: apply.memoryBytes } : {}),
            },
          );
          if (violations.length > 0) {
            throw new AboxError('policy_denied', violations.map((v) => v.reason).join('; '), {
              hint: [...new Set(violations.map((v) => v.hint))].join(' '),
              details: { reasons: violations.map((v) => v.reason) },
            });
          }
        }
        registry.setEffective(fresh.id, {
          ...cur,
          resources: {
            ...cur.resources,
            cpus: Math.max(cur.resources.cpus, apply.cpus ?? 0),
            memoryBytes: Math.max(cur.resources.memoryBytes, apply.memoryBytes ?? 0),
          },
        });
        return cur.resources;
      });
      // The backend first: if it refuses (a memory limit below what the sandbox uses now) the
      // registry keeps the limits that are really in force.
      try {
        await provider.updateResources!(fresh.id, {
          ...(apply.cpus !== undefined ? { cpus: apply.cpus } : {}),
          ...(apply.memoryBytes !== undefined ? { memoryBytes: apply.memoryBytes } : {}),
        });
      } catch (e) {
        const now = I.state.sandboxes.get(fresh.id)?.effective as StoredEffective | undefined;
        if (previous && now)
          I.state.sandboxes.setEffective(fresh.id, {
            ...now,
            resources: { ...now.resources, cpus: previous.cpus, memoryBytes: previous.memoryBytes },
          });
        throw e;
      }
      const latest = (I.state.sandboxes.get(fresh.id)?.effective ??
        eff) as unknown as StoredEffective;
      const resources = {
        ...latest.resources,
        ...(apply.cpus !== undefined ? { cpus: apply.cpus } : {}),
        ...(apply.memoryBytes !== undefined ? { memoryBytes: apply.memoryBytes } : {}),
      };
      I.state.sandboxes.setEffective(fresh.id, { ...latest, resources });
      message = `limits are now ${resources.cpus} cpu(s), ${formatSize(resources.memoryBytes)} memory`;
    } else {
      await assertApplicable(I, fresh, apply);
      message = '';
    }
    I.audit(actor, 'sandbox.access_applied', {
      sandboxId: fresh.id,
      decision: approvalId ? 'approved' : 'allow',
      details: { kind: apply.kind, apply, approvalId, message },
    });
    return { message, ...(port ? { port } : {}) };
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
  I.requirePolicyValid(ctx, 'access.apply', 'applying access requests');
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
  const done = await applyAccess(I, rec, apply, ctx.owner, a.id);
  return { ok: true, message: done.message };
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
