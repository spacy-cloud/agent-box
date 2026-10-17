import { afterEach, describe, expect, it } from 'vitest';
import type { Abox } from '../abox.js';
import { A, EMPTY_WS, HUMAN, HUMAN_YES, created, fakeOf, makeEnv, openAbox } from './harness.js';
import type { OpenOpts, TestEnv } from './harness.js';

let env: TestEnv;
let abox: Abox | undefined;

async function setup(o: OpenOpts = {}): Promise<Abox> {
  env = makeEnv();
  abox = await openAbox(env, o);
  return abox;
}
afterEach(() => {
  abox?.close();
  abox = undefined;
  env.cleanup();
});

const box = async (a: Abox, caller = HUMAN_YES): Promise<string> =>
  created(await a.createSandbox(caller, { template: 'fake-box', workspace: EMPTY_WS })).sandbox.id;

describe('sandboxStats (live cpu / memory)', () => {
  it('returns one sample per running sandbox and leaves out the others', async () => {
    const a = await setup({ fake: { stats: true } });
    const running = await box(a);
    const stopped = await box(a);
    await a.stopSandbox(HUMAN, stopped);
    const r = await a.sandboxStats(HUMAN, [running, stopped, 'local/ffffffff', running]);
    expect(Object.keys(r.usage)).toEqual([running]);
    expect(r.usage[running]).toMatchObject({
      cpuPercent: 12.5,
      memoryBytes: 64 * 1024 * 1024,
      memoryLimitBytes: 256 * 1024 * 1024,
      pids: 3,
    });
    // duplicates are asked once, a stopped sandbox is not asked at all
    expect(fakeOf(env).statsCalls).toEqual([running]);
  });

  it('a backend without stats yields no data (the GUI shows the configured limits)', async () => {
    const a = await setup();
    const id = await box(a);
    expect(await a.sandboxStats(HUMAN, [id])).toEqual({ usage: {} });
  });

  it('one failing sample does not hide the others', async () => {
    let n = 0;
    const a = await setup({
      fake: {
        stats: () => {
          if (++n === 1) throw new Error('engine busy');
          return { ts: 1, cpuPercent: 1, memoryBytes: 2, memoryLimitBytes: null, pids: null };
        },
      },
    });
    const ids = [await box(a), await box(a)];
    const r = await a.sandboxStats(HUMAN, ids);
    expect(Object.keys(r.usage)).toHaveLength(1);
  });

  it('is human only and validates its input', async () => {
    const a = await setup({ fake: { stats: true } });
    const id = await box(a, A);
    await expect(a.sandboxStats(A, [id])).rejects.toMatchObject({ code: 'policy_denied' });
    await expect(a.sandboxStats(HUMAN, 'x' as unknown as string[])).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(
      a.sandboxStats(
        HUMAN,
        Array.from({ length: 201 }, (_, i) => `local/${i}`),
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    // an agent's sandbox is visible to the human
    expect(Object.keys((await a.sandboxStats(HUMAN, [id])).usage)).toEqual([id]);
  });

  it('is not audited (it is a poll)', async () => {
    const a = await setup({ fake: { stats: true } });
    const id = await box(a);
    const before = (await a.queryAudit(HUMAN, { limit: 5000 })).length;
    await a.sandboxStats(HUMAN, [id]);
    await a.sandboxStats(HUMAN, [id]);
    expect((await a.queryAudit(HUMAN, { limit: 5000 })).length).toBe(before);
  });
});
