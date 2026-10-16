import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ForeignResource } from '../../types.js';
import type { Abox } from '../abox.js';
import type { AboxEvent } from '../types.js';
import {
  A,
  B,
  EMPTY_WS,
  HUMAN,
  HUMAN_YES,
  created,
  fakeOf,
  makeEnv,
  openAbox,
  testPolicy,
} from './harness.js';
import type { TestEnv } from './harness.js';

let env: TestEnv;
let abox: Abox;
beforeEach(async () => {
  env = makeEnv();
  abox = await openAbox(env);
});
afterEach(() => {
  abox.close();
  env.cleanup();
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('policy', () => {
  it('validatePolicy reports field paths and lines without changing anything', () => {
    expect(abox.validatePolicy(testPolicy(env)).ok).toBe(true);
    const bad = abox.validatePolicy('profiles:\n  p:\n    approvall: strict\n');
    expect(bad.ok).toBe(false);
    expect(bad.issues[0]).toMatchObject({ line: 3 });
    expect(abox.validatePolicy('x'.repeat(300_000)).ok).toBe(false);
  });

  it('setPolicy writes the file (0600), records a revision, audits and reloads', async () => {
    const before = abox.policyHash;
    const text = testPolicy(env) + '\n# v2\n';
    const r = await abox.setPolicy(HUMAN, text);
    expect(r.changed).toBe(true);
    expect(abox.policyHash).toBe(r.contentHash);
    expect(abox.policyHash).not.toBe(before);
    expect(readFileSync(abox.paths.policyFile, 'utf8')).toBe(text);
    expect(statSync(abox.paths.policyFile).mode & 0o777).toBe(0o600);
    const entry = (await abox.queryAudit(HUMAN, { action: 'policy.set' }))[0]!;
    expect(entry.details).toMatchObject({
      oldHash: before,
      newHash: r.contentHash,
      revision: r.revision,
    });
    expect((await abox.setPolicy(HUMAN, text)).changed).toBe(false);
    await expect(abox.setPolicy(HUMAN, 'profiles:\n  p:\n    bogus: 1\n')).rejects.toMatchObject({
      code: 'invalid_input',
    });
    expect(abox.policyHash).toBe(r.contentHash);
  });

  it('picks up edits made by a human in another process; a broken edit keeps the last good policy', async () => {
    const good = abox.policyHash;
    await sleep(520);
    writeFileSync(abox.paths.policyFile, testPolicy(env).replace('sandboxes: 5', 'sandboxes: 1'));
    await abox.listSandboxes(A);
    expect(abox.policyHash).not.toBe(good);
    expect((await abox.showPolicy(A)).profile.limits.sandboxes).toBe(1);
    const edited = abox.policyHash;
    await sleep(520);
    writeFileSync(abox.paths.policyFile, 'profiles: [not, a, map]');
    await abox.listSandboxes(A);
    expect(abox.policyHash).toBe(edited);
    expect(await abox.queryAudit(HUMAN, { action: 'policy.reload_failed' })).toHaveLength(1);
  });

  it('every policy revision is stored', async () => {
    await abox.setPolicy(HUMAN, testPolicy(env) + '\n# one\n');
    await abox.setPolicy(HUMAN, testPolicy(env) + '\n# two\n');
    expect((await abox.showPolicy(HUMAN)).policy.revision).toBeGreaterThanOrEqual(3);
  });
});

describe('audit, tokens, events', () => {
  it('the hash chain verifies and exports as JSON lines', async () => {
    created(await abox.createSandbox(A, { template: 'fake-box', workspace: EMPTY_WS }));
    const v = await abox.verifyAudit(HUMAN);
    expect(v.ok).toBe(true);
    expect(v.checked).toBeGreaterThan(1);
    let text = '';
    const n = await abox.exportAudit(HUMAN, {}, { write: (c) => (text += c) });
    expect(text.trim().split('\n')).toHaveLength(n);
    expect(JSON.parse(text.split('\n')[0]!)).toHaveProperty('hash');
  });

  it('agent tokens: create, verify, revoke; removed contexts stop working', async () => {
    const t = await abox.createAgentToken(HUMAN, 'agent-a', 'orca');
    expect(t.token).toMatch(/^abox_/);
    expect(abox.verifyAgentToken(t.token)).toBe('agent-a');
    expect(abox.verifyAgentToken(t.token + 'x')).toBeUndefined();
    expect((await abox.listAgentTokens(HUMAN))[0]).not.toHaveProperty('token');
    expect(JSON.stringify(await abox.queryAudit(HUMAN, { limit: 1000 }))).not.toContain(t.token);
    expect(await abox.revokeAgentToken(HUMAN, t.id)).toBe(true);
    expect(abox.verifyAgentToken(t.token)).toBeUndefined();

    const t2 = await abox.createAgentToken(HUMAN, 'agent-b', 'x');
    await abox.setPolicy(HUMAN, testPolicy(env).replace('  agent-b: { profile: agent }\n', ''));
    expect(abox.verifyAgentToken(t2.token)).toBeUndefined();
  });

  it('emits in-process events', async () => {
    const events: AboxEvent[] = [];
    const off = abox.onEvent((e) => events.push(e));
    const sb = created(await abox.createSandbox(A, { template: 'fake-box', workspace: EMPTY_WS }));
    const p = await abox.createSandbox(
      A,
      {
        template: 'fake-box',
        workspace: EMPTY_WS,
        overrides: { network: { mode: 'allowlist', allow: ['x.example.org'] } },
      },
      { waitForApprovalMs: 0 },
    );
    if (p.status !== 'pending_approval') throw new Error('x');
    await abox.approve(HUMAN, p.approvalId);
    await abox.removeSandbox(A, sb.sandbox.id);
    expect(events.map((e) => e.type)).toEqual([
      'sandbox.created',
      'approval.created',
      'approval.decided',
      'sandbox.removed',
    ]);
    off();
    await abox.setPolicy(HUMAN, testPolicy(env) + '\n#x\n');
    expect(events).toHaveLength(4);
  });

  it('listApprovals filters by status; expireApprovals flips overdue ones', async () => {
    const p = await abox.createSandbox(
      A,
      {
        template: 'fake-box',
        workspace: EMPTY_WS,
        overrides: { network: { mode: 'allowlist', allow: ['x.example.org'] } },
      },
      { waitForApprovalMs: 0 },
    );
    if (p.status !== 'pending_approval') throw new Error('x');
    expect((await abox.listApprovals(HUMAN, { status: 'pending' })).map((a) => a.id)).toEqual([
      p.approvalId,
    ]);
    env.clock.t += abox.config.limits.approvalTtlMs + 1;
    expect(await abox.listApprovals(HUMAN, { status: 'pending' })).toEqual([]);
    expect((await abox.listApprovals(HUMAN, { status: 'expired' })).map((a) => a.id)).toEqual([
      p.approvalId,
    ]);
    expect(await abox.expireApprovals(HUMAN)).toEqual([]);
  });
});

describe('doctor and reconcile', () => {
  it('a healthy system reports ok', async () => {
    created(await abox.createSandbox(A, { template: 'fake-box', workspace: EMPTY_WS }));
    const d = await abox.doctor(HUMAN);
    expect(d.ok).toBe(true);
    expect(d.backends.map((b) => b.backend).sort()).toEqual(['docker', 'process']);
    expect(d.backends.every((b) => b.available)).toBe(true);
    expect(d.audit.ok).toBe(true);
    expect(d.policy.source).toBe('file');
    expect(d.reconcile).toMatchObject({ orphans: [], ghosts: [], interrupted: [], expired: [] });
  });

  it('warns when policy.yaml is writable by others', async () => {
    chmodSync(abox.paths.policyFile, 0o666);
    const d = await abox.doctor(HUMAN);
    expect(d.checks.find((c) => c.id === 'policy.perms')).toMatchObject({ level: 'warn' });
    expect(d.ok).toBe(true);
  });

  it('reports ghosts, orphans and expired sandboxes consistently and deletes nothing itself', async () => {
    const keep = created(
      await abox.createSandbox(A, { template: 'fake-box', workspace: EMPTY_WS }),
    );
    const ghost = created(
      await abox.createSandbox(A, { template: 'fake-box', workspace: EMPTY_WS }),
    );
    const old = created(
      await abox.createSandbox(A, {
        template: 'fake-box',
        workspace: EMPTY_WS,
        overrides: { ttl: '5m' },
      }),
    );
    const fake = fakeOf(env);
    fake.sandboxes.delete(ghost.sandbox.id);
    const spec = { ...fake.specs[0]!, id: 'local/aaaaaaaa', name: 'stray' };
    await fake.create(spec);

    const list = await abox.listSandboxes(HUMAN);
    expect(list.orphans.map((o) => o.id)).toEqual(['local/aaaaaaaa']);
    const g = list.sandboxes.find((s) => s.id === ghost.sandbox.id)!;
    expect(g).toMatchObject({ stale: true, missingInBackend: true });
    expect((await abox.listSandboxes(A)).orphans).toEqual([]);

    env.clock.t += 10 * 60_000;
    const d = await abox.doctor(HUMAN);
    expect(d.ok).toBe(true);
    expect(d.reconcile.orphans.map((e) => e.id)).toEqual(['local/aaaaaaaa']);
    expect(d.reconcile.ghosts.map((e) => e.id)).toEqual([ghost.sandbox.id]);
    expect(d.reconcile.expired.map((e) => e.id)).toEqual([old.sandbox.id]);
    expect(d.checks.filter((c) => c.level === 'warn').length).toBeGreaterThanOrEqual(3);
    expect(fake.sandboxes.has('local/aaaaaaaa')).toBe(true);
    expect(fake.sandboxes.has(keep.sandbox.id)).toBe(true);

    const applied = await abox.reconcile(HUMAN, { apply: true });
    expect(applied.applied.removed).toEqual([ghost.sandbox.id]);
    expect(applied.applied.orphansRemoved).toEqual([]);
    expect(fake.sandboxes.has('local/aaaaaaaa')).toBe(true);
    const withOrphans = await abox.reconcile(HUMAN, { apply: true, removeOrphans: true });
    expect(withOrphans.applied.orphansRemoved).toEqual(['local/aaaaaaaa']);
    expect(fake.sandboxes.has('local/aaaaaaaa')).toBe(false);
    expect((await abox.doctor(HUMAN)).reconcile.ghosts).toEqual([]);
  });

  it('a fresh open marks a vanished sandbox as stale without deleting anything', async () => {
    abox.close();
    abox = await openAbox(env, { bare: true });
    const sb = created(
      await abox.createSandbox(HUMAN_YES, {
        template: 'host-shell',
        workspace: { mode: 'copy', path: env.project },
      }),
    );
    const { rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    rmSync(join(abox.paths.dataDir, 'process', 'sandboxes', sb.sandbox.id.split('/')[1]!), {
      recursive: true,
    });
    abox.close();
    abox = await openAbox(env, { bare: true });
    const v = (await abox.listSandboxes(HUMAN)).sandboxes[0]!;
    expect(v).toMatchObject({ id: sb.sandbox.id, stale: true, missingInBackend: true });
    expect(existsSync(abox.paths.stateDb)).toBe(true);
    await abox.reconcile(HUMAN, { apply: true });
    expect((await abox.listSandboxes(HUMAN)).sandboxes).toEqual([]);
  });

  it('humans can start a stopped sandbox; others see not_found', async () => {
    const sb = created(await abox.createSandbox(A, { template: 'fake-box', workspace: EMPTY_WS }));
    await abox.stopSandbox(A, sb.sandbox.id);
    await expect(abox.startSandbox(B, sb.sandbox.id)).rejects.toMatchObject({ code: 'not_found' });
    expect((await abox.startSandbox(HUMAN, sb.sandbox.id)).state).toBe('running');
  });
});

describe('gc --orphans', () => {
  const res = (
    o: Partial<ForeignResource> & Pick<ForeignResource, 'kind' | 'ref'>,
  ): ForeignResource => ({
    name: `abox-${o.ref}`,
    instance: 'lost0000lost0000',
    engine: 'docker',
    ...o,
  });
  const FOREIGN = [
    res({ kind: 'volume', ref: 'v1' }),
    res({ kind: 'network', ref: 'n1', role: 'network' }),
    res({
      kind: 'container',
      ref: 'c1',
      aboxName: 'work',
      sandboxId: 'local/aaaaaaaa',
      state: 'running',
      createdAt: Date.now() - 3600_000,
    }),
    res({ kind: 'container', ref: 'c2', instance: 'other000other000' }),
    res({ kind: 'container', ref: 'c3', instance: '' }),
  ];

  async function reopen(foreign: ForeignResource[], failRemove?: string): Promise<void> {
    abox.close();
    abox = await openAbox(env, {
      fake: { foreign, ...(failRemove ? { failForeignRemove: failRemove } : {}) },
    });
  }

  it('lists by default, containers first, and removes nothing', async () => {
    await reopen(FOREIGN);
    const r = await abox.gcOrphans(HUMAN);
    expect(r).toMatchObject({ dryRun: true, removed: [], errors: [] });
    expect(r.resources.map((x) => x.ref)).toEqual(['c2', 'c3', 'c1', 'n1', 'v1']);
    expect(r.resources.find((x) => x.ref === 'c1')).toMatchObject({
      host: 'local',
      backend: 'docker',
      aboxName: 'work',
      instance: 'lost0000lost0000',
      state: 'running',
    });
    // the process backend has no engine objects: reported, not an error
    expect(r.skipped).toContainEqual({
      host: 'local',
      backend: 'process',
      reason: 'not supported',
    });
    expect(fakeOf(env).foreignRemoved).toEqual([]);
    const audit = await abox.queryAudit(HUMAN, { action: 'gc.orphans' });
    expect(audit[0]?.details).toMatchObject({ remove: false, found: 5, removed: 0 });
  });

  it('removes the listed resources only with remove, and audits each one', async () => {
    await reopen(FOREIGN);
    const r = await abox.gcOrphans(HUMAN, { remove: true });
    expect(r.dryRun).toBe(false);
    expect(r.removed.map((x) => x.ref)).toEqual(['c2', 'c3', 'c1', 'n1', 'v1']);
    expect(fakeOf(env).foreignResources).toEqual([]);
    const entries = await abox.queryAudit(HUMAN, { action: 'resource.gc_orphan' });
    expect(entries).toHaveLength(5);
    expect(entries.every((e) => e.decision === 'allow')).toBe(true);
    expect(entries.map((e) => e.details?.['name'])).toContain('abox-c1');
    expect((await abox.gcOrphans(HUMAN)).resources).toEqual([]);
  });

  it('--instance narrows to one abox.instance', async () => {
    await reopen(FOREIGN);
    const r = await abox.gcOrphans(HUMAN, { instance: 'other000other000', remove: true });
    expect(r.removed.map((x) => x.ref)).toEqual(['c2']);
    expect(fakeOf(env).foreignResources.map((x) => x.ref)).toEqual(['v1', 'n1', 'c1', 'c3']);
  });

  it('a failing removal is reported and does not stop the others', async () => {
    await reopen(FOREIGN, 'c1');
    const r = await abox.gcOrphans(HUMAN, { remove: true });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain('c1');
    expect(r.removed.map((x) => x.ref)).toEqual(['c2', 'c3', 'n1', 'v1']);
    const failed = (await abox.queryAudit(HUMAN, { action: 'resource.gc_orphan' })).filter(
      (e) => e.decision === 'error',
    );
    expect(failed).toHaveLength(1);
  });

  it('is for humans only', async () => {
    await reopen(FOREIGN);
    await expect(abox.gcOrphans(A, { remove: true })).rejects.toMatchObject({
      code: 'policy_denied',
    });
    expect(fakeOf(env).foreignResources).toHaveLength(5);
  });

  it('never touches sandboxes of this instance (they are not listed by the provider)', async () => {
    await reopen([]);
    const sb = created(await abox.createSandbox(A, { template: 'fake-box', workspace: EMPTY_WS }));
    const r = await abox.gcOrphans(HUMAN, { remove: true });
    expect(r.resources).toEqual([]);
    expect((await abox.inspectSandbox(HUMAN, sb.sandbox.id)).state).toBe('running');
  });
});
