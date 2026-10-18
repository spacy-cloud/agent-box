import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Abox } from '../abox.js';
import type { HostLiveSource, HostResolver } from '../internals.js';
import type { HostLiveResult } from '../../hosts/live.js';
import { A, EMPTY_WS, HUMAN, HUMAN_YES, created, fakeOf, makeEnv, openAbox } from './harness.js';
import type { OpenOpts, TestEnv } from './harness.js';

const GIB = 1024 ** 3;

let env: TestEnv;
let abox: Abox | undefined;

afterEach(() => {
  abox?.close();
  abox = undefined;
  env.cleanup();
});

type Limits = { cpus?: number; memory?: string; sandboxes?: number };

/** `local` unlimited, `srv` (a "remote" host, fake docker) with the given limits, `down` unreachable. */
function resolver(limits: Limits): HostResolver {
  return async (id) => {
    if (id === 'down')
      throw Object.assign(new Error('host "down" is not reachable'), { code: 'host_unreachable' });
    return {
      connection: { host: id, kind: id === 'srv' ? 'ssh' : 'local' },
      zone: id === 'srv' ? 'lab' : 'workstation',
      backends: ['docker', 'process'],
      ...(id === 'srv' ? { limits } : {}),
    };
  };
}

function live(over: Partial<Extract<HostLiveResult, { ok: true }>['usage']> = {}): HostLiveResult {
  return {
    ok: true,
    usage: {
      ts: 1,
      cpuPercent: 35,
      load: { m1: 0.5, m5: 0.5, m15: 0.5 },
      memoryTotalBytes: 16 * GIB,
      memoryAvailableBytes: 6.4 * GIB,
      cpus: 8,
      source: 'ssh',
      ...over,
    },
  };
}

async function setup(
  limits: Limits = {},
  o: OpenOpts & { liveResult?: HostLiveResult } = {},
): Promise<{ abox: Abox; liveCalls: string[] }> {
  env = makeEnv();
  const liveCalls: string[] = [];
  const hostLive: HostLiveSource = async (id) => {
    liveCalls.push(id);
    return o.liveResult ?? live();
  };
  const { liveResult: _l, ...rest } = o;
  abox = await openAbox(env, {
    hostResolver: resolver(limits),
    hostLive,
    fake: { hostResources: { cpus: 8, memoryBytes: 16 * GIB }, ...o.fake },
    ...rest,
  });
  return { abox, liveCalls };
}

const make = (a: Abox, host: string, o: { cpus?: number; memory?: string } = {}) =>
  a.createSandbox(HUMAN_YES, {
    template: 'fake-box',
    host,
    workspace: EMPTY_WS,
    overrides: { ttl: '20m', ...o },
  });

describe('hostCapacity', () => {
  it('reports the machine, the live numbers, the reservations and the limits', async () => {
    const { abox: a } = await setup({ cpus: 6, memory: '12g', sandboxes: 3 });
    created(await make(a, 'srv', { cpus: 2, memory: '2g' }));
    created(await make(a, 'srv', { cpus: 1, memory: '1g' }));
    created(await make(a, 'local', { cpus: 1 }));
    const c = await a.hostCapacity(HUMAN, 'srv');
    expect(c.host).toBe('srv');
    expect(c.capacity).toEqual({ cpus: 8, memoryBytes: 16 * GIB, source: 'engine' });
    expect(c.live).toEqual({
      available: true,
      cpuPercent: 35,
      load: { m1: 0.5, m5: 0.5, m15: 0.5 },
      memoryTotalBytes: 16 * GIB,
      memoryAvailableBytes: 6.4 * GIB,
      memoryUsedBytes: 16 * GIB - 6.4 * GIB,
      source: 'ssh',
    });
    // only the two sandboxes on srv count, and what they reserve is their limit, not their use
    expect(c.abox.sandboxes).toBe(2);
    expect(c.abox.reserved).toEqual({ cpus: 3, memoryBytes: 3 * GIB });
    expect(c.limits).toEqual({
      sandboxes: { limit: 3, reserved: 2 },
      cpus: { limit: 6, reserved: 3 },
      memoryBytes: { limit: 12 * GIB, reserved: 3 * GIB },
    });
    // a host without limits has none in the answer
    expect((await a.hostCapacity(HUMAN, 'local')).limits).toEqual({});
  });

  it('sums the live use of the running sandboxes of abox on the host', async () => {
    const { abox: a } = await setup(
      {},
      {
        fake: {
          stats: (id) => ({
            ts: 1,
            cpuPercent: id.endsWith('x') ? 10 : 25,
            memoryBytes: 100 * 1024 * 1024,
            memoryLimitBytes: null,
            pids: 1,
          }),
        },
      },
    );
    const one = created(await make(a, 'srv')).sandbox.id;
    created(await make(a, 'srv'));
    const stopped = created(await make(a, 'srv')).sandbox.id;
    await a.stopSandbox(HUMAN, stopped);
    const c = await a.hostCapacity(HUMAN, 'srv');
    expect(c.abox.running).toBe(2);
    expect(c.abox.sandboxes).toBe(3);
    expect(c.abox.usage).toMatchObject({ sampled: 2, memoryBytes: 200 * 1024 * 1024 });
    expect(fakeOf(env).statsCalls).not.toContain(stopped);
    expect(one).toBeTruthy();
    // a backend without stats: no usage, not zero
    abox?.close();
    env.cleanup();
    const { abox: b } = await setup({});
    created(await make(b, 'srv'));
    expect((await b.hostCapacity(HUMAN, 'srv')).abox.usage).toBeNull();
  });

  it('is unknown, not guessed, where live numbers are not available', async () => {
    const { abox: a } = await setup({}, { liveResult: { ok: false, reason: 'login failed' } });
    const c = await a.hostCapacity(HUMAN, 'srv');
    expect(c.live).toEqual({
      available: false,
      reason: 'login failed',
      cpuPercent: null,
      load: null,
      memoryTotalBytes: null,
      memoryAvailableBytes: null,
      memoryUsedBytes: null,
      source: null,
    });
    // the engine still says how big the machine is
    expect(c.capacity.source).toBe('engine');
  });

  it('falls back to /proc for the size when the engine does not say', async () => {
    // a fake engine without hostResources (the option replaces the defaults of setup)
    const { abox: a } = await setup({}, { fake: {} });
    expect((await a.hostCapacity(HUMAN, 'srv')).capacity).toEqual({
      cpus: 8,
      memoryBytes: 16 * GIB,
      source: 'proc',
    });
  });

  it('uses this machine for the size of local when nothing else says', async () => {
    env = makeEnv();
    abox = await openAbox(env, { hostLive: async () => ({ ok: false, reason: 'n/a' }) });
    const c = await abox.hostCapacity(HUMAN, 'local');
    expect(c.capacity.source).toBe('os');
    expect(c.capacity.cpus).toBeGreaterThan(0);
    expect(c.capacity.memoryBytes).toBeGreaterThan(0);
  });

  it('reports the size of a remote host as unknown when neither the engine nor /proc says', async () => {
    const { abox: a } = await setup({}, { fake: {}, liveResult: { ok: false, reason: 'timeout' } });
    const c = await a.hostCapacity(HUMAN, 'srv');
    expect(c.capacity).toEqual({ cpus: null, memoryBytes: null, source: 'unknown' });
    // and an estimate on it can only use the configured limits (here: only the sandbox quota of the profile)
    const e = await a.estimateFit(HUMAN, { hostId: 'srv', template: 'fake-box' });
    expect(e.bounds.every((b) => b.source === 'profile')).toBe(true);
    expect(e.projection.reservedPercent).toEqual({ cpu: null, memory: null });
    expect(e.warnings.map((w) => w.code)).toEqual(['capacity_unknown']);
  });

  it('shares measurements for a few seconds and measures again afterwards', async () => {
    const { abox: a, liveCalls } = await setup();
    await a.hostCapacity(HUMAN, 'srv');
    await a.hostCapacity(HUMAN, 'srv');
    await Promise.all([
      a.hostCapacity(HUMAN, 'srv'),
      a.estimateFit(HUMAN, { hostId: 'srv', template: 'fake-box' }),
    ]);
    expect(liveCalls).toEqual(['srv']);
    expect(fakeOf(env).hostResourcesCalls).toBe(1);
    // another host is another measurement
    await a.hostCapacity(HUMAN, 'local');
    expect(liveCalls).toEqual(['srv', 'local']);
    env.clock.t += 6000;
    await a.hostCapacity(HUMAN, 'srv');
    expect(liveCalls).toEqual(['srv', 'local', 'srv']);
  });

  it('keeps the reservations current even while the measurement is cached', async () => {
    const { abox: a } = await setup();
    expect((await a.hostCapacity(HUMAN, 'srv')).abox.sandboxes).toBe(0);
    created(await make(a, 'srv', { cpus: 2 }));
    const c = await a.hostCapacity(HUMAN, 'srv');
    expect(c.abox.sandboxes).toBe(1);
    expect(c.abox.reserved.cpus).toBe(2);
  });

  it('does not cache a failure', async () => {
    const { abox: a } = await setup();
    await expect(a.hostCapacity(HUMAN, 'down')).rejects.toMatchObject({
      message: expect.stringContaining('not reachable'),
    });
    await expect(a.hostCapacity(HUMAN, 'down')).rejects.toBeTruthy();
  });

  it('is human only and validates the host id', async () => {
    const { abox: a } = await setup();
    await expect(a.hostCapacity(A, 'srv')).rejects.toMatchObject({ code: 'policy_denied' });
    await expect(a.hostCapacity(HUMAN, '../etc')).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(a.hostCapacity(HUMAN, 'x'.repeat(80))).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  it('audits the read of a remote host once per ten minutes, and never reads of this machine', async () => {
    const { abox: a } = await setup();
    await a.hostCapacity(HUMAN, 'local');
    await a.hostCapacity(HUMAN, 'srv');
    env.clock.t += 6000;
    await a.hostCapacity(HUMAN, 'srv');
    const entries = (await a.queryAudit(HUMAN, { action: 'host.capacity' })).filter(
      (e) => e.action === 'host.capacity',
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.details).toEqual({ host: 'srv' });
  });

  it('does not hang on a live source that never answers', async () => {
    vi.useFakeTimers();
    try {
      env = makeEnv();
      abox = await openAbox(env, {
        hostResolver: resolver({}),
        hostLive: () => new Promise(() => undefined),
        fake: { hostResources: { cpus: 2, memoryBytes: GIB } },
      });
      const p = abox.hostCapacity(HUMAN, 'srv');
      await vi.advanceTimersByTimeAsync(41_000);
      expect((await p).live).toMatchObject({ available: false, reason: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('estimateFit', () => {
  it('says how often the planned sandbox fits and what the host looks like with it', async () => {
    const { abox: a } = await setup();
    created(await make(a, 'srv', { cpus: 1, memory: '1g' }));
    const e = await a.estimateFit(HUMAN, {
      hostId: 'srv',
      template: 'fake-box',
      overrides: { cpus: 2, memory: '4g' },
    });
    expect(e.request).toEqual({ template: 'fake-box', cpus: 2, memoryBytes: 4 * GIB });
    // reserved: 1 cpu / 1 GiB + 2 cpus / 4 GiB of 8 / 16; free now: 6.4 GiB -> 1
    expect(e.projection.reservedPercent).toEqual({ cpu: 38, memory: 31 });
    expect(e.projection.usedPercent).toEqual({ cpu: 35, memory: 60 });
    expect(e.fits).toBe(1);
    expect(e.limitedBy).toEqual({ source: 'live', resource: 'memory', count: 1 });
    expect(e.blocked).toEqual([]);
    expect(e.tone).toBe('info');
    expect(e.capacity.abox.sandboxes).toBe(1);
  });

  it('uses the template resources when nothing is overridden', async () => {
    const { abox: a } = await setup();
    const e = await a.estimateFit(HUMAN, { template: 'fake-box' });
    expect(e.host).toBe('local');
    expect(e.request).toMatchObject({ cpus: 1, memoryBytes: 512 * 1024 * 1024 });
  });

  it('shows a host limit that would be exceeded as a refusal before the create', async () => {
    const { abox: a } = await setup({ sandboxes: 2, cpus: 4, memory: '4g' });
    created(await make(a, 'srv', { cpus: 1, memory: '1g' }));
    created(await make(a, 'srv', { cpus: 1, memory: '1g' }));
    const e = await a.estimateFit(HUMAN, { hostId: 'srv', template: 'fake-box' });
    expect(e.tone).toBe('error');
    expect(e.fits).toBe(0);
    expect(e.blocked).toEqual([
      expect.objectContaining({
        kind: 'host_limit',
        field: 'sandboxes',
        reason: expect.stringContaining('its limit is 2'),
      }),
    ]);
    // and the create is refused for the same reason
    await expect(make(a, 'srv')).rejects.toMatchObject({ code: 'policy_denied' });
    const big = await a.estimateFit(HUMAN, {
      hostId: 'srv',
      template: 'fake-box',
      overrides: { cpus: 8, memory: '8g' },
    });
    expect(big.blocked.map((b) => b.field).sort()).toEqual(['cpus', 'memory', 'sandboxes']);
  });

  it('counts a request that fits exactly under the limits as fitting', async () => {
    const { abox: a } = await setup({ sandboxes: 3, cpus: 3, memory: '3g' });
    const e = await a.estimateFit(HUMAN, {
      hostId: 'srv',
      template: 'fake-box',
      overrides: { cpus: 1, memory: '1g' },
    });
    expect(e.blocked).toEqual([]);
    expect(e.fits).toBe(3);
    expect(e.limitedBy).toMatchObject({ source: 'limit' });
    expect(e.projection.limitPercent).toEqual({ sandboxes: 33, cpu: 33, memory: 33 });
  });

  it('warns about memory over-commit without refusing it', async () => {
    const { abox: a } = await setup(
      {},
      { fake: { hostResources: { cpus: 8, memoryBytes: 2 * GIB } } },
    );
    const e = await a.estimateFit(HUMAN, {
      hostId: 'srv',
      template: 'fake-box',
      overrides: { memory: '3g' },
    });
    expect(e.blocked).toEqual([]);
    expect(e.tone).toBe('warn');
    expect(e.warnings.map((w) => w.code)).toContain('memory_overcommit');
    expect(e.fits).toBe(0);
  });

  it('refuses what the profile of the human does not allow, like the create', async () => {
    const { abox: a } = await setup();
    const e = await a.estimateFit(HUMAN, {
      template: 'fake-box',
      overrides: { cpus: 1000 },
    });
    expect(e.blocked.some((b) => b.kind === 'profile_limit' && b.field === 'cpus')).toBe(true);
    expect(e.tone).toBe('error');
  });

  it('validates its input and is human only', async () => {
    const { abox: a } = await setup();
    await expect(a.estimateFit(A, { template: 'fake-box' })).rejects.toMatchObject({
      code: 'policy_denied',
    });
    await expect(a.estimateFit(HUMAN, { template: 'no-such-template' })).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      a.estimateFit(HUMAN, { template: 'fake-box', overrides: { memory: 'lots' } }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      a.estimateFit(HUMAN, { template: 'fake-box', hostId: 'a b' }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      a.estimateFit(HUMAN, { template: 'fake-box', extra: 1 } as never),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('is not audited (a poll) and changes nothing', async () => {
    const { abox: a } = await setup();
    const before = (await a.listSandboxes(HUMAN)).sandboxes.length;
    await a.estimateFit(HUMAN, { template: 'fake-box' });
    expect((await a.listSandboxes(HUMAN)).sandboxes.length).toBe(before);
    expect((await a.queryAudit(HUMAN, { action: 'host.estimate' })).length).toBe(0);
  });
});
