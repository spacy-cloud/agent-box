import type { RepoContext } from './db.js';
import { transaction } from './db.js';
import { num } from './json.js';
import type { Row } from './json.js';

export interface PolicyRevision {
  rev: number;
  contentHash: string;
  content: string;
  actor: string;
  createdAt: number;
}

function toRevision(r: Row): PolicyRevision {
  return {
    rev: num(r['rev']),
    contentHash: r['content_hash'] as string,
    content: r['content'] as string,
    actor: r['actor'] as string,
    createdAt: num(r['created_at']),
  };
}

/** Versioned history of `policy.yaml` (a new revision only when the content hash changes). */
export class PolicyRevisions {
  private readonly ctx: RepoContext;

  constructor(ctx: RepoContext) {
    this.ctx = ctx;
  }

  /**
   * Record the policy file content. Returns the new revision number with `changed: true`,
   * or the current revision with `changed: false` when the hash equals the latest one.
   */
  record(input: { contentHash: string; content: string; actor: string }): {
    rev: number;
    changed: boolean;
  } {
    return transaction(this.ctx.db, () => {
      const latest = this.latest();
      if (latest && latest.contentHash === input.contentHash)
        return { rev: latest.rev, changed: false };
      const res = this.ctx.db
        .prepare(
          'INSERT INTO policy_revisions (content_hash, content, actor, created_at) VALUES (?, ?, ?, ?)',
        )
        .run(input.contentHash, input.content, input.actor, this.ctx.now());
      return { rev: num(res.lastInsertRowid), changed: true };
    });
  }

  latest(): PolicyRevision | undefined {
    const row = this.ctx.db
      .prepare('SELECT * FROM policy_revisions ORDER BY rev DESC LIMIT 1')
      .get();
    return row ? toRevision(row) : undefined;
  }

  get(rev: number): PolicyRevision | undefined {
    const row = this.ctx.db.prepare('SELECT * FROM policy_revisions WHERE rev = ?').get(rev);
    return row ? toRevision(row) : undefined;
  }

  /** All revisions, newest first. */
  list(): PolicyRevision[] {
    return this.ctx.db
      .prepare('SELECT * FROM policy_revisions ORDER BY rev DESC')
      .all()
      .map(toRevision);
  }
}
