import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AboxError } from '../errors.js';
import { MIGRATIONS } from './migrations.js';
import type { Migration } from './migrations.js';

export type Clock = () => number;

/** What every repository needs: the connection and a (testable) clock. */
export interface RepoContext {
  db: DatabaseSync;
  now: Clock;
}

export interface OpenDatabaseOptions {
  /** `busy_timeout` in ms (default 5000). */
  busyTimeoutMs?: number;
  /** Migration list override (tests). */
  migrations?: readonly Migration[];
}

const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;

/** True for SQLITE_BUSY / SQLITE_LOCKED (including extended result codes). */
export function isBusyError(e: unknown): boolean {
  const code = (e as { errcode?: unknown } | null)?.errcode;
  if (typeof code === 'number') {
    const primary = code & 0xff;
    return primary === SQLITE_BUSY || primary === SQLITE_LOCKED;
  }
  return false;
}

export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface RetryOptions {
  /** Maximum number of attempts (default 8). */
  attempts?: number;
  /** First backoff in ms; doubles each attempt with jitter (default 10). */
  baseDelayMs?: number;
}

/** Run `fn`, retrying while SQLite reports BUSY/LOCKED. */
export function retryBusy<T>(fn: () => T, opts: RetryOptions = {}): T {
  const attempts = opts.attempts ?? 8;
  let delay = opts.baseDelayMs ?? 10;
  for (let attempt = 1; ; attempt++) {
    try {
      return fn();
    } catch (e) {
      if (!isBusyError(e) || attempt >= attempts) throw e;
      sleepSync(delay + Math.floor(Math.random() * delay));
      delay = Math.min(delay * 2, 500);
    }
  }
}

export interface TransactionOptions extends RetryOptions {
  /** `immediate` (default) takes the write lock up front, avoiding upgrade deadlocks. */
  mode?: 'deferred' | 'immediate' | 'exclusive';
}

/**
 * Run `fn` in a transaction; commits on return, rolls back on throw, and retries the
 * whole transaction on SQLITE_BUSY. `fn` must be synchronous and idempotent with respect
 * to side effects outside the database. Nested calls join the outer transaction.
 */
export function transaction<T>(db: DatabaseSync, fn: () => T, opts: TransactionOptions = {}): T {
  if (db.isTransaction) return fn();
  const begin = `BEGIN ${(opts.mode ?? 'immediate').toUpperCase()}`;
  return retryBusy(() => {
    db.exec(begin);
    let result: T;
    try {
      result = fn();
      db.exec('COMMIT');
    } catch (e) {
      if (db.isTransaction) {
        try {
          db.exec('ROLLBACK');
        } catch {
          /* connection is in a bad state; the original error is more useful */
        }
      }
      throw e;
    }
    return result;
  }, opts);
}

/** Apply all pending migrations. Idempotent and safe to run from several processes. */
export function migrate(db: DatabaseSync, migrations: readonly Migration[] = MIGRATIONS): number {
  retryBusy(() =>
    db.exec(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version    INTEGER PRIMARY KEY,
         name       TEXT NOT NULL,
         applied_at INTEGER NOT NULL
       )`,
    ),
  );
  const currentVersion = (): number =>
    Number(
      (
        db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get() as {
          v: number;
        }
      ).v,
    );

  const latest = migrations.reduce((max, m) => Math.max(max, m.version), 0);
  const existing = retryBusy(currentVersion);
  if (existing > latest) {
    throw new AboxError(
      'internal',
      `state database has schema version ${existing}, but this abox only knows up to ${latest} (written by a newer abox version)`,
      { hint: 'Update abox; the database was written by a newer version.' },
    );
  }

  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (m.version <= existing) continue;
    transaction(db, () => {
      // Re-check under the write lock: another process may have applied it meanwhile.
      const done = db
        .prepare('SELECT 1 AS x FROM schema_migrations WHERE version = ?')
        .get(m.version);
      if (done) return;
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        m.version,
        m.name,
        Date.now(),
      );
    });
  }
  return retryBusy(currentVersion);
}

/**
 * Open (creating if needed) the shared state database: file mode 0600, WAL,
 * `busy_timeout`, foreign keys on, migrations applied.
 */
export function openDatabase(path: string, opts: OpenDatabaseOptions = {}): DatabaseSync {
  const isMemory = path === ':memory:' || path === '';
  if (!isMemory) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // Pre-create with 0600 so SQLite (and its -wal/-shm companions, which inherit the mode)
    // never exist with looser permissions.
    closeSync(openSync(path, 'a', 0o600));
    chmodSync(path, 0o600);
  }
  const busy = opts.busyTimeoutMs ?? 5000;
  const db = new DatabaseSync(isMemory ? ':memory:' : path, {
    timeout: busy,
    enableForeignKeyConstraints: true,
  });
  try {
    db.exec(`PRAGMA busy_timeout = ${Math.trunc(busy)}`);
    if (!isMemory) retryBusy(() => db.exec('PRAGMA journal_mode = WAL'));
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db, opts.migrations ?? MIGRATIONS);
  } catch (e) {
    db.close();
    throw e;
  }
  return db;
}
