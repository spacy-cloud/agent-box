import { AboxError } from '../errors.js';
import type { BackendKind, IsolationLevel, SandboxId, SandboxState } from '../types.js';
import type { RepoContext } from './db.js';
import { transaction } from './db.js';
import { fromJson, num, numOrNull, strOrNull, toJson } from './json.js';
import type { Row } from './json.js';
import { redact } from './redact.js';

/** Registry row of a sandbox. Existence is decided by the backend; this is metadata + cache. */
export interface SandboxRecord {
  id: SandboxId;
  host: string;
  name: string;
  owner: string;
  template: string;
  templateHash: string;
  backend: BackendKind;
  isolation: IsolationLevel;
  state: SandboxState;
  createdAt: number;
  expiresAt: number;
  /** Idempotency key chosen by the caller; unique per owner. */
  requestId: string | null;
  /** Workspace description (mode, host path, ref, …). Never contains secrets. */
  workspace: Record<string, unknown> | null;
  /** Effective options actually applied (for `inspect` and audit). Never contains secrets. */
  effective: Record<string, unknown> | null;
  lastSeenAt: number | null;
  /** True when the backend no longer reported the sandbox at the last reconcile. */
  stale: boolean;
  error: string | null;
  removedAt: number | null;
}

export type SandboxInput = Pick<
  SandboxRecord,
  | 'id'
  | 'host'
  | 'name'
  | 'owner'
  | 'template'
  | 'templateHash'
  | 'backend'
  | 'isolation'
  | 'state'
  | 'createdAt'
  | 'expiresAt'
> &
  Partial<Pick<SandboxRecord, 'requestId' | 'workspace' | 'effective' | 'error'>>;

export interface SandboxListFilter {
  owner?: string;
  host?: string;
  state?: SandboxState | SandboxState[];
  /** Include soft-removed sandboxes (default: only when `state` asks for `removed`). */
  includeRemoved?: boolean;
}

function toRecord(r: Row): SandboxRecord {
  return {
    id: r['id'] as string,
    host: r['host'] as string,
    name: r['name'] as string,
    owner: r['owner'] as string,
    template: r['template'] as string,
    templateHash: r['template_hash'] as string,
    backend: r['backend'] as BackendKind,
    isolation: r['isolation'] as IsolationLevel,
    state: r['state'] as SandboxState,
    createdAt: num(r['created_at']),
    expiresAt: num(r['expires_at']),
    requestId: strOrNull(r['request_id']),
    workspace: fromJson<Record<string, unknown> | null>(r['workspace'], null),
    effective: fromJson<Record<string, unknown> | null>(r['effective'], null),
    lastSeenAt: numOrNull(r['last_seen_at']),
    stale: num(r['stale']) !== 0,
    error: strOrNull(r['error']),
    removedAt: numOrNull(r['removed_at']),
  };
}

export class SandboxRegistry {
  private readonly ctx: RepoContext;

  constructor(ctx: RepoContext) {
    this.ctx = ctx;
  }

  /**
   * Insert or update by id. `createdAt` and `requestId` of an existing row are kept
   * unless a new `requestId` is given. `workspace` and `effective` are passed through
   * `redact()` as a safety net against accidental secrets.
   */
  upsert(input: SandboxInput): SandboxRecord {
    const { db } = this.ctx;
    try {
      db.prepare(
        `INSERT INTO sandboxes (id, host, name, owner, template, template_hash, backend, isolation, state,
                                created_at, expires_at, request_id, workspace, effective, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           host = excluded.host, name = excluded.name, owner = excluded.owner,
           template = excluded.template, template_hash = excluded.template_hash,
           backend = excluded.backend, isolation = excluded.isolation, state = excluded.state,
           expires_at = excluded.expires_at,
           request_id = COALESCE(excluded.request_id, sandboxes.request_id),
           workspace = COALESCE(excluded.workspace, sandboxes.workspace),
           effective = COALESCE(excluded.effective, sandboxes.effective),
           error = excluded.error,
           removed_at = CASE WHEN excluded.state = 'removed' THEN COALESCE(sandboxes.removed_at, ?) ELSE NULL END`,
      ).run(
        input.id,
        input.host,
        input.name,
        input.owner,
        input.template,
        input.templateHash,
        input.backend,
        input.isolation,
        input.state,
        input.createdAt,
        input.expiresAt,
        input.requestId ?? null,
        toJson(input.workspace ? redact(input.workspace) : null),
        toJson(input.effective ? redact(input.effective) : null),
        input.error ?? null,
        this.ctx.now(),
      );
    } catch (e) {
      if (
        /UNIQUE constraint failed: sandboxes\.owner, sandboxes\.request_id/.test(
          (e as Error).message,
        )
      ) {
        throw new AboxError(
          'conflict',
          `request id '${input.requestId}' already used by ${input.owner}`,
          {
            cause: e,
            hint: 'Use findByRequestId() before creating, or pick a new request id.',
          },
        );
      }
      throw e;
    }
    return this.get(input.id)!;
  }

  get(id: SandboxId): SandboxRecord | undefined {
    const row = this.ctx.db.prepare('SELECT * FROM sandboxes WHERE id = ?').get(id);
    return row ? toRecord(row) : undefined;
  }

  list(filter: SandboxListFilter = {}): SandboxRecord[] {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (filter.owner !== undefined) {
      where.push('owner = ?');
      args.push(filter.owner);
    }
    if (filter.host !== undefined) {
      where.push('host = ?');
      args.push(filter.host);
    }
    const states =
      filter.state === undefined
        ? undefined
        : Array.isArray(filter.state)
          ? filter.state
          : [filter.state];
    if (states && states.length > 0) {
      where.push(`state IN (${states.map(() => '?').join(',')})`);
      args.push(...states);
    }
    const wantsRemoved = filter.includeRemoved ?? states?.includes('removed') ?? false;
    if (!wantsRemoved) where.push(`state <> 'removed'`);
    const sql = `SELECT * FROM sandboxes ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at, id`;
    return this.ctx.db
      .prepare(sql)
      .all(...args)
      .map(toRecord);
  }

  /** Update the lifecycle state; `error` is set (or cleared when omitted). */
  updateState(
    id: SandboxId,
    state: SandboxState,
    opts: { error?: string | null } = {},
  ): SandboxRecord {
    const res = this.ctx.db
      .prepare(
        `UPDATE sandboxes SET state = ?, error = ?,
           removed_at = CASE WHEN ? = 'removed' THEN COALESCE(removed_at, ?) ELSE removed_at END
         WHERE id = ?`,
      )
      .run(state, opts.error ?? null, state, this.ctx.now(), id);
    if (num(res.changes) === 0) throw new AboxError('not_found', `unknown sandbox '${id}'`);
    return this.get(id)!;
  }

  /** The backend reported this sandbox: record the time and clear `stale`. */
  markSeen(id: SandboxId, ts: number = this.ctx.now()): void {
    this.ctx.db
      .prepare('UPDATE sandboxes SET last_seen_at = ?, stale = 0 WHERE id = ?')
      .run(ts, id);
  }

  /** The backend no longer reports this sandbox (reconcile); it is kept and flagged, never deleted. */
  markStale(id: SandboxId): void {
    this.ctx.db.prepare('UPDATE sandboxes SET stale = 1 WHERE id = ?').run(id);
  }

  /** Soft remove: state `removed` plus `removed_at`. The row stays for history and idempotency. */
  remove(id: SandboxId): boolean {
    const res = this.ctx.db
      .prepare(
        `UPDATE sandboxes SET state = 'removed', removed_at = COALESCE(removed_at, ?) WHERE id = ?`,
      )
      .run(this.ctx.now(), id);
    return num(res.changes) > 0;
  }

  /** Idempotency lookup (includes soft-removed sandboxes). */
  findByRequestId(owner: string, requestId: string): SandboxRecord | undefined {
    const row = this.ctx.db
      .prepare('SELECT * FROM sandboxes WHERE owner = ? AND request_id = ?')
      .get(owner, requestId);
    return row ? toRecord(row) : undefined;
  }

  /** Atomically get-or-create by request id. Returns `created: false` when the key already existed. */
  upsertIdempotent(input: SandboxInput & { requestId: string }): {
    record: SandboxRecord;
    created: boolean;
  } {
    return transaction(this.ctx.db, () => {
      const existing = this.findByRequestId(input.owner, input.requestId);
      if (existing) return { record: existing, created: false };
      return { record: this.upsert(input), created: true };
    });
  }
}
