import { cpus as osCpus, totalmem } from 'node:os';
import { AboxError } from '../errors.js';
import { readLocalLive, type HostLiveResult } from '../hosts/live.js';
import { hostQuotaViolations } from '../policy/engine.js';
import { tryParseSize } from '../policy/units.js';
import type { BackendKind } from '../types.js';
import { computeFit } from './fit.js';
import type { Internals } from './internals.js';
import { estimateFitSchema, hostCapacitySchema } from './schemas.js';
import { loadTemplate, projectDirCandidates } from './templates.js';
import type {
  Caller,
  EstimateFitInput,
  FitBlock,
  FitEstimate,
  HostCapacity,
  HostLimitUse,
} from './types.js';
import { errMessage, parseInput } from './util.js';
import { sandboxStats } from './usage.js';

/** Measurements are shared for this long: a GUI polling every few seconds does not hammer ssh or the engine. */
export const CAPACITY_CACHE_MS = 5000;
/** At most this many running sandboxes are sampled for `abox.usage` (each sample takes about a second). */
const USAGE_SAMPLE_MAX = 24;
/** The remote read is given this long before the host counts as "no live numbers". */
const LIVE_TIMEOUT_MS = 40_000;
/** The first remote read of a burst is audited, the polls after it are not. */
const AUDIT_WINDOW_MS = 10 * 60_000;

type Measured = Pick<HostCapacity, 'ts' | 'capacity' | 'live'>;

const ENGINE_BACKENDS: BackendKind[] = ['docker', 'podman'];

/** A promise cached for `CAPACITY_CACHE_MS`; a failure is not kept. */
function cached<T>(I: Internals, key: string, make: () => Promise<T>): Promise<T> {
  const hit = I.capacityCache.get(key);
  if (hit && I.now() - hit.at < CAPACITY_CACHE_MS) return hit.value as Promise<T>;
  const value = make();
  I.capacityCache.set(key, { at: I.now(), value });
  value.catch(() => {
    if (I.capacityCache.get(key)?.value === value) I.capacityCache.delete(key);
  });
  if (I.capacityCache.size > 200) I.capacityCache.clear();
  return value;
}

async function readLive(I: Internals, hostId: string, remote: boolean): Promise<HostLiveResult> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const read = I.hostLiveFn
      ? I.hostLiveFn(hostId)
      : remote
        ? Promise.resolve<HostLiveResult>({
            ok: false,
            reason: 'no way to read this host is configured',
          })
        : readLocalLive({ now: I.now });
    const r = await Promise.race([
      read,
      new Promise<HostLiveResult>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), LIVE_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
    if (remote && I.firstWithin(`host-live|${hostId}`, AUDIT_WINDOW_MS)) {
      // what was read is only /proc numbers; the audit says that a read of the host happened
      I.audit('human', 'host.capacity', {
        decision: r.ok ? 'allow' : 'error',
        details: { host: hostId, ...(r.ok ? {} : { reason: r.reason }) },
      });
    }
    return r;
  } catch (e) {
    return { ok: false, reason: errMessage(e).slice(0, 200) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function engineResources(
  I: Internals,
  host: Awaited<ReturnType<Internals['resolveHost']>>,
): Promise<{ cpus: number; memoryBytes: number } | undefined> {
  for (const backend of ENGINE_BACKENDS) {
    if (!host.backends.includes(backend) || !I.providerFactories[backend]) continue;
    try {
      const r = await I.providerFor(host, backend).hostResources?.();
      if (r) return r;
    } catch {
      /* engine not reachable through this backend: try the next, or ask the host itself */
    }
  }
  return undefined;
}

async function measure(
  I: Internals,
  hostId: string,
  host: Awaited<ReturnType<Internals['resolveHost']>>,
): Promise<Measured> {
  const remote = host.connection.kind !== 'local';
  const [engine, liveRead] = await Promise.all([
    engineResources(I, host),
    readLive(I, hostId, remote),
  ]);
  const live = liveRead.ok ? liveRead.usage : undefined;
  let capacity: Measured['capacity'];
  if (engine) {
    capacity = { cpus: engine.cpus, memoryBytes: engine.memoryBytes, source: 'engine' };
  } else if (live && (live.cpus !== null || live.memoryTotalBytes !== null)) {
    capacity = { cpus: live.cpus, memoryBytes: live.memoryTotalBytes, source: 'proc' };
  } else if (!remote) {
    capacity = { cpus: osCpus().length || null, memoryBytes: totalmem() || null, source: 'os' };
  } else {
    capacity = { cpus: null, memoryBytes: null, source: 'unknown' };
  }
  const total = live?.memoryTotalBytes ?? null;
  const available = live?.memoryAvailableBytes ?? null;
  return {
    ts: I.now(),
    capacity,
    live: {
      available: live !== undefined,
      ...(liveRead.ok ? {} : { reason: liveRead.reason }),
      cpuPercent: live?.cpuPercent ?? null,
      load: live?.load ?? null,
      memoryTotalBytes: total,
      memoryAvailableBytes: available,
      memoryUsedBytes: total !== null && available !== null ? Math.max(0, total - available) : null,
      source: live?.source ?? null,
    },
  };
}

/** What abox's own running sandboxes use right now (their `stats`, summed). */
async function sampleUsage(
  I: Internals,
  caller: Caller,
  hostId: string,
): Promise<NonNullable<HostCapacity['abox']['usage']> | null> {
  const ids = I.state.sandboxes
    .list({ host: hostId, state: ['running'] })
    .filter((r) => !r.stale && r.expiresAt > I.now())
    .slice(0, USAGE_SAMPLE_MAX)
    .map((r) => r.id);
  if (ids.length === 0) return null;
  const { usage } = await sandboxStats(I, caller, ids);
  const samples = Object.values(usage);
  if (samples.length === 0) return null;
  return {
    cpuPercent: Math.round(samples.reduce((n, u) => n + u.cpuPercent, 0) * 10) / 10,
    memoryBytes: samples.reduce((n, u) => n + u.memoryBytes, 0),
    sampled: samples.length,
  };
}

function limitUse(limit: number | undefined, reserved: number): HostLimitUse | undefined {
  return limit === undefined ? undefined : { limit, reserved };
}

async function capacityOf(
  I: Internals,
  caller: Caller,
  hostId: string,
  o: { usage: boolean },
): Promise<HostCapacity> {
  const host = await I.resolveHost(hostId);
  const measured = await cached(I, `m|${hostId}`, () => measure(I, hostId, host));
  const usage = o.usage
    ? await cached(I, `u|${hostId}`, () => sampleUsage(I, caller, hostId)).catch(() => null)
    : null;
  // reservations are cheap and must be exact (a create just happened), so they are never cached
  const used = I.hostUsage(hostId);
  const running = I.state.sandboxes
    .list({ host: hostId, state: ['running'] })
    .filter((r) => !r.stale && !I.isInterrupted(r)).length;
  const limits = host.limits;
  const memLimit = limits?.memory === undefined ? undefined : tryParseSize(limits.memory);
  const l: HostCapacity['limits'] = {};
  const sb = limitUse(limits?.sandboxes, used.sandboxes);
  const cpu = limitUse(limits?.cpus, used.cpus);
  const mem = limitUse(memLimit, used.memoryBytes);
  if (sb) l.sandboxes = sb;
  if (cpu) l.cpus = cpu;
  if (mem) l.memoryBytes = mem;
  return {
    host: hostId,
    ts: measured.ts,
    capacity: measured.capacity,
    live: measured.live,
    abox: {
      sandboxes: used.sandboxes,
      running,
      reserved: { cpus: used.cpus, memoryBytes: used.memoryBytes },
      usage,
    },
    limits: l,
  };
}

/**
 * Human only. Capacity and live utilisation of a host: cpus and memory of the machine the engine runs on,
 * what the whole machine uses right now (read-only numbers from `/proc`, over the hardened ssh connection
 * for remote hosts), what abox's sandboxes reserve and use there, and the configured limits. Measured parts
 * are shared for `CAPACITY_CACHE_MS`; reservations are always current. Anything unavailable is reported as
 * unknown, never guessed. Not audited (it is polled), except that a read of a remote host is audited once per
 * ten minutes.
 *
 * Agents cannot call this: a coarse version for them would reveal the size and load of machines they only
 * borrow a sandbox on, and the policy already tells them what they may reserve.
 */
export async function hostCapacity(
  I: Internals,
  caller: Caller,
  hostId: string,
): Promise<HostCapacity> {
  const ctx = await I.context(caller);
  I.requireHuman(ctx, 'host.capacity');
  const req = parseInput(hostCapacitySchema, { hostId }, 'host capacity request');
  return capacityOf(I, caller, req.hostId, { usage: true });
}

/**
 * Human only. Read-only estimate for a planned sandbox: how many sandboxes of this size fit on the host
 * (by configured limits, by reservations against the machine, by what is free right now), what the host looks
 * like with it, and whether the create would be refused. A ceiling from limits, not a performance prediction.
 */
export async function estimateFit(
  I: Internals,
  caller: Caller,
  input: EstimateFitInput,
): Promise<FitEstimate> {
  const ctx = await I.context(caller);
  I.requireHuman(ctx, 'host.estimate');
  const req = parseInput(estimateFitSchema, input, 'fit estimate request');
  const hostId = req.hostId ?? 'local';
  const host = await I.resolveHost(hostId);
  const { template } = await loadTemplate(
    I,
    ctx,
    req.template,
    projectDirCandidates(I, ctx, req.projectDir, req.workspacePath),
  );
  if (!host.backends.includes(template.backend) || !I.providerFactories[template.backend]) {
    throw new AboxError(
      'backend_unavailable',
      `template '${template.name}' needs backend '${template.backend}', which is not available on host '${hostId}'`,
      { hint: 'Run `abox doctor` to see which backends are available.' },
    );
  }
  const cpus = req.overrides?.cpus ?? template.resources.cpus;
  let memoryBytes = template.resources.memoryBytes;
  if (req.overrides?.memory !== undefined) {
    const m = tryParseSize(req.overrides.memory);
    if (m === undefined) {
      throw new AboxError(
        'invalid_input',
        `invalid memory ${JSON.stringify(req.overrides.memory)} (examples: 512m, 4g)`,
      );
    }
    memoryBytes = m;
  }

  const capacity = await capacityOf(I, caller, hostId, { usage: false });

  // The refusals a create would run into: the host limits (the same check as the create's claim) and the profile.
  const blocked: FitBlock[] = [];
  const hostInfo = I.hostInfo(host, host.connection.kind !== 'local');
  for (const v of hostQuotaViolations(hostInfo, I.hostUsage(hostId), {
    sandbox: true,
    cpus,
    memoryBytes,
  })) {
    blocked.push({
      kind: 'host_limit',
      field: v.field,
      reason: v.reason,
      hint: v.hint,
    });
  }
  const p = ctx.profile;
  const ownerSandboxes = I.countActive(ctx.owner);
  if (cpus > p.limits.cpus) {
    blocked.push({
      kind: 'profile_limit',
      field: 'cpus',
      reason: `requested cpus ${cpus} exceeds the limit of ${p.limits.cpus} set by profile "${p.name}" (limits.cpus)`,
      hint: `Request at most ${p.limits.cpus} cpus, or raise limits.cpus in policy.yaml.`,
    });
  }
  if (memoryBytes > p.limits.memoryBytes) {
    blocked.push({
      kind: 'profile_limit',
      field: 'memory',
      reason: `requested memory exceeds the limit set by profile "${p.name}" (limits.memory)`,
      hint: 'Request less memory, or raise limits.memory in policy.yaml.',
    });
  }
  if (ownerSandboxes >= p.limits.sandboxes) {
    blocked.push({
      kind: 'profile_limit',
      field: 'sandboxes',
      reason: `${ctx.owner} already has ${ownerSandboxes} sandbox(es); profile "${p.name}" allows at most ${p.limits.sandboxes} (limits.sandboxes)`,
      hint: 'Delete a sandbox you no longer need, then retry.',
    });
  }

  const fit = computeFit({
    request: { cpus, memoryBytes },
    capacity,
    profile: { name: p.name, ownerSandboxes, maxSandboxes: p.limits.sandboxes },
    blocked,
  });
  return {
    host: hostId,
    ts: capacity.ts,
    request: { template: template.name, cpus, memoryBytes },
    ...fit,
    blocked,
    capacity,
  };
}
