import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PreparedImage, ResolvedTemplate } from '@abox/core';
import { MiB, makeSpec, makeTemplate } from './__tests__/helpers.js';
import { Tracker, dockerEnabled, newProvider, sweepTestObjects } from './__tests__/harness.js';
import { usageFromEngineStats } from './stats.js';
import type { EngineStats } from './stats.js';

const NOW = 1_700_000_000_000;

describe('usageFromEngineStats', () => {
  it('computes cpu like `docker stats` (cgroup v2: page cache is not counted as memory)', () => {
    const raw: EngineStats = {
      read: '2026-10-17T10:00:01.000000000Z',
      preread: '2026-10-17T10:00:00.000000000Z',
      cpu_stats: {
        cpu_usage: { total_usage: 600_000_000 },
        system_cpu_usage: 40_000_000_000,
        online_cpus: 4,
      },
      precpu_stats: { cpu_usage: { total_usage: 400_000_000 }, system_cpu_usage: 36_000_000_000 },
      memory_stats: {
        usage: 100 * MiB,
        limit: 256 * MiB,
        stats: { inactive_file: 30 * MiB, anon: 70 * MiB },
      },
      pids_stats: { current: 5 },
    };
    // 0.2 s of cpu time while the 4 cpus together advanced 4 s: 0.2/4 * 4 * 100 = 20 % of one core
    expect(usageFromEngineStats(raw, NOW)).toEqual({
      ts: NOW,
      cpuPercent: 20,
      memoryBytes: 70 * MiB,
      memoryLimitBytes: 256 * MiB,
      pids: 5,
    });
  });

  it('cgroup v1 reports the cache as total_inactive_file; an unlimited sandbox has no limit value', () => {
    const u = usageFromEngineStats(
      {
        cpu_stats: { cpu_usage: { total_usage: 1000 }, system_cpu_usage: 2000, online_cpus: 1 },
        precpu_stats: { cpu_usage: { total_usage: 500 }, system_cpu_usage: 1000 },
        memory_stats: { usage: 50 * MiB, limit: 0, stats: { total_inactive_file: 10 * MiB } },
      },
      NOW,
    );
    expect(u.memoryBytes).toBe(40 * MiB);
    expect(u.memoryLimitBytes).toBeNull();
    expect(u.pids).toBeNull();
    expect(u.cpuPercent).toBe(50);
  });

  it('falls back to the wall clock between the two readings when the host cpu time is missing (Podman)', () => {
    const u = usageFromEngineStats(
      {
        read: '2026-10-17T10:00:02.000000000Z',
        preread: '2026-10-17T10:00:01.000000000Z',
        cpu_stats: { cpu_usage: { total_usage: 1_500_000_000 }, online_cpus: 2 },
        precpu_stats: { cpu_usage: { total_usage: 1_000_000_000 } },
        memory_stats: { usage: 10 * MiB, limit: 64 * MiB },
      },
      NOW,
    );
    expect(u.cpuPercent).toBe(50);
  });

  it('a first reading without a predecessor, or an empty document, yields zeros instead of NaN', () => {
    expect(
      usageFromEngineStats(
        {
          read: '2026-10-17T10:00:02Z',
          preread: '0001-01-01T00:00:00Z',
          cpu_stats: { cpu_usage: { total_usage: 5 }, system_cpu_usage: 10, online_cpus: 2 },
          precpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: 0 },
        },
        NOW,
      ),
    ).toMatchObject({ memoryBytes: 0, memoryLimitBytes: null, pids: null });
    expect(usageFromEngineStats({}, NOW)).toEqual({
      ts: NOW,
      cpuPercent: 0,
      memoryBytes: 0,
      memoryLimitBytes: null,
      pids: null,
    });
  });
});

describe.skipIf(!dockerEnabled)('DockerProvider.stats (real docker)', () => {
  const provider = newProvider();
  const track = new Tracker(provider);
  const template: ResolvedTemplate = makeTemplate();
  let prepared: PreparedImage;

  beforeAll(async () => {
    await sweepTestObjects();
    await provider.init();
    prepared = await provider.prepare(template);
  }, 300_000);

  afterAll(async () => {
    await track.cleanup();
    await sweepTestObjects();
  }, 120_000);

  it('reports cpu, memory and pids of a busy running sandbox and rejects a stopped one', async () => {
    expect(provider.capabilities().stats).toBe(true);
    const s = await track.create(makeSpec(template, prepared.ref));
    // burn some cpu and hold some memory in the background
    await provider.exec(s.id, {
      command: 'nohup sh -c "while :; do :; done" >/dev/null 2>&1 &',
    });
    const u = await provider.stats!(s.id);
    expect(u.ts).toBeGreaterThan(0);
    expect(u.memoryBytes).toBeGreaterThan(0);
    expect(u.memoryBytes).toBeLessThanOrEqual(template.resources.memoryBytes);
    expect(u.memoryLimitBytes).toBe(template.resources.memoryBytes);
    expect(u.pids).toBeGreaterThanOrEqual(2);
    expect(u.cpuPercent).toBeGreaterThanOrEqual(0);
    expect(u.cpuPercent).toBeLessThanOrEqual(120); // limit is one cpu

    await provider.stop(s.id);
    await expect(provider.stats!(s.id)).rejects.toMatchObject({ code: 'conflict' });
    await expect(provider.stats!('local/ffffffff')).rejects.toMatchObject({ code: 'not_found' });
  }, 120_000);
});
