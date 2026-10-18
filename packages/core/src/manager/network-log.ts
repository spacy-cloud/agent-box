import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { AboxError } from '../errors.js';
import {
  DEFAULT_POLICY_YAML,
  domainCovered,
  networkDestinationProblem,
  normalizeDomainPattern,
  profileDomains,
  proposeNetworkAllow,
  resolveContext,
  wildcardFor,
  DEFAULT_ALLOW_PORTS,
} from '../policy/index.js';
import type { AgentContext } from '../policy/index.js';
import type { AuditEntry } from '../state/audit-log.js';
import type { SandboxRecord } from '../state/sandbox-registry.js';
import type { NetworkMode } from '../types.js';
import { accessRequest } from './access.js';
import { confirmationRequired } from './approvals.js';
import type { Internals, StoredEffective } from './internals.js';
import { collectNetworkEvents } from './network-audit.js';
import type {
  AccessResult,
  Caller,
  NetworkAllowAdvice,
  NetworkAllowInput,
  NetworkDenials,
  NetworkLogEntry,
  NetworkLogOptions,
  NetworkLogView,
  NetworkPolicyProposal,
  NetworkReasonKind,
} from './types.js';
import { parseInput } from './util.js';

/**
 * The network log of a sandbox is a view of the audit log: the egress proxy's decisions are copied there
 * (`network.egress`, one entry per request, floods as `network.egress.summary`, see network-audit.ts), so the log
 * has no storage of its own. That gives it the audit log's rules: append-only, hash-chained, never any header,
 * path, body or secret (the proxy records host, port, method, resolved address and the reason only), and the same
 * retention. What is bounded here is the work for one answer: at most {@link MAX_LOG_EVENTS} entries of the
 * sandbox are aggregated per call, newest first.
 */
export const MAX_LOG_EVENTS = 10_000;
export const DEFAULT_LOG_LIMIT = 200;
export const MAX_LOG_LIMIT = 1000;
/** Collections for the same sandbox closer together than this are skipped (the GUI polls). */
const LOG_COLLECT_THROTTLE_MS = 1000;
const SINCE_SLACK_MS = 10 * 60_000;
const MAX_METHODS = 8;
const MAX_DESTINATIONS = 32;
const EGRESS = 'network.egress';
const SUMMARY = 'network.egress.summary';

/** Maps the proxy's wording to a kind (the wording itself is `docs/internal/proxy-contract.md`). */
export function classifyReason(reason: string | undefined): NetworkReasonKind | undefined {
  if (!reason) return undefined;
  if (reason === 'not in allowlist') return 'not_in_allowlist';
  if (reason === 'port not allowed') return 'port_not_allowed';
  if (reason === 'ip literal not allowed') return 'ip_literal';
  if (reason.startsWith('blocked address')) return 'blocked_address';
  if (reason.startsWith('dns lookup')) return 'dns_failed';
  if (reason === 'plain http to injection host') return 'plain_http_injection';
  if (reason === 'method not allowed') return 'method_not_allowed';
  if (reason.startsWith('connect failed')) return 'connect_failed';
  if (
    reason.startsWith('invalid ') ||
    reason.startsWith('ambiguous') ||
    reason === 'empty host' ||
    reason === 'host too long' ||
    reason === 'missing port' ||
    reason === 'userinfo not allowed' ||
    reason === 'bad request target' ||
    reason === 'proxy request expected' ||
    reason === 'early data before tunnel established' ||
    reason.startsWith('only http://')
  )
    return 'invalid_request';
  return 'other';
}

/** The allowlist pattern for host and port: `host` for the default ports 80 / 443, else `host:port`. */
export function destinationPattern(host: string, port: number): string {
  return DEFAULT_ALLOW_PORTS.includes(port) ? host : `${host}:${port}`;
}

interface Group {
  host: string;
  port: number;
  allowed: number;
  denied: number;
  summarized: number;
  first: number;
  last: number;
  lastDecision: 'allow' | 'deny';
  lastDecisionTs: number;
  denyReason?: string;
  denyReasonTs: number;
  anyReason?: string;
  anyReasonTs: number;
  methods: Set<string>;
}

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const str = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' ? v.slice(0, max) : undefined;

function groupFor(groups: Map<string, Group>, host: string, port: number): Group {
  const key = `${host}\n${port}`;
  let g = groups.get(key);
  if (!g) {
    g = {
      host,
      port,
      allowed: 0,
      denied: 0,
      summarized: 0,
      first: Infinity,
      last: -Infinity,
      lastDecision: 'allow',
      lastDecisionTs: -Infinity,
      denyReasonTs: -Infinity,
      anyReasonTs: -Infinity,
      methods: new Set(),
    };
    groups.set(key, g);
  }
  return g;
}

/** Why the destination of an entry can (not) be allowed. */
function adviceFor(
  host: string,
  port: number,
  kind: NetworkReasonKind | undefined,
): NetworkAllowAdvice {
  const no = (why: string): NetworkAllowAdvice => ({ possible: false, why });
  switch (kind) {
    case 'not_in_allowlist':
    case 'port_not_allowed': {
      if (host === '' || port < 1)
        return no('the request could not be read, so there is no destination to allow');
      const pattern = destinationPattern(host, port);
      const problem = networkDestinationProblem(pattern);
      if (problem) return no(problem);
      const wildcard = wildcardFor(host);
      return {
        possible: true,
        pattern: normalizeDomainPattern(pattern) ?? pattern,
        ...(wildcard
          ? { wildcard: DEFAULT_ALLOW_PORTS.includes(port) ? wildcard : `${wildcard}:${port}` }
          : {}),
      };
    }
    case 'ip_literal':
      return no(
        'it is an IP address; use the host name (the proxy never connects to private or metadata addresses, and IP addresses are not allowed here)',
      );
    case 'blocked_address':
      return no(
        'the name resolves to a private, local or cloud-metadata address, which the proxy never connects to. A range of private addresses can only be opened by a private-address exception (access_request kind=network with private_exceptions), which a human has to approve',
      );
    case 'dns_failed':
      return no('the name did not resolve; check the spelling (allowing it would change nothing)');
    case 'plain_http_injection':
      return no('a secret is injected for this host over https only; use https instead of http');
    case 'method_not_allowed':
      return no('this request method is refused by the proxy whatever the allowlist says');
    case 'invalid_request':
      return no('the request was malformed, so there is no destination to allow');
    default:
      return no('the denial does not come from the allowlist');
  }
}

export interface AggregateOptions {
  since?: number;
  denied?: boolean;
  limit: number;
  /** Current allowlist of the sandbox (for `allowedNow` and the advice). */
  allow: readonly string[];
  mode: NetworkMode;
}

/**
 * Groups `network.egress` / `network.egress.summary` audit entries by destination. Pure (no I/O), the
 * counting rules are tested on their own. Entries may come in any order.
 */
export function aggregateNetworkLog(
  entries: readonly AuditEntry[],
  o: AggregateOptions,
): { entries: NetworkLogEntry[]; totals: NetworkLogView['totals']; truncated: boolean } {
  const groups = new Map<string, Group>();
  const touch = (
    g: Group,
    ts: number,
    decision: 'allow' | 'deny',
    reason: string | undefined,
    method: string | undefined,
  ): void => {
    if (ts < g.first) g.first = ts;
    if (ts > g.last) g.last = ts;
    if (ts >= g.lastDecisionTs) {
      g.lastDecisionTs = ts;
      g.lastDecision = decision;
    }
    if (reason) {
      if (ts >= g.anyReasonTs) {
        g.anyReasonTs = ts;
        g.anyReason = reason;
      }
      if (decision === 'deny' && ts >= g.denyReasonTs) {
        g.denyReasonTs = ts;
        g.denyReason = reason;
      }
    }
    if (method && g.methods.size < MAX_METHODS) g.methods.add(method);
  };

  for (const e of entries) {
    const d = e.details ?? {};
    if (e.action === EGRESS) {
      const decision = e.decision === 'deny' ? 'deny' : 'allow';
      if (o.denied && decision !== 'deny') continue;
      const ts = num(d['eventTs']) ?? e.ts;
      if (o.since !== undefined && ts < o.since) continue;
      const g = groupFor(groups, str(d['host'], 255) ?? '', num(d['port']) ?? 0);
      if (decision === 'deny') g.denied++;
      else g.allowed++;
      touch(g, ts, decision, str(d['reason'], 200), str(d['method'], 16));
    } else if (e.action === SUMMARY) {
      // Overflow of a flood: only counts per destination, with the time span of the whole summary.
      const to = num(d['toEventTs']) ?? e.ts;
      const from = num(d['fromEventTs']) ?? to;
      if (o.since !== undefined && to < o.since) continue;
      const by = Array.isArray(d['byHost']) ? d['byHost'] : [];
      for (const raw of by) {
        if (typeof raw !== 'object' || raw === null) continue;
        const r = raw as Record<string, unknown>;
        const decision = r['decision'] === 'deny' ? 'deny' : 'allow';
        if (o.denied && decision !== 'deny') continue;
        const count = num(r['count']);
        if (count === undefined || count < 1) continue;
        const g = groupFor(groups, str(r['host'], 255) ?? '', num(r['port']) ?? 0);
        if (decision === 'deny') g.denied += count;
        else g.allowed += count;
        g.summarized += count;
        touch(g, from, decision, undefined, undefined);
        touch(g, to, decision, undefined, undefined);
      }
    }
  }

  const out: NetworkLogEntry[] = [];
  let allowed = 0;
  let denied = 0;
  for (const g of groups.values()) {
    allowed += g.allowed;
    denied += g.denied;
    const reason = g.denied > 0 ? (g.denyReason ?? undefined) : g.anyReason;
    const kind = classifyReason(reason);
    const pattern = g.host !== '' && g.port > 0 ? destinationPattern(g.host, g.port) : undefined;
    const allowedNow = pattern !== undefined && domainCovered(pattern, o.allow);
    const entry: NetworkLogEntry = {
      host: g.host,
      port: g.port,
      decision: g.lastDecision,
      allowed: g.allowed,
      denied: g.denied,
      count: g.allowed + g.denied,
      firstSeen: g.first,
      lastSeen: g.last,
      ...(reason ? { reason } : {}),
      ...(kind ? { reasonKind: kind } : {}),
      methods: [...g.methods].sort(),
      summarized: g.summarized,
      allowedNow,
      ...(g.denied > 0 && !allowedNow && o.mode === 'allowlist'
        ? { allow: adviceFor(g.host, g.port, classifyReason(g.denyReason)) }
        : {}),
    };
    out.push(entry);
  }
  out.sort((a, b) => b.lastSeen - a.lastSeen || a.host.localeCompare(b.host) || a.port - b.port);
  const limit = Math.max(1, Math.min(o.limit, MAX_LOG_LIMIT));
  return {
    entries: out.slice(0, limit),
    totals: { allowed, denied, destinations: out.length },
    truncated: out.length > limit,
  };
}

function networkOf(rec: SandboxRecord): { mode: NetworkMode; allow: string[] } {
  const eff = rec.effective as Partial<StoredEffective> | null;
  return {
    mode: (eff?.network?.mode ?? 'none') as NetworkMode,
    allow: [...(eff?.network?.allow ?? [])],
  };
}

/**
 * The egress log of one sandbox, grouped by destination. Owner or human (an agent only ever sees its own
 * sandboxes: anything else is `not_found`). Pulls in the proxy's newest decisions first.
 */
export async function networkLog(
  I: Internals,
  caller: Caller,
  id: string,
  o: NetworkLogOptions = {},
): Promise<NetworkLogView> {
  const ctx = await I.context(caller);
  const rec = I.lookup(ctx, id, { allowRemoved: true });
  if (o.since !== undefined && !(Number.isFinite(o.since) && o.since >= 0))
    throw new AboxError('invalid_input', 'since must be a time in milliseconds since the epoch');
  if (o.limit !== undefined && !(Number.isInteger(o.limit) && o.limit > 0))
    throw new AboxError('invalid_input', 'limit must be a positive integer');
  await collectNetworkEvents(I, rec, { throttleMs: LOG_COLLECT_THROTTLE_MS });
  const net = networkOf(rec);
  const rows = I.state.audit.query({
    sandboxId: rec.id,
    action: [EGRESS, SUMMARY],
    // The audit entry is written when the event is collected, normally right after it happened; the slack covers
    // the clock of a remote host running ahead. The exact cut is made on the event's own time.
    ...(o.since !== undefined ? { since: Math.max(0, o.since - SINCE_SLACK_MS) } : {}),
    limit: MAX_LOG_EVENTS + 1,
    order: 'desc',
  });
  const capped = rows.length > MAX_LOG_EVENTS;
  const agg = aggregateNetworkLog(capped ? rows.slice(0, MAX_LOG_EVENTS) : rows, {
    ...(o.since !== undefined ? { since: o.since } : {}),
    ...(o.denied ? { denied: true } : {}),
    limit: o.limit ?? DEFAULT_LOG_LIMIT,
    allow: net.allow,
    mode: net.mode,
  });
  return {
    sandboxId: rec.id,
    mode: net.mode,
    entries: agg.entries,
    totals: agg.totals,
    truncated: capped || agg.truncated,
    maxEvents: MAX_LOG_EVENTS,
  };
}

/**
 * What the proxy denied for `rec` since audit entry `afterSeq` (the entries other processes collected
 * meanwhile count too). Used to tell the caller of an exec what its command ran into.
 */
export function denialsSince(
  I: Internals,
  rec: SandboxRecord,
  afterSeq: number,
): NetworkDenials | undefined {
  if (networkOf(rec).mode !== 'allowlist') return undefined;
  const rows = I.state.audit.query({
    sandboxId: rec.id,
    action: [EGRESS, SUMMARY],
    afterSeq,
    limit: 2000,
    order: 'asc',
  });
  const by = new Map<string, { host: string; port: number; count: number }>();
  let total = 0;
  const add = (host: string, port: number, count: number): void => {
    const key = `${host}\n${port}`;
    const cur = by.get(key);
    if (cur) cur.count += count;
    else by.set(key, { host, port, count });
    total += count;
  };
  for (const e of rows) {
    const d = e.details ?? {};
    if (e.action === EGRESS && e.decision === 'deny') {
      add(str(d['host'], 255) ?? '', num(d['port']) ?? 0, 1);
    } else if (e.action === SUMMARY && Array.isArray(d['byHost'])) {
      for (const raw of d['byHost']) {
        const r = raw as Record<string, unknown> | null;
        if (r && r['decision'] === 'deny' && num(r['count']) !== undefined)
          add(str(r['host'], 255) ?? '', num(r['port']) ?? 0, num(r['count'])!);
      }
    }
  }
  if (total === 0) return undefined;
  const hosts = [...by.values()].sort((a, b) => b.count - a.count || a.host.localeCompare(b.host));
  return { denied: total, hosts: hosts.slice(0, 5), moreHosts: Math.max(0, hosts.length - 5) };
}

// ---------------------------------------------------------------------------
// allow
// ---------------------------------------------------------------------------

const allowSchema = z.strictObject({
  destinations: z.array(z.string().min(1).max(260)).min(1).max(MAX_DESTINATIONS),
});

interface Checked {
  rec: SandboxRecord;
  /** Normalized patterns, as the allowlist takes them. */
  patterns: string[];
  wildcards: string[];
}

function isWildcard(pattern: string): boolean {
  return pattern.startsWith('*.');
}

/**
 * Common checks of "allow once" and "allow permanently": human only, an allowlist sandbox, valid destinations,
 * nothing the proxy would never connect to. Refusals are audited (`network.allow`, decision `deny`).
 */
async function check(
  I: Internals,
  caller: Caller,
  id: string,
  raw: NetworkAllowInput,
  what: string,
): Promise<{ ctx: AgentContext } & Checked> {
  const ctx = await I.context(caller);
  if (ctx.kind !== 'human') {
    I.audit(ctx.owner, 'network.allow', {
      decision: 'deny',
      details: { reason: 'human only', what },
    });
    throw new AboxError(
      'policy_denied',
      'allowing network destinations is only available to a human',
      {
        hint: 'Ask with access_request kind=network (details.domains); a human decides.',
      },
    );
  }
  I.requirePolicyValid(ctx, 'network.allow', 'allowing network destinations');
  const input = parseInput(allowSchema, raw, 'network allow');
  const rec = I.lookup(ctx, id);
  await collectNetworkEvents(I, rec, { throttleMs: LOG_COLLECT_THROTTLE_MS });
  const net = networkOf(rec);
  const refusal = (
    message: string,
    hint?: string,
    code: 'unsupported' | 'invalid_input' | 'policy_denied' = 'invalid_input',
  ): AboxError => {
    I.audit(ctx.owner, 'network.allow', {
      sandboxId: rec.id,
      decision: 'deny',
      details: {
        what,
        destinations: input.destinations.map((d) => d.slice(0, 260)),
        reason: message,
      },
    });
    return new AboxError(code, message, hint ? { hint } : {});
  };
  if (net.mode === 'none')
    throw refusal(
      `the network of sandbox ${rec.id} is off (mode none); there is nothing to allow`,
      'A sandbox keeps its network mode. Create a new sandbox with network mode allowlist (template or overrides.network).',
      'unsupported',
    );
  if (net.mode === 'open')
    throw refusal(
      `sandbox ${rec.id} has open network access; there is nothing to allow`,
      undefined,
      'unsupported',
    );
  const patterns: string[] = [];
  for (const d of input.destinations) {
    const norm = normalizeDomainPattern(d);
    if (norm === undefined)
      throw refusal(
        `"${d.slice(0, 80)}" is not a valid destination`,
        'Use a host name like pypi.org, host:port, or *.example.org.',
      );
    const problem = networkDestinationProblem(norm);
    if (problem) throw refusal(`${norm}: ${problem}`);
    if (!patterns.includes(norm)) patterns.push(norm);
  }
  // What the log says about an exact destination can rule it out as well (a name that resolves to a private address).
  const log = aggregateNetworkLog(
    I.state.audit.query({
      sandboxId: rec.id,
      action: [EGRESS, SUMMARY],
      limit: MAX_LOG_EVENTS,
      order: 'desc',
    }),
    { limit: MAX_LOG_LIMIT, allow: net.allow, mode: net.mode },
  ).entries;
  for (const p of patterns) {
    if (isWildcard(p)) continue;
    const hit = log.find(
      (e) =>
        e.host !== '' &&
        e.port > 0 &&
        destinationPattern(e.host, e.port) === p &&
        e.allow !== undefined &&
        !e.allow.possible &&
        e.reasonKind === 'blocked_address',
    );
    if (hit?.allow?.why) throw refusal(`${p}: ${hit.allow.why}`, undefined, 'policy_denied');
  }
  return { ctx, rec, patterns, wildcards: patterns.filter(isWildcard) };
}

/**
 * "Allow once for this sandbox": adds destinations to the allowlist of THIS sandbox (its proxy is updated live,
 * `updateNetwork`), nothing else: policy.yaml is not touched, new sandboxes do not get it, and the profile's limits
 * hold as for any access request (a destination beyond the human's profile needs the confirmation, as before).
 * Human only. A wildcard always needs an explicit confirmation (`humanConfirmed`). Audited as `network.allow`
 * and `sandbox.access_applied`.
 */
export async function allowNetwork(
  I: Internals,
  caller: Caller,
  id: string,
  raw: NetworkAllowInput,
): Promise<AccessResult> {
  const c = await check(I, caller, id, raw, 'sandbox');
  if (c.wildcards.length > 0 && caller.humanConfirmed !== true) {
    return confirmationRequired(
      c.wildcards.map(
        (w) =>
          `${w} allows every subdomain of ${w.slice(2)} (today's and future ones), not only the one that was denied`,
      ),
      [
        'A wildcard also covers subdomains other people can register or control (storage buckets, user pages, tunnels). Prefer the exact host.',
      ],
      c.wildcards.map((w) => ({
        kind: 'network_domains' as const,
        reason: `wildcard destination ${w}`,
        risk: 'The sandbox can send data to and load code from any subdomain.',
        invariant: false,
      })),
    );
  }
  const res = await accessRequest(
    I,
    caller,
    c.rec.id,
    {
      kind: 'network',
      details: { domains: c.patterns },
      reason: 'allowed from the network log',
    },
    {},
  );
  if (res.status === 'applied') {
    I.audit(c.ctx.owner, 'network.allow', {
      sandboxId: c.rec.id,
      decision: 'allow',
      details: {
        scope: 'sandbox',
        source: 'network_log',
        destinations: c.patterns,
        wildcard: c.wildcards.length > 0,
        message: res.message,
      },
    });
  }
  return res;
}

// ---------------------------------------------------------------------------
// allow permanently (proposal)
// ---------------------------------------------------------------------------

async function currentPolicyText(I: Internals): Promise<string> {
  if (I.policy.source.kind === 'file') {
    try {
      return await readFile(I.policy.source.path, 'utf8');
    } catch {
      /* the file vanished since it was loaded: the built-in text is what a save would start from */
    }
  }
  return DEFAULT_POLICY_YAML;
}

/**
 * "Allow permanently": the change of `policy.yaml` that adds the destinations to `network.allow` of the profile
 * of the sandbox owner (every context that uses the profile gets them, as with an approval). Nothing is written
 * here: the caller shows the diff, asks for a confirmation and saves with `setPolicy` (validated, revisioned,
 * audited), then applies the destinations to the sandbox with {@link allowNetwork}. Human only.
 */
export async function proposeNetworkPolicy(
  I: Internals,
  caller: Caller,
  id: string,
  raw: NetworkAllowInput,
): Promise<NetworkPolicyProposal> {
  const c = await check(I, caller, id, raw, 'policy');
  const owner = c.rec.owner;
  const contextId = owner === 'human' ? 'human' : owner.replace(/^agent:/, '');
  let owning;
  try {
    owning = resolveContext(I.policy, contextId, { home: I.home });
  } catch {
    throw new AboxError(
      'conflict',
      `the context "${contextId}" that owns sandbox ${c.rec.id} is not in the policy any more`,
      { hint: 'Add the context to policy.yaml, or allow the destinations for this sandbox only.' },
    );
  }
  const allowed = profileDomains(owning);
  const covered = c.patterns.filter((p) => domainCovered(p, allowed));
  const missing = c.patterns.filter((p) => !covered.includes(p));
  const current = await currentPolicyText(I);
  const usedBy = Object.entries(I.policy.contexts)
    .filter(([, def]) => def.profile === owning.profileName)
    .map(([k]) => k)
    .sort();
  const base = {
    context: contextId,
    profile: owning.profileName,
    usedBy,
    baseHash: I.policy.contentHash,
    current,
  };
  if (missing.length === 0) {
    return { ...base, added: [], alreadyAllowed: covered, proposed: null };
  }
  const edit = proposeNetworkAllow(
    current,
    owning.profileName,
    owning.profile.network.allow,
    missing,
  );
  if (!edit.ok) {
    throw new AboxError(
      'conflict',
      edit.error === 'parse'
        ? 'policy.yaml cannot be read as YAML, so no change can be proposed'
        : `profile "${owning.profileName}" is not defined in policy.yaml (it comes from the built-in policy)`,
      {
        hint: 'Edit the policy with `abox policy edit`, or allow the destinations for this sandbox only.',
      },
    );
  }
  return {
    ...base,
    added: edit.added,
    alreadyAllowed: covered,
    proposed: edit.text,
  };
}
