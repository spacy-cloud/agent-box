import { describe, expect, it } from 'vitest';
import type { FitEstimate, HostCapacity } from '@abox/core';
import { barTone, fitBanner, liveBars, reservedShare } from '../../src/shared/capacity';
import { hasLimitErrors, limitFieldsOf, parseLimitFields } from '../../src/shared/host-limits';

const GIB = 1024 ** 3;

function cap(
  over: Partial<HostCapacity['live']> = {},
  size = { cpus: 8, mem: 16 * GIB },
): HostCapacity {
  return {
    host: 'srv',
    ts: 1,
    capacity: { cpus: size.cpus, memoryBytes: size.mem, source: 'engine' },
    live: {
      available: true,
      cpuPercent: 35,
      load: null,
      memoryTotalBytes: size.mem,
      memoryAvailableBytes: size.mem * 0.4,
      memoryUsedBytes: size.mem * 0.6,
      source: 'ssh',
      ...over,
    },
    abox: { sandboxes: 2, running: 1, reserved: { cpus: 4, memoryBytes: 4 * GIB }, usage: null },
    limits: {},
  };
}

describe('barTone', () => {
  it('turns amber above 80 % and red above 95 %, not at the thresholds', () => {
    expect(barTone(0)).toBe('ok');
    expect(barTone(80)).toBe('ok');
    expect(barTone(81)).toBe('warn');
    expect(barTone(95)).toBe('warn');
    expect(barTone(96)).toBe('danger');
    expect(barTone(100)).toBe('danger');
    expect(barTone(null)).toBe('ok');
  });
});

describe('liveBars / reservedShare', () => {
  it('derives used and total for cpu (cores) and ram (bytes)', () => {
    const b = liveBars(cap());
    expect(b.cpu).toEqual({ percent: 35, used: 2.8, total: 8 });
    expect(b.ram).toEqual({ percent: 60, used: 9.6 * GIB, total: 16 * GIB });
    expect(reservedShare(cap())).toEqual({ cpu: 50, ram: 25 });
  });

  it('has no bar for what is not known', () => {
    expect(liveBars(undefined)).toEqual({ cpu: null, ram: null });
    expect(liveBars(cap({ available: false }))).toEqual({ cpu: null, ram: null });
    const noCpu = liveBars(cap({ cpuPercent: null }));
    expect(noCpu.cpu).toBeNull();
    expect(noCpu.ram).not.toBeNull();
    expect(liveBars(cap({ memoryUsedBytes: null })).ram).toBeNull();
    expect(
      reservedShare({ ...cap(), capacity: { cpus: null, memoryBytes: null, source: 'unknown' } }),
    ).toEqual({
      cpu: null,
      ram: null,
    });
  });

  it('a cpu bar without the size of the machine still shows the percent', () => {
    const c = {
      ...cap(),
      capacity: { cpus: null, memoryBytes: 16 * GIB, source: 'proc' as const },
    };
    expect(liveBars(c).cpu).toEqual({ percent: 35, used: null, total: null });
  });
});

function est(over: Partial<FitEstimate> = {}): FitEstimate {
  return {
    host: 'srv',
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
    capacity: cap(),
    ...over,
  };
}

describe('fitBanner', () => {
  it('info: how often, what limits it, reserved with it and used now', () => {
    const b = fitBanner(est(), 'home-server');
    expect(b.tone).toBe('info');
    expect(b.blocks).toBe(false);
    expect(b.headline).toEqual({
      key: 'new.fit.fitsBy',
      params: { host: 'home-server', count: 3 },
      by: 'new.fit.by.memory',
    });
    expect(b.detail).toEqual({
      key: 'new.fit.detail',
      params: { rcpu: '80', rram: '95', ucpu: '35', uram: '60' },
    });
  });

  it('names the kind of ceiling: host limit, profile, free memory', () => {
    const by = (limitedBy: FitEstimate['limitedBy']) =>
      fitBanner(est({ limitedBy }), 'h').headline.by;
    expect(by({ source: 'limit', resource: 'sandboxes', count: 3 })).toBe(
      'new.fit.by.limitSandboxes',
    );
    expect(by({ source: 'limit', resource: 'cpu', count: 3 })).toBe('new.fit.by.limitCpu');
    expect(by({ source: 'limit', resource: 'memory', count: 3 })).toBe('new.fit.by.limitMemory');
    expect(by({ source: 'profile', resource: 'sandboxes', count: 3 })).toBe(
      'new.fit.by.profileSandboxes',
    );
    expect(by({ source: 'live', resource: 'memory', count: 3 })).toBe('new.fit.by.liveMemory');
    expect(by({ source: 'reservation', resource: 'cpu', count: 3 })).toBe('new.fit.by.cpu');
    expect(fitBanner(est({ limitedBy: null }), 'h').headline.key).toBe('new.fit.fits');
  });

  it('warn tone from the manager: over-commit or nearly full', () => {
    const b = fitBanner(
      est({
        tone: 'warn',
        fits: 0,
        warnings: [{ code: 'memory_overcommit', message: 'x' }],
        projection: {
          reservedPercent: { cpu: 80, memory: 113 },
          limitPercent: {},
          usedPercent: { cpu: null, memory: null },
        },
      }),
      'h',
    );
    expect(b.tone).toBe('warn');
    expect(b.blocks).toBe(false);
    expect(b.headline.key).toBe('new.fit.none');
    expect(b.detail?.key).toBe('new.fit.detailReserved');
    expect(b.warnings.map((w) => w.code)).toEqual(['memory_overcommit']);
  });

  it('says what is missing when it does not fit: memory free right now, a limit, or over-booking', () => {
    const none = (limitedBy: FitEstimate['limitedBy']) =>
      fitBanner(est({ fits: 0, limitedBy }), 'h').headline;
    expect(none({ source: 'live', resource: 'memory', count: 0 })).toEqual({
      key: 'new.fit.noneLive',
      params: { host: 'h' },
    });
    expect(none({ source: 'limit', resource: 'cpu', count: 0 })).toEqual({
      key: 'new.fit.noneBy',
      params: { host: 'h' },
      by: 'new.fit.by.limitCpu',
    });
    expect(none({ source: 'reservation', resource: 'memory', count: 0 }).key).toBe('new.fit.none');
    expect(none(null).key).toBe('new.fit.none');
  });

  it('error tone blocks "Next" when a host or profile limit would be exceeded', () => {
    const b = fitBanner(
      est({
        tone: 'error',
        fits: 0,
        blocked: [{ kind: 'host_limit', field: 'sandboxes', reason: 'its limit is 3', hint: 'x' }],
      }),
      'h',
    );
    expect(b.tone).toBe('danger');
    expect(b.blocks).toBe(true);
    expect(b.headline.key).toBe('new.fit.blocked');
    expect(b.blocked).toEqual([{ field: 'sandboxes', reason: 'its limit is 3', hint: 'x' }]);
  });

  it('unknown capacity without limits says so instead of inventing a number', () => {
    const b = fitBanner(
      est({
        fits: null,
        limitedBy: null,
        projection: {
          reservedPercent: { cpu: null, memory: null },
          limitPercent: {},
          usedPercent: { cpu: null, memory: null },
        },
        warnings: [{ code: 'capacity_unknown', message: 'x' }],
      }),
      'h',
    );
    expect(b.headline.key).toBe('new.fit.unknown');
    expect(b.detail).toBeNull();
    expect(b.tone).toBe('info');
  });
});

describe('parseLimitFields (like abox host add)', () => {
  const f = (sandboxes = '', cpus = '', memory = '') => ({ sandboxes, cpus, memory });

  it('empty means no limit', () => {
    expect(parseLimitFields(f())).toEqual({ limits: null, errors: {} });
    expect(parseLimitFields(f(' ', ' ', ' ')).limits).toBeNull();
  });

  it('accepts the values the CLI accepts, with a decimal comma', () => {
    expect(parseLimitFields(f('3', '8', '16g'))).toEqual({
      limits: { sandboxes: 3, cpus: 8, memory: '16g' },
      errors: {},
    });
    expect(parseLimitFields(f('0', '2,5', '512m')).limits).toEqual({
      sandboxes: 0,
      cpus: 2.5,
      memory: '512m',
    });
    expect(parseLimitFields(f('10000', '1024', '1.5g')).errors).toEqual({});
  });

  it('refuses what the CLI refuses', () => {
    for (const bad of ['-1', '3.5', '10001', 'many', '1e3', '0x10'])
      expect(parseLimitFields(f(bad)).errors.sandboxes, bad).toBe('hosts.limits.err.sandboxes');
    for (const bad of ['0', '-2', '1025', 'lots', '1e2', '2,5,1'])
      expect(parseLimitFields(f('', bad)).errors.cpus, bad).toBe('hosts.limits.err.cpus');
    for (const bad of ['plenty', '0', '-1g', '16 gigs', '1e9'])
      expect(parseLimitFields(f('', '', bad)).errors.memory, bad).toBe('hosts.limits.err.memory');
    const all = parseLimitFields(f('x', 'y', 'z'));
    expect(hasLimitErrors(all.errors)).toBe(true);
    expect(all.limits).toBeNull();
    expect(hasLimitErrors({})).toBe(false);
  });

  it('turns a profile back into text fields', () => {
    expect(limitFieldsOf(undefined)).toEqual(f());
    expect(limitFieldsOf({ sandboxes: 0, cpus: 2.5, memory: '4g' })).toEqual(f('0', '2.5', '4g'));
  });
});
