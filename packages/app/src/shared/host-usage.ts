/**
 * Utilisation of a host as the Hosts view shows it, computed from the sandbox list the manager returns
 * (no extra query, nothing measured on the host): how many sandboxes occupy it and what they reserve.
 *
 * Counted are the sandboxes the manager counts for the host limits: preparing, created, running or stopped
 * (a stopped one keeps its reservation), not stale. What they reserve is what they were created with (cpu and
 * memory limits), not live usage. The limits of a host profile (`limits.sandboxes`, `limits.cpus`,
 * `limits.memory`) are quotas of the host as a whole: all of these sandboxes together may not exceed them.
 */
import type { SandboxView } from '@abox/core';

const OCCUPYING = new Set(['preparing', 'created', 'running', 'stopped']);

export interface HostUtilisation {
  sandboxes: number;
  running: number;
  cpusReserved: number;
  memoryReservedBytes: number;
  /** `limits.sandboxes`, `limits.cpus`, `limits.memory` of the profile, when set. */
  sandboxLimit: number | undefined;
  cpuLimit: number | undefined;
  memoryLimitBytes: number | undefined;
  /** Share of each limit in use (0..1), when there is that limit. */
  sandboxFraction: number | undefined;
  cpuFraction: number | undefined;
  memoryFraction: number | undefined;
  /** At least one limit is reached or exceeded: the next sandbox on this host is probably refused. */
  full: boolean;
}

const UNITS: Record<string, number> = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 };

/** Size like `4g`, `512m`, `1.5g` (as in host profiles and policy.yaml) in bytes; undefined when it is not one. */
export function parseSizeBytes(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const m = /^(\d{1,6}(?:\.\d+)?)([kmgt]?)b?$/i.exec(text.trim());
  if (!m) return undefined;
  return Math.round(Number(m[1]) * (UNITS[m[2]!.toLowerCase()] ?? 1));
}

const EPSILON = 1e-9;
const fraction = (used: number, limit: number | undefined): number | undefined =>
  limit !== undefined && limit > 0 ? Math.min(1, used / limit) : undefined;

export function hostUtilisation(
  hostId: string,
  sandboxes: readonly SandboxView[],
  limits:
    | { cpus?: number | undefined; memory?: string | undefined; sandboxes?: number | undefined }
    | undefined,
): HostUtilisation {
  const mine = sandboxes.filter((s) => s.host === hostId && OCCUPYING.has(s.state) && !s.stale);
  const cpusReserved = mine.reduce((n, s) => n + s.resources.cpus, 0);
  const memoryReservedBytes = mine.reduce((n, s) => n + s.resources.memoryBytes, 0);
  const sandboxLimit = limits?.sandboxes;
  const cpuLimit = limits?.cpus;
  const memoryLimitBytes = parseSizeBytes(limits?.memory);
  return {
    sandboxes: mine.length,
    running: mine.filter((s) => s.state === 'running').length,
    cpusReserved,
    memoryReservedBytes,
    sandboxLimit,
    cpuLimit,
    memoryLimitBytes,
    sandboxFraction: fraction(mine.length, sandboxLimit),
    cpuFraction: fraction(cpusReserved, cpuLimit),
    memoryFraction: fraction(memoryReservedBytes, memoryLimitBytes),
    full:
      (sandboxLimit !== undefined && mine.length >= sandboxLimit) ||
      (cpuLimit !== undefined && cpusReserved >= cpuLimit - EPSILON) ||
      (memoryLimitBytes !== undefined && memoryReservedBytes >= memoryLimitBytes),
  };
}

/**
 * Tags that name a group: `group.lab`, `gruppe.lab`. A host profile has tags only, no separate group field, and
 * the tag syntax (letters, digits, `._-`) allows no colon.
 */
const GROUP_PREFIX = /^(?:group|gruppe)\./i;

export function groupsOf(tags: readonly string[]): string[] {
  return tags
    .filter((t) => GROUP_PREFIX.test(t))
    .map((t) => t.replace(GROUP_PREFIX, '').trim())
    .filter((g) => g !== '');
}

export function plainTags(tags: readonly string[]): string[] {
  return tags.filter((t) => !GROUP_PREFIX.test(t));
}

export interface HostGroup<T> {
  /** `null` = hosts without a group. */
  name: string | null;
  hosts: T[];
}

/**
 * Sections for the table: the hosts without a group first (this computer is among them), then one section
 * per group (a host with several group tags appears in each of them). Order inside a section is kept. With no group at all there is one section only.
 */
export function groupHosts<T extends { tags: readonly string[] }>(
  hosts: readonly T[],
): HostGroup<T>[] {
  const named = new Map<string, T[]>();
  const loose: T[] = [];
  for (const h of hosts) {
    const gs = groupsOf(h.tags);
    if (gs.length === 0) loose.push(h);
    for (const g of gs) named.set(g, [...(named.get(g) ?? []), h]);
  }
  const out: HostGroup<T>[] = [];
  if (loose.length > 0 || named.size === 0) out.push({ name: null, hosts: loose });
  out.push(
    ...[...named.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, list]): HostGroup<T> => ({ name, hosts: list })),
  );
  return out;
}
