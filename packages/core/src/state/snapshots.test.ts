import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from './db.js';
import { MIGRATIONS } from './migrations.js';
import type { SandboxInput } from './sandbox-registry.js';
import { StateStore } from './store.js';

let dir: string;
let dbPath: string;
let clock: number;
const opened: StateStore[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'abox-snap-'));
  dbPath = join(dir, 'state.db');
  clock = 5_000;
});
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
  rmSync(dir, { recursive: true, force: true });
});

const box = (id: string): SandboxInput => ({
  id,
  host: 'local',
  name: 'n',
  owner: 'human',
  template: 't',
  templateHash: 'h',
  backend: 'docker',
  isolation: 'container',
  state: 'running',
  createdAt: 1,
  expiresAt: 2,
});

function open(): StateStore {
  const s = StateStore.open(dbPath, { now: () => clock });
  opened.push(s);
  return s;
}

describe('snapshot index', () => {
  it('records, lists oldest first, replaces on the same id and forgets per sandbox', () => {
    const s = open();
    s.snapshots.add({ sandboxId: 'local/aaaaaaaa', snapshotId: 's1', name: 'one' });
    clock += 10;
    s.snapshots.add({ sandboxId: 'local/aaaaaaaa', snapshotId: 's2', name: 'two' });
    s.snapshots.add({ sandboxId: 'local/bbbbbbbb', snapshotId: 's1', name: 'other' });
    expect(
      s.snapshots.list('local/aaaaaaaa').map((x) => [x.snapshotId, x.name, x.createdAt]),
    ).toEqual([
      ['s1', 'one', 5_000],
      ['s2', 'two', 5_010],
    ]);
    clock += 10;
    s.snapshots.add({ sandboxId: 'local/aaaaaaaa', snapshotId: 's1', name: 'one-again' });
    expect(s.snapshots.get('local/aaaaaaaa', 's1')).toMatchObject({
      name: 'one-again',
      createdAt: 5_020,
    });
    expect(s.snapshots.deleteAll('local/aaaaaaaa')).toBe(2);
    expect(s.snapshots.list('local/aaaaaaaa')).toEqual([]);
    expect(s.snapshots.list('local/bbbbbbbb')).toHaveLength(1);
  });
});

describe('network event cursor', () => {
  it('is empty until set and stored per sandbox', () => {
    const s = open();
    s.sandboxes.upsert(box('local/aaaaaaaa'));
    s.sandboxes.upsert(box('local/bbbbbbbb'));
    expect(s.sandboxes.getNetCursor('local/aaaaaaaa')).toBeUndefined();
    s.sandboxes.setNetCursor('local/aaaaaaaa', { ts: 1234, seen: 3 });
    expect(s.sandboxes.getNetCursor('local/aaaaaaaa')).toEqual({ ts: 1234, seen: 3 });
    expect(s.sandboxes.getNetCursor('local/bbbbbbbb')).toBeUndefined();
    // an upsert of the row keeps the cursor
    s.sandboxes.upsert({ ...box('local/aaaaaaaa'), state: 'stopped' });
    expect(s.sandboxes.getNetCursor('local/aaaaaaaa')).toEqual({ ts: 1234, seen: 3 });
  });
});

describe('migration 3 on an existing database', () => {
  it('upgrades a version 2 database in place and keeps its rows', () => {
    const v2 = MIGRATIONS.filter((m) => m.version <= 2);
    const old = openDatabase(dbPath, { migrations: v2 });
    old
      .prepare(
        `INSERT INTO sandboxes (id, host, name, owner, template, template_hash, backend, isolation, state, created_at, expires_at)
         VALUES ('local/cccccccc','local','n','human','t','h','docker','container','running',1,2)`,
      )
      .run();
    old.close();
    const s = open();
    expect(s.sandboxes.get('local/cccccccc')).toMatchObject({ state: 'running' });
    expect(s.sandboxes.getNetCursor('local/cccccccc')).toBeUndefined();
    s.sandboxes.setNetCursor('local/cccccccc', { ts: 9, seen: 1 });
    expect(s.sandboxes.getNetCursor('local/cccccccc')).toEqual({ ts: 9, seen: 1 });
    s.snapshots.add({ sandboxId: 'local/cccccccc', snapshotId: 'x', name: 'x' });
    expect(s.snapshots.list('local/cccccccc')).toHaveLength(1);
  });
});

describe('migration 5 on an existing database', () => {
  it('upgrades a version 4 database in place; old approvals have no recorded items', () => {
    const v4 = MIGRATIONS.filter((m) => m.version <= 4);
    const old = openDatabase(dbPath, { migrations: v4 });
    old
      .prepare(
        `INSERT INTO approvals (id, requester, kind, request, request_hash, risks, status, ttl_ms, created_at, expires_at)
         VALUES ('a1','agent:x/default','create','{"template":{"name":"t"}}','h','["r"]','pending',60000,1,${Date.now() + 60_000})`,
      )
      .run();
    old.close();
    const s = open();
    expect(s.approvals.get('a1')).toMatchObject({ kind: 'create', risks: ['r'], items: [] });
    const fresh = s.approvals.create({
      requester: 'agent:x/default',
      kind: 'create',
      request: { n: 1 },
      items: [{ kind: 'mount', reason: 'why', risk: 'what', invariant: false }],
      ttlMs: 1000,
    });
    expect(s.approvals.get(fresh.id)?.items.map((i) => i.kind)).toEqual(['mount']);
  });
});
