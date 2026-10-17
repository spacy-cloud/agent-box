import { AboxError } from '../errors.js';
import type { Approval } from '../state/approval-queue.js';
import { hashRequest } from '../state/approval-queue.js';
import type { AgentContext, ApprovalItem } from '../policy/index.js';
import type { Internals } from './internals.js';
import { trustSnapshot } from './templates.js';
import type {
  ApprovalBase,
  ApprovalDecision,
  ApprovalView,
  Caller,
  ConfirmationRequired,
  PendingApproval,
} from './types.js';
import { errMessage } from './util.js';

/** After a human denied an identical request, the same request is refused without bothering them again. */
export const DENIAL_COOLDOWN_MS = 10 * 60_000;
/** A request that expired undecided is reported as `approval_expired` when repeated within this window. */
export const EXPIRED_REPORT_WINDOW_MS = 120_000;

/** The template base recorded in a create / template-trust request digest, if it is well-formed. */
function requestBase(request: unknown): ApprovalBase | null {
  const tpl = (request as { template?: { base?: unknown } } | null)?.template;
  const raw = tpl && typeof tpl === 'object' ? tpl.base : undefined;
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as Record<string, unknown>;
  const out: ApprovalBase = {};
  if (typeof b['os'] === 'string') out.os = b['os'];
  if (typeof b['dockerfile'] === 'string') out.dockerfile = b['dockerfile'];
  if (typeof b['registry'] === 'string') out.registry = b['registry'];
  return out.os !== undefined || out.dockerfile !== undefined ? out : null;
}

export function toApprovalView(a: Approval): ApprovalView {
  return {
    id: a.id,
    kind: a.kind,
    requester: a.requester,
    sandboxId: a.sandboxId,
    status: a.status,
    reason: a.reason,
    risks: a.risks,
    items: a.items.map((i) => ({
      kind: i.kind as ApprovalItem['kind'],
      reason: i.reason,
      risk: i.risk,
      invariant: i.invariant,
    })),
    kinds: [...new Set(a.items.map((i) => i.kind))],
    reasons: a.items.map((i) => i.reason),
    base: requestBase(a.request),
    request: a.request,
    createdAt: a.createdAt,
    expiresAt: a.expiresAt,
    decidedAt: a.decidedAt,
    decidedBy: a.decidedBy,
    decisionNote: a.decisionNote,
    usedAt: a.usedAt,
  };
}

export interface GateInput {
  ctx: AgentContext;
  kind: string;
  sandboxId?: string | undefined;
  /** The exact request an approval is bound to (hashed). Must be deterministic and free of secret values. */
  request: Record<string, unknown>;
  reasons: string[];
  risks: string[];
  /** The policy findings behind the request (stored with the approval so surfaces can show why). */
  items: ApprovalItem[];
  /** Free text written by the agent (stored as untrusted). */
  agentReason?: string | undefined;
  waitMs: number;
  signal?: AbortSignal | undefined;
  /** Short action name for the audit entry, e.g. `sandbox.create`. */
  action: string;
}

export type GateOutcome =
  { outcome: 'approved'; approval: Approval } | { outcome: 'pending'; pending: PendingApproval };

/**
 * The single approval gate used by create, exec, process start and access requests:
 * reuse an approved-and-unused approval with the identical request digest, otherwise queue one
 * (or reuse the still pending one), wait up to `waitMs`, and report approved / pending.
 * Denied and expired decisions throw.
 */
export async function gate(I: Internals, g: GateInput): Promise<GateOutcome> {
  const hash = hashRequest(g.request);
  const q = I.state.approvals;
  const owner = g.ctx.owner;

  const approved = q.findApproved(owner, hash);
  if (approved) return { outcome: 'approved', approval: approved };

  const cutoff = I.now() - DENIAL_COOLDOWN_MS;
  const denied = q
    .list({ status: 'denied', requester: owner })
    .filter((a) => a.requestHash === hash && (a.decidedAt ?? 0) >= cutoff)
    .at(-1);
  if (denied) {
    I.audit(owner, g.action, {
      ...(g.sandboxId ? { sandboxId: g.sandboxId } : {}),
      decision: 'denied',
      details: { approvalId: denied.id, reason: 'identical request was denied recently' },
    });
    throw new AboxError(
      'approval_denied',
      `an identical request was denied by ${denied.decidedBy ?? 'a human'}${denied.decisionNote ? `: ${denied.decisionNote}` : ''}`,
      {
        hint: 'Do not retry the same request. Change it so it needs fewer rights, or ask the human directly.',
        details: { approvalId: denied.id },
      },
    );
  }

  const expiredRecently = q
    .list({ status: 'expired', requester: owner })
    .filter((a) => a.requestHash === hash && a.expiresAt >= I.now() - EXPIRED_REPORT_WINDOW_MS)
    .at(-1);
  if (expiredRecently) {
    I.audit(owner, g.action, {
      ...(g.sandboxId ? { sandboxId: g.sandboxId } : {}),
      decision: 'denied',
      details: { approvalId: expiredRecently.id, reason: 'approval expired without a decision' },
    });
    throw new AboxError(
      'approval_expired',
      'nobody decided on the request in time; an undecided request counts as denied',
      {
        hint: 'Ask the human to watch the approval queue (`abox approvals ls` / GUI), then repeat the request to queue a new approval.',
        details: { approvalId: expiredRecently.id },
      },
    );
  }

  let approval = q
    .list({ status: 'pending', requester: owner })
    .find((a) => a.requestHash === hash);
  if (!approval) {
    approval = q.create({
      requester: owner,
      kind: g.kind,
      ...(g.sandboxId ? { sandboxId: g.sandboxId } : {}),
      request: g.request,
      reason: g.agentReason?.slice(0, 4000) ?? '',
      risks: g.risks,
      items: g.items,
      ttlMs: I.config.limits.approvalTtlMs,
    });
    I.audit(owner, 'approval.request', {
      ...(g.sandboxId ? { sandboxId: g.sandboxId } : {}),
      decision: 'approval',
      details: {
        approvalId: approval.id,
        kind: g.kind,
        for: g.action,
        reasons: g.reasons,
        requestHash: hash,
      },
    });
    I.emit('approval.created', {
      approvalId: approval.id,
      owner,
      ...(g.sandboxId ? { sandboxId: g.sandboxId } : {}),
    });
  }

  if (g.waitMs > 0) {
    approval = await q.waitForDecision(approval.id, g.waitMs, g.signal ? { signal: g.signal } : {});
  }
  switch (approval.status) {
    case 'approved':
      return { outcome: 'approved', approval };
    case 'denied':
      I.audit(owner, g.action, {
        ...(g.sandboxId ? { sandboxId: g.sandboxId } : {}),
        decision: 'denied',
        details: {
          approvalId: approval.id,
          decidedBy: approval.decidedBy,
          note: approval.decisionNote,
        },
      });
      throw new AboxError(
        'approval_denied',
        `the request was denied by ${approval.decidedBy ?? 'a human'}${approval.decisionNote ? `: ${approval.decisionNote}` : ''}`,
        {
          hint: 'Do not retry the same request; adjust it or ask the human.',
          details: { approvalId: approval.id },
        },
      );
    case 'expired':
      I.audit(owner, g.action, {
        ...(g.sandboxId ? { sandboxId: g.sandboxId } : {}),
        decision: 'denied',
        details: { approvalId: approval.id, reason: 'approval expired without a decision' },
      });
      throw new AboxError(
        'approval_expired',
        'nobody decided on the request in time; an undecided request counts as denied',
        {
          hint: 'Ask the human to watch the approval queue (`abox approvals ls` / GUI) and repeat the request.',
          details: { approvalId: approval.id },
        },
      );
    case 'pending':
      return {
        outcome: 'pending',
        pending: {
          status: 'pending_approval',
          approvalId: approval.id,
          kind: approval.kind,
          kinds: [...new Set(g.items.map((i) => i.kind))],
          reasons: g.reasons,
          risks: g.risks,
          expiresAt: approval.expiresAt,
          message: `Approval ${approval.id} is waiting for a human decision (until ${new Date(approval.expiresAt).toISOString()}). Repeat the identical call to continue once it is approved; without a decision it counts as denied.`,
        },
      };
  }
}

/** Consume an approval; a lost race (someone else used it) is a `conflict`. */
export function consumeApproval(I: Internals, approval: Approval): void {
  if (!I.state.approvals.consume(approval.id)) {
    throw new AboxError('conflict', `approval ${approval.id} was already used or expired`, {
      hint: 'Repeat the request to get a new decision.',
    });
  }
  I.audit('system', 'approval.consume', {
    ...(approval.sandboxId ? { sandboxId: approval.sandboxId } : {}),
    decision: 'approved',
    details: { approvalId: approval.id, kind: approval.kind, requester: approval.requester },
  });
}

/** Humans are not queued: they get the items back and re-call with `humanConfirmed`. */
export function confirmationRequired(
  reasons: string[],
  risks: string[],
  items: ConfirmationRequired['items'],
): ConfirmationRequired {
  return {
    status: 'confirmation_required',
    reasons,
    risks,
    items,
    message:
      'This request needs your explicit confirmation. Show the reasons and risks, then repeat the call with humanConfirmed: true.',
  };
}

// ---------------------------------------------------------------------------
// Public approval operations
// ---------------------------------------------------------------------------

export async function listApprovals(
  I: Internals,
  caller: Caller,
  filter: { status?: ApprovalView['status'] | ApprovalView['status'][]; limit?: number } = {},
): Promise<ApprovalView[]> {
  const ctx = await I.context(caller);
  const list = I.state.approvals.list({
    ...(filter.status ? { status: filter.status } : {}),
    ...(ctx.kind === 'agent' ? { requester: ctx.owner } : {}),
    ...(filter.limit ? { limit: filter.limit } : {}),
  });
  return list.map(toApprovalView);
}

export async function getApproval(I: Internals, caller: Caller, id: string): Promise<ApprovalView> {
  const ctx = await I.context(caller);
  const a = typeof id === 'string' ? I.state.approvals.get(id) : undefined;
  if (!a || (ctx.kind === 'agent' && a.requester !== ctx.owner)) {
    throw new AboxError('not_found', `approval '${String(id).slice(0, 80)}' not found`);
  }
  return toApprovalView(a);
}

async function decide(
  I: Internals,
  caller: Caller,
  id: string,
  decision: 'approved' | 'denied',
  note: string | undefined,
  applyAccess: (approvalId: string) => Promise<{ ok: boolean; message: string }>,
): Promise<ApprovalDecision> {
  const ctx = await I.context(caller);
  I.requireHuman(ctx, decision === 'approved' ? 'approval.approve' : 'approval.deny');
  // Denying is always possible; approving grants rights, so it waits for a valid policy.
  if (decision === 'approved') I.requirePolicyValid(ctx, 'approval.approve', 'approving requests');
  if (typeof id !== 'string' || id.length === 0 || id.length > 80)
    throw new AboxError('not_found', 'approval not found');
  const decided = I.state.approvals.decide(id, {
    decision,
    by: ctx.owner,
    ...(note ? { note: note.slice(0, 1000) } : {}),
  });
  I.audit(ctx.owner, decision === 'approved' ? 'approval.approve' : 'approval.deny', {
    ...(decided.sandboxId ? { sandboxId: decided.sandboxId } : {}),
    decision,
    details: {
      approvalId: decided.id,
      kind: decided.kind,
      requester: decided.requester,
      requestHash: decided.requestHash,
      note: decided.decisionNote,
    },
  });
  I.emit('approval.decided', {
    approvalId: decided.id,
    owner: decided.requester,
    data: { decision },
  });

  const result: ApprovalDecision = { approval: toApprovalView(decided) };
  if (decision === 'approved') {
    if (decided.kind === 'template_trust') {
      const tpl = (
        decided.request as {
          template?: { contentHash?: string; name?: string; source?: { path?: string } };
        } | null
      )?.template;
      const t = tpl
        ? { contentHash: tpl.contentHash, name: tpl.name, path: tpl.source?.path }
        : undefined;
      if (t?.contentHash && /^[0-9a-f]{64}$/.test(t.contentHash)) {
        // Keep what was approved, so the next change of this template is reviewed as a diff against it.
        const snapshot = await trustSnapshot(I, t.path, t.contentHash);
        I.state.templateTrust.trust(t.contentHash, {
          path: t.path ?? t.name ?? '',
          by: ctx.owner,
          ...(t.name ? { name: t.name } : {}),
          ...(snapshot ? { snapshot } : {}),
        });
        I.audit(ctx.owner, 'template.trust', {
          decision: 'approved',
          details: {
            template: t.name,
            contentHash: t.contentHash,
            path: t.path,
            approvalId: decided.id,
          },
        });
      }
    }
    if (decided.kind === 'access') {
      try {
        result.applied = await applyAccess(decided.id);
      } catch (e) {
        result.applied = { ok: false, message: errMessage(e) };
      }
      result.approval = toApprovalView(I.state.approvals.get(decided.id) ?? decided);
    }
  }
  return result;
}

export function approve(
  I: Internals,
  caller: Caller,
  id: string,
  note: string | undefined,
  applyAccess: (approvalId: string) => Promise<{ ok: boolean; message: string }>,
): Promise<ApprovalDecision> {
  return decide(I, caller, id, 'approved', note, applyAccess);
}

export function deny(
  I: Internals,
  caller: Caller,
  id: string,
  note: string | undefined,
): Promise<ApprovalDecision> {
  return decide(I, caller, id, 'denied', note, () => Promise.resolve({ ok: true, message: '' }));
}

export async function expireApprovals(I: Internals, caller: Caller): Promise<string[]> {
  const ctx = await I.context(caller);
  I.requireHuman(ctx, 'approval.expire');
  const ids = I.state.approvals.expireOverdue();
  for (const id of ids) {
    I.audit('system', 'approval.expired', { decision: 'denied', details: { approvalId: id } });
    I.emit('approval.expired', { approvalId: id });
  }
  return ids;
}
