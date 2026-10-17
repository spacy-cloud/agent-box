import type { RepoContext } from './db.js';
import { num } from './json.js';
import type { Row } from './json.js';

/** A project template content hash a human has allowed (like `direnv allow`). */
export interface TrustedTemplate {
  contentHash: string;
  path: string;
  trustedBy: string;
  trustedAt: number;
  /** Template name; absent for entries from before reviews existed. */
  name?: string;
  /** Canonical text of the resolved template at the time it was trusted (see `renderTemplateSnapshot`), if recorded. */
  snapshot?: string;
}

function toTrusted(r: Row): TrustedTemplate {
  return {
    contentHash: r['content_hash'] as string,
    path: r['path'] as string,
    trustedBy: r['trusted_by'] as string,
    trustedAt: num(r['trusted_at']),
    ...(typeof r['name'] === 'string' ? { name: r['name'] } : {}),
    ...(typeof r['snapshot'] === 'string' ? { snapshot: r['snapshot'] } : {}),
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

  /**
   * Trust exactly this content hash. Re-trusting refreshes path, actor and time (and the name and
   * snapshot when given).
   */
  trust(
    contentHash: string,
    info: { path: string; by: string; name?: string; snapshot?: string },
  ): TrustedTemplate {
    this.ctx.db
      .prepare(
        `INSERT INTO template_trust (content_hash, path, trusted_by, trusted_at, name, snapshot)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(content_hash) DO UPDATE SET path = excluded.path, trusted_by = excluded.trusted_by,
                                                 trusted_at = excluded.trusted_at,
                                                 name = COALESCE(excluded.name, name),
                                                 snapshot = COALESCE(excluded.snapshot, snapshot)`,
      )
      .run(
        contentHash,
        info.path,
        info.by,
        this.ctx.now(),
        info.name ?? null,
        info.snapshot ?? null,
      );
    return this.get(contentHash)!;
  }

  /**
   * The most recently trusted version of a template that has a recorded snapshot and a different
   * content hash: same name and path first, then the same name anywhere.
   */
  previousVersion(info: {
    name: string;
    path?: string;
    exceptHash: string;
  }): (TrustedTemplate & { snapshot: string }) | undefined {
    const find = (sql: string, ...args: string[]): Row | undefined =>
      this.ctx.db
        .prepare(
          `SELECT * FROM template_trust WHERE snapshot IS NOT NULL AND content_hash != ? AND name = ? ${sql} ORDER BY trusted_at DESC, content_hash LIMIT 1`,
        )
        .get(info.exceptHash, info.name, ...args);
    const row = (info.path ? find('AND path = ?', info.path) : undefined) ?? find('');
    return row ? (toTrusted(row) as TrustedTemplate & { snapshot: string }) : undefined;
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
