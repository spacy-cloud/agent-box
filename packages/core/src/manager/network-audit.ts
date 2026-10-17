import { transaction } from '../state/db.js';
import type { SandboxRecord } from '../state/sandbox-registry.js';
import type { NetworkEvent } from '../types.js';
import type { Internals, StoredEffective } from './internals.js';

/** Individual `network.egress` entries per collection before the rest is summarized. */
const MAX_DENY_ENTRIES = 500;
const MAX_ALLOW_ENTRIES = 200;
const SUMMARY_TOP = 50;
/** Minimum time between two collections for the same sandbox when the caller asks for throttling. */
export const NET_POLL_THROTTLE_MS = 2000;

const clip = (s: unknown, n: number): string => String(s ?? '').slice(0, n);

/**
 * Copies the egress decisions the proxy recorded for a sandbox into the audit log
 * (`network.egress`, decision `allow` / `deny`, with host, port, method, reason; never headers, paths
 * or bodies). Every call asks the backend only for events newer than the per-sandbox cursor kept in
 * the state db, so each event is audited once, also when several processes (CLI, MCP, GUI) collect
 * at the same time. Best effort: a backend that cannot be reached must never break the operation that
 * triggered the collection. Returns the number of events audited.
 *
 * `throttleMs`: skip when this process collected for the sandbox less than that long ago.
 */
export async function collectNetworkEvents(
  I: Internals,
  rec: SandboxRecord,
  o: { throttleMs?: number } = {},
): Promise<number> {
  if (I.closed) return 0;
  if (rec.state === 'removed' || rec.state === 'failed' || rec.state === 'preparing') return 0;
  const eff = rec.effective as Partial<StoredEffective> | null;
  if (eff?.network?.mode !== 'allowlist') return 0;
  const t = Date.now();
  if (o.throttleMs && t - (I.netPolledAt.get(rec.id) ?? -Infinity) < o.throttleMs) return 0;
  I.netPolledAt.set(rec.id, t);
  try {
    const provider = await I.providerForRecord(rec);
    if (!provider.networkEvents) return 0;
    const start = I.state.sandboxes.getNetCursor(rec.id) ?? { ts: rec.createdAt, seen: 0 };
    const events = await provider.networkEvents(rec.id, start.ts);
    if (I.closed || events.length === 0) return 0;
    // Stable sort: events of one millisecond keep the order of the proxy log.
    const ordered = events
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => Number.isFinite(e.ts))
      .sort((a, b) => a.e.ts - b.e.ts || a.i - b.i)
      .map(({ e }) => e);
    return transaction(I.state.db, () => {
      // Another process may have collected meanwhile: filter against the cursor as it is now.
      const cur = I.state.sandboxes.getNetCursor(rec.id) ?? { ts: rec.createdAt, seen: 0 };
      const fresh: NetworkEvent[] = [];
      let atCursor = 0;
      for (const e of ordered) {
        if (e.ts < cur.ts) continue;
        if (e.ts === cur.ts && atCursor++ < cur.seen) continue;
        fresh.push(e);
      }
      if (fresh.length === 0) return 0;
      const last = fresh[fresh.length - 1]!;
      const sameTsBefore = last.ts === cur.ts ? cur.seen : 0;
      const next = {
        ts: last.ts,
        seen: sameTsBefore + fresh.filter((e) => e.ts === last.ts).length,
      };
      writeEntries(I, rec, fresh);
      I.state.sandboxes.setNetCursor(rec.id, next);
      return fresh.length;
    });
  } catch {
    return 0;
  }
}

function writeEntries(I: Internals, rec: SandboxRecord, events: NetworkEvent[]): void {
  let denies = 0;
  let allows = 0;
  const overflow: NetworkEvent[] = [];
  for (const e of events) {
    const deny = e.decision === 'deny';
    if (deny ? denies >= MAX_DENY_ENTRIES : allows >= MAX_ALLOW_ENTRIES) {
      overflow.push(e);
      continue;
    }
    if (deny) denies++;
    else allows++;
    I.audit(rec.owner, 'network.egress', {
      sandboxId: rec.id,
      decision: deny ? 'deny' : 'allow',
      details: {
        host: clip(e.host, 255),
        port: e.port,
        method: clip(e.method, 16),
        ...(e.ip ? { ip: clip(e.ip, 64) } : {}),
        ...(e.reason ? { reason: clip(e.reason, 200) } : {}),
        eventTs: e.ts,
      },
    });
  }
  if (overflow.length === 0) return;
  const counts = new Map<string, { host: string; port: number; decision: string; count: number }>();
  for (const e of overflow) {
    const key = `${e.decision}|${e.host}|${e.port}`;
    const c = counts.get(key);
    if (c) c.count++;
    else counts.set(key, { host: clip(e.host, 255), port: e.port, decision: e.decision, count: 1 });
  }
  const top = [...counts.values()].sort((a, b) => b.count - a.count).slice(0, SUMMARY_TOP);
  I.audit(rec.owner, 'network.egress.summary', {
    sandboxId: rec.id,
    decision: 'info',
    details: {
      count: overflow.length,
      denied: overflow.filter((e) => e.decision === 'deny').length,
      allowed: overflow.filter((e) => e.decision !== 'deny').length,
      fromEventTs: overflow[0]!.ts,
      toEventTs: overflow[overflow.length - 1]!.ts,
      byHost: top,
      note: 'too many events for one-by-one entries; the proxy log has the full list',
    },
  });
}

/** Collect for every live allowlist sandbox visible to the caller (used before an audit query). */
export async function collectAllNetworkEvents(
  I: Internals,
  owner: string | undefined,
  throttleMs: number,
): Promise<void> {
  for (const rec of I.state.sandboxes.list({
    ...(owner ? { owner } : {}),
    state: ['created', 'running', 'stopped', 'expired'],
  })) {
    await collectNetworkEvents(I, rec, { throttleMs });
  }
}
