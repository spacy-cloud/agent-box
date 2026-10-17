import { randomUUID } from 'node:crypto';
import { AboxError } from '../errors.js';
import type { RepoContext } from './db.js';
import { transaction } from './db.js';
import { hashJson } from './canonical.js';
import { fromJson, num, numOrNull, strOrNull, toJson } from './json.js';
import type { Row } from './json.js';

/** Well-known kinds; the queue accepts any string so new kinds need no migration. */
export type ApprovalKind =
  'create' | 'exec' | 'access' | 'template_trust' | (string & Record<never, never>);
export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';
export const FINAL_STATUSES: readonly ApprovalStatus[] = ['approved', 'denied', 'expired'];

/** One policy finding that made an approval necessary (what the policy engine reported as an approval item). */
export interface ApprovalItemRecord {
  /** Policy item kind, e.g. `image_registry`, `template_trust`, `mount`. */
  kind: string;
  reason: string;
  risk: string;
  invariant: boolean;
}

export interface Approval {
  id: string;
  requester: string;
  kind: ApprovalKind;
  sandboxId: string | null;
  /** The exact request the decision applies to. */
  request: unknown;
  /** sha256 of the canonical JSON of `request`; an approval is bound to it. */
  requestHash: string;
  /**
   * Free text written by the agent. Stored as-is and **untrusted**: UIs must render it as
   * plain text, visually separated from abox's own `risks`.
   */
  reason: string;
  /** Always true: marks `reason` as agent-supplied. */
  reasonUntrusted: true;
  /** Risks computed by abox (trusted). */
  risks: string[];
  /**
   * Why approval was needed, as the policy engine reported it (trusted). Empty for approvals stored
   * before items were recorded, and for kinds the policy did not raise.
   */
  items: ApprovalItemRecord[];
  status: ApprovalStatus;
  ttlMs: number;
  createdAt: number;
  /**
   * While pending: the decision deadline (created + ttl). After approval: the last moment
   * the approval can be consumed (decision time + ttl).
   */
  expiresAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
  decisionNote: string | null;
  /** Set once an approved entry has been consumed (one-time approvals). */
  usedAt: number | null;
}

export interface CreateApprovalInput {
  requester: string;
  kind: ApprovalKind;
  sandboxId?: string;
  request: unknown;
  reason?: string;
  risks?: string[];
  items?: ApprovalItemRecord[];
  ttlMs: number;
}

export interface ApprovalListFilter {
  status?: ApprovalStatus | ApprovalStatus[];
  requester?: string;
  sandboxId?: string;
  limit?: number;
}

export interface WaitOptions {
  /** Polling interval in ms (default 250). */
  pollMs?: number;
  signal?: AbortSignal;
}

/** The hash an approval is bound to. Callers use it for `findApproved`. */
export function hashRequest(request: unknown): string {
  return hashJson(request);
}

function toApproval(r: Row): Approval {
  return {
    id: r['id'] as string,
    requester: r['requester'] as string,
    kind: r['kind'] as ApprovalKind,
    sandboxId: strOrNull(r['sandbox_id']),
    request: fromJson<unknown>(r['request'], null),
    requestHash: r['request_hash'] as string,
    reason: r['reason'] as string,
    reasonUntrusted: true,
    risks: fromJson<string[]>(r['risks'], []),
    items: storedItems(r['items']),
    status: r['status'] as ApprovalStatus,
    ttlMs: num(r['ttl_ms']),
    createdAt: num(r['created_at']),
    expiresAt: num(r['expires_at']),
    decidedAt: numOrNull(r['decided_at']),
    decidedBy: strOrNull(r['decided_by']),
    decisionNote: strOrNull(r['decision_note']),
    usedAt: numOrNull(r['used_at']),
  };
}

/** Items column -> records; NULL (old rows) and anything malformed give an empty list. */
function storedItems(text: unknown): ApprovalItemRecord[] {
  const raw = fromJson<unknown>(text, []);
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((x): ApprovalItemRecord[] => {
    const i = x as Partial<ApprovalItemRecord> | null;
    return i && typeof i.kind === 'string' && typeof i.reason === 'string'
      ? [
          {
            kind: i.kind,
            reason: i.reason,
            risk: typeof i.risk === 'string' ? i.risk : '',
            invariant: i.invariant === true,
          },
        ]
      : [];
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * Approval queue shared by CLI, MCP server and GUI through SQLite.
 * Semantics: undecided or overdue = denied (status `expired`). Approvals are
 * one-time and bound to the exact request hash.
 */
export class ApprovalQueue {
  private readonly ctx: RepoContext;

  constructor(ctx: RepoContext) {
    this.ctx = ctx;
  }

  create(input: CreateApprovalInput): Approval {
    if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0) {
      throw new AboxError('invalid_input', 'approval ttlMs must be a positive number');
    }
    const now = this.ctx.now();
    const id = randomUUID();
    this.ctx.db
      .prepare(
        `INSERT INTO approvals (id, requester, kind, sandbox_id, request, request_hash, reason, risks,
                                items, status, ttl_ms, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .run(
        id,
        input.requester,
        input.kind,
        input.sandboxId ?? null,
        toJson(input.request) ?? 'null',
        hashRequest(input.request),
        input.reason ?? '',
        JSON.stringify(input.risks ?? []),
        JSON.stringify(
          (input.items ?? []).map((i) => ({
            kind: i.kind,
            reason: i.reason,
            risk: i.risk,
            invariant: i.invariant,
          })),
        ),
        Math.trunc(input.ttlMs),
        now,
        now + Math.trunc(input.ttlMs),
      );
    return this.get(id)!;
  }

  /** Fetch one approval; an overdue pending entry is flipped to `expired` first. */
  get(id: string): Approval | undefined {
    const row = this.ctx.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id);
    if (!row) return undefined;
    const approval = toApproval(row);
    if (approval.status === 'pending' && approval.expiresAt <= this.ctx.now()) {
      this.expireOverdue();
      return toApproval(this.ctx.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id)!);
    }
    return approval;
  }

  list(filter: ApprovalListFilter = {}): Approval[] {
    this.expireOverdue();
    const where: string[] = [];
    const args: Array<string | number> = [];
    const statuses =
      filter.status === undefined
        ? undefined
        : Array.isArray(filter.status)
          ? filter.status
          : [filter.status];
    if (statuses && statuses.length > 0) {
      where.push(`status IN (${statuses.map(() => '?').join(',')})`);
      args.push(...statuses);
    }
    if (filter.requester !== undefined) {
      where.push('requester = ?');
      args.push(filter.requester);
    }
    if (filter.sandboxId !== undefined) {
      where.push('sandbox_id = ?');
      args.push(filter.sandboxId);
    }
    const limit =
      filter.limit !== undefined ? ` LIMIT ${Math.max(1, Math.trunc(filter.limit))}` : '';
    const sql = `SELECT * FROM approvals ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at, rowid${limit}`;
    return this.ctx.db
      .prepare(sql)
      .all(...args)
      .map(toApproval);
  }

  /**
   * Record the human decision. Only pending, not yet overdue entries can be decided.
   * An approval's validity window restarts at the decision (`expiresAt = now + ttl`).
   */
  decide(
    id: string,
    decision: { decision: 'approved' | 'denied'; by: string; note?: string },
  ): Approval {
    if (decision.decision !== 'approved' && decision.decision !== 'denied') {
      throw new AboxError('invalid_input', `invalid decision '${String(decision.decision)}'`);
    }
    return transaction(this.ctx.db, () => {
      const now = this.ctx.now();
      const res = this.ctx.db
        .prepare(
          `UPDATE approvals
              SET status = ?, decided_at = ?, decided_by = ?, decision_note = ?,
                  expires_at = CASE WHEN ? = 'approved' THEN ? + ttl_ms ELSE expires_at END
            WHERE id = ? AND status = 'pending' AND expires_at > ?`,
        )
        .run(
          decision.decision,
          now,
          decision.by,
          decision.note ?? null,
          decision.decision,
          now,
          id,
          now,
        );
      if (num(res.changes) === 0) {
        const current = this.get(id);
        if (!current) throw new AboxError('not_found', `unknown approval '${id}'`);
        if (current.status === 'expired') {
          throw new AboxError('approval_expired', `approval '${id}' expired before it was decided`);
        }
        throw new AboxError('conflict', `approval '${id}' is already ${current.status}`);
      }
      return this.get(id)!;
    });
  }

  /** Mark all overdue pending approvals as `expired` (= denied). Returns their ids. */
  expireOverdue(now: number = this.ctx.now()): string[] {
    return transaction(this.ctx.db, () => {
      const rows = this.ctx.db
        .prepare(
          `UPDATE approvals SET status = 'expired' WHERE status = 'pending' AND expires_at <= ? RETURNING id`,
        )
        .all(now);
      return rows.map((r) => r['id'] as string);
    });
  }

  /**
   * Wait (polling, so decisions made by other processes are seen) until the approval is
   * decided or expired. On timeout or abort the still-pending approval is returned; the
   * caller treats that as "no decision yet" and must not proceed.
   */
  async waitForDecision(id: string, timeoutMs: number, opts: WaitOptions = {}): Promise<Approval> {
    const pollMs = Math.max(10, opts.pollMs ?? 250);
    const deadline = Date.now() + Math.max(0, timeoutMs);
    for (;;) {
      const approval = this.get(id);
      if (!approval) throw new AboxError('not_found', `unknown approval '${id}'`);
      if (approval.status !== 'pending') return approval;
      const remaining = deadline - Date.now();
      if (remaining <= 0 || opts.signal?.aborted) return approval;
      await sleep(Math.min(pollMs, remaining), opts.signal);
    }
  }

  /**
   * An approved, unused, unexpired approval for exactly this requester and request hash.
   * Does not consume it; call {@link consume} right before acting.
   */
  findApproved(requester: string, requestHash: string): Approval | undefined {
    const row = this.ctx.db
      .prepare(
        `SELECT * FROM approvals
          WHERE requester = ? AND request_hash = ? AND status = 'approved'
            AND used_at IS NULL AND expires_at > ?
          ORDER BY decided_at, id LIMIT 1`,
      )
      .get(requester, requestHash, this.ctx.now());
    return row ? toApproval(row) : undefined;
  }

  /** Atomically mark an approved entry as used. Returns false when it was already used, expired or not approved. */
  consume(id: string): boolean {
    const res = this.ctx.db
      .prepare(
        `UPDATE approvals SET used_at = ?
          WHERE id = ? AND status = 'approved' AND used_at IS NULL AND expires_at > ?`,
      )
      .run(this.ctx.now(), id, this.ctx.now());
    return num(res.changes) > 0;
  }
}
