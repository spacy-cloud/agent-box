import { formatBytesHuman } from '../policy/units.js';
import type { FitBlock, FitBound, FitEstimate, FitWarning, HostCapacity } from './types.js';

/** Above this share of the machine's memory reserved the estimate turns into a warning. */
export const MEMORY_HIGH_PERCENT = 90;

const EPS = 1e-9;

/** Whole sandboxes of `each` that fit into `room` (never negative). */
function count(room: number, each: number): number {
  if (!(each > 0) || !Number.isFinite(room)) return 0;
  return Math.max(0, Math.floor(room / each + EPS));
}

const pct = (part: number, whole: number | null | undefined): number | null =>
  whole !== null && whole !== undefined && whole > 0 ? Math.round((part / whole) * 100) : null;

export interface FitParams {
  /** The resources the planned sandbox would reserve. */
  request: { cpus: number; memoryBytes: number };
  capacity: HostCapacity;
  /** How many sandboxes the owner (the human) has and may have under the policy profile. */
  profile?: { name: string; ownerSandboxes: number; maxSandboxes: number };
  /** Host / profile limits the create would exceed (decided by the same checks as a create). */
  blocked: readonly FitBlock[];
}

export type FitResult = Pick<
  FitEstimate,
  'fits' | 'limitedBy' | 'bounds' | 'projection' | 'warnings' | 'tone'
>;

/**
 * How often a sandbox of this size fits on a host and what the host looks like afterwards. Pure.
 *
 * Three families of ceilings, each in whole sandboxes (the planned one counts as the first):
 * - `limit` / `profile`: the configured host limits (cpus, memory, sandboxes) minus what is reserved
 *   already, and the profile's sandbox count of the owner;
 * - `reservation`: what the sandboxes reserve plus this one against the cpus and memory of the machine;
 * - `live`: memory the machine reports as available now against the sandbox's memory limit, and cpu left
 *   over after the current load.
 * `fits` is the smallest of the known ceilings. A ceiling that cannot be computed (unknown capacity, no
 * live reading, no limit set) is left out, never guessed.
 */
export function computeFit(p: FitParams): FitResult {
  const { request: r, capacity: c } = p;
  const reserved = c.abox.reserved;
  const bounds: FitBound[] = [];

  // configured limits ------------------------------------------------------------------------------
  if (c.limits.sandboxes) {
    bounds.push({
      source: 'limit',
      resource: 'sandboxes',
      count: Math.max(0, c.limits.sandboxes.limit - c.limits.sandboxes.reserved),
    });
  }
  if (c.limits.cpus) {
    bounds.push({
      source: 'limit',
      resource: 'cpu',
      count: count(c.limits.cpus.limit - c.limits.cpus.reserved, r.cpus),
    });
  }
  if (c.limits.memoryBytes) {
    bounds.push({
      source: 'limit',
      resource: 'memory',
      count: count(c.limits.memoryBytes.limit - c.limits.memoryBytes.reserved, r.memoryBytes),
    });
  }
  if (p.profile) {
    bounds.push({
      source: 'profile',
      resource: 'sandboxes',
      count: Math.max(0, p.profile.maxSandboxes - p.profile.ownerSandboxes),
    });
  }

  // reserved against the machine ------------------------------------------------------------------
  const ncpu = c.capacity.cpus;
  const mem = c.capacity.memoryBytes;
  if (ncpu !== null) {
    bounds.push({
      source: 'reservation',
      resource: 'cpu',
      count: count(ncpu - reserved.cpus, r.cpus),
    });
  }
  if (mem !== null) {
    bounds.push({
      source: 'reservation',
      resource: 'memory',
      count: count(mem - reserved.memoryBytes, r.memoryBytes),
    });
  }

  // free right now --------------------------------------------------------------------------------
  const live = c.live;
  if (live.available) {
    if (live.memoryAvailableBytes !== null) {
      bounds.push({
        source: 'live',
        resource: 'memory',
        count: count(live.memoryAvailableBytes, r.memoryBytes),
      });
    }
    if (live.cpuPercent !== null && ncpu !== null) {
      bounds.push({
        source: 'live',
        resource: 'cpu',
        count: count((ncpu * (100 - live.cpuPercent)) / 100, r.cpus),
        advisory: true,
      });
    }
  }

  let limitedBy: FitBound | null = null;
  for (const b of bounds) {
    if (b.advisory) continue;
    if (limitedBy === null || b.count < limitedBy.count) limitedBy = b;
  }
  const fits = limitedBy ? limitedBy.count : null;

  // projection ------------------------------------------------------------------------------------
  const cpuAfter = reserved.cpus + r.cpus;
  const memAfter = reserved.memoryBytes + r.memoryBytes;
  const reservedPercent = { cpu: pct(cpuAfter, ncpu), memory: pct(memAfter, mem) };
  const limitPercent: FitResult['projection']['limitPercent'] = {};
  if (c.limits.sandboxes) {
    const v = pct(c.limits.sandboxes.reserved + 1, c.limits.sandboxes.limit);
    if (v !== null) limitPercent.sandboxes = v;
  }
  if (c.limits.cpus) {
    const v = pct(cpuAfter, c.limits.cpus.limit);
    if (v !== null) limitPercent.cpu = v;
  }
  if (c.limits.memoryBytes) {
    const v = pct(memAfter, c.limits.memoryBytes.limit);
    if (v !== null) limitPercent.memory = v;
  }
  const memTotalLive = live.memoryTotalBytes ?? mem;
  const usedPercent = {
    cpu: live.available && live.cpuPercent !== null ? Math.round(live.cpuPercent) : null,
    memory:
      live.available && live.memoryUsedBytes !== null
        ? pct(live.memoryUsedBytes, memTotalLive)
        : null,
  };

  // warnings --------------------------------------------------------------------------------------
  const warnings: FitWarning[] = [];
  if (mem !== null && memAfter > mem) {
    warnings.push({
      code: 'memory_overcommit',
      message: `Over-committed: the memory limits of all sandboxes (${formatBytesHuman(memAfter)}) would exceed the ${formatBytesHuman(mem)} of the machine. Sandboxes can be killed when they use what they reserve.`,
    });
  } else if (reservedPercent.memory !== null && reservedPercent.memory > MEMORY_HIGH_PERCENT) {
    warnings.push({
      code: 'memory_high',
      message: `${reservedPercent.memory}% of the machine's memory would be reserved: little room is left for anything else.`,
    });
  }
  if (ncpu !== null && cpuAfter > ncpu + EPS) {
    warnings.push({
      code: 'cpu_overcommit',
      message: `The cpu limits of all sandboxes (${Number(cpuAfter.toFixed(2))}) would exceed the ${ncpu} cpus of the machine: they share the cpus and run slower when all are busy.`,
    });
  }
  if (
    live.available &&
    live.memoryAvailableBytes !== null &&
    live.memoryAvailableBytes < r.memoryBytes &&
    !warnings.some((w) => w.code === 'memory_overcommit')
  ) {
    warnings.push({
      code: 'memory_not_free',
      message: `Only ${formatBytesHuman(live.memoryAvailableBytes)} of memory is free on the machine right now, less than the ${formatBytesHuman(r.memoryBytes)} this sandbox may use.`,
    });
  }
  if (
    live.available &&
    live.cpuPercent !== null &&
    ncpu !== null &&
    (ncpu * (100 - live.cpuPercent)) / 100 < r.cpus
  ) {
    warnings.push({
      code: 'cpu_busy',
      message: `The machine is busy right now (${Math.round(live.cpuPercent)}% of its cpus): a sandbox with ${Number(r.cpus.toFixed(2))} cpus would compete for what is left.`,
    });
  }
  if (ncpu === null && mem === null) {
    warnings.push({
      code: 'capacity_unknown',
      message: 'The size of the machine is unknown, so only the configured limits can be checked.',
    });
  }

  const tone: FitResult['tone'] =
    p.blocked.length > 0
      ? 'error'
      : warnings.some((w) => w.code !== 'capacity_unknown')
        ? 'warn'
        : 'info';
  return {
    fits,
    limitedBy,
    bounds,
    projection: { reservedPercent, limitPercent, usedPercent },
    warnings,
    tone,
  };
}

/**
 * One English sentence for the CLI and logs, e.g.
 * `Fits ~3x on home-server (limited by memory). With it: ~80% CPU and ~95% RAM reserved; now 35% CPU, 60% RAM in use.`
 * Says outright that reserved is not used and that this is a ceiling.
 */
export function describeFit(e: FitEstimate): string {
  const parts: string[] = [];
  const by = e.limitedBy
    ? ` (limited by ${e.limitedBy.resource === 'cpu' ? 'CPU' : e.limitedBy.resource === 'memory' ? 'memory' : 'the sandbox count'}${
        e.limitedBy.source === 'limit' || e.limitedBy.source === 'profile'
          ? ', a configured limit'
          : e.limitedBy.source === 'live'
            ? ', what is free right now'
            : ''
      })`
    : '';
  if (e.blocked.length > 0) {
    parts.push(`Will be refused on ${e.host}: ${e.blocked.map((b) => b.reason).join('; ')}.`);
  } else if (e.fits === null) {
    parts.push(
      `Fit on ${e.host} cannot be estimated (no limits set, size of the machine unknown).`,
    );
  } else if (e.fits === 0) {
    parts.push(`Does not fit on ${e.host} without over-committing${by}.`);
  } else {
    parts.push(`Fits ~${e.fits}x on ${e.host}${by}.`);
  }
  const r = e.projection.reservedPercent;
  const reservedBits = [
    r.cpu !== null ? `~${r.cpu}% CPU` : undefined,
    r.memory !== null ? `~${r.memory}% RAM` : undefined,
  ].filter(Boolean);
  const u = e.projection.usedPercent;
  const usedBits = [
    u.cpu !== null ? `${u.cpu}% CPU` : undefined,
    u.memory !== null ? `${u.memory}% RAM` : undefined,
  ].filter(Boolean);
  const tail = [
    reservedBits.length > 0 ? `With it: ${reservedBits.join(' and ')} reserved` : undefined,
    usedBits.length > 0 ? `in use now: ${usedBits.join(', ')}` : undefined,
  ].filter(Boolean);
  if (tail.length > 0) parts.push(`${tail.join('; ')}.`);
  return parts.join(' ');
}
