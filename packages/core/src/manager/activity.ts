import { AboxError } from '../errors.js';
import type { AuditEntry } from '../state/audit-log.js';
import { ACTIVITY_KINDS } from './types.js';
import type {
  ActivityEntry,
  ActivityKind,
  ActivityOptions,
  ActivityOutcome,
  ActivityView,
  Caller,
  RecentActivityOptions,
  RecentActivityView,
} from './types.js';
import type { Internals } from './internals.js';
import { collectNetworkEvents } from './network-audit.js';
import { destinationPattern } from './network-log.js';

/**
 * The activity timeline is a view of the audit log, like the network log: it has no storage of its own, so it
 * keeps the audit log's rules (append-only, hash-chained, secrets masked when written, same retention). What is
 * bounded here is the work for one answer: one page looks at most {@link MAX_ACTIVITY_LIMIT} audit entries of
 * the sandbox, newest first, and the next page starts behind the last one looked at (`cursor`).
 *
 * Only a whitelist of facts of each audit entry is passed on (see {@link describe}), every string clipped.
 * File writes show path and size, never content; commands are the already masked text of the audit entry,
 * environment variables are names only.
 */
export const DEFAULT_ACTIVITY_LIMIT = 100;
export const MAX_ACTIVITY_LIMIT = 500;
export const DEFAULT_RECENT_LIMIT = 20;
export const MAX_RECENT_LIMIT = 100;
/** Sandboxes of an agent looked at for the cross-sandbox list. */
const MAX_RECENT_SANDBOXES = 500;
/** Egress entries are stamped with the time of the collection; the event's own time can be earlier. */
const SINCE_SLACK_MS = 10 * 60_000;
const COLLECT_THROTTLE_MS = 1000;
const MAX_TEXT = 500;

interface Described {
  kind: ActivityKind;
  label: string;
  subject?: string;
  detail: Record<string, string | number | boolean>;
  approvalId?: string;
}

type Details = Record<string, unknown>;

const clip = (v: string, n = MAX_TEXT): string => (v.length > n ? `${v.slice(0, n - 1)}…` : v);
const text = (v: unknown, n = MAX_TEXT): string | undefined =>
  typeof v === 'string' && v !== '' ? clip(v, n) : undefined;
const int = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const list = (v: unknown, n = MAX_TEXT): string | undefined =>
  Array.isArray(v) && v.length > 0
    ? clip(
        v
          .filter((x): x is string | number => typeof x === 'string' || typeof x === 'number')
          .join(' '),
        n,
      )
    : undefined;
const reasons = (v: unknown): string | undefined =>
  Array.isArray(v) && v.length > 0
    ? clip(v.filter((x): x is string => typeof x === 'string').join('; '))
    : undefined;

/** Keeps the defined members of `o` (string / number / boolean only). */
function facts(o: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === 'string' && v !== '') out[k] = clip(v);
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
  }
  return out;
}

const hostPort = (d: Details): string | undefined => {
  const host = text(d['host'], 255);
  const port = int(d['port']);
  if (host === undefined) return undefined;
  return port !== undefined && port > 0 ? destinationPattern(host, port) : host;
};

/** The kind, label and whitelisted facts of an audit action; `undefined` for actions that are not activity. */
function describe(e: AuditEntry): Described | undefined {
  const d: Details = e.details ?? {};
  const approvalId = text(d['approvalId'], 80);
  const base = (
    kind: ActivityKind,
    label: string,
    subject: string | undefined,
    detail: Record<string, unknown>,
  ): Described => ({
    kind,
    label,
    ...(subject !== undefined ? { subject } : {}),
    detail: facts(detail),
    ...(approvalId ? { approvalId } : {}),
  });
  switch (e.action) {
    case 'sandbox.exec':
      return base('exec', 'Command', text(d['command']) ?? list(d['argv']), {
        cwd: text(d['cwd'], 300),
        env: list(d['envKeys'], 300),
        exitCode: int(d['exitCode']),
        durationMs: int(d['durationMs']),
        timedOut: d['timedOut'] === true ? true : undefined,
        truncated: d['truncated'] === true ? true : undefined,
        reason: reasons(d['reasons']) ?? text(d['reason']),
        message: text(d['message']),
      });
    case 'sandbox.process_start':
      return base('exec', 'Background process', text(d['command']) ?? list(d['argv']), {
        processId: text(d['processId'], 80),
        cwd: text(d['cwd'], 300),
        exitCode: int(d['exitCode']),
        reason: reasons(d['reasons']),
        message: text(d['message']),
      });
    case 'sandbox.process_stop':
      return base('exec', 'Stopped background process', text(d['processId'], 80), {});
    case 'sandbox.attach':
      return base('exec', 'Human shell opened', text(d['command']), {
        message: text(d['message']),
      });
    case 'sandbox.attach.end':
      return base('exec', 'Human shell closed', undefined, {
        durationMs: int(d['durationMs']),
        exitCode: int(d['exitCode']),
      });
    case 'sandbox.takeover':
      return base('exec', 'Human took over', undefined, { message: text(d['message']) });
    case 'sandbox.takeover.end':
      return base('exec', 'Human handed back', undefined, {
        durationMs: int(d['durationMs']),
        exitCode: int(d['exitCode']),
      });
    case 'sandbox.write_file':
      return base('file', 'Wrote file', text(d['path'], 300), {
        size: int(d['size']),
        mode: int(d['mode']) !== undefined ? int(d['mode'])!.toString(8) : undefined,
      });
    case 'sandbox.read_file':
      return base('file', 'Read file', text(d['path'], 300), {
        size: int(d['size']),
        returnedBytes: int(d['returnedBytes']),
        truncated: d['truncated'] === true ? true : undefined,
      });
    // Host paths of a copy are left out: the sandbox side is what the timeline is about.
    case 'sandbox.copy_in':
      return base('file', 'Copied into the sandbox', text(d['sandboxPath'], 300), {
        message: text(d['message']),
        reason: text(d['reason']),
      });
    case 'sandbox.copy_out':
      return base('file', 'Copied out of the sandbox', text(d['sandboxPath'], 300), {
        message: text(d['message']),
        reason: text(d['reason']),
      });
    case 'network.egress':
      return base(
        'network',
        e.decision === 'deny' ? 'Request denied' : 'Request allowed',
        hostPort(d),
        {
          method: text(d['method'], 16),
          ip: text(d['ip'], 64),
          reason: text(d['reason'], 200),
        },
      );
    case 'network.egress.summary':
      return base('network', 'Requests (overflow summary)', String(int(d['count']) ?? 0), {
        denied: int(d['denied']),
        allowed: int(d['allowed']),
      });
    case 'network.allow':
      return base('network', 'Destinations allowed', list(d['destinations']), {
        scope: text(d['scope'], 40),
        wildcard: d['wildcard'] === true ? true : undefined,
        reason: text(d['reason']),
      });
    case 'sandbox.port.add':
      return base('network', 'Port forward opened', int(d['sandboxPort'])?.toString(), {
        hostPort: int(d['hostPort']),
      });
    case 'sandbox.port.remove':
    case 'sandbox.port.close':
      return base('network', 'Port forward closed', int(d['sandboxPort'])?.toString(), {
        hostPort: int(d['hostPort']),
        reason: text(d['reason'], 80),
        message: text(d['message']),
      });
    case 'approval.request':
      return base('approval', 'Approval requested', text(d['for'], 80) ?? text(d['kind'], 80), {
        kind: text(d['kind'], 80),
        reasons: reasons(d['reasons']),
      });
    case 'approval.approve':
    case 'approval.deny':
      return base(
        'approval',
        e.action === 'approval.approve' ? 'Approval granted' : 'Approval denied',
        text(d['kind'], 80),
        { requester: text(d['requester'], 80), note: text(d['note'], 300) },
      );
    case 'approval.expired':
      return base('approval', 'Approval expired', undefined, {});
    case 'sandbox.access_request':
      return base('approval', 'Access requested', text(d['kind'], 80), {
        reason: reasons(d['reasons']),
        noop: text(d['noop']),
      });
    case 'sandbox.access_applied':
      return base('approval', 'Access applied', text(d['kind'], 80), {
        message: text(d['message']),
      });
    case 'sandbox.create':
      return base('lifecycle', 'Sandbox created', text(d['template'], 120), {
        isolation: text(d['isolation'], 40),
        host: text(d['host'], 120),
        reason: reasons(d['reasons']),
        message: text(d['message']),
      });
    case 'sandbox.start':
      return base('lifecycle', 'Sandbox started', undefined, { reason: text(d['reason'], 80) });
    case 'sandbox.stop':
      return base('lifecycle', 'Sandbox stopped', undefined, {});
    case 'sandbox.expired':
    case 'sandbox.expired_stop':
      return base('lifecycle', 'Sandbox expired', undefined, {});
    case 'sandbox.remove':
      return base('lifecycle', 'Sandbox removed', undefined, {});
    case 'sandbox.snapshot':
      return base('lifecycle', 'Snapshot taken', text(d['name'], 120), {});
    case 'sandbox.restore':
      return base('lifecycle', 'Snapshot restored', text(d['snapshotId'], 120), {});
    case 'sandbox.export':
      return base('lifecycle', 'Exported', text(d['format'], 40), {
        filesChanged: int(d['filesChanged']),
        branch: text(d['branch'], 120),
        reason: text(d['reason']),
        message: text(d['message']),
      });
    default:
      return undefined;
  }
}

/** Every audit action the timeline turns into an entry, by kind (for the query's action filter). */
const ACTIONS_OF_KIND: Record<ActivityKind, string[]> = {
  exec: [
    'sandbox.exec',
    'sandbox.process_start',
    'sandbox.process_stop',
    'sandbox.attach',
    'sandbox.attach.end',
    'sandbox.takeover',
    'sandbox.takeover.end',
  ],
  file: ['sandbox.write_file', 'sandbox.read_file', 'sandbox.copy_in', 'sandbox.copy_out'],
  network: [
    'network.egress',
    'network.egress.summary',
    'network.allow',
    'sandbox.port.add',
    'sandbox.port.remove',
    'sandbox.port.close',
  ],
  approval: [
    'approval.request',
    'approval.approve',
    'approval.deny',
    'approval.expired',
    'sandbox.access_request',
    'sandbox.access_applied',
  ],
  lifecycle: [
    'sandbox.create',
    'sandbox.start',
    'sandbox.stop',
    'sandbox.expired',
    'sandbox.expired_stop',
    'sandbox.remove',
    'sandbox.snapshot',
    'sandbox.restore',
    'sandbox.export',
  ],
};

function outcomeOf(e: AuditEntry): ActivityOutcome {
  switch (e.decision) {
    case 'deny':
    case 'denied':
      return 'denied';
    case 'error':
      return 'error';
    case 'approval':
      return 'pending';
    case 'info':
      return 'info';
    default:
      return 'ok';
  }
}

/** Entries of a sandbox's audit rows (newest first) as timeline items; runs of equal proxy decisions merge. */
export function toActivity(
  rows: readonly AuditEntry[],
  o: { since?: number; names?: ReadonlyMap<string, string> } = {},
): ActivityEntry[] {
  const out: ActivityEntry[] = [];
  for (const e of rows) {
    if (e.sandboxId === null) continue;
    const d = describe(e);
    if (!d) continue;
    const ts = e.action === 'network.egress' ? (int(e.details?.['eventTs']) ?? e.ts) : e.ts;
    if (o.since !== undefined && ts < o.since) continue;
    const outcome = outcomeOf(e);
    const name = o.names?.get(e.sandboxId);
    const prev = out[out.length - 1];
    if (
      prev &&
      e.action === 'network.egress' &&
      prev.action === 'network.egress' &&
      prev.sandboxId === e.sandboxId &&
      prev.subject === d.subject &&
      prev.outcome === outcome
    ) {
      prev.count++;
      prev.from = Math.min(prev.from ?? prev.ts, ts);
      continue;
    }
    out.push({
      seq: e.seq,
      ts,
      kind: d.kind,
      action: e.action,
      actor: clip(e.actor, 80),
      outcome,
      summary: d.subject !== undefined ? `${d.label}: ${d.subject}` : d.label,
      ...(d.subject !== undefined ? { subject: d.subject } : {}),
      detail: d.detail,
      count: 1,
      ...(d.approvalId ? { approvalId: d.approvalId } : {}),
      sandboxId: e.sandboxId,
      ...(name !== undefined ? { sandboxName: clip(name, 120) } : {}),
    });
  }
  return out;
}

function checkKinds(kinds: unknown): ActivityKind[] {
  if (kinds === undefined) return [...ACTIVITY_KINDS];
  if (
    !Array.isArray(kinds) ||
    kinds.length === 0 ||
    !kinds.every((k) => (ACTIVITY_KINDS as readonly unknown[]).includes(k))
  )
    throw new AboxError(
      'invalid_input',
      `kinds must be a non-empty list of: ${ACTIVITY_KINDS.join(', ')}`,
    );
  return [...new Set(kinds as ActivityKind[])];
}

function checkSince(since: unknown): number | undefined {
  if (since === undefined) return undefined;
  if (typeof since !== 'number' || !Number.isFinite(since) || since < 0)
    throw new AboxError('invalid_input', 'since must be a time in milliseconds since the epoch');
  return since;
}

function checkLimit(limit: unknown, dflt: number, max: number): number {
  if (limit === undefined) return dflt;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1)
    throw new AboxError('invalid_input', 'limit must be a positive integer');
  return Math.min(limit, max);
}

function checkCursor(cursor: unknown): number | undefined {
  if (cursor === undefined) return undefined;
  if (typeof cursor !== 'string' || !/^\d{1,15}$/.test(cursor))
    throw new AboxError('invalid_input', 'cursor must be the nextCursor of a previous page');
  return Number(cursor);
}

const actionsOf = (kinds: readonly ActivityKind[]): string[] =>
  kinds.flatMap((k) => ACTIONS_OF_KIND[k]);

/**
 * The activity timeline of one sandbox, newest first, one page at a time. Owner or human (an agent only ever
 * sees its own sandboxes: anything else is `not_found`). Pulls in the proxy's newest decisions first.
 */
export async function activity(
  I: Internals,
  caller: Caller,
  id: string,
  o: ActivityOptions = {},
): Promise<ActivityView> {
  const ctx = await I.context(caller);
  const rec = I.lookup(ctx, id, { allowRemoved: true });
  const kinds = checkKinds(o.kinds);
  const since = checkSince(o.since);
  const limit = checkLimit(o.limit, DEFAULT_ACTIVITY_LIMIT, MAX_ACTIVITY_LIMIT);
  const before = checkCursor(o.cursor);
  if (kinds.includes('network'))
    await collectNetworkEvents(I, rec, { throttleMs: COLLECT_THROTTLE_MS });
  const rows = I.state.audit.query({
    sandboxId: rec.id,
    action: actionsOf(kinds),
    ...(since !== undefined ? { since: Math.max(0, since - SINCE_SLACK_MS) } : {}),
    ...(before !== undefined ? { beforeSeq: before } : {}),
    limit: limit + 1,
    order: 'desc',
  });
  const more = rows.length > limit;
  const page = more ? rows.slice(0, limit) : rows;
  return {
    sandboxId: rec.id,
    entries: toActivity(page, { ...(since !== undefined ? { since } : {}) }),
    ...(more ? { nextCursor: String(page[page.length - 1]!.seq) } : {}),
  };
}

/** Actions that are noise in a short "what happened lately" list: reads and requests the proxy allowed. */
const RECENT_SKIP = new Set(['sandbox.read_file']);

/**
 * The newest activity across the sandboxes the caller may see (a human: all; an agent: its own), for an
 * overview. Bounded: at most {@link MAX_RECENT_LIMIT} entries, from at most four times as many audit
 * entries. Allowed proxy requests and file reads are left out (they would crowd out everything else).
 */
export async function recentActivity(
  I: Internals,
  caller: Caller,
  o: RecentActivityOptions = {},
): Promise<RecentActivityView> {
  const ctx = await I.context(caller);
  const kinds = checkKinds(o.kinds);
  const since = checkSince(o.since);
  const limit = checkLimit(o.limit, DEFAULT_RECENT_LIMIT, MAX_RECENT_LIMIT);
  const recs = I.state.sandboxes.list({
    ...(ctx.kind === 'agent' ? { owner: ctx.owner } : {}),
    includeRemoved: true,
  });
  const names = new Map(recs.map((r) => [r.id, r.name]));
  const own =
    ctx.kind === 'agent' ? recs.slice(0, MAX_RECENT_SANDBOXES).map((r) => r.id) : undefined;
  const rows = I.state.audit.query({
    action: actionsOf(kinds).filter((a) => !RECENT_SKIP.has(a)),
    ...(own !== undefined ? { sandboxIds: own } : {}),
    ...(since !== undefined ? { since: Math.max(0, since - SINCE_SLACK_MS) } : {}),
    limit: limit * 4,
    order: 'desc',
  });
  const entries = toActivity(
    rows.filter((e) => !(e.action === 'network.egress' && e.decision !== 'deny')),
    { ...(since !== undefined ? { since } : {}), names },
  );
  return { entries: entries.slice(0, limit) };
}
