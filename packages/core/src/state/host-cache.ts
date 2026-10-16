import type { RepoContext } from './db.js';
import { fromJson, num } from './json.js';
import type { Row } from './json.js';

export interface HostCacheEntry {
  host: string;
  /** Last probe result (version, capabilities, …). */
  info: unknown;
  /** Whether the last probe succeeded. */
  ok: boolean;
  ts: number;
  /** True when the entry is older than the requested max age. */
  stale: boolean;
}

export const DEFAULT_HOST_CACHE_MAX_AGE_MS = 5 * 60_000;

/** Last known state of remote hosts, so offline hosts can still be listed. */
export class HostCache {
  private readonly ctx: RepoContext;

  constructor(ctx: RepoContext) {
    this.ctx = ctx;
  }

  put(host: string, info: unknown, ok: boolean, ts: number = this.ctx.now()): void {
    this.ctx.db
      .prepare(
        `INSERT INTO host_cache (host, info, ok, ts) VALUES (?, ?, ?, ?)
         ON CONFLICT(host) DO UPDATE SET info = excluded.info, ok = excluded.ok, ts = excluded.ts`,
      )
      .run(host, JSON.stringify(info ?? null), ok ? 1 : 0, ts);
  }

  get(host: string, maxAgeMs: number = DEFAULT_HOST_CACHE_MAX_AGE_MS): HostCacheEntry | undefined {
    const row = this.ctx.db.prepare('SELECT * FROM host_cache WHERE host = ?').get(host);
    return row ? this.toEntry(row, maxAgeMs) : undefined;
  }

  list(maxAgeMs: number = DEFAULT_HOST_CACHE_MAX_AGE_MS): HostCacheEntry[] {
    return this.ctx.db
      .prepare('SELECT * FROM host_cache ORDER BY host')
      .all()
      .map((r) => this.toEntry(r, maxAgeMs));
  }

  delete(host: string): boolean {
    return num(this.ctx.db.prepare('DELETE FROM host_cache WHERE host = ?').run(host).changes) > 0;
  }

  private toEntry(r: Row, maxAgeMs: number): HostCacheEntry {
    const ts = num(r['ts']);
    return {
      host: r['host'] as string,
      info: fromJson<unknown>(r['info'], null),
      ok: num(r['ok']) !== 0,
      ts,
      stale: this.ctx.now() - ts > maxAgeMs,
    };
  }
}
