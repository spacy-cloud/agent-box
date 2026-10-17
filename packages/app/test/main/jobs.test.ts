import { describe, expect, it, vi } from 'vitest';
import type { Abox } from '@abox/core';
import { createManagerHandlers } from '../../src/main/service';

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** A manager whose create / estimate wait until their signal fires (or are released by hand). */
function fakeAbox() {
  const seen: Array<{ signal?: AbortSignal; onProgress?: (l: string, i?: unknown) => void }> = [];
  const release: Array<() => void> = [];
  const wait = (opts: { signal?: AbortSignal } | undefined, result: unknown) =>
    new Promise((resolve, reject) => {
      release.push(() => resolve(result));
      opts?.signal?.addEventListener('abort', () => reject(new Error('create cancelled')));
    });
  const abox = {
    createSandbox: vi.fn((_c: unknown, _r: unknown, opts?: { signal?: AbortSignal }) => {
      seen.push(opts ?? {});
      return wait(opts, { status: 'created' });
    }),
    estimateWorkspace: vi.fn((_c: unknown, _r: unknown, opts?: { signal?: AbortSignal }) => {
      seen.push(opts ?? {});
      return wait(opts, { applicable: true, bytes: 1 });
    }),
  } as unknown as Abox;
  return { abox, seen, release };
}

describe('cancellable calls', () => {
  it('jobs:cancel aborts a running create by its progress key', async () => {
    const { abox, seen } = fakeAbox();
    const h = createManagerHandlers({ abox, paths: {} as never });
    const running = h['sandboxes:create']({ template: 'alpine-min', progressKey: 'create-1' }, {});
    const outcome = running.then(
      () => 'done',
      (e: Error) => e.message,
    );
    await flush();
    expect(seen[0]?.signal?.aborted).toBe(false);
    await expect(h['jobs:cancel']({ key: 'create-1' }, {})).resolves.toEqual({ cancelled: true });
    expect(seen[0]?.signal?.aborted).toBe(true);
    await expect(outcome).resolves.toBe('create cancelled');
    // gone afterwards
    await expect(h['jobs:cancel']({ key: 'create-1' }, {})).resolves.toEqual({ cancelled: false });
  });

  it('a create without a key has no signal; a finished call leaves nothing to cancel', async () => {
    const { abox, seen, release } = fakeAbox();
    const h = createManagerHandlers({ abox, paths: {} as never });
    const p = h['sandboxes:create']({ template: 'alpine-min' }, {});
    await flush();
    expect(seen[0]?.signal).toBeUndefined();
    release[0]!();
    await p;
    const q = h['workspace:estimate']({ path: '/p', progressKey: 'estimate-1' }, {});
    release[1]!();
    await q;
    await expect(h['jobs:cancel']({ key: 'estimate-1' }, {})).resolves.toEqual({
      cancelled: false,
    });
  });

  it('a new estimate with the same key cancels the older one', async () => {
    const { abox, seen, release } = fakeAbox();
    const h = createManagerHandlers({ abox, paths: {} as never });
    const first = h['workspace:estimate']({ path: '/a', progressKey: 'estimate-1' }, {});
    const firstOutcome = first.then(
      () => 'done',
      () => 'cancelled',
    );
    const second = h['workspace:estimate']({ path: '/b', progressKey: 'estimate-1' }, {});
    expect(seen[0]?.signal?.aborted).toBe(true);
    expect(seen[1]?.signal?.aborted).toBe(false);
    release[1]!();
    await expect(second).resolves.toMatchObject({ bytes: 1 });
    await expect(firstOutcome).resolves.toBe('cancelled');
  });

  it('forwards progress lines with their numbers under the key', async () => {
    const { abox, seen, release } = fakeAbox();
    const h = createManagerHandlers({ abox, paths: {} as never });
    const lines: Array<[string, string, unknown]> = [];
    const p = h['sandboxes:create'](
      { template: 'alpine-min', progressKey: 'create-2' },
      { onProgress: (k, l, i) => lines.push([k, l, i]) },
    );
    await flush();
    seen[0]!.onProgress!('copying workspace … 1.0 MiB of 2.0 MiB', {
      phase: 'copy',
      done: 1,
      total: 2,
    });
    release[0]!();
    await p;
    expect(lines).toEqual([
      ['create-2', 'copying workspace … 1.0 MiB of 2.0 MiB', { phase: 'copy', done: 1, total: 2 }],
    ]);
  });

  it('estimates as the human context', async () => {
    const { abox, release } = fakeAbox();
    const h = createManagerHandlers({ abox, paths: {} as never });
    const p = h['workspace:estimate']({ path: '/p', mode: 'copy', exclude: ['x'] }, {});
    release[0]!();
    await p;
    expect(abox.estimateWorkspace).toHaveBeenCalledWith(
      { contextId: 'human' },
      { path: '/p', mode: 'copy', exclude: ['x'] },
      expect.any(Object),
    );
  });
});
