import type { RepoContext } from './db.js';
import { num } from './json.js';
import type { Row } from './json.js';

/** A snapshot taken through the manager (the backend owns the data; this is the index). */
export interface SnapshotRecord {
  sandboxId: string;
  /** The id the backend returned; what `restore` takes. */
  snapshotId: string;
  name: string;
  createdAt: number;
}

function toSnapshot(r: Row): SnapshotRecord {
  return {
    sandboxId: r['sandbox_id'] as string,
    snapshotId: r['snapshot_id'] as string,
    name: r['name'] as string,
    createdAt: num(r['created_at']),
  };
}

export class Snapshots {
  private readonly ctx: RepoContext;

  constructor(ctx: RepoContext) {
    this.ctx = ctx;
  }

  /** Record (or re-record: same id replaces the name/time) a snapshot of a sandbox. */
  add(input: { sandboxId: string; snapshotId: string; name: string }): SnapshotRecord {
    this.ctx.db
      .prepare(
        `INSERT INTO snapshots (sandbox_id, snapshot_id, name, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(sandbox_id, snapshot_id) DO UPDATE SET name = excluded.name, created_at = excluded.created_at`,
      )
      .run(input.sandboxId, input.snapshotId, input.name, this.ctx.now());
    return this.get(input.sandboxId, input.snapshotId)!;
  }

  get(sandboxId: string, snapshotId: string): SnapshotRecord | undefined {
    const row = this.ctx.db
      .prepare('SELECT * FROM snapshots WHERE sandbox_id = ? AND snapshot_id = ?')
      .get(sandboxId, snapshotId);
    return row ? toSnapshot(row) : undefined;
  }

  /** Oldest first. */
  list(sandboxId: string): SnapshotRecord[] {
    return this.ctx.db
      .prepare('SELECT * FROM snapshots WHERE sandbox_id = ? ORDER BY created_at, rowid')
      .all(sandboxId)
      .map(toSnapshot);
  }

  /** Every recorded snapshot of every sandbox, oldest first. */
  listAll(): SnapshotRecord[] {
    return this.ctx.db
      .prepare('SELECT * FROM snapshots ORDER BY created_at, rowid')
      .all()
      .map(toSnapshot);
  }

  /** Forget one snapshot (it was deleted). */
  delete(sandboxId: string, snapshotId: string): boolean {
    return (
      num(
        this.ctx.db
          .prepare('DELETE FROM snapshots WHERE sandbox_id = ? AND snapshot_id = ?')
          .run(sandboxId, snapshotId).changes,
      ) > 0
    );
  }

  /** Forget all snapshots of a sandbox (it was removed). */
  deleteAll(sandboxId: string): number {
    return num(
      this.ctx.db.prepare('DELETE FROM snapshots WHERE sandbox_id = ?').run(sandboxId).changes,
    );
  }
}
