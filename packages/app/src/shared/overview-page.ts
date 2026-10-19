/**
 * What the start page ("Overview") shows, computed from the answers the other views already use: the sandbox list,
 * the approval queue, the doctor report, the audit-based activity and the hosts. Pure and free of React so that the
 * numbers and the one-line summaries can be tested on their own; the texts are in the i18n catalogs.
 */
import type {
  ActivityEntry,
  ApprovalView,
  DoctorReport,
  HostCapacity,
  SandboxView,
} from '@abox/core';
import { riskHints } from './approval-diff';
import { formatDuration, shortId } from './format';
import type { HostRow } from './types';

/** "Expires soon" on the start page: running sandboxes with less than this left. */
export const EXPIRY_WINDOW_MS = 15 * 60_000;
/** Hosts shown on the start page before "all hosts" (the Hosts view has them all). */
export const OVERVIEW_MAX_HOSTS = 6;
/** Entries of the activity list. */
export const OVERVIEW_ACTIVITY_LIMIT = 8;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// -- sandboxes ------------------------------------------------------------------------------------------------

export function runningSandboxes(all: readonly SandboxView[]): SandboxView[] {
  return all.filter((s) => s.state === 'running' && !s.stale);
}

/** Sandboxes that need a look: failed, not reported by their backend, or on a host that cannot be reached. */
export function problemSandboxes(all: readonly SandboxView[]): SandboxView[] {
  return all.filter(
    (s) =>
      s.state === 'failed' ||
      s.stale ||
      s.missingInBackend ||
      (!s.hostReachable && s.state !== 'removed'),
  );
}

/** Running sandboxes that expire within `windowMs`, the soonest first. */
export function expiringSoon(
  all: readonly SandboxView[],
  now: number,
  windowMs = EXPIRY_WINDOW_MS,
): SandboxView[] {
  return runningSandboxes(all)
    .filter((s) => s.expiresAt - now <= windowMs)
    .sort((a, b) => a.expiresAt - b.expiresAt);
}

// -- diagnostics ----------------------------------------------------------------------------------------------

export interface ProblemCount {
  /** Errors and warnings of the doctor report: what needs action. */
  problems: number;
  errors: number;
  warnings: number;
  /** Advisory notes about something that works. */
  info: number;
}

export function problemCount(report: DoctorReport): ProblemCount {
  const s = report.summary;
  return {
    problems: s.error + s.warning,
    errors: s.error,
    warnings: s.warning,
    info:
      s.info +
      report.checks.reduce(
        (n, c) => n + (c.notes?.filter((x) => x.severity === 'info').length ?? 0),
        0,
      ),
  };
}

// -- approvals ------------------------------------------------------------------------------------------------

export interface ApprovalHeadline {
  /** i18n key and parameters of the one-line title; `null`: no specific title, use the kind label. */
  key: string;
  params: Record<string, string | number>;
  /**
   * The title says everything the human has to judge (a lifetime, a few destinations, a port): "Allow" and "Deny" are
   * offered right on the start page. Anything else (a create with its isolation, mounts or secrets, a command, a template
   * to trust) needs the details first, as in the approvals view.
   */
  quick: boolean;
}

const MAX_SHOWN_DOMAINS = 3;

/**
 * A short title for the access requests that fit in one line. Everything is read from the request the approval is bound
 * to (never from the agent's reason). Returns null for requests that need the full view.
 */
export function approvalHeadline(
  a: Pick<ApprovalView, 'kind' | 'request' | 'sandboxId'>,
  sandboxName: string,
): ApprovalHeadline | null {
  if (a.kind !== 'access' || !isRecord(a.request) || !isRecord(a.request['request'])) return null;
  const req = a.request['request'];
  const details = isRecord(req['details']) ? req['details'] : {};
  const hints = riskHints(a.kind, a.request);
  const calm = hints.every((h) => h === 'port_forward' || h === 'network_destinations');
  switch (req['kind']) {
    case 'port': {
      const port = details['sandboxPort'];
      if (typeof port !== 'number') return null;
      return { key: 'overview.approval.port', params: { port, sandbox: sandboxName }, quick: calm };
    }
    case 'ttl': {
      const ms = details['ttlMs'];
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return null;
      return {
        key: 'overview.approval.ttl',
        params: { ttl: formatDuration(ms), sandbox: sandboxName },
        quick: calm,
      };
    }
    case 'network': {
      const domains = Array.isArray(details['domains'])
        ? details['domains'].filter((d): d is string => typeof d === 'string')
        : [];
      if (domains.length === 0) return null;
      const privateExceptions = details['privateExceptions'];
      const plain =
        (details['mode'] === undefined || details['mode'] === 'allowlist') &&
        !(Array.isArray(privateExceptions) && privateExceptions.length > 0);
      return {
        key: 'overview.approval.network',
        params: {
          domains: domains.slice(0, MAX_SHOWN_DOMAINS).join(', '),
          sandbox: sandboxName,
        },
        quick: calm && plain && domains.length <= MAX_SHOWN_DOMAINS,
      };
    }
    default:
      return null;
  }
}

// -- hosts ----------------------------------------------------------------------------------------------------

/**
 * The hosts of the start page: this computer first, then favorites, then hosts that run sandboxes, then the rest by
 * name; at most `max` of them (every shown host is measured, an ssh host costs a round trip).
 */
export function overviewHosts(
  rows: readonly HostRow[],
  sandboxes: readonly SandboxView[],
  max = OVERVIEW_MAX_HOSTS,
): { shown: HostRow[]; hidden: number } {
  const busy = new Set(sandboxes.map((s) => s.host));
  const rank = (r: HostRow): number =>
    r.profile.kind === 'local' ? 0 : r.profile.favorite ? 1 : busy.has(r.profile.id) ? 2 : 3;
  const sorted = [...rows].sort(
    (a, b) => rank(a) - rank(b) || a.profile.id.localeCompare(b.profile.id),
  );
  return { shown: sorted.slice(0, max), hidden: Math.max(0, sorted.length - max) };
}

/** The sandbox bar of a host: running + stopped sandboxes against the limit; `limit` null when the host has none. */
export function sandboxBar(c: HostCapacity): { count: number; limit: number | null } {
  const lim = c.limits.sandboxes;
  return { count: c.abox.sandboxes, limit: lim ? lim.limit : null };
}

// -- activity -------------------------------------------------------------------------------------------------

export type ActivityBadge = 'ok' | 'blocked' | 'error' | 'export' | 'pending';

/**
 * The entries of the cross-sandbox activity list that belong on the start page: what agents did (not you, not the
 * system), without the approval requests (the approvals card shows those) and without the proxy's allowed requests
 * (only the denied ones are news).
 */
export function agentActivity(
  entries: readonly ActivityEntry[],
  limit = OVERVIEW_ACTIVITY_LIMIT,
): ActivityEntry[] {
  return entries
    .filter(
      (e) =>
        e.actor.startsWith('agent:') &&
        e.kind !== 'approval' &&
        (e.kind !== 'network' || e.outcome === 'denied'),
    )
    .slice(0, limit);
}

export function activityBadge(e: Pick<ActivityEntry, 'outcome' | 'action'>): ActivityBadge {
  if (e.outcome === 'denied') return 'blocked';
  if (e.outcome === 'error') return 'error';
  if (e.outcome === 'pending') return 'pending';
  return e.action === 'sandbox.export' ? 'export' : 'ok';
}

/** The catalog key of the action's label (the activity tab's labels; the proxy's two decisions are two labels). */
export function activityLabelKey(e: Pick<ActivityEntry, 'action' | 'outcome'>): string {
  if (e.action === 'network.egress')
    return `activity.action.network.egress.${e.outcome === 'denied' ? 'deny' : 'allow'}`;
  return `activity.action.${e.action}`;
}

/** What follows the subject in the one-line summary: an exit code with the duration, or how many files an export changed. */
export function activityResult(e: ActivityEntry): { code?: number; time?: string; files?: number } {
  const d = e.detail;
  const out: { code?: number; time?: string; files?: number } = {};
  if (typeof d['exitCode'] === 'number') {
    out.code = d['exitCode'];
    if (typeof d['durationMs'] === 'number') out.time = formatDuration(d['durationMs']);
  }
  if (e.action === 'sandbox.export' && typeof d['filesChanged'] === 'number')
    out.files = d['filesChanged'];
  return out;
}

/** The name a sandbox is shown under: the registry name when the list has it, else its short id. */
export function sandboxLabel(id: string, byId: ReadonlyMap<string, SandboxView>): string {
  return byId.get(id)?.name ?? shortId(id);
}
