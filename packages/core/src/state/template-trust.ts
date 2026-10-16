import type { RepoContext } from './db.js';
import { num } from './json.js';
import type { Row } from './json.js';

/** A project template content hash a human has allowed (like `direnv allow`). */
export interface TrustedTemplate {
  contentHash: string;
  path: string;
  trustedBy: string;
  trustedAt: number;
}

function toTrusted(r: Row): TrustedTemplate {
  return {
    contentHash: r['content_hash'] as string,
    path: r['path'] as string,
    trustedBy: r['trusted_by'] as string,
    trustedAt: num(r['trusted_at']),
  };
}

export class TemplateTrust {
  private readonly ctx: RepoContext;

  constructor(ctx: RepoContext) {
    this.ctx = ctx;
  }

  isTrusted(contentHash: string): boolean {
    return (
      this.ctx.db
        .prepare('SELECT 1 AS x FROM template_trust WHERE content_hash = ?')
        .get(contentHash) !== undefined
    );
  }

  get(contentHash: string): TrustedTemplate | undefined {
    const row = this.ctx.db
      .prepare('SELECT * FROM template_trust WHERE content_hash = ?')
      .get(contentHash);
    return row ? toTrusted(row) : undefined;
  }

  /** Trust exactly this content hash. Re-trusting refreshes path, actor and time. */
  trust(contentHash: string, info: { path: string; by: string }): TrustedTemplate {
    this.ctx.db
      .prepare(
        `INSERT INTO template_trust (content_hash, path, trusted_by, trusted_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(content_hash) DO UPDATE SET path = excluded.path, trusted_by = excluded.trusted_by,
                                                 trusted_at = excluded.trusted_at`,
      )
      .run(contentHash, info.path, info.by, this.ctx.now());
    return this.get(contentHash)!;
  }

  list(): TrustedTemplate[] {
    return this.ctx.db
      .prepare('SELECT * FROM template_trust ORDER BY trusted_at, content_hash')
      .all()
      .map(toTrusted);
  }

  /** Returns true when a trust entry existed. */
  revoke(contentHash: string): boolean {
    return (
      num(
        this.ctx.db.prepare('DELETE FROM template_trust WHERE content_hash = ?').run(contentHash)
          .changes,
      ) > 0
    );
  }
}
