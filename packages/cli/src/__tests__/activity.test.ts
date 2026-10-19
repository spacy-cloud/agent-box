import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ActivityOptions, ActivityView, Caller } from '@abox/core';
import type { AboxRuntime } from '@abox/runtime';
import { makeEnv, run, type RunResult, type TestEnv } from './harness.js';

/** What `abox activity` prints and passes on, against a stub manager (the derivation is tested in packages/core). */
const ID = 'local/1a2b3c4d';

const VIEW: ActivityView = {
  sandboxId: ID,
  entries: [
    {
      seq: 9,
      ts: Date.parse('2026-10-18T10:00:05'),
      kind: 'exec',
      action: 'sandbox.exec',
      actor: 'claude-code',
      outcome: 'ok',
      summary: 'Command: pnpm test',
      subject: 'pnpm test',
      detail: { exitCode: 0 },
      count: 1,
      sandboxId: ID,
    },
    {
      seq: 8,
      ts: Date.parse('2026-10-18T10:00:01'),
      kind: 'network',
      action: 'network.egress',
      actor: 'claude-code',
      outcome: 'denied',
      summary: 'Request denied: evil.example',
      subject: 'evil.example',
      detail: { reason: 'not in allowlist' },
      count: 3,
      sandboxId: ID,
    },
  ],
  nextCursor: '8',
};

let t: TestEnv;
beforeEach(() => {
  t = makeEnv();
});
afterEach(() => t.cleanup());

function stub(): {
  calls: Array<{ caller: Caller; id: string; o: ActivityOptions }>;
  rt: AboxRuntime;
} {
  const calls: Array<{ caller: Caller; id: string; o: ActivityOptions }> = [];
  const abox = {
    activity: (caller: Caller, id: string, o: ActivityOptions) => {
      calls.push({ caller, id, o });
      return Promise.resolve(VIEW);
    },
  };
  const rt = {
    abox,
    caller: { contextId: 'human' },
    close: () => Promise.resolve(),
  } as unknown as AboxRuntime;
  return { calls, rt };
}
const act = (s: ReturnType<typeof stub>, args: string[]): Promise<RunResult> =>
  run(t, ['activity', ...args], { openRuntime: () => Promise.resolve(s.rt) });

describe('abox activity', () => {
  it('prints the timeline as a table and says how to get older entries', async () => {
    const s = stub();
    const r = await act(s, [ID]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('Command: pnpm test');
    expect(r.stdout).toContain('exit 0');
    expect(r.stdout).toContain('denied');
    expect(r.stdout).toContain('3x, not in allowlist');
    expect(r.stdout).toContain('--cursor 8');
    expect(s.calls[0]).toMatchObject({ caller: { contextId: 'human' }, id: ID, o: { limit: 100 } });
  });

  it('passes --kind, --since, --limit and --cursor on', async () => {
    const s = stub();
    const before = Date.now();
    const r = await act(s, [
      ID,
      '--kind',
      'exec,network',
      '--since',
      '1h',
      '--limit',
      '7',
      '--cursor',
      '12',
    ]);
    expect(r.code, r.stderr).toBe(0);
    const o = s.calls[0]!.o;
    expect(o.kinds).toEqual(['exec', 'network']);
    expect(o.limit).toBe(7);
    expect(o.cursor).toBe('12');
    expect(o.since!).toBeGreaterThan(before - 3_600_000 - 5000);
    expect(o.since!).toBeLessThan(Date.now() - 3_600_000 + 5000);
  });

  it('refuses an unknown kind before asking the manager', async () => {
    const s = stub();
    const r = await act(s, [ID, '--kind', 'exec,bogus']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('unknown kind');
    expect(s.calls).toHaveLength(0);
  });

  it('--json prints the view as it is', async () => {
    const r = await act(stub(), [ID, '--json']);
    expect(r.code).toBe(0);
    expect(r.json.ok).toBe(true);
    expect(r.json.data.nextCursor).toBe('8');
    expect(r.json.data.entries[0]).toMatchObject({ kind: 'exec', action: 'sandbox.exec' });
  });
});
