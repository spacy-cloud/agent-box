import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Abox } from '../abox.js';
import {
  A,
  EMPTY_WS,
  HUMAN,
  created,
  createApproved,
  fakeOf,
  makeEnv,
  openAbox,
} from './harness.js';
import type { TestEnv } from './harness.js';
import type { FakeOptions } from './fake-provider.js';

let env: TestEnv;
let abox: Abox;

async function setup(fake: FakeOptions = {}): Promise<void> {
  abox?.close();
  abox = await openAbox(env, { fake });
}

beforeEach(async () => {
  env = makeEnv();
  await setup({ updateResources: true });
});
afterEach(() => {
  abox.close();
  env.cleanup();
});

const newSandbox = async (caller = A): Promise<string> =>
  created(await abox.createSandbox(caller, { template: 'fake-box', workspace: EMPTY_WS })).sandbox
    .id;

describe('access_request kind=resources on a running sandbox', () => {
  it('changes cpu and memory within the profile limit, at once in medium mode', async () => {
    const id = await newSandbox();
    expect((await abox.inspectSandbox(A, id)).resources).toMatchObject({ cpus: 1 });
    const r = await abox.accessRequest(A, id, {
      kind: 'resources',
      details: { cpus: 2, memory: '2g' },
    });
    expect(r.status).toBe('applied');
    expect(fakeOf(env).resourceUpdates).toEqual([{ id, cpus: 2, memoryBytes: 2 * 1024 ** 3 }]);
    // the backend really holds them, and the registry shows the same
    expect(fakeOf(env).sandboxes.get(id)!.spec.resources).toMatchObject({
      cpus: 2,
      memoryBytes: 2 * 1024 ** 3,
    });
    const view = await abox.inspectSandbox(A, id);
    expect(view.resources).toMatchObject({ cpus: 2, memoryBytes: 2 * 1024 ** 3 });
    const audit = await abox.queryAudit(HUMAN, { action: ['sandbox.access_applied'] });
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0])).toContain('"resources"');
  });

  it('a single field changes only that field', async () => {
    const id = await newSandbox();
    const before = (await abox.inspectSandbox(A, id)).resources;
    await abox.accessRequest(A, id, { kind: 'resources', details: { memory: '1g' } });
    expect(fakeOf(env).resourceUpdates).toEqual([{ id, memoryBytes: 1024 ** 3 }]);
    const after = (await abox.inspectSandbox(A, id)).resources;
    expect(after.cpus).toBe(before.cpus);
    expect(after.memoryBytes).toBe(1024 ** 3);
  });

  it('asking for what the sandbox already has changes nothing', async () => {
    const id = await newSandbox();
    const cpus = (await abox.inspectSandbox(A, id)).resources.cpus;
    const r = await abox.accessRequest(A, id, { kind: 'resources', details: { cpus } });
    expect(r.status).toBe('applied');
    expect(fakeOf(env).resourceUpdates).toHaveLength(0);
  });

  it('beyond the profile limit is denied and never reaches the backend', async () => {
    const id = await newSandbox();
    await expect(
      abox.accessRequest(A, id, { kind: 'resources', details: { cpus: 64 } }),
    ).rejects.toMatchObject({ code: 'policy_denied' });
    await expect(
      abox.accessRequest(A, id, { kind: 'resources', details: { memory: '64g' } }),
    ).rejects.toMatchObject({ code: 'policy_denied' });
    expect(fakeOf(env).resourceUpdates).toHaveLength(0);
  });

  it('keeps the registry when the backend refuses, and audits the error', async () => {
    await setup({ updateResources: true, failUpdateResources: 'memory below usage (fake)' });
    const id = await newSandbox();
    const before = (await abox.inspectSandbox(A, id)).resources;
    await expect(
      abox.accessRequest(A, id, { kind: 'resources', details: { cpus: 2 } }),
    ).rejects.toMatchObject({
      code: 'backend_error',
      message: expect.stringContaining('memory below usage'),
    });
    expect((await abox.inspectSandbox(A, id)).resources).toEqual(before);
    const audit = await abox.queryAudit(HUMAN, { action: ['sandbox.access_applied'] });
    expect(audit.map((a) => a.decision)).toEqual(['error']);
  });

  it('strict mode asks a human first, and applies the approved change', async () => {
    const S = { contextId: 'strict-agent' };
    const id = (await createApproved(abox, S, { template: 'fake-box', workspace: EMPTY_WS }))
      .sandbox.id;
    const pending = await abox.accessRequest(S, id, {
      kind: 'resources',
      details: { cpus: 2 },
      reason: 'build is slow',
    });
    expect(pending.status).toBe('pending_approval');
    if (pending.status !== 'pending_approval') return;
    expect(fakeOf(env).resourceUpdates).toHaveLength(0);
    const dec = await abox.approve(HUMAN, pending.approvalId);
    expect(dec.applied?.ok).toBe(true);
    expect(fakeOf(env).resourceUpdates).toEqual([{ id, cpus: 2 }]);
    expect((await abox.inspectSandbox(S, id)).resources.cpus).toBe(2);
  });

  it('says unsupported, queueing nothing, when the backend cannot update limits', async () => {
    await setup({});
    const id = await newSandbox();
    await expect(
      abox.accessRequest(A, id, { kind: 'resources', details: { cpus: 2 } }),
    ).rejects.toMatchObject({ code: 'unsupported', hint: expect.stringContaining('new sandbox') });
    expect(await abox.listApprovals(HUMAN)).toHaveLength(0);
  });
});

describe('access_request kind=network on a sandbox created without an allowlist', () => {
  it('is unsupported with an accurate hint (the mode of a running sandbox is fixed), and queues nothing', async () => {
    await setup({ updateNetwork: true });
    const id = await newSandbox();
    expect((await abox.inspectSandbox(A, id)).network.mode).toBe('none');
    const e = await abox
      .accessRequest(A, id, {
        kind: 'network',
        details: { domains: ['registry.npmjs.org'] },
        reason: 'npm install',
      })
      .catch((x: unknown) => x as { code: string; hint?: string });
    expect(e).toMatchObject({ code: 'unsupported' });
    expect((e as { hint: string }).hint).toContain('overrides.network');
    expect((e as { hint: string }).hint).toContain('mode none');
    // explicitly asking for the mode does not help either
    await expect(
      abox.accessRequest(A, id, {
        kind: 'network',
        details: { mode: 'allowlist', domains: ['registry.npmjs.org'] },
      }),
    ).rejects.toMatchObject({ code: 'unsupported' });
    expect(await abox.listApprovals(HUMAN)).toHaveLength(0);
    expect(fakeOf(env).networkUpdates).toHaveLength(0);
  });
});
