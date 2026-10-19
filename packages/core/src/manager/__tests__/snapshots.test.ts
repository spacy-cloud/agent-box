import { writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { Abox } from '../abox.js';
import type { SnapshotRef } from '../types.js';
import {
  A,
  EMPTY_WS,
  HUMAN,
  HUMAN_YES,
  created,
  fakeOf,
  makeEnv,
  openAbox,
  projectTemplate,
  writeProjectTemplate,
} from './harness.js';
import type { OpenOpts, TestEnv } from './harness.js';

let env: TestEnv;
let abox: Abox | undefined;

const MANAGED: OpenOpts = {
  fake: { capabilities: { snapshots: true }, snapshotManagement: true },
};

async function setup(o: OpenOpts = MANAGED): Promise<Abox> {
  env = makeEnv();
  abox = await openAbox(env, o);
  return abox;
}
afterEach(() => {
  abox?.close();
  abox = undefined;
  env.cleanup();
});

async function newBox(a: Abox, template = 'fake-box', extra: Record<string, unknown> = {}) {
  return created(await a.createSandbox(HUMAN_YES, { template, workspace: EMPTY_WS, ...extra }))
    .sandbox.id;
}

const refOf = (sandboxId: string, snapshotId: string): SnapshotRef => ({
  backend: 'docker',
  sandboxId,
  snapshotId,
});

describe('snapshot lists', () => {
  it('shows size, whether it can be deleted and cloned; without backend support only the record', async () => {
    const a = await setup();
    const id = await newBox(a);
    fakeOf(env).sandboxes.get(id)!.files.set('/workspace/node_modules/x', Buffer.alloc(1234));
    const { snapshotId } = await a.snapshot(HUMAN, id, 'installed');
    const [view] = await a.listSnapshots(HUMAN, id);
    expect(view).toMatchObject({
      id: snapshotId,
      name: 'installed',
      sizeBytes: 1234,
      deletable: true,
      cloneable: true,
    });
    expect(view!.cloneBlocked).toBeUndefined();
    await a.close();
    abox = undefined;
    env.cleanup();

    // a backend that can snapshot but not list, delete or clone
    const b = await setup({ fake: { capabilities: { snapshots: true } } });
    const id2 = await newBox(b);
    const snap = await b.snapshot(HUMAN, id2, 'plain');
    expect(await b.listSnapshots(HUMAN, id2)).toEqual([
      {
        id: snap.snapshotId,
        name: 'plain',
        createdAt: expect.any(Number),
        deletable: false,
        cloneable: false,
        cloneBlocked: 'backend',
      },
    ]);
    const all = await b.listAllSnapshots(HUMAN);
    expect(all.snapshots.map((s) => s.id)).toEqual([snap.snapshotId]);
    expect(all.totalBytes).toBe(0);
    await expect(b.deleteSnapshots(HUMAN, [refOf(id2, snap.snapshotId)])).resolves.toMatchObject({
      removed: [],
      errors: [{ code: 'unsupported' }],
    });
  });

  it('lists every sandbox with its name and the total, marks those of deleted sandboxes, human only', async () => {
    const a = await setup({ fake: { ...MANAGED.fake!, keepSnapshotsOnRemove: true } });
    const one = await newBox(a, 'fake-box', { name: 'first' });
    const two = await newBox(a, 'fake-box', { name: 'second' });
    fakeOf(env).sandboxes.get(one)!.files.set('/a', Buffer.alloc(100));
    fakeOf(env).sandboxes.get(two)!.files.set('/b', Buffer.alloc(250));
    env.clock.t += 1000;
    const s1 = await a.snapshot(HUMAN, one, 'one');
    env.clock.t += 1000;
    const s2 = await a.snapshot(HUMAN, two, 'two');
    await a.removeSandbox(HUMAN_YES, two);

    const all = await a.listAllSnapshots(HUMAN);
    expect(all.totalBytes).toBe(350);
    expect(all.unreachable).toEqual([]);
    expect(all.snapshots.map((s) => [s.id, s.sandboxName, s.orphaned, s.sizeBytes])).toEqual([
      [s1.snapshotId, 'first', false, 100],
      [s2.snapshotId, undefined, true, 250],
    ]);
    expect(all.snapshots[1]).toMatchObject({
      sandboxId: two,
      template: 'fake-box',
      backend: 'docker',
      host: 'local',
    });
    // the per-sandbox list of a deleted sandbox is gone with it
    await expect(a.listSnapshots(HUMAN, two)).rejects.toMatchObject({ code: 'not_found' });

    await expect(a.listAllSnapshots(A)).rejects.toMatchObject({ code: 'policy_denied' });
  });
});

describe('delete', () => {
  it('removes the chosen snapshots and the index entry, audits each, leaves the rest and the sandbox', async () => {
    const a = await setup();
    const id = await newBox(a);
    const s1 = await a.snapshot(HUMAN, id, 'one');
    const s2 = await a.snapshot(HUMAN, id, 'two');
    const r = await a.deleteSnapshots(HUMAN, [refOf(id, s1.snapshotId)]);
    expect(r).toEqual({ removed: [refOf(id, s1.snapshotId)], errors: [] });
    expect((await a.listSnapshots(HUMAN, id)).map((s) => s.id)).toEqual([s2.snapshotId]);
    expect(fakeOf(env).snapshotDeleted).toEqual([s1.snapshotId]);
    expect((await a.inspectSandbox(HUMAN, id)).state).toBe('running');
    const audit = await a.queryAudit(HUMAN, { action: 'snapshot.delete', order: 'asc' });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      decision: 'allow',
      sandboxId: id,
      details: { snapshotId: s1.snapshotId, name: 'one', backend: 'docker', sandboxGone: false },
    });
  });

  it('reports a failing snapshot without stopping the others; only a human may delete', async () => {
    const a = await setup();
    const one = await newBox(a);
    const two = await newBox(a);
    const mine = await a.snapshot(HUMAN, one, 'mine');
    const theirs = await a.snapshot(HUMAN, two, 'theirs');
    const r = await a.deleteSnapshots(HUMAN, [
      refOf(one, theirs.snapshotId), // another sandbox's snapshot named under this one
      refOf(one, mine.snapshotId),
      { backend: 'vm', sandboxId: one, snapshotId: 'x' }, // no such backend configured
    ]);
    expect(r.removed).toEqual([refOf(one, mine.snapshotId)]);
    expect(r.errors.map((e) => e.ref.snapshotId)).toEqual([theirs.snapshotId, 'x']);
    expect(r.errors[0]).toMatchObject({ code: 'not_found' });
    expect((await a.listSnapshots(HUMAN, two)).map((s) => s.id)).toEqual([theirs.snapshotId]);

    await expect(a.deleteSnapshots(A, [refOf(one, mine.snapshotId)])).rejects.toMatchObject({
      code: 'policy_denied',
    });
    await expect(a.deleteSnapshots(HUMAN, [])).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      a.deleteSnapshots(HUMAN, [{ backend: 'docker', sandboxId: '../x', snapshotId: 'x' }]),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('deletes the snapshot of a sandbox that is gone', async () => {
    const a = await setup({ fake: { ...MANAGED.fake!, keepSnapshotsOnRemove: true } });
    const id = await newBox(a);
    const s = await a.snapshot(HUMAN, id, 'left');
    await a.removeSandbox(HUMAN_YES, id);
    expect((await a.listAllSnapshots(HUMAN)).snapshots.map((x) => x.orphaned)).toEqual([true]);
    const r = await a.deleteSnapshots(HUMAN, [refOf(id, s.snapshotId)]);
    expect(r.errors).toEqual([]);
    expect((await a.listAllSnapshots(HUMAN)).snapshots).toEqual([]);
    const audit = await a.queryAudit(HUMAN, { action: 'snapshot.delete' });
    expect(audit[0]!.details).toMatchObject({ sandboxGone: true });
  });
});

describe('gc', () => {
  it('lists the snapshots of deleted sandboxes on a dry run and removes only those', async () => {
    const a = await setup({ fake: { ...MANAGED.fake!, keepSnapshotsOnRemove: true } });
    const live = await newBox(a);
    const gone = await newBox(a);
    const keep = await a.snapshot(HUMAN, live, 'keep');
    const left = await a.snapshot(HUMAN, gone, 'left');
    await a.removeSandbox(HUMAN_YES, gone);

    const dry = await a.gc(HUMAN, { dryRun: true });
    expect(dry.snapshots).toMatchObject([
      { sandboxId: gone, snapshotId: left.snapshotId, name: 'left', backend: 'docker' },
    ]);
    expect(fakeOf(env).snapshotDeleted).toEqual([]);

    const real = await a.gc(HUMAN, {});
    expect(real.snapshots.map((s) => s.snapshotId)).toEqual([left.snapshotId]);
    expect(real.errors).toEqual([]);
    expect(fakeOf(env).snapshotDeleted).toEqual([left.snapshotId]);
    expect((await a.listAllSnapshots(HUMAN)).snapshots.map((s) => s.id)).toEqual([keep.snapshotId]);
    const audit = await a.queryAudit(HUMAN, { action: 'snapshot.gc' });
    expect(audit).toHaveLength(1);
  });
});

describe('a sandbox the registry forgot', () => {
  it('is not gone while the backend still has it: its snapshots are not leftovers and gc keeps them', async () => {
    const a = await setup();
    const known = await newBox(a);
    const fake = fakeOf(env);
    // the backend has a sandbox the registry does not know (a lost state database)
    const stray = { ...fake.specs.find((x) => x.id === known)!, id: 'local/cafebabe' };
    await fake.create(stray);
    const snap = await fake.snapshot!(stray.id, 'kept');

    const all = await a.listAllSnapshots(HUMAN);
    expect(all.snapshots.find((x) => x.id === snap)).toMatchObject({
      sandboxId: stray.id,
      orphaned: false,
    });
    const gc = await a.gc(HUMAN, {});
    expect(gc.snapshots).toEqual([]);
    expect(fake.snapshotDeleted).toEqual([]);

    // once the backend sandbox is gone as well, the snapshot is a leftover
    fake.sandboxes.delete(stray.id);
    expect((await a.listAllSnapshots(HUMAN)).snapshots.find((x) => x.id === snap)?.orphaned).toBe(
      true,
    );
    expect((await a.gc(HUMAN, {})).snapshots.map((x) => x.snapshotId)).toEqual([snap]);
  });
});

describe('create from a snapshot', () => {
  async function source(a: Abox, template = 'fake-box') {
    const id = await newBox(a, template);
    fakeOf(env).sandboxes.get(id)!.files.set('/workspace/node_modules/x', Buffer.from('dep'));
    const { snapshotId } = await a.snapshot(HUMAN, id, 'installed');
    return { id, snapshotId, src: { sandboxId: id, snapshotId } };
  }

  it('starts from the files of the snapshot, with the limits, network and policy of its own request', async () => {
    const a = await setup();
    const { src } = await source(a, 'fake-net');
    const r = created(
      await a.createFromSnapshot(HUMAN_YES, src, {
        template: 'fake-net',
        name: 'second',
        overrides: { memory: '256m', network: { mode: 'none' } },
      }),
    );
    const fake = fakeOf(env);
    const spec = fake.specs.at(-1)!;
    expect(spec.id).toBe(r.sandbox.id);
    expect(spec.fromSnapshot).toBe(src.snapshotId);
    // never what the snapshot's sandbox had
    expect(spec.network.mode).toBe('none');
    expect(spec.resources.memoryBytes).toBe(256 * 1024 * 1024);
    expect(spec.workspace.kind).toBe('none');
    expect([...fake.sandboxes.get(r.sandbox.id)!.files.keys()]).toEqual([
      '/workspace/node_modules/x',
    ]);
    const detail = await a.inspectSandbox(HUMAN, r.sandbox.id);
    expect(detail.name).toBe('second');
    const audit = await a.queryAudit(HUMAN, { action: 'sandbox.create', order: 'asc' });
    expect(audit.at(-1)!.details).toMatchObject({ fromSnapshot: src });
    expect(audit.at(-1)!.sandboxId).toBe(r.sandbox.id);
  });

  it('is a human action; an agent cannot name a snapshot', async () => {
    const a = await setup();
    const { src } = await source(a);
    await expect(a.createFromSnapshot(A, src, { template: 'fake-box' })).rejects.toMatchObject({
      code: 'policy_denied',
    });
    await expect(
      a.createSandbox(A, { template: 'fake-box', workspace: EMPTY_WS }, { fromSnapshot: src }),
    ).rejects.toMatchObject({ code: 'policy_denied' });
    // and the request schema has no field for it
    await expect(
      a.createSandbox(A, { template: 'fake-box', fromSnapshot: src } as never),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(fakeOf(env).specs.filter((s) => s.fromSnapshot)).toEqual([]);
  });

  it("still runs the create checks: a template changed since needs the human's confirmation again", async () => {
    const a = await setup();
    const file = writeProjectTemplate(env);
    const { src } = await source(a, 'proj-tpl');
    writeFileSync(file, projectTemplate('proj-tpl', 'env: { EXTRA: "1" }\n'));
    const specs = fakeOf(env).specs.length;
    const asked = await a.createFromSnapshot(HUMAN, src, { template: 'proj-tpl' });
    expect(asked.status).toBe('confirmation_required');
    expect(fakeOf(env).specs.length).toBe(specs);
    created(await a.createFromSnapshot(HUMAN_YES, src, { template: 'proj-tpl' }));
    // a snapshot lives on its own host
    await expect(
      a.createFromSnapshot(HUMAN_YES, src, { template: 'proj-tpl', host: 'elsewhere' }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('refuses a snapshot taken with another template, a copy workspace and unknown snapshots', async () => {
    const a = await setup();
    const { src } = await source(a, 'fake-box');
    await expect(
      a.createFromSnapshot(HUMAN_YES, src, { template: 'fake-net' }),
    ).rejects.toMatchObject({
      code: 'invalid_input',
      message: expect.stringContaining("'fake-box'"),
    });
    await expect(
      a.createFromSnapshot(HUMAN_YES, src, {
        template: 'fake-box',
        workspace: { mode: 'copy', path: env.project },
      }),
    ).rejects.toMatchObject({ code: 'invalid_input', message: expect.stringContaining('copies') });
    await expect(
      a.createFromSnapshot(
        HUMAN_YES,
        { sandboxId: src.sandboxId, snapshotId: 'snap-99-nope' },
        { template: 'fake-box' },
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      a.createFromSnapshot(
        HUMAN_YES,
        { sandboxId: '../x', snapshotId: 'x' },
        { template: 'fake-box' },
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(fakeOf(env).specs.filter((s) => s.fromSnapshot)).toEqual([]);
  });

  it('refuses a snapshot that holds secrets, also when only the registry knows', async () => {
    const a = await setup({ fake: { ...MANAGED.fake!, keepSnapshotsOnRemove: true } });
    const envSecret = await source(a, 'fake-env-secret');
    expect(fakeOf(env).specs.find((s) => s.id === envSecret.id)!.secretMaterial).toBe(true);
    const view = (await a.listSnapshots(HUMAN, envSecret.id))[0]!;
    expect(view).toMatchObject({ cloneable: false, cloneBlocked: 'secrets' });
    await expect(
      a.createFromSnapshot(HUMAN_YES, envSecret.src, { template: 'fake-env-secret' }),
    ).rejects.toMatchObject({ code: 'policy_denied' });

    // a proxy secret never enters the sandbox: its snapshot can be cloned
    const proxySecret = await source(a, 'fake-secret');
    expect(fakeOf(env).specs.find((s) => s.id === proxySecret.id)!.secretMaterial).toBe(false);
    created(await a.createFromSnapshot(HUMAN_YES, proxySecret.src, { template: 'fake-secret' }));

    // a snapshot from before the backend recorded it: the registry decides while the sandbox exists
    const plain = await source(a, 'fake-box');
    fakeOf(env).snapshotStore.get(plain.snapshotId)!.carriesSecrets = undefined;
    created(await a.createFromSnapshot(HUMAN_YES, plain.src, { template: 'fake-box' }));
    fakeOf(env).snapshotStore.get(envSecret.snapshotId)!.carriesSecrets = undefined;
    await expect(
      a.createFromSnapshot(HUMAN_YES, envSecret.src, { template: 'fake-env-secret' }),
    ).rejects.toMatchObject({ code: 'policy_denied' });
    // the record of a removed sandbox still says what it was created with
    await a.removeSandbox(HUMAN_YES, plain.id);
    created(await a.createFromSnapshot(HUMAN_YES, plain.src, { template: 'fake-box' }));
    // ... but a snapshot nothing knows anything about counts as holding secrets
    fakeOf(env).snapshotStore.set('snap-stray', {
      ...fakeOf(env).snapshotStore.get(plain.snapshotId)!,
      snapshotId: 'snap-stray',
      sandboxId: 'local/deadbeef',
    });
    await expect(
      a.createFromSnapshot(
        HUMAN_YES,
        { sandboxId: 'local/deadbeef', snapshotId: 'snap-stray' },
        { template: 'fake-box' },
      ),
    ).rejects.toMatchObject({ code: 'policy_denied' });
  });

  it('is unsupported where the backend creates from templates only', async () => {
    const a = await setup({ fake: { capabilities: { snapshots: true } } });
    const id = await newBox(a);
    const { snapshotId } = await a.snapshot(HUMAN, id, 'x');
    await expect(
      a.createFromSnapshot(HUMAN_YES, { sandboxId: id, snapshotId }, { template: 'fake-box' }),
    ).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('is idempotent per request id and distinguishes the snapshot', async () => {
    const a = await setup();
    const one = await source(a);
    const two = await a.snapshot(HUMAN, one.id, 'again');
    const req = { template: 'fake-box', requestId: 'clone-1' };
    const first = created(await a.createFromSnapshot(HUMAN_YES, one.src, req));
    const again = created(await a.createFromSnapshot(HUMAN_YES, one.src, req));
    expect(again.idempotent).toBe(true);
    expect(again.sandbox.id).toBe(first.sandbox.id);
    await expect(
      a.createFromSnapshot(HUMAN_YES, { sandboxId: one.id, snapshotId: two.snapshotId }, req),
    ).rejects.toMatchObject({ code: expect.stringMatching(/conflict|invalid_input/) });
  });
});
