import type { RepoContext } from './db.js';
import { num, strOrNull } from './json.js';
import type { Row } from './json.js';

/** What abox remembers about a package cache volume: when it was last mounted by a sandbox. */
export interface PackageCacheRecord {
  host: string;
  key: string;
  /** Canonical project path. */
  project: string;
  /** Template name (the stack). */
  stack: string;
  /** Cache name from the template. */
  name: string;
  /** `human` or `agent:<context>`. */
  owner: string;
  createdAt: number;
  lastUsedAt: number;
  /** Sandbox that mounted it last. */
  lastSandbox: string | null;
}

function toRecord(r: Row): PackageCacheRecord {
  return {
    host: r['host'] as string,
    key: r['key'] as string,
    project: r['project'] as string,
    stack: r['stack'] as string,
    name: r['name'] as string,
    owner: r['owner'] as string,
    createdAt: num(r['created_at']),
    lastUsedAt: num(r['last_used_at']),
    lastSandbox: strOrNull(r['last_sandbox']),
  };
}

/** Last-use bookkeeping of the package cache volumes (existence and size come from the engine). */
export class PackageCaches {
  private readonly ctx: RepoContext;

  constructor(ctx: RepoContext) {
    this.ctx = ctx;
  }

  get(host: string, key: string): PackageCacheRecord | undefined {
    const row = this.ctx.db
      .prepare('SELECT * FROM package_caches WHERE host = ? AND key = ?')
      .get(host, key);
    return row ? toRecord(row) : undefined;
  }

  list(host?: string): PackageCacheRecord[] {
    const rows =
      host === undefined
        ? this.ctx.db.prepare('SELECT * FROM package_caches ORDER BY host, last_used_at').all()
        : this.ctx.db
            .prepare('SELECT * FROM package_caches WHERE host = ? ORDER BY last_used_at')
            .all(host);
    return rows.map(toRecord);
  }

  /** Hosts with at least one remembered cache. */
  hosts(): string[] {
    return this.ctx.db
      .prepare('SELECT DISTINCT host FROM package_caches ORDER BY host')
      .all()
      .map((r) => r['host'] as string);
  }

  /** Records that `sandbox` mounted the cache now; the first call creates the record. */
  touch(input: {
    host: string;
    key: string;
    project: string;
    stack: string;
    name: string;
    owner: string;
    sandbox?: string;
  }): PackageCacheRecord {
    const now = this.ctx.now();
    this.ctx.db
      .prepare(
        `INSERT INTO package_caches (host, key, project, stack, name, owner, created_at, last_used_at, last_sandbox)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(host, key) DO UPDATE SET last_used_at = excluded.last_used_at,
           last_sandbox = excluded.last_sandbox`,
      )
      .run(
        input.host,
        input.key,
        input.project,
        input.stack,
        input.name,
        input.owner,
        now,
        now,
        input.sandbox ?? null,
      );
    return this.get(input.host, input.key)!;
  }

  delete(host: string, key: string): boolean {
    return (
      num(
        this.ctx.db.prepare('DELETE FROM package_caches WHERE host = ? AND key = ?').run(host, key)
          .changes,
      ) > 0
    );
  }
}
