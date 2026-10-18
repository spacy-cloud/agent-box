import type { Abox, Caller, HostCapacity, HostLimits } from '@abox/core';
import { formatBytes, oneLine, safe } from '../format.js';

/** `3 sandboxes, 8 cpus, 16g memory`, or `-` for a host without limits. */
export function limitsText(limits: HostLimits | undefined, none = '-'): string {
  const parts: string[] = [];
  if (limits?.sandboxes !== undefined) {
    parts.push(`${limits.sandboxes} sandbox${limits.sandboxes === 1 ? '' : 'es'}`);
  }
  if (limits?.cpus !== undefined) parts.push(`${limits.cpus} cpus`);
  if (limits?.memory !== undefined) parts.push(`${limits.memory} memory`);
  return parts.join(', ') || none;
}

const pct = (n: number | null): string => (n === null ? '?' : `${Math.round(n)}%`);

/** The size of the machine, e.g. `8 cpus, 15.6 GiB memory (engine)`. */
export function machineText(c: HostCapacity): string {
  const { cpus, memoryBytes, source } = c.capacity;
  if (cpus === null && memoryBytes === null) return 'unknown';
  return `${cpus === null ? '? cpus' : `${cpus} cpus`}, ${
    memoryBytes === null ? '? memory' : `${formatBytes(memoryBytes)} memory`
  } (${source})`;
}

/** What the whole machine uses right now, e.g. `cpu 35%, memory 9.6 GiB of 15.6 GiB (60%), load 0.52 0.58 0.59`. */
export function liveText(c: HostCapacity): string {
  const l = c.live;
  if (!l.available) return `unknown${l.reason ? ` (${oneLine(l.reason)})` : ''}`;
  const parts: string[] = [];
  if (l.cpuPercent !== null) parts.push(`cpu ${pct(l.cpuPercent)}`);
  if (l.memoryUsedBytes !== null && l.memoryTotalBytes !== null) {
    parts.push(
      `memory ${formatBytes(l.memoryUsedBytes)} of ${formatBytes(l.memoryTotalBytes)} (${pct(
        (l.memoryUsedBytes / l.memoryTotalBytes) * 100,
      )})`,
    );
  }
  if (l.load) parts.push(`load ${l.load.m1} ${l.load.m5} ${l.load.m15}`);
  return parts.join(', ') || 'unknown';
}

/** What abox's sandboxes reserve (their limits, not their use) and, when sampled, use. */
export function aboxText(c: HostCapacity): string {
  const a = c.abox;
  const base = `${a.sandboxes} sandbox${a.sandboxes === 1 ? '' : 'es'}${
    a.running > 0 ? ` (${a.running} running)` : ''
  } reserve ${Number(a.reserved.cpus.toFixed(2))} cpus and ${formatBytes(a.reserved.memoryBytes)}`;
  return a.usage
    ? `${base}; using ${a.usage.cpuPercent.toFixed(1)}% of one cpu and ${formatBytes(a.usage.memoryBytes)}`
    : base;
}

/** `sandboxes 2 of 3, cpus 3 of 6, memory 3.0 GiB of 12.0 GiB`; undefined without limits. */
export function reservedOfLimitsText(c: HostCapacity): string | undefined {
  const parts: string[] = [];
  const l = c.limits;
  if (l.sandboxes) parts.push(`sandboxes ${l.sandboxes.reserved} of ${l.sandboxes.limit}`);
  if (l.cpus) parts.push(`cpus ${Number(l.cpus.reserved.toFixed(2))} of ${l.cpus.limit}`);
  if (l.memoryBytes) {
    parts.push(
      `memory ${formatBytes(l.memoryBytes.reserved)} of ${formatBytes(l.memoryBytes.limit)}`,
    );
  }
  return parts.length > 0 ? parts.join(', ') : undefined;
}

/** The compact USAGE cell of `abox host ls --usage`. */
export function usageCell(c: HostCapacity | undefined, error?: string): string {
  if (!c) return error ? `unknown (${oneLine(error).slice(0, 60)})` : '-';
  const l = c.live;
  const live =
    l.available && (l.cpuPercent !== null || l.memoryUsedBytes !== null)
      ? `cpu ${pct(l.cpuPercent)} ram ${
          l.memoryUsedBytes !== null && l.memoryTotalBytes
            ? pct((l.memoryUsedBytes / l.memoryTotalBytes) * 100)
            : '?'
        }`
      : 'live unknown';
  return `${live}; ${c.abox.sandboxes} reserved`;
}

/** Lines for `abox host test`. */
export function capacityLines(c: HostCapacity): Array<[string, string | undefined]> {
  return [
    ['capacity', machineText(c)],
    ['in use now', liveText(c)],
    ['abox', aboxText(c)],
    ['limits', reservedOfLimitsText(c)],
  ];
}

export interface CapacityOutcome {
  capacity?: HostCapacity;
  error?: string;
}

/**
 * Capacity of several hosts in parallel; one that cannot be reached is reported with its reason instead of
 * failing the whole call. Each host has `timeoutMs` (an unreachable ssh host must not hold up the others).
 */
export async function gatherCapacity(
  abox: Pick<Abox, 'hostCapacity'>,
  caller: Caller,
  hostIds: readonly string[],
  timeoutMs = 45_000,
): Promise<Map<string, CapacityOutcome>> {
  const out = new Map<string, CapacityOutcome>();
  await Promise.all(
    hostIds.map(async (id) => {
      let timer: NodeJS.Timeout | undefined;
      try {
        const capacity = await Promise.race([
          abox.hostCapacity(caller, id),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
            timer.unref?.();
          }),
        ]);
        out.set(id, { capacity });
      } catch (e) {
        out.set(id, { error: safe(e instanceof Error ? e.message : String(e)).slice(0, 300) });
      } finally {
        if (timer) clearTimeout(timer);
      }
    }),
  );
  return out;
}
