import type { RepoContext } from './db.js';
import { transaction } from './db.js';
import { canonicalJson, sha256Hex } from './canonical.js';
import { fromJson, num, strOrNull } from './json.js';
import type { Row } from './json.js';
import { redact, redactValues } from './redact.js';

export const AUDIT_DECISIONS = [
  'allow',
  'deny',
  'approval',
  'approved',
  'denied',
  'error',
  'info',
] as const;
export type AuditDecision = (typeof AUDIT_DECISIONS)[number];

/** `prevHash` of the first entry. */
export const AUDIT_GENESIS_HASH = '0'.repeat(64);

export interface AuditEntry {
  seq: number;
  ts: number;
  /** `human` or an agent context id. */
  actor: string;
  action: string;
  sandboxId: string | null;
  decision: AuditDecision | null;
  details: Record<string, unknown> | null;
  prevHash: string;
  /** sha256(prevHash + canonicalJson({seq, ts, actor, action, sandboxId, decision, details})). */
  hash: string;
}

export interface AuditAppendInput {
  actor: string;
  action: string;
  sandboxId?: string;
  decision?: AuditDecision;
  details?: Record<string, unknown>;
}

export interface AuditQuery {
  sandboxId?: string;
  actor?: string;
  action?: string | string[];
  decision?: AuditDecision;
  /** Inclusive lower bound (ms since epoch). */
  since?: number;
  /** Inclusive upper bound (ms since epoch). */
  until?: number;
  /** Only entries with `seq > afterSeq` (for polling UIs). */
  afterSeq?: number;
  /** Only entries with `seq < beforeSeq` (paging backwards through a newest-first listing). */
  beforeSeq?: number;
  /** Only entries of one of these sandboxes (an empty list matches nothing). */
  sandboxIds?: string[];
  /** Maximum number of entries (default 100). */
  limit?: number;
  /** `desc` (default, newest first) or `asc`. */
  order?: 'asc' | 'desc';
}

export interface ChainVerification {
  ok: boolean;
  /** Number of entries checked. */
  checked: number;
  /** Sequence number of the first entry that does not verify. */
  brokenAt?: number;
  reason?: string;
}

export interface AuditLogOptions {
  /** Known secret values (e.g. currently resolved secrets) to mask in details. */
  secretValues?: () => Iterable<string>;
}

function toEntry(r: Row): AuditEntry {
  return {
    seq: num(r['seq']),
    ts: num(r['ts']),
    actor: r['actor'] as string,
    action: r['action'] as string,
    sandboxId: strOrNull(r['sandbox_id']),
    decision: strOrNull(r['decision']) as AuditDecision | null,
    details: fromJson<Record<string, unknown> | null>(r['details'], null),
    prevHash: r['prev_hash'] as string,
    hash: r['hash'] as string,
  };
}

/** The hash input of an entry (also usable by external verifiers of a JSONL export). */
export function auditEntryHash(entry: Omit<AuditEntry, 'hash'>): string {
  return sha256Hex(
    entry.prevHash +
      canonicalJson({
        seq: entry.seq,
        ts: entry.ts,
        actor: entry.actor,
        action: entry.action,
        sandboxId: entry.sandboxId,
        decision: entry.decision,
        details: entry.details,
      }),
  );
}

/**
 * Append-only, hash-chained audit log. There is deliberately no update/delete API and
 * SQLite triggers abort UPDATE/DELETE. Appends take the write lock (`BEGIN IMMEDIATE`)
 * while reading the chain head, so concurrent writers in several processes serialize
 * and the chain stays linear.
 */
export class AuditLog {
  private readonly ctx: RepoContext;
  private readonly opts: AuditLogOptions;

  constructor(ctx: RepoContext, opts: AuditLogOptions = {}) {
    this.ctx = ctx;
    this.opts = opts;
  }

  append(input: AuditAppendInput): AuditEntry {
    let details: Record<string, unknown> | null = null;
    if (input.details !== undefined) {
      details = redact(input.details);
      const secrets = this.opts.secretValues?.();
      if (secrets) details = redactValues(details, secrets);
      // Normalize through canonical JSON so what is hashed is exactly what is stored.
      details = JSON.parse(canonicalJson(details)) as Record<string, unknown>;
    }
    const ts = this.ctx.now();
    return transaction(this.ctx.db, () => {
      const head = this.ctx.db
        .prepare('SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1')
        .get();
      const base: Omit<AuditEntry, 'hash'> = {
        seq: head ? num(head['seq']) + 1 : 1,
        ts,
        actor: input.actor,
        action: input.action,
        sandboxId: input.sandboxId ?? null,
        decision: input.decision ?? null,
        details,
        prevHash: head ? (head['hash'] as string) : AUDIT_GENESIS_HASH,
      };
      const entry: AuditEntry = { ...base, hash: auditEntryHash(base) };
      this.ctx.db
        .prepare(
          `INSERT INTO audit_log (seq, ts, actor, action, sandbox_id, decision, details, prev_hash, hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          entry.seq,
          entry.ts,
          entry.actor,
          entry.action,
          entry.sandboxId,
          entry.decision,
          details === null ? null : canonicalJson(details),
          entry.prevHash,
          entry.hash,
        );
      return entry;
    });
  }

  private buildWhere(q: AuditQuery): { where: string; args: Array<string | number> } {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (q.sandboxId !== undefined) {
      where.push('sandbox_id = ?');
      args.push(q.sandboxId);
    }
    if (q.actor !== undefined) {
      where.push('actor = ?');
      args.push(q.actor);
    }
    if (q.action !== undefined) {
      const actions = Array.isArray(q.action) ? q.action : [q.action];
      where.push(`action IN (${actions.map(() => '?').join(',')})`);
      args.push(...actions);
    }
    if (q.decision !== undefined) {
      where.push('decision = ?');
      args.push(q.decision);
    }
    if (q.since !== undefined) {
      where.push('ts >= ?');
      args.push(q.since);
    }
    if (q.until !== undefined) {
      where.push('ts <= ?');
      args.push(q.until);
    }
    if (q.afterSeq !== undefined) {
      where.push('seq > ?');
      args.push(q.afterSeq);
    }
    if (q.beforeSeq !== undefined) {
      where.push('seq < ?');
      args.push(q.beforeSeq);
    }
    if (q.sandboxIds !== undefined) {
      where.push(
        q.sandboxIds.length === 0
          ? '0'
          : `sandbox_id IN (${q.sandboxIds.map(() => '?').join(',')})`,
      );
      args.push(...q.sandboxIds);
    }
    return { where: where.length ? 'WHERE ' + where.join(' AND ') : '', args };
  }

  query(q: AuditQuery = {}): AuditEntry[] {
    const { where, args } = this.buildWhere(q);
    const limit = Math.max(1, Math.trunc(q.limit ?? 100));
    const order = q.order === 'asc' ? 'ASC' : 'DESC';
    return this.ctx.db
      .prepare(`SELECT * FROM audit_log ${where} ORDER BY seq ${order} LIMIT ${limit}`)
      .all(...args)
      .map(toEntry);
  }

  /** Latest entry (chain head), useful as an external anchor. */
  head(): { seq: number; hash: string } | undefined {
    const row = this.ctx.db
      .prepare('SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1')
      .get();
    return row ? { seq: num(row['seq']), hash: row['hash'] as string } : undefined;
  }

  count(): number {
    return num(this.ctx.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get()!['n']);
  }

  /** Recompute the whole chain. `brokenAt` is the seq of the first inconsistent entry. */
  verifyChain(): ChainVerification {
    let prevHash = AUDIT_GENESIS_HASH;
    let expectedSeq = 1;
    let checked = 0;
    for (const row of this.ctx.db.prepare('SELECT * FROM audit_log ORDER BY seq').iterate()) {
      const e = toEntry(row);
      const fail = (reason: string): ChainVerification => ({
        ok: false,
        checked,
        brokenAt: e.seq,
        reason,
      });
      if (e.seq !== expectedSeq)
        return fail(`expected seq ${expectedSeq}, found ${e.seq} (missing entries)`);
      if (e.prevHash !== prevHash) return fail('prev_hash does not match the previous entry');
      if (auditEntryHash(e) !== e.hash) return fail('hash does not match the entry content');
      prevHash = e.hash;
      expectedSeq++;
      checked++;
    }
    return { ok: true, checked };
  }

  /** Lazily yields the matching entries as JSON lines (ascending by seq, no default limit). */
  *iterateJsonl(filter: Omit<AuditQuery, 'order'> = {}): Generator<string> {
    const { where, args } = this.buildWhere(filter);
    const limit =
      filter.limit !== undefined ? ` LIMIT ${Math.max(1, Math.trunc(filter.limit))}` : '';
    for (const row of this.ctx.db
      .prepare(`SELECT * FROM audit_log ${where} ORDER BY seq${limit}`)
      .iterate(...args)) {
      yield JSON.stringify(toEntry(row));
    }
  }

  /**
   * Export as JSON Lines. With a stream-like target, writes to it and returns the number of
   * lines; with only a filter (or nothing), returns the whole text.
   */
  exportJsonl(filter?: Omit<AuditQuery, 'order'>): string;
  exportJsonl(out: { write(chunk: string): unknown }, filter?: Omit<AuditQuery, 'order'>): number;
  exportJsonl(
    a?: Omit<AuditQuery, 'order'> | { write(chunk: string): unknown },
    b?: Omit<AuditQuery, 'order'>,
  ): string | number {
    if (a && typeof (a as { write?: unknown }).write === 'function') {
      const out = a as { write(chunk: string): unknown };
      let n = 0;
      for (const line of this.iterateJsonl(b)) {
        out.write(line + '\n');
        n++;
      }
      return n;
    }
    let text = '';
    for (const line of this.iterateJsonl(a as Omit<AuditQuery, 'order'> | undefined))
      text += line + '\n';
    return text;
  }
}
