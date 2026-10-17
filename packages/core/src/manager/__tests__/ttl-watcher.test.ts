import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Abox } from '../abox.js';
import { AboxError } from '../../errors.js';
import { A, EMPTY_WS, HUMAN, created, makeEnv, openAbox } from './harness.js';
import type { TestEnv } from './harness.js';

let env: TestEnv;
let abox: Abox;
let stops: Array<() => void> = [];

beforeEach(async () => {
  env = makeEnv();
  abox = await openAbox(env);
});
afterEach(() => {
  for (const stop of stops) stop();
  stops = [];
  abox.close();
  env.cleanup();
});

const watch = (onError?: (e: unknown) => void): void => {
  stops.push(abox.startTtlWatcher({ intervalMs: 20, ...(onError ? { onError } : {}) }));
};

/** A started sandbox of agent A with the 20 minute default TTL of the test policy. */
async function runningSandbox(): Promise<string> {
  const id = created(await abox.createSandbox(A, { template: 'fake-box', workspace: EMPTY_WS }))
    .sandbox.id;
  await abox.startSandbox(A, id);
  expect(env.fakes[0]!.sandboxes.get(id)!.state).toBe('running');
  return id;
}
const backendState = (id: string): string | undefined => env.fakes[0]!.sandboxes.get(id)?.state;

describe('the background TTL watcher', () => {
  it('stops an overdue sandbox although nothing else calls the manager', async () => {
    const id = await runningSandbox();
    watch();
    // nothing is overdue yet: the watcher leaves it alone
    await new Promise((r) => setTimeout(r, 100));
    expect(backendState(id)).toBe('running');
    env.clock.t += 3 * 3600_000;
    await vi.waitFor(() => expect(backendState(id)).toBe('stopped'), { timeout: 3000 });
    const audit = await abox.queryAudit(HUMAN, { action: ['sandbox.expired'] });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ sandboxId: id, actor: 'system' });
    expect((await abox.inspectSandbox(A, id)).state).toBe('expired');
  });

  it('keeps nothing alive when the deadline was moved behind the registry in the backend', async () => {
    // a backend that reports and honours a later deadline than the registry has (the container
    // was told so from the inside): the registry decides
    const id = await runningSandbox();
    const fake = env.fakes[0]!;
    fake.sandboxes.get(id)!.spec.expiresAt += 99 * 3600_000;
    watch();
    env.clock.t += 3 * 3600_000;
    await vi.waitFor(() => expect(backendState(id)).toBe('stopped'), { timeout: 3000 });
  });

  it('retries a stop that failed, and audits the failure once', async () => {
    const id = await runningSandbox();
    const fake = env.fakes[0]!;
    let failures = 3;
    const stop = fake.stop.bind(fake);
    const spy = vi.spyOn(fake, 'stop').mockImplementation((sid) => {
      if (failures-- > 0) return Promise.reject(new AboxError('backend_error', 'engine busy'));
      return stop(sid);
    });
    watch();
    env.clock.t += 3 * 3600_000;
    await vi.waitFor(() => expect(backendState(id)).toBe('stopped'), { timeout: 3000 });
    // the sweep itself failed once, the retries came from the watcher; later rounds ask no more
    const calls = spy.mock.calls.length;
    expect(calls).toBeGreaterThanOrEqual(4);
    await new Promise((r) => setTimeout(r, 150));
    expect(spy.mock.calls.length).toBe(calls);
    const expired = await abox.queryAudit(HUMAN, { action: ['sandbox.expired'] });
    expect(expired).toHaveLength(1);
    expect(JSON.stringify(expired[0])).toContain('engine busy');
    const failed = await abox.queryAudit(HUMAN, { action: ['sandbox.expired_stop'] });
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ decision: 'error' });
  });

  it('a backend that never stops is reported once, not on every round', async () => {
    const id = await runningSandbox();
    const fake = env.fakes[0]!;
    const spy = vi
      .spyOn(fake, 'stop')
      .mockImplementation(() => Promise.reject(new AboxError('backend_error', 'gone fishing')));
    watch();
    env.clock.t += 3 * 3600_000;
    await vi.waitFor(() => expect(spy.mock.calls.length).toBeGreaterThanOrEqual(5), {
      timeout: 3000,
    });
    expect(backendState(id)).toBe('running');
    const failed = await abox.queryAudit(HUMAN, { action: ['sandbox.expired_stop'] });
    expect(failed).toHaveLength(1);
  });

  it('does not touch sandboxes that are not overdue, nor remove expired ones', async () => {
    const id = await runningSandbox();
    watch();
    env.clock.t += 3 * 3600_000;
    await vi.waitFor(() => expect(backendState(id)).toBe('stopped'), { timeout: 3000 });
    await new Promise((r) => setTimeout(r, 100));
    // still there for an export; removal is `gc`
    expect(env.fakes[0]!.sandboxes.has(id)).toBe(true);
  });

  it('survives a failing round and reports it', async () => {
    const id = await runningSandbox();
    const errors: unknown[] = [];
    const internals = (abox as unknown as { I: { sweepTtl: () => Promise<string[]> } }).I;
    vi.spyOn(internals, 'sweepTtl')
      .mockRejectedValueOnce(new Error('database is locked'))
      .mockImplementation(() => Promise.resolve([]));
    watch((e) => errors.push(e));
    await vi.waitFor(() => expect(errors).toHaveLength(1), { timeout: 3000 });
    expect(backendState(id)).toBe('running');
  });

  it('stops with its function and with close(); several watchers do not double-expire', async () => {
    const id = await runningSandbox();
    const stop = abox.startTtlWatcher({ intervalMs: 20 });
    stop();
    env.clock.t += 3 * 3600_000;
    await new Promise((r) => setTimeout(r, 150));
    expect(backendState(id)).toBe('running');
    // two watchers in this process, a second instance on the same database
    const other = await openAbox(env, { bare: true });
    try {
      watch();
      watch();
      stops.push(other.startTtlWatcher({ intervalMs: 20 }));
      await vi.waitFor(() => expect(backendState(id)).toBe('stopped'), { timeout: 3000 });
      await new Promise((r) => setTimeout(r, 100));
      expect(await abox.queryAudit(HUMAN, { action: ['sandbox.expired'] })).toHaveLength(1);
    } finally {
      other.close();
    }
  });
});
