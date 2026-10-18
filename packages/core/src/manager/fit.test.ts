import { describe, expect, it } from 'vitest';
import { computeFit, describeFit } from './fit.js';
import type { FitEstimate, HostCapacity } from './types.js';

const GIB = 1024 ** 3;

function cap(over: {
  cpus?: number | null;
  mem?: number | null;
  reserved?: { cpus: number; memoryBytes: number };
  sandboxes?: number;
  limits?: HostCapacity['limits'];
  live?: Partial<HostCapacity['live']> | 'off';
}): HostCapacity {
  const total = over.mem === undefined ? 16 * GIB : over.mem;
  const live: HostCapacity['live'] =
    over.live === 'off'
      ? {
          available: false,
          reason: 'x',
          cpuPercent: null,
          load: null,
          memoryTotalBytes: null,
          memoryAvailableBytes: null,
          memoryUsedBytes: null,
          source: null,
        }
      : {
          available: true,
          cpuPercent: 35,
          load: { m1: 1, m5: 1, m15: 1 },
          memoryTotalBytes: total,
          memoryAvailableBytes: total === null ? null : Math.round(total * 0.4),
          memoryUsedBytes: total === null ? null : Math.round(total * 0.6),
          source: 'ssh',
          ...over.live,
        };
  return {
    host: 'home-server',
    ts: 1,
    capacity: {
      cpus: over.cpus === undefined ? 8 : over.cpus,
      memoryBytes: total,
      source: over.cpus === null && total === null ? 'unknown' : 'engine',
    },
    live,
    abox: {
      sandboxes: over.sandboxes ?? 0,
      running: 0,
      reserved: over.reserved ?? { cpus: 0, memoryBytes: 0 },
      usage: null,
    },
    limits: over.limits ?? {},
  };
}

const fit = (c: HostCapacity, cpus = 2, memGib = 4, blocked: FitEstimate['blocked'] = []) =>
  computeFit({ request: { cpus, memoryBytes: memGib * GIB }, capacity: c, blocked });

describe('computeFit: the ceilings', () => {
  it('by reservation against the machine: the smaller of cpu and memory decides', () => {
    // 8 cpus / 16 GiB, nothing reserved, 2 cpus + 4 GiB each: cpu allows 4, memory allows 4
    const r = fit(cap({ live: 'off' }));
    expect(r.fits).toBe(4);
    // 1 cpu + 4 GiB: cpu allows 8, memory 4 -> memory limits
    const m = fit(cap({ live: 'off' }), 1, 4);
    expect(m.fits).toBe(4);
    expect(m.limitedBy).toEqual({ source: 'reservation', resource: 'memory', count: 4 });
    // 4 cpus + 1 GiB: cpu 2, memory 16
    const c = fit(cap({ live: 'off' }), 4, 1);
    expect(c.limitedBy).toEqual({ source: 'reservation', resource: 'cpu', count: 2 });
  });

  it('subtracts what is reserved already and rounds down to whole sandboxes', () => {
    const c = cap({ live: 'off', reserved: { cpus: 3, memoryBytes: 5 * GIB }, sandboxes: 2 });
    // cpu: (8-3)/2 = 2.5 -> 2; memory: (16-5)/4 = 2.75 -> 2
    const r = fit(c);
    expect(r.fits).toBe(2);
    expect(r.bounds).toContainEqual({ source: 'reservation', resource: 'cpu', count: 2 });
    expect(r.bounds).toContainEqual({ source: 'reservation', resource: 'memory', count: 2 });
  });

  it('never goes below zero when the host is already over-reserved', () => {
    const r = fit(cap({ live: 'off', reserved: { cpus: 12, memoryBytes: 30 * GIB } }));
    expect(r.fits).toBe(0);
    expect(r.bounds.every((b) => b.count === 0)).toBe(true);
  });

  it('by configured host limits: sandboxes, cpus and memory of the whole host together', () => {
    const c = cap({
      live: 'off',
      sandboxes: 1,
      reserved: { cpus: 1, memoryBytes: 1 * GIB },
      limits: {
        sandboxes: { limit: 3, reserved: 1 },
        cpus: { limit: 8, reserved: 1 },
        memoryBytes: { limit: 16 * GIB, reserved: 1 * GIB },
      },
    });
    const r = fit(c, 1, 1);
    // sandboxes: 3-1 = 2 is the smallest of 2 / 7 / 15 (and the machine allows more)
    expect(r.fits).toBe(2);
    expect(r.limitedBy).toEqual({ source: 'limit', resource: 'sandboxes', count: 2 });
  });

  it('the "3 containers" case: a limit of 3 sandboxes with none there yet fits 3', () => {
    const r = fit(cap({ live: 'off', limits: { sandboxes: { limit: 3, reserved: 0 } } }), 0.5, 0.5);
    expect(r.fits).toBe(3);
    expect(r.limitedBy).toMatchObject({ source: 'limit', resource: 'sandboxes' });
  });

  it('counts the profile sandbox quota of the owner', () => {
    const r = computeFit({
      request: { cpus: 1, memoryBytes: GIB },
      capacity: cap({ live: 'off' }),
      profile: { name: 'human', ownerSandboxes: 4, maxSandboxes: 5 },
      blocked: [],
    });
    expect(r.fits).toBe(1);
    expect(r.limitedBy).toEqual({ source: 'profile', resource: 'sandboxes', count: 1 });
  });

  it('by what is free right now: MemAvailable against the memory limit, free cpus against its cpus', () => {
    // 16 GiB total, 40% available = 6.4 GiB -> one 4 GiB sandbox; 35% of 8 cpus busy -> 5.2 cpus free -> 2 of 2 cpus
    const r = fit(cap({}));
    expect(r.bounds).toContainEqual({ source: 'live', resource: 'memory', count: 1 });
    expect(r.bounds).toContainEqual({ source: 'live', resource: 'cpu', count: 2, advisory: true });
    expect(r.fits).toBe(1);
    expect(r.limitedBy).toEqual({ source: 'live', resource: 'memory', count: 1 });
    // a busier host leaves less cpu
    const busy = fit(cap({ live: { cpuPercent: 90 } }), 2, 0.5);
    expect(busy.bounds).toContainEqual({
      source: 'live',
      resource: 'cpu',
      count: 0,
      advisory: true,
    });
    // ... but that does not make it "fit 0 times": cpus are shared in time, it only warns
    expect(busy.fits).toBe(4);
    expect(busy.limitedBy).toMatchObject({ source: 'reservation' });
    expect(busy.warnings.map((w) => w.code)).toEqual(['cpu_busy']);
    expect(busy.tone).toBe('warn');
  });

  it('leaves out every ceiling it cannot compute and says nothing is known when none is left', () => {
    const r = fit(cap({ cpus: null, mem: null, live: 'off' }));
    expect(r.bounds).toEqual([]);
    expect(r.fits).toBeNull();
    expect(r.limitedBy).toBeNull();
    expect(r.projection.reservedPercent).toEqual({ cpu: null, memory: null });
    expect(r.warnings.map((w) => w.code)).toEqual(['capacity_unknown']);
    expect(r.tone).toBe('info');
    // limits alone still bound it
    const l = fit(
      cap({ cpus: null, mem: null, live: 'off', limits: { sandboxes: { limit: 2, reserved: 0 } } }),
    );
    expect(l.fits).toBe(2);
  });

  it('a live reading without MemAvailable only contributes what it has', () => {
    const r = fit(cap({ live: { memoryAvailableBytes: null } }));
    expect(r.bounds.some((b) => b.source === 'live' && b.resource === 'memory')).toBe(false);
    expect(r.bounds.some((b) => b.source === 'live' && b.resource === 'cpu')).toBe(true);
  });
});

describe('computeFit: projection, warnings and tone', () => {
  it('projects the reserved share including the planned sandbox, rounded', () => {
    // reserved 4 cpus / 8 GiB + 2 cpus / 4 GiB of 8 / 16 -> 75% / 75%
    const r = fit(cap({ live: 'off', reserved: { cpus: 4, memoryBytes: 8 * GIB } }));
    expect(r.projection.reservedPercent).toEqual({ cpu: 75, memory: 75 });
    expect(r.tone).toBe('info');
    expect(r.warnings).toEqual([]);
  });

  it('projects against the host limits and reports what the whole machine uses now', () => {
    const r = fit(
      cap({
        limits: {
          sandboxes: { limit: 4, reserved: 1 },
          cpus: { limit: 4, reserved: 1 },
          memoryBytes: { limit: 8 * GIB, reserved: 1 * GIB },
        },
        reserved: { cpus: 1, memoryBytes: 1 * GIB },
        sandboxes: 1,
      }),
    );
    expect(r.projection.limitPercent).toEqual({ sandboxes: 50, cpu: 75, memory: 63 });
    expect(r.projection.usedPercent).toEqual({ cpu: 35, memory: 60 });
  });

  it('warns above 90% of the memory reserved', () => {
    // 11 + 4 = 15 of 16 GiB = 94%
    const r = fit(cap({ live: 'off', reserved: { cpus: 0, memoryBytes: 11 * GIB } }));
    expect(r.projection.reservedPercent.memory).toBe(94);
    expect(r.warnings.map((w) => w.code)).toEqual(['memory_high']);
    expect(r.tone).toBe('warn');
    // exactly 90% is not above
    const edge = computeFit({
      request: { cpus: 1, memoryBytes: 2 * GIB },
      capacity: cap({ mem: 20 * GIB, live: 'off', reserved: { cpus: 0, memoryBytes: 16 * GIB } }),
      blocked: [],
    });
    expect(edge.projection.reservedPercent.memory).toBe(90);
    expect(edge.warnings).toEqual([]);
  });

  it('warns about memory over-commit instead of "high" and still allows it', () => {
    const r = fit(cap({ live: 'off', reserved: { cpus: 0, memoryBytes: 14 * GIB } }));
    expect(r.projection.reservedPercent.memory).toBe(113);
    expect(r.warnings.map((w) => w.code)).toEqual(['memory_overcommit']);
    expect(r.tone).toBe('warn');
    expect(r.fits).toBe(0);
  });

  it('warns about cpu over-commit', () => {
    const r = fit(cap({ live: 'off', reserved: { cpus: 7, memoryBytes: 0 } }));
    expect(r.projection.reservedPercent.cpu).toBe(113);
    expect(r.warnings.map((w) => w.code)).toEqual(['cpu_overcommit']);
    expect(r.tone).toBe('warn');
  });

  it('warns when less memory is free right now than the sandbox may use', () => {
    const r = fit(cap({ live: { memoryAvailableBytes: 2 * GIB, memoryUsedBytes: 14 * GIB } }));
    expect(r.warnings.map((w) => w.code)).toEqual(['memory_not_free']);
    expect(r.tone).toBe('warn');
  });

  it('is an error when the create would be refused, whatever else holds', () => {
    const blocked: FitEstimate['blocked'] = [
      {
        kind: 'host_limit',
        field: 'sandboxes',
        reason: 'host "home-server" already runs 3 sandbox(es); its limit is 3',
      },
    ];
    const r = fit(cap({ live: 'off' }), 1, 1, blocked);
    expect(r.tone).toBe('error');
  });
});

describe('describeFit', () => {
  const base = (over: Partial<FitEstimate>): FitEstimate => ({
    host: 'home-server',
    ts: 1,
    request: { template: 't', cpus: 2, memoryBytes: 4 * GIB },
    fits: 3,
    limitedBy: { source: 'reservation', resource: 'memory', count: 3 },
    bounds: [],
    projection: {
      reservedPercent: { cpu: 80, memory: 95 },
      limitPercent: {},
      usedPercent: { cpu: 35, memory: 60 },
    },
    blocked: [],
    warnings: [],
    tone: 'info',
    capacity: cap({}),
    ...over,
  });

  it('says how often, what limits it, what is reserved and what is used now', () => {
    expect(describeFit(base({}))).toBe(
      'Fits ~3x on home-server (limited by memory). With it: ~80% CPU and ~95% RAM reserved; in use now: 35% CPU, 60% RAM.',
    );
  });

  it('names configured limits and refusals', () => {
    expect(
      describeFit(
        base({
          limitedBy: { source: 'limit', resource: 'sandboxes', count: 3 },
          projection: {
            reservedPercent: { cpu: null, memory: null },
            limitPercent: {},
            usedPercent: { cpu: null, memory: null },
          },
        }),
      ),
    ).toBe('Fits ~3x on home-server (limited by the sandbox count, a configured limit).');
    expect(
      describeFit(
        base({ blocked: [{ kind: 'host_limit', field: 'sandboxes', reason: 'its limit is 3' }] }),
      ),
    ).toContain('Will be refused on home-server: its limit is 3.');
  });

  it('does not invent numbers for unknowns', () => {
    const line = describeFit(
      base({
        fits: null,
        limitedBy: null,
        projection: {
          reservedPercent: { cpu: null, memory: null },
          limitPercent: {},
          usedPercent: { cpu: null, memory: null },
        },
      }),
    );
    expect(line).toBe(
      'Fit on home-server cannot be estimated (no limits set, size of the machine unknown).',
    );
    expect(describeFit(base({ fits: 0 }))).toContain('Does not fit on home-server');
  });
});
