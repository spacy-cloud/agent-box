import { describe, expect, it, vi } from 'vitest';
import { ExpiryWatcher } from '../../src/main/expiry';
import type { ExpiryCandidate } from '../../src/main/expiry';

const MIN = 60_000;

function setup(list: ExpiryCandidate[], enabled = true) {
  let now = 10_000_000;
  const reported: string[][] = [];
  const lookups = vi.fn();
  const state = { list, enabled };
  const w = new ExpiryWatcher({
    list: () => {
      lookups();
      return Promise.resolve(state.list);
    },
    enabled: () => state.enabled,
    onExpiring: (l) => reported.push(l.map((s) => s.id)),
    warnMs: 10 * MIN,
    intervalMs: 1_000_000,
    now: () => now,
  });
  return { w, reported, lookups, state, advance: (ms: number) => (now += ms), now: () => now };
}

const sb = (id: string, state: string, expiresAt: number): ExpiryCandidate => ({
  id,
  name: id,
  state,
  expiresAt,
});

describe('expiry watcher', () => {
  it('reports running sandboxes inside the warning time, once per expiry time', async () => {
    const t = setup([]);
    const base = t.now();
    t.state.list = [
      sb('soon', 'running', base + 5 * MIN),
      sb('later', 'running', base + 60 * MIN),
      sb('stopped', 'stopped', base + 5 * MIN),
      sb('gone', 'running', base - MIN),
    ];
    await t.w.check();
    expect(t.reported).toEqual([['soon']]);
    t.advance(MIN);
    await t.w.check();
    expect(t.reported).toHaveLength(1); // not again

    t.advance(55 * MIN); // "later" is now due
    await t.w.check();
    expect(t.reported.at(-1)).toEqual(['later']);
  });

  it('warns again after the sandbox was extended', async () => {
    const t = setup([]);
    const base = t.now();
    t.state.list = [sb('a', 'running', base + 5 * MIN)];
    await t.w.check();
    t.state.list = [sb('a', 'running', base + 65 * MIN)]; // extended by an hour
    t.advance(MIN);
    await t.w.check();
    expect(t.reported).toHaveLength(1);
    t.advance(60 * MIN);
    await t.w.check();
    expect(t.reported).toEqual([['a'], ['a']]);
  });

  it('looks nothing up while the kind is off', async () => {
    const t = setup([], false);
    await t.w.check();
    expect(t.lookups).not.toHaveBeenCalled();
  });

  it('survives a failing lookup', async () => {
    const onExpiring = vi.fn();
    const w = new ExpiryWatcher({
      list: () => Promise.reject(new Error('engine down')),
      enabled: () => true,
      onExpiring,
      warnMs: MIN,
      intervalMs: 1_000_000,
    });
    await expect(w.check()).resolves.toBeUndefined();
    expect(onExpiring).not.toHaveBeenCalled();
  });
});
