import { AboxError } from '../errors.js';
import type { ResourceUsage } from '../types.js';
import type { Internals } from './internals.js';
import type { Caller, SandboxStatsResult } from './types.js';

const STATS_MAX_IDS = 200;
/** Samples taken in parallel: each one takes about a second on a container engine. */
const STATS_PARALLEL = 6;

/**
 * Live resource usage (cpu, memory, pids) of running sandboxes, for the GUI's table and detail view.
 * Human only. Best effort per sandbox: one that is not running, whose backend has no `stats`, whose
 * host cannot be reached or whose sample fails is simply left out of the result (the GUI then shows
 * the configured values only). Nothing is audited: the call is a read-only poll.
 */
export async function sandboxStats(
  I: Internals,
  caller: Caller,
  ids: string[],
): Promise<SandboxStatsResult> {
  const ctx = await I.context(caller);
  I.requireHuman(ctx, 'sandbox.stats');
  if (
    !Array.isArray(ids) ||
    ids.length > STATS_MAX_IDS ||
    ids.some((i) => typeof i !== 'string' || i.length === 0 || i.length > 200)
  ) {
    throw new AboxError('invalid_input', `ids must be an array of at most ${STATS_MAX_IDS} ids`);
  }
  const usage: Record<string, ResourceUsage> = {};
  const queue = [...new Set(ids)];
  const worker = async (): Promise<void> => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      try {
        const rec = I.state.sandboxes.get(id);
        if (!rec || rec.state !== 'running' || rec.expiresAt <= I.now()) continue;
        const provider = await I.providerForRecord(rec);
        if (!provider.stats || provider.capabilities().stats !== true) continue;
        usage[id] = await provider.stats(id);
      } catch {
        /* not running any more, host gone, engine busy: no data for this one */
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(STATS_PARALLEL, queue.length) }, worker));
  return { usage };
}
