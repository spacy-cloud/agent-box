import type { ResourceUsage } from '@abox/core';

/** The parts of the engine's `stats` document that abox reads (Docker and Podman compat API). */
export interface EngineStats {
  read?: string;
  preread?: string;
  cpu_stats?: {
    cpu_usage?: { total_usage?: number };
    system_cpu_usage?: number;
    online_cpus?: number;
  };
  precpu_stats?: {
    cpu_usage?: { total_usage?: number };
    system_cpu_usage?: number;
  };
  memory_stats?: {
    usage?: number;
    limit?: number;
    stats?: Record<string, number>;
  };
  pids_stats?: { current?: number };
}

function finite(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}

function ms(t: string | undefined): number | undefined {
  if (!t) return undefined;
  const v = Date.parse(t);
  // The engine reports the zero time for "no earlier sample".
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

/**
 * Turns one engine stats document (two readings: `precpu_stats` is the earlier one) into a
 * `ResourceUsage`. Same formulas as `docker stats`: cpu % is the cpu time used over the host cpu
 * time passed, times the number of cpus (100 = one core); memory is the usage without the
 * reclaimable page cache (`inactive_file` on cgroup v2, `total_inactive_file` on v1).
 */
export function usageFromEngineStats(raw: EngineStats, now: number): ResourceUsage {
  const cpu = finite(raw.cpu_stats?.cpu_usage?.total_usage);
  const pre = finite(raw.precpu_stats?.cpu_usage?.total_usage);
  const sys = finite(raw.cpu_stats?.system_cpu_usage);
  const preSys = finite(raw.precpu_stats?.system_cpu_usage);
  const cpus = finite(raw.cpu_stats?.online_cpus) || 1;
  let cpuPercent = 0;
  if (cpu !== undefined && pre !== undefined && cpu >= pre) {
    const cpuDelta = cpu - pre;
    if (sys !== undefined && preSys !== undefined && sys > preSys) {
      cpuPercent = (cpuDelta / (sys - preSys)) * cpus * 100;
    } else {
      // No host cpu time (some Podman versions): use the wall clock between the two readings.
      const t1 = ms(raw.read);
      const t0 = ms(raw.preread);
      if (t1 !== undefined && t0 !== undefined && t1 > t0) {
        cpuPercent = (cpuDelta / ((t1 - t0) * 1e6)) * 100;
      }
    }
  }
  const mem = raw.memory_stats;
  const cache =
    finite(mem?.stats?.['inactive_file']) ?? finite(mem?.stats?.['total_inactive_file']);
  const usage = finite(mem?.usage) ?? 0;
  const memoryBytes = cache !== undefined && cache <= usage ? usage - cache : usage;
  const limit = finite(mem?.limit);
  const pids = finite(raw.pids_stats?.current);
  return {
    ts: now,
    cpuPercent: Math.round(cpuPercent * 10) / 10,
    memoryBytes,
    memoryLimitBytes: limit !== undefined && limit > 0 ? limit : null,
    pids: pids !== undefined ? pids : null,
  };
}
