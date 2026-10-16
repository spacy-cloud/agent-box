import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Abox } from '../abox.js';
import { A, EMPTY_WS, HUMAN, created, fakeOf, makeEnv, openAbox } from './harness.js';
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
  await setup();
});
afterEach(() => {
  abox.close();
  env.cleanup();
});

const newSandbox = async (): Promise<string> =>
  created(await abox.createSandbox(A, { template: 'fake-box', workspace: EMPTY_WS })).sandbox.id;

describe('extending the lifetime moves the backend deadline', () => {
  it('asks the backend first, then records the same expiry in the registry', async () => {
    const id = await newSandbox();
    const before = (await abox.inspectSandbox(A, id)).expiresAt;
    const r = await abox.extendTtl(A, id, '1h');
    expect(r.status).toBe('applied');
    const after = (await abox.inspectSandbox(A, id)).expiresAt;
    expect(after - before).toBeGreaterThanOrEqual(3_599_000);
    const calls = fakeOf(env).expiryUpdates;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ id, expiresAt: after });
    // the backend now reports the same deadline
    expect((await fakeOf(env).inspect(id)).expiresAt).toBe(after);
  });

  it('works the same through access_request kind=ttl', async () => {
    const id = await newSandbox();
    const r = await abox.accessRequest(A, id, { kind: 'ttl', details: { ttl: '30m' } });
    expect(r.status).toBe('applied');
    expect(fakeOf(env).expiryUpdates).toHaveLength(1);
  });

  it('leaves the registry alone and reports the error when the backend fails', async () => {
    await setup({ failExtendExpiry: 'cannot move the deadline (fake)' });
    const id = await newSandbox();
    const before = await abox.inspectSandbox(A, id);
    await expect(abox.extendTtl(A, id, '1h')).rejects.toMatchObject({
      code: 'backend_error',
      message: expect.stringContaining('cannot move the deadline'),
    });
    const after = await abox.inspectSandbox(A, id);
    expect(after.expiresAt).toBe(before.expiresAt);
    expect(after.resources.ttlMs).toBe(before.resources.ttlMs);
    expect(fakeOf(env).expiryUpdates).toHaveLength(0);
  });

  it('says unsupported (with a hint) when the backend cannot move its deadline', async () => {
    await setup({ noExtendExpiry: true });
    const id = await newSandbox();
    const before = (await abox.inspectSandbox(A, id)).expiresAt;
    await expect(abox.extendTtl(A, id, '1h')).rejects.toMatchObject({
      code: 'unsupported',
      hint: expect.stringContaining('new sandbox'),
    });
    expect((await abox.inspectSandbox(A, id)).expiresAt).toBe(before);
    // nothing was queued for a human to approve
    expect(await abox.listApprovals(HUMAN)).toHaveLength(0);
  });
});
