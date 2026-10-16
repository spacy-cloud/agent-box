import { mkdtempSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { isBusyError, migrate, openDatabase, retryBusy, transaction } from './db.js';
import { MIGRATIONS } from './migrations.js';

const tmp: string[] = [];
export function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'abox-state-'));
  tmp.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('openDatabase', () => {
  it('creates a 0600 WAL database with pragmas set', () => {
    const path = join(tempDir(), 'sub', 'state.db');
    const db = openDatabase(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(path, '..')).mode & 0o777).toBe(0o700);
    expect((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe(
      'wal',
    );
    expect((db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout).toBe(5000);
    expect((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(
      1,
    );
    db.prepare('INSERT INTO host_cache (host, info, ok, ts) VALUES (?,?,?,?)').run('h', '{}', 1, 1);
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(path + suffix)) expect(statSync(path + suffix).mode & 0o777).toBe(0o600);
    }
    db.close();
  });

  it('migrations are idempotent across re-opens', () => {
    const path = join(tempDir(), 'state.db');
    const last = MIGRATIONS[MIGRATIONS.length - 1]!.version;
    const a = openDatabase(path);
    expect(migrate(a)).toBe(last);
    a.close();
    const b = openDatabase(path);
    expect(migrate(b)).toBe(last);
    const rows = b.prepare('SELECT version FROM schema_migrations').all();
    expect(rows).toHaveLength(MIGRATIONS.length);
    b.close();
  });

  it('applies only pending migrations and refuses newer databases', () => {
    const path = join(tempDir(), 'state.db');
    const m1 = { version: 1, name: 'a', sql: 'CREATE TABLE a (x)' };
    const m2 = { version: 2, name: 'b', sql: 'CREATE TABLE b (x)' };
    openDatabase(path, { migrations: [m1] }).close();
    const db = openDatabase(path, { migrations: [m1, m2] });
    expect(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()).toEqual({ n: 2 });
    db.close();
    expect(() => openDatabase(path, { migrations: [m1] })).toThrow(/newer abox version/);
  });

  it('failed migration rolls back completely', () => {
    const path = join(tempDir(), 'state.db');
    const bad = { version: 1, name: 'bad', sql: 'CREATE TABLE ok (x); CREATE TABLE ok (x);' };
    expect(() => openDatabase(path, { migrations: [bad] })).toThrow();
    const raw = new DatabaseSync(path);
    expect(raw.prepare(`SELECT name FROM sqlite_master WHERE name = 'ok'`).get()).toBeUndefined();
    raw.close();
  });
});

describe('transaction', () => {
  it('commits, rolls back on throw, and nests', () => {
    const db = openDatabase(':memory:');
    transaction(db, () => {
      db.prepare('INSERT INTO host_cache VALUES (?,?,?,?)').run('a', '{}', 1, 1);
      transaction(db, () =>
        db.prepare('INSERT INTO host_cache VALUES (?,?,?,?)').run('b', '{}', 1, 1),
      );
    });
    expect(() =>
      transaction(db, () => {
        db.prepare('INSERT INTO host_cache VALUES (?,?,?,?)').run('c', '{}', 1, 1);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(
      db
        .prepare('SELECT host FROM host_cache ORDER BY host')
        .all()
        .map((r) => r['host']),
    ).toEqual(['a', 'b']);
    expect(db.isTransaction).toBe(false);
    db.close();
  });

  it('detects real SQLITE_BUSY errors from a second connection', () => {
    const path = join(tempDir(), 'state.db');
    const a = openDatabase(path, { busyTimeoutMs: 20 });
    const b = openDatabase(path, { busyTimeoutMs: 20 });
    a.exec('BEGIN IMMEDIATE');
    let caught: unknown;
    try {
      b.exec('BEGIN IMMEDIATE');
    } catch (e) {
      caught = e;
    }
    expect(isBusyError(caught)).toBe(true);
    // transaction() gives up after the configured attempts and surfaces the busy error
    expect(() => transaction(b, () => 1, { attempts: 2, baseDelayMs: 1 })).toThrow(/locked/);
    a.exec('COMMIT');
    expect(transaction(b, () => 'ok', { attempts: 2, baseDelayMs: 1 })).toBe('ok');
    a.close();
    b.close();
  });

  it('retryBusy retries busy errors only', () => {
    const busy = Object.assign(new Error('database is locked'), { errcode: 5 });
    let n = 0;
    expect(
      retryBusy(
        () => {
          if (++n < 3) throw busy;
          return n;
        },
        { baseDelayMs: 1 },
      ),
    ).toBe(3);
    let m = 0;
    expect(() =>
      retryBusy(() => {
        m++;
        throw new Error('other');
      }),
    ).toThrow('other');
    expect(m).toBe(1);
  });
});
