import { isIP } from 'node:net';
import { expandNetworkPresets } from '../template/network-presets.js';
import {
  isolationAtLeast,
  ISOLATION_LEVELS,
  type AccessMode,
  type HostId,
  type IsolationLevel,
  type NetworkMode,
  type ResolvedTemplate,
  type SecretInjection,
  type TemplateSourceKind,
  type WorkspaceMode,
} from '../types.js';
import { domainCovered, normalizeDomainPattern } from './domains.js';
import { imageAllowedByRegistries, imageRegistry, isKnownBaseImage } from './images.js';
import type { AgentContext, ApprovalMode } from './model.js';
import {
  checkHostPath,
  checkMountTarget,
  type CheckHostPathOptions,
  type PathCheck,
} from './paths.js';
import { formatBytesHuman, formatDuration, formatSize, tryParseSize } from './units.js';

/**
 * Decision engine: pure functions over request data. One policy check for CLI,
 * MCP and GUI. The only I/O is the injectable path check (`deps.checkHostPath`,
 * which looks at the file system to find symlinked forbidden directories and
 * socket files).
 *
 * Decision order: **deny always wins over approval**. First every hard rule is
 * evaluated (rights/limits of the profile, host, isolation, forbidden paths);
 * only when nothing is denied are approval requirements collected. See
 * README.md for the rule table.
 */

export type HostZone = 'workstation' | 'lab' | 'shared' | 'restricted';

export interface HostInfo {
  id: HostId;
  zone: HostZone;
  /** Host profile `min_isolation`. */
  minIsolation?: IsolationLevel;
  /** Hard per-host quotas; `memory` is a size string (`4g`) or bytes. */
  limits?: { cpus?: number; memory?: string | number; sandboxes?: number };
  /** Remote host: workspace mode `mount` is impossible there. */
  remote?: boolean;
}

export interface CreateRequest {
  context: AgentContext;
  template: Pick<ResolvedTemplate, 'name' | 'isolation' | 'hash' | 'contentHash'> &
    Partial<Pick<ResolvedTemplate, 'backend' | 'base'>>;
  /** False for project templates whose content hash has not been approved. */
  templateTrusted: boolean;
  templateSource: { kind: TemplateSourceKind; path?: string };
  host: HostInfo;
  /** Isolation the chosen provider actually delivers. */
  providerIsolation: IsolationLevel;
  /**
   * Absent or mode `empty` = no host path involved. `hostPath` must be canonical. `lexicalPath`
   * is the path as typed (not symlink-resolved, see `lexicalPath()`); only a human's explicit
   * roots look at it, never an agent's.
   */
  workspace?: {
    mode: WorkspaceMode;
    hostPath?: string;
    lexicalPath?: string;
    /**
     * What the pre-scan of a `copy` / `sync` folder found (`scanTree`; lower bounds when the scan
     * stopped early). Absent: the size is not checked.
     */
    copy?: { bytes: number; entries: number };
  };
  /**
   * Additional mounts (template + overrides); `hostPath` canonical, `target` inside the sandbox,
   * `lexicalPath` as for the workspace.
   */
  mounts: Array<{ hostPath: string; target: string; access: AccessMode; lexicalPath?: string }>;
  network: { mode: NetworkMode; allow: string[]; privateExceptions?: string[] };
  secrets: Array<{ ref: string; inject: SecretInjection }>;
  /** Final resources (template defaults + overrides). */
  resources: { cpus: number; memoryBytes: number };
  ttlMs: number;
  /** Sandboxes currently owned by `context.owner`. */
  currentSandboxCount: number;
  /** Sandboxes currently on `host`. */
  currentHostSandboxCount: number;
  /**
   * What the sandboxes already on `host` reserve together (cpus, memory; see `hostQuotaViolations`).
   * Default: nothing, which only checks the request on its own against the host limits.
   */
  hostUsage?: { cpus: number; memoryBytes: number };
  paths: { home: string; extraForbidden?: string[] };
  /**
   * The human explicitly confirmed the approval items (CLI `--yes`/dialog).
   * Satisfies approval only for context kind `human`; ignored for agents.
   * Never overrides a deny.
   */
  humanConfirmed?: boolean;
}

export type ApprovalKind =
  | 'strict_mode'
  | 'template_trust'
  | 'isolation_none'
  | 'host_zone'
  | 'mount'
  | 'network_open'
  | 'network_domains'
  | 'image_registry'
  | 'workspace_size'
  | 'secret_env'
  | 'secret_file'
  | 'private_address'
  | 'exec'
  | 'extension';

export interface ApprovalItem {
  kind: ApprovalKind;
  /** Why approval is needed. */
  reason: string;
  /** What could go wrong if approved. */
  risk: string;
  /** Security invariant: needed in every approval mode (also `open`). */
  invariant: boolean;
}

export type PolicyDecision =
  | { decision: 'allow'; notes: string[]; confirmed?: ApprovalItem[] }
  | { decision: 'deny'; reasons: string[]; hint?: string }
  | {
      decision: 'approval';
      reasons: string[];
      risks: string[];
      kinds: ApprovalKind[];
      items: ApprovalItem[];
    };

export interface EffectiveCreate {
  owner: string;
  context: string;
  profile: string;
  approvalMode: ApprovalMode;
  template: string;
  host: HostId;
  hostZone: HostZone;
  isolation: IsolationLevel;
  /** Strongest isolation any rule demands for this request. */
  requiredIsolation: IsolationLevel;
  /** Requested resources clamped to the strictest of profile and host limits. */
  resources: { cpus: number; memoryBytes: number; ttlMs: number };
  /** Names of the resource fields that had to be clamped (non-empty only when denied). */
  clamped: string[];
  workspace?: { mode: WorkspaceMode; hostPath?: string };
  mounts: Array<{ hostPath: string; target: string; access: AccessMode }>;
  network: { mode: NetworkMode; allow: string[]; privateExceptions: string[] };
  secrets: Array<{ ref: string; inject: SecretInjection }>;
}

export type CreateEvaluation = PolicyDecision & {
  effective: EffectiveCreate;
  /** Canonical object to hash (`hashRequestDigest`) for approval binding. */
  requestDigest: Record<string, unknown>;
};

export interface EngineDeps {
  checkHostPath?: (canonical: string, opts: CheckHostPathOptions) => PathCheck;
}

// ---------------------------------------------------------------------------
// Host quotas
// ---------------------------------------------------------------------------

/** What the live sandboxes of a host reserve together (their cpu and memory limits, not live usage). */
export interface HostUsage {
  sandboxes: number;
  cpus: number;
  memoryBytes: number;
}

export interface HostQuotaViolation {
  field: 'sandboxes' | 'cpus' | 'memory';
  reason: string;
  hint: string;
  /** Largest value of the field that would still fit (0 when the host is full). */
  max: number;
}

const QUOTA_EPSILON = 1e-9;

/**
 * Host profile limits (`limits.cpus`, `limits.memory`, `limits.sandboxes`) are quotas of the host as a
 * whole: all live sandboxes on it together may not reserve more. `others` is what the other sandboxes
 * already reserve (for a resize: without the sandbox being resized); `next` is the sandbox that is
 * created (`sandbox: true`) or resized (the fields that change). A request that exceeds a limit on
 * its own is reported as such, otherwise as exceeding the total. Pure: the manager calls it once for
 * the policy decision and again inside the registry transaction that claims the sandbox, so parallel
 * creates cannot overshoot.
 */
export function hostQuotaViolations(
  host: HostInfo,
  others: HostUsage,
  next: { sandbox?: boolean; cpus?: number; memoryBytes?: number },
): HostQuotaViolation[] {
  const limits = host.limits;
  const out: HostQuotaViolation[] = [];
  if (!limits) return out;
  if (next.sandbox && limits.sandboxes !== undefined && others.sandboxes >= limits.sandboxes) {
    out.push({
      field: 'sandboxes',
      reason: `host "${host.id}" already runs ${others.sandboxes} sandbox(es); its limit is ${limits.sandboxes}`,
      hint: 'Delete a sandbox on that host or use another host.',
      max: 0,
    });
  }
  if (limits.cpus !== undefined && next.cpus !== undefined && Number.isFinite(next.cpus)) {
    const room = Math.max(0, limits.cpus - others.cpus);
    if (next.cpus > limits.cpus + QUOTA_EPSILON) {
      out.push({
        field: 'cpus',
        reason: `requested cpus ${next.cpus} exceeds the limit of ${limits.cpus} on host "${host.id}"`,
        hint: `Request at most ${limits.cpus} cpus on this host.`,
        max: limits.cpus,
      });
    } else if (next.cpus > room + QUOTA_EPSILON) {
      out.push({
        field: 'cpus',
        reason: `requested cpus ${next.cpus} exceeds what is left of the host limit on "${host.id}": the limit of ${limits.cpus} cpus applies to all sandboxes there together and ${others.cpus} are reserved by the others`,
        hint: `Request at most ${room} cpus now, or delete a sandbox on that host.`,
        max: room,
      });
    }
  }
  const hostMem = limits.memory === undefined ? undefined : tryParseSize(limits.memory);
  if (
    hostMem !== undefined &&
    next.memoryBytes !== undefined &&
    Number.isFinite(next.memoryBytes)
  ) {
    const room = Math.max(0, hostMem - others.memoryBytes);
    if (next.memoryBytes > hostMem) {
      out.push({
        field: 'memory',
        reason: `requested memory ${formatSize(next.memoryBytes)} exceeds the limit of ${formatSize(hostMem)} on host "${host.id}"`,
        hint: `Request at most ${formatSize(hostMem)} of memory on this host.`,
        max: hostMem,
      });
    } else if (next.memoryBytes > room) {
      out.push({
        field: 'memory',
        reason: `requested memory ${formatSize(next.memoryBytes)} exceeds what is left of the host limit on "${host.id}": the limit of ${formatSize(hostMem)} applies to all sandboxes there together and ${formatSize(others.memoryBytes)} are reserved by the others`,
        hint: `Request at most ${formatSize(room)} of memory now, or delete a sandbox on that host.`,
        max: room,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Collector
// ---------------------------------------------------------------------------

class Findings {
  readonly denies: Array<{ reason: string; hint?: string }> = [];
  readonly items: ApprovalItem[] = [];

  deny(reason: string, hint?: string): void {
    this.denies.push(hint ? { reason, hint } : { reason });
  }

  need(item: ApprovalItem): void {
    if (!this.items.some((i) => i.kind === item.kind && i.reason === item.reason))
      this.items.push(item);
  }

  decide(
    ctx: AgentContext,
    humanConfirmed: boolean | undefined,
    notes: string[] = [],
  ): PolicyDecision {
    if (this.denies.length > 0) {
      const hints = [...new Set(this.denies.map((d) => d.hint).filter((h): h is string => !!h))];
      return {
        decision: 'deny',
        reasons: this.denies.map((d) => d.reason),
        ...(hints.length > 0 ? { hint: hints.join(' ') } : {}),
      };
    }
    if (this.items.length === 0) return { decision: 'allow', notes };
    if (ctx.kind === 'human' && humanConfirmed === true) {
      return {
        decision: 'allow',
        notes: [...notes, 'approval items confirmed explicitly by the human'],
        confirmed: [...this.items],
      };
    }
    return {
      decision: 'approval',
      reasons: this.items.map((i) => i.reason),
      risks: [...new Set(this.items.map((i) => i.risk))],
      kinds: [...new Set(this.items.map((i) => i.kind))],
      items: [...this.items],
    };
  }
}

const ZONE_MIN_ISOLATION: Readonly<Record<HostZone, IsolationLevel>> = {
  workstation: 'none',
  lab: 'none',
  shared: 'hardened',
  restricted: 'vm',
};

function maxIsolation(levels: IsolationLevel[]): IsolationLevel {
  let best: IsolationLevel = 'none';
  for (const l of levels)
    if (ISOLATION_LEVELS.indexOf(l) > ISOLATION_LEVELS.indexOf(best)) best = l;
  return best;
}

function profileDomains(ctx: AgentContext): string[] {
  const out: string[] = [...expandNetworkPresets(ctx.profile.network.allow_presets)];
  for (const a of ctx.profile.network.allow) {
    if (a.trim() === '*') out.push('*');
    else {
      const n = normalizeDomainPattern(a);
      if (n) out.push(n);
    }
  }
  return out;
}

const list = (xs: readonly string[]): string => (xs.length > 0 ? xs.join(', ') : 'none');

// ---------------------------------------------------------------------------
// Shared checks (create + access requests)
// ---------------------------------------------------------------------------

interface DomainResult {
  normalized: string[];
  beyond: string[];
  /** True when the profile allows no destination at all. */
  profileHasNone: boolean;
}

function evaluateDomains(
  ctx: AgentContext,
  requested: readonly string[],
  f: Findings,
): DomainResult {
  const normalized: string[] = [];
  for (const entry of requested) {
    const n = typeof entry === 'string' ? normalizeDomainPattern(entry) : undefined;
    if (n === undefined) {
      f.deny(
        `network destination "${String(entry)}" is not a valid domain pattern`,
        'Use a host name like pypi.org or a subdomain wildcard like *.example.org (a bare "*" or "*.com" is too broad; use a network preset or ask for network mode open).',
      );
    } else if (!normalized.includes(n)) normalized.push(n);
  }
  const allowed = profileDomains(ctx);
  const beyond = normalized.filter((d) => !domainCovered(d, allowed));
  return { normalized: normalized.sort(), beyond, profileHasNone: allowed.length === 0 };
}

function checkPrivateExceptions(entries: readonly string[] | undefined, f: Findings): string[] {
  const out: string[] = [];
  for (const e of entries ?? []) {
    const [ip, bits, ...rest] = String(e).split('/');
    const max = isIP(ip ?? '') === 6 ? 128 : 32;
    const bitsOk = bits === undefined || (/^\d{1,3}$/.test(bits) && Number(bits) <= max);
    if (isIP(ip ?? '') === 0 || !bitsOk || rest.length > 0) {
      f.deny(
        `private address exception "${String(e)}" is not a valid IP address or CIDR`,
        'Use an exact IP such as 192.168.1.20 or a CIDR such as 192.168.1.0/24.',
      );
    } else out.push(String(e));
  }
  return out.sort();
}

function domainApproval(
  ctx: AgentContext,
  beyond: string[],
  profileHasNone: boolean,
  f: Findings,
): void {
  if (beyond.length === 0) return;
  const p = ctx.profile;
  if (profileHasNone) {
    f.deny(
      `network destination(s) ${list(beyond)} are not allowed: profile "${p.name}" has no network allowlist (network.allow_presets and network.allow are empty)`,
      'Use network mode none, or ask the human to add presets/destinations to the profile in policy.yaml.',
    );
    return;
  }
  f.need({
    kind: 'network_domains',
    reason: `network destination(s) ${list(beyond)} are beyond the allowlist of profile "${p.name}" (presets: ${list(p.network.allow_presets)}; extra: ${list(p.network.allow)})`,
    risk: 'The sandbox can send data to and load code from these destinations.',
    invariant: false,
  });
}

/** Backends whose `base.os` is an OCI image reference (vm bases are distro names checked by the backend). */
const IMAGE_BACKENDS: readonly string[] = ['docker', 'podman', 'python'];

/**
 * Free image names are checked against the registry allowlist of the profile (`images.registries`).
 * Like network destinations beyond the allowlist: a profile without any registry denies, otherwise
 * the human decides (approval). Base images of the built-in templates are always accepted; a
 * Dockerfile base cannot be inspected here, so it counts as an unchecked image.
 */
function checkBaseImage(ctx: AgentContext, template: CreateRequest['template'], f: Findings): void {
  const registries = ctx.profile.images.registries;
  const base = template.base;
  if (!base || registries.includes('*')) return;
  if (template.backend !== undefined && !IMAGE_BACKENDS.includes(template.backend)) return;
  const p = ctx.profile;
  let subject: string | undefined;
  if (base.os !== undefined) {
    if (isKnownBaseImage(base.os) || imageAllowedByRegistries(base.os, registries)) return;
    subject = `base image "${base.os}"`;
  } else if (base.dockerfile !== undefined) {
    subject = `Dockerfile base "${base.dockerfile}" (the images it builds on cannot be checked)`;
  }
  if (subject === undefined) return;
  if (registries.length === 0) {
    f.deny(
      `${subject} of template "${template.name}" is not allowed: profile "${p.name}" has no image registry allowlist (images.registries is empty)`,
      'Use a built-in base image, or ask the human to add registries to images.registries with `abox policy edit`.',
    );
    return;
  }
  f.need({
    kind: 'image_registry',
    reason: `${subject} of template "${template.name}" is outside the image registries of profile "${p.name}" (images.registries: ${list(registries)})`,
    risk: 'The sandbox is built from an image you have not allowed: its publisher controls everything that runs in it.',
    invariant: false,
  });
}

/**
 * The base of the template as recorded in the request digest: the image reference and/or Dockerfile
 * marker and the registry an image reference points to. An approval is bound to it, so it cannot be
 * reused for a template with another base, and surfaces can show it without resolving the template again.
 */
function digestBase(template: CreateRequest['template']): Record<string, string> | undefined {
  const base = template.base;
  if (!base) return undefined;
  const out: Record<string, string> = {};
  if (base.os !== undefined) {
    out['os'] = base.os;
    if (template.backend === undefined || IMAGE_BACKENDS.includes(template.backend)) {
      const registry = imageRegistry(base.os);
      if (registry !== undefined) out['registry'] = registry;
    }
  }
  if (base.dockerfile !== undefined) out['dockerfile'] = base.dockerfile;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Soft limit of a copied workspace (`workspace.max_copy_bytes` / `max_copy_entries`). Copying a
 * big folder takes long and needs several times its size in disk space, so it is never silent: a
 * human confirms it (an invariant item, also in approval mode `open`), an agent is denied with the
 * alternatives its profile offers. The hard copy limit is enforced by the copy itself.
 */
function checkCopySize(
  ctx: AgentContext,
  mode: WorkspaceMode,
  hostPath: string | undefined,
  found: { bytes: number; entries: number },
  f: Findings,
): void {
  const p = ctx.profile;
  const limitBytes = p.workspace.maxCopyBytes;
  const limitEntries = p.workspace.max_copy_entries;
  const overBytes = found.bytes > limitBytes;
  const overEntries = found.entries > limitEntries;
  if (!overBytes && !overEntries) return;
  const folder = hostPath ? `workspace folder ${hostPath}` : 'workspace folder';
  const foundText = `${formatBytesHuman(found.bytes)} in ${found.entries} ${found.entries === 1 ? 'entry' : 'entries'}`;
  const limitText = `${formatBytesHuman(limitBytes)} / ${limitEntries} entries`;
  if (ctx.kind === 'agent') {
    const alternatives = (['clone', 'worktree', 'mount'] as const).filter((m) =>
      p.workspace.modes.includes(m),
    );
    f.deny(
      `${folder} is too large to copy (mode ${mode}): ${foundText}; profile "${p.name}" allows ${limitText} (workspace.max_copy_bytes / max_copy_entries)`,
      [
        'Choose the project folder itself, not a parent directory.',
        alternatives.length > 0
          ? `Use workspace mode ${alternatives.map((m) => `"${m}"`).join(' or ')} for big repositories.`
          : undefined,
        'Exclude large directories with workspace.exclude (for example ["node_modules"]).',
        'Only the human can raise workspace.max_copy_bytes in policy.yaml (abox policy edit).',
      ]
        .filter(Boolean)
        .join(' '),
    );
    return;
  }
  invariant(f, {
    kind: 'workspace_size',
    reason: `${folder} is large for a copy (mode ${mode}): ${foundText}, more than the ${limitText} that is copied without asking (workspace.max_copy_bytes / max_copy_entries)`,
    risk: 'Copying takes a while and needs several times the size in free disk space on this machine; the sandbox sees everything in the folder. Choose the project folder itself, use workspace mode "mount" or "clone" for big repositories, or exclude large directories (node_modules, build output).',
  });
}

function elevated(f: Findings, ctx: AgentContext, item: Omit<ApprovalItem, 'invariant'>): void {
  // Elevated-but-within-rights items are auto-allowed only in approval mode `open`.
  if (ctx.profile.approval !== 'open') f.need({ ...item, invariant: false });
}

function invariant(f: Findings, item: Omit<ApprovalItem, 'invariant'>): void {
  f.need({ ...item, invariant: true });
}

/**
 * Concept: network mode `open` wants at least isolation `hardened`. Agents are held to that through
 * `isolation.network_open` (deny). The human profile does not enforce isolation minimums (it may
 * run anything it confirms), but open network below the minimum is never silent: it is an
 * invariant approval item, i.e. an explicit human confirmation in every approval mode.
 */
export const NETWORK_OPEN_MIN_ISOLATION: IsolationLevel = 'hardened';

function humanOpenNetworkBelowMinimum(
  f: Findings,
  ctx: AgentContext,
  isolation: IsolationLevel | undefined,
  subject: string,
): void {
  if (ctx.kind !== 'human') return;
  if (isolation !== undefined && isolationAtLeast(isolation, NETWORK_OPEN_MIN_ISOLATION)) return;
  invariant(f, {
    kind: 'network_open',
    reason: `network mode "open" needs isolation "${NETWORK_OPEN_MIN_ISOLATION}" by default; ${subject} runs with "${isolation ?? 'unknown'}"`,
    risk: 'Unrestricted internet access without a hardened sandbox: code in it can reach any destination, exfiltrate data and attack your local network.',
  });
}

function checkMount(
  ctx: AgentContext,
  m: { hostPath: string; target: string; access: AccessMode; lexicalPath?: string },
  paths: CreateRequest['paths'],
  check: NonNullable<EngineDeps['checkHostPath']>,
  f: Findings,
): void {
  const p = ctx.profile;
  const who = `mount ${m.hostPath} -> ${m.target}`;
  const target = checkMountTarget(m.target);
  if (!target.ok) f.deny(`${who}: ${target.reason}`);
  const res = check(m.hostPath, {
    home: paths.home,
    roots: ctx.mountRoots,
    ...(ctx.kind === 'human' && m.lexicalPath ? { lexicalPath: m.lexicalPath } : {}),
    kind: 'mount',
    extraForbidden: paths.extraForbidden ?? [],
    denyHiddenHomeDirs: ctx.kind === 'agent',
  });
  if (!res.ok) f.deny(`${who}: ${res.reason}`, res.hint);
  if (p.mounts && m.access !== 'ro' && !p.mounts.access.includes(m.access)) {
    f.deny(
      `${who}: access "${m.access}" is not allowed for profile "${p.name}" (mounts.access: ${list(p.mounts.access)})`,
      'Request the mount read-only (access ro) or ask the human to allow rw mounts in policy.yaml.',
    );
  }
}

// ---------------------------------------------------------------------------
// evaluateCreate
// ---------------------------------------------------------------------------

/** Decides a sandbox creation request. See README.md for the rule table. */
export function evaluateCreate(req: CreateRequest, deps: EngineDeps = {}): CreateEvaluation {
  const check = deps.checkHostPath ?? checkHostPath;
  const ctx = req.context;
  const p = ctx.profile;
  const f = new Findings();
  const mounts = req.mounts ?? [];
  const secrets = req.secrets ?? [];
  const reqRes = req.resources;

  // --- template ---------------------------------------------------------
  if (!p.templates.includes('*') && !p.templates.includes(req.template.name)) {
    f.deny(
      `template "${req.template.name}" is not allowed for profile "${p.name}"`,
      p.templates.length > 0
        ? `Use one of the allowed templates: ${p.templates.join(', ')}.`
        : 'This profile allows no templates; ask the human to add some in policy.yaml.',
    );
  }

  checkBaseImage(ctx, req.template, f);

  // --- host -------------------------------------------------------------
  if (!ctx.allowedHosts.includes('*') && !ctx.allowedHosts.includes(req.host.id)) {
    f.deny(
      `host "${req.host.id}" is not allowed for context "${ctx.id}" (allowed hosts: ${list(ctx.allowedHosts)})`,
      'Only a human can allow additional hosts, in policy.yaml (hosts: of the profile or context).',
    );
  }

  // --- limits -----------------------------------------------------------
  const cpusOk = Number.isFinite(reqRes?.cpus) && reqRes.cpus > 0;
  const memOk = Number.isSafeInteger(reqRes?.memoryBytes) && reqRes.memoryBytes > 0;
  const ttlOk = Number.isFinite(req.ttlMs) && req.ttlMs > 0;
  if (!cpusOk) f.deny(`requested cpus ${String(reqRes?.cpus)} is not a positive number`);
  if (!memOk)
    f.deny(`requested memory ${String(reqRes?.memoryBytes)} is not a positive number of bytes`);
  if (!ttlOk) f.deny(`requested ttl ${String(req.ttlMs)} is not a positive number of milliseconds`);

  const clamped: string[] = [];
  let effCpus = cpusOk ? reqRes.cpus : 0;
  let effMem = memOk ? reqRes.memoryBytes : 0;
  let effTtl = ttlOk ? req.ttlMs : 0;
  const hostLimits = req.host.limits;
  const hostMemBytes =
    hostLimits?.memory === undefined ? undefined : tryParseSize(hostLimits.memory);
  if (hostLimits?.memory !== undefined && hostMemBytes === undefined) {
    f.deny(
      `host "${req.host.id}" has an invalid memory limit "${String(hostLimits.memory)}"`,
      'Fix the host profile (hosts.yaml).',
    );
  }

  if (cpusOk && reqRes.cpus > p.limits.cpus) {
    f.deny(
      `requested cpus ${reqRes.cpus} exceeds the limit of ${p.limits.cpus} set by profile "${p.name}" (limits.cpus)`,
      `Request at most ${p.limits.cpus} cpus, or ask the human to raise limits.cpus.`,
    );
    clamped.push('cpus');
    effCpus = Math.min(effCpus, p.limits.cpus);
  }
  if (memOk && reqRes.memoryBytes > p.limits.memoryBytes) {
    f.deny(
      `requested memory ${formatSize(reqRes.memoryBytes)} exceeds the limit of ${formatSize(p.limits.memoryBytes)} set by profile "${p.name}" (limits.memory)`,
      `Request at most ${formatSize(p.limits.memoryBytes)} of memory, or ask the human to raise limits.memory.`,
    );
    clamped.push('memory');
    effMem = Math.min(effMem, p.limits.memoryBytes);
  }
  // The host limits are quotas of the whole host: the request plus what the sandboxes already there reserve.
  const used = req.hostUsage ?? { cpus: 0, memoryBytes: 0 };
  for (const v of hostQuotaViolations(
    req.host,
    {
      sandboxes: req.currentHostSandboxCount,
      cpus: used.cpus,
      memoryBytes: used.memoryBytes,
    },
    {
      ...(cpusOk ? { cpus: reqRes.cpus } : {}),
      ...(memOk ? { memoryBytes: reqRes.memoryBytes } : {}),
    },
  )) {
    if (v.field === 'sandboxes') continue; // the count is checked below, next to the profile's
    f.deny(v.reason, v.hint);
    if (!clamped.includes(v.field)) clamped.push(v.field);
    if (v.field === 'cpus') effCpus = Math.min(effCpus, v.max);
    else effMem = Math.min(effMem, v.max);
  }
  if (ttlOk && req.ttlMs > p.limits.ttlMs) {
    f.deny(
      `requested ttl ${formatDuration(req.ttlMs)} exceeds the limit of ${p.limits.ttl} set by profile "${p.name}" (limits.ttl)`,
      `Request a ttl of at most ${p.limits.ttl}, or ask the human to raise limits.ttl.`,
    );
    clamped.push('ttl');
    effTtl = Math.min(effTtl, p.limits.ttlMs);
  }
  if (req.currentSandboxCount >= p.limits.sandboxes) {
    f.deny(
      `${ctx.owner} already has ${req.currentSandboxCount} sandbox(es); profile "${p.name}" allows at most ${p.limits.sandboxes} (limits.sandboxes)`,
      'Delete a sandbox you no longer need (or wait until it expires), then retry.',
    );
  }
  for (const v of hostQuotaViolations(
    req.host,
    { sandboxes: req.currentHostSandboxCount, cpus: 0, memoryBytes: 0 },
    { sandbox: true },
  ))
    f.deny(v.reason, v.hint);

  // --- workspace --------------------------------------------------------
  const ws = req.workspace;
  if (ws) {
    if (!p.workspace.modes.includes(ws.mode)) {
      f.deny(
        `workspace mode "${ws.mode}" is not allowed for profile "${p.name}" (allowed: ${list(p.workspace.modes)})`,
        `Use one of the allowed workspace modes: ${list(p.workspace.modes)}.`,
      );
    }
    if (ws.mode === 'mount' && req.host.remote) {
      f.deny(
        `workspace mode "mount" is not possible on remote host "${req.host.id}"`,
        'Use workspace mode sync, clone, worktree or copy on remote hosts.',
      );
    }
    if (ws.mode !== 'empty') {
      if (!ws.hostPath) {
        f.deny(`workspace mode "${ws.mode}" requires a host path`);
      } else {
        const res = check(ws.hostPath, {
          home: req.paths.home,
          roots: ctx.workspaceRoots,
          ...(ctx.kind === 'human' && ws.lexicalPath ? { lexicalPath: ws.lexicalPath } : {}),
          kind: 'workspace',
          extraForbidden: req.paths.extraForbidden ?? [],
          scanSockets: ws.mode === 'mount',
          denyHiddenHomeDirs: ctx.kind === 'agent',
          strictlyBelowRoots: ctx.kind === 'agent',
        });
        if (!res.ok) f.deny(res.reason, res.hint);
      }
      if (ws.copy && (ws.mode === 'copy' || ws.mode === 'sync')) {
        checkCopySize(ctx, ws.mode, ws.hostPath, ws.copy, f);
      }
    }
  }

  // --- mounts -----------------------------------------------------------
  if (mounts.length > 0) {
    if (p.mounts === null) {
      f.deny(
        `additional mounts are denied for profile "${p.name}" (mounts: deny)`,
        'Put the files into the workspace (copy/clone), or ask the human to allow mounts in policy.yaml.',
      );
    } else {
      const targets = new Set<string>();
      for (const m of mounts) {
        checkMount(ctx, m, req.paths, check, f);
        if (targets.has(m.target)) f.deny(`mount target ${m.target} is used more than once`);
        targets.add(m.target);
      }
    }
    elevated(f, ctx, {
      kind: 'mount',
      reason: `additional host mount(s): ${mounts.map((m) => `${m.hostPath} (${m.access})`).join(', ')}`,
      risk: 'The sandbox can read (and with rw modify) these host files.',
    });
  }

  // --- network ----------------------------------------------------------
  const net = req.network;
  let netAllow: string[] = [];
  let privateExceptions: string[] = [];
  if (!p.network.modes.includes(net.mode)) {
    f.deny(
      `network mode "${net.mode}" is not allowed for profile "${p.name}" (allowed: ${list(p.network.modes)})`,
      `Use one of the allowed network modes (${list(p.network.modes)}); with allowlist you can request destinations from the profile's presets.`,
    );
  } else if (net.mode === 'allowlist') {
    const d = evaluateDomains(ctx, net.allow ?? [], f);
    netAllow = d.normalized;
    domainApproval(ctx, d.beyond, d.profileHasNone, f);
  } else if (net.mode === 'open') {
    elevated(f, ctx, {
      kind: 'network_open',
      reason: `network mode "open" (unrestricted internet access) for profile "${p.name}"`,
      risk: 'Code in the sandbox can reach any internet destination and exfiltrate data.',
    });
    humanOpenNetworkBelowMinimum(f, ctx, req.providerIsolation, `template "${req.template.name}"`);
  }
  if ((net.privateExceptions?.length ?? 0) > 0) {
    privateExceptions = checkPrivateExceptions(net.privateExceptions, f);
    if (net.mode === 'none') {
      f.deny(
        'private address exceptions have no effect with network mode "none"',
        'Use network mode allowlist or remove the exceptions.',
      );
    } else {
      invariant(f, {
        kind: 'private_address',
        reason: `exception(s) to the private-address block: ${privateExceptions.join(', ')}`,
        risk: 'The sandbox can reach devices on your local network (router, home automation, internal services).',
      });
    }
  }

  // --- secrets ----------------------------------------------------------
  for (const s of secrets) {
    if (!p.secrets.allowed.includes('*') && !p.secrets.allowed.includes(s.ref)) {
      f.deny(
        `secret "${s.ref}" is not allowed for profile "${p.name}" (secrets.allowed: ${list(p.secrets.allowed)})`,
        'Use an allowed secret, or ask the human to allow it in policy.yaml.',
      );
    }
    if (!p.secrets.inject.includes(s.inject)) {
      f.deny(
        `secret "${s.ref}": injection "${s.inject}" is not allowed for profile "${p.name}" (secrets.inject: ${list(p.secrets.inject)})`,
        'Use inject: proxy, which keeps the secret value out of the sandbox.',
      );
    }
    if (s.inject === 'env' || s.inject === 'file') {
      invariant(f, {
        kind: s.inject === 'env' ? 'secret_env' : 'secret_file',
        reason: `secret "${s.ref}" would be injected as ${s.inject === 'env' ? 'an environment variable' : 'a file'}`,
        risk: 'Code in the sandbox (and a prompt-injected agent) can read the secret value and send it away.',
      });
    }
  }

  // --- isolation --------------------------------------------------------
  const required: Array<{ level: IsolationLevel; source: string }> = [
    { level: req.template.isolation, source: `template "${req.template.name}"` },
    { level: p.isolation.min, source: `profile "${p.name}" (isolation.min)` },
    { level: ZONE_MIN_ISOLATION[req.host.zone], source: `host zone "${req.host.zone}"` },
  ];
  if (req.host.minIsolation)
    required.push({
      level: req.host.minIsolation,
      source: `host "${req.host.id}" (min_isolation)`,
    });
  if (net.mode === 'open')
    required.push({
      level: p.isolation.network_open,
      source: `profile "${p.name}" for network mode open (isolation.network_open)`,
    });
  if (mounts.length > 0)
    required.push({
      level: p.isolation.mounts,
      source: `profile "${p.name}" for additional mounts (isolation.mounts)`,
    });
  if (secrets.some((s) => s.inject === 'env' || s.inject === 'file')) {
    required.push({
      level: p.isolation.secrets_env,
      source: `profile "${p.name}" for env/file secret injection (isolation.secrets_env)`,
    });
  }
  const requiredIsolation = maxIsolation(required.map((r) => r.level));
  for (const r of required) {
    if (!isolationAtLeast(req.providerIsolation, r.level)) {
      f.deny(
        `isolation "${req.providerIsolation}" is below "${r.level}" required by ${r.source}`,
        `Use a template/backend that delivers isolation ${requiredIsolation} or stronger${req.host.zone === 'restricted' ? ' (restricted hosts only accept vm)' : ''}.`,
      );
    }
  }

  // --- approval items ---------------------------------------------------
  if (req.providerIsolation === 'none') {
    invariant(f, {
      kind: 'isolation_none',
      reason: 'isolation "none": the sandbox runs directly on the host without a security boundary',
      risk: 'Code runs with your user rights on the host and can read and change your files and credentials.',
    });
  }
  if (!req.templateTrusted) {
    invariant(f, {
      kind: 'template_trust',
      reason: `template "${req.template.name}" comes from ${req.templateSource.kind === 'project' ? 'a project' : 'an unapproved'} source${req.templateSource.path ? ` (${req.templateSource.path})` : ''} whose content has not been approved`,
      risk: 'A foreign template can run arbitrary setup commands and request mounts, network and secrets.',
    });
  }
  if (req.host.zone === 'shared' || req.host.zone === 'restricted') {
    invariant(f, {
      kind: 'host_zone',
      reason: `host "${req.host.id}" is in zone "${req.host.zone}" (hosts other services or sensitive data)`,
      risk: 'A sandbox escape could affect the services and data on that host.',
    });
  }
  if (p.approval === 'strict') {
    f.need({
      kind: 'strict_mode',
      reason: `profile "${p.name}" uses approval mode strict: every sandbox creation needs approval`,
      risk: 'No additional risk beyond the request itself.',
      invariant: false,
    });
  }

  // --- result -----------------------------------------------------------
  const sortedMounts = [...mounts].sort((a, b) =>
    a.target < b.target ? -1 : a.target > b.target ? 1 : 0,
  );
  const sortedSecrets = [...secrets].sort((a, b) =>
    `${a.ref}|${a.inject}` < `${b.ref}|${b.inject}` ? -1 : 1,
  );
  const effective: EffectiveCreate = {
    owner: ctx.owner,
    context: ctx.id,
    profile: p.name,
    approvalMode: p.approval,
    template: req.template.name,
    host: req.host.id,
    hostZone: req.host.zone,
    isolation: req.providerIsolation,
    requiredIsolation,
    resources: { cpus: effCpus, memoryBytes: effMem, ttlMs: effTtl },
    clamped,
    ...(ws
      ? {
          workspace:
            ws.mode === 'empty'
              ? { mode: ws.mode }
              : { mode: ws.mode, ...(ws.hostPath ? { hostPath: ws.hostPath } : {}) },
        }
      : {}),
    mounts: sortedMounts.map((m) => ({ hostPath: m.hostPath, target: m.target, access: m.access })),
    network: { mode: net.mode, allow: netAllow, privateExceptions },
    secrets: sortedSecrets.map((s) => ({ ref: s.ref, inject: s.inject })),
  };
  const requestDigest: Record<string, unknown> = {
    v: 1,
    kind: 'create',
    owner: ctx.owner,
    context: ctx.id,
    profile: p.name,
    template: {
      name: req.template.name,
      hash: req.template.hash,
      contentHash: req.template.contentHash,
      source: { kind: req.templateSource.kind, path: req.templateSource.path },
      trusted: req.templateTrusted,
      base: digestBase(req.template),
    },
    host: { id: req.host.id, zone: req.host.zone },
    isolation: req.providerIsolation,
    workspace: ws
      ? { mode: ws.mode, hostPath: ws.mode === 'empty' ? undefined : ws.hostPath }
      : undefined,
    mounts: sortedMounts.map((m) => ({ hostPath: m.hostPath, target: m.target, access: m.access })),
    network: {
      mode: net.mode,
      allow: net.mode === 'allowlist' ? netAllow : [],
      privateExceptions,
    },
    secrets: sortedSecrets.map((s) => ({ ref: s.ref, inject: s.inject })),
    resources: { cpus: reqRes?.cpus, memoryBytes: reqRes?.memoryBytes },
    ttlMs: req.ttlMs,
  };

  return { ...f.decide(ctx, req.humanConfirmed), effective, requestDigest };
}

// ---------------------------------------------------------------------------
// Sandbox-bound decisions: exec and access requests
// ---------------------------------------------------------------------------

export interface SandboxRef {
  id: string;
  /** `human` or `agent:<context id>`. */
  owner: string;
  host?: HostInfo;
  /** Isolation the sandbox actually runs with. */
  isolation?: IsolationLevel;
  network?: { mode: NetworkMode; allow: string[] };
  /**
   * What the other live sandboxes on the same host reserve (without this one). With it, a resource
   * request is checked against the host limits as a whole (see `hostQuotaViolations`); without it,
   * only the request on its own.
   */
  hostUsage?: HostUsage;
}

/** Humans may act on every sandbox; agent contexts only on their own. */
export function ownsSandbox(ctx: AgentContext, sandbox: Pick<SandboxRef, 'owner'>): boolean {
  return ctx.kind === 'human' || sandbox.owner === ctx.owner;
}

function notOwner(ctx: AgentContext, sandbox: SandboxRef, f: Findings): void {
  if (!ownsSandbox(ctx, sandbox)) {
    f.deny(
      `sandbox ${sandbox.id} belongs to ${sandbox.owner}, not to ${ctx.owner}`,
      'Agents can only use their own sandboxes.',
    );
  }
}

export interface ExecOptions {
  /** Shown to the approver and bound into the digest. */
  command?: string;
  humanConfirmed?: boolean;
}

export type ExecEvaluation = PolicyDecision & { requestDigest: Record<string, unknown> };

/**
 * Decides a command execution in an existing sandbox. Approval is required in
 * approval mode `strict` or when the profile sets `exec.approval: true`.
 * Commands are not inspected (no command deny-list): the sandbox is the boundary.
 */
export function evaluateExec(
  ctx: AgentContext,
  sandbox: SandboxRef,
  opts: ExecOptions = {},
): ExecEvaluation {
  const f = new Findings();
  notOwner(ctx, sandbox, f);
  if (ctx.profile.approval === 'strict' || ctx.profile.exec.approval) {
    f.need({
      kind: 'exec',
      reason:
        ctx.profile.approval === 'strict'
          ? `profile "${ctx.profile.name}" uses approval mode strict: every command needs approval`
          : `profile "${ctx.profile.name}" requires approval for command execution (exec.approval)`,
      risk: 'The command runs inside the sandbox with all its granted rights (network, mounts, secrets).',
      invariant: false,
    });
  }
  return {
    ...f.decide(ctx, opts.humanConfirmed),
    requestDigest: {
      v: 1,
      kind: 'exec',
      owner: ctx.owner,
      context: ctx.id,
      sandbox: sandbox.id,
      command: opts.command,
    },
  };
}

export type AccessRequestSpec =
  | {
      kind: 'network';
      details: { mode?: NetworkMode; domains?: string[]; privateExceptions?: string[] };
    }
  | {
      kind: 'mount';
      details: {
        hostPath: string;
        target: string;
        access: AccessMode;
        paths: { home: string; extraForbidden?: string[] };
      };
    }
  | { kind: 'resources'; details: { cpus?: number; memoryBytes?: number } }
  /** `ttlMs` = desired total lifetime measured from sandbox creation. */
  | { kind: 'ttl'; details: { ttlMs: number } };

export interface AccessOptions {
  humanConfirmed?: boolean;
}

export type AccessEvaluation = PolicyDecision & { requestDigest: Record<string, unknown> };

/**
 * Decides a later extension of a sandbox's rights (`access_request`). Never
 * auto-allows anything beyond the profile: limits and rights of the profile are
 * hard (deny); destinations beyond the profile need approval; additional mounts
 * need approval unless the mode is `open`. Within the profile: allowed in
 * `medium` and `open`, approval in `strict`.
 */
export function evaluateAccessRequest(
  ctx: AgentContext,
  sandbox: SandboxRef,
  request: AccessRequestSpec,
  opts: AccessOptions & EngineDeps = {},
): AccessEvaluation {
  const f = new Findings();
  const p = ctx.profile;
  notOwner(ctx, sandbox, f);

  switch (request.kind) {
    case 'network': {
      const d = request.details;
      const currentMode = sandbox.network?.mode ?? 'none';
      const mode =
        d.mode ??
        (d.domains && d.domains.length > 0 && currentMode === 'none' ? 'allowlist' : currentMode);
      if (!p.network.modes.includes(mode)) {
        f.deny(
          `network mode "${mode}" is not allowed for profile "${p.name}" (allowed: ${list(p.network.modes)})`,
          `Use one of the allowed network modes: ${list(p.network.modes)}.`,
        );
      } else if (mode === 'open' && currentMode !== 'open') {
        if (!sandbox.isolation || !isolationAtLeast(sandbox.isolation, p.isolation.network_open)) {
          f.deny(
            `network mode "open" needs isolation "${p.isolation.network_open}" (profile "${p.name}", isolation.network_open); this sandbox runs with "${sandbox.isolation ?? 'unknown'}"`,
            'Create a new sandbox with a stronger isolation level instead.',
          );
        }
        elevated(f, ctx, {
          kind: 'network_open',
          reason: `switching sandbox ${sandbox.id} to network mode "open"`,
          risk: 'Code in the sandbox can reach any internet destination and exfiltrate data.',
        });
        humanOpenNetworkBelowMinimum(f, ctx, sandbox.isolation, `sandbox ${sandbox.id}`);
      } else if (mode === 'allowlist') {
        const dom = evaluateDomains(ctx, d.domains ?? [], f);
        domainApproval(ctx, dom.beyond, dom.profileHasNone, f);
      } else if (mode === 'none' && (d.domains?.length ?? 0) > 0) {
        f.deny(
          'network destinations require network mode allowlist',
          'Destinations belong to network mode allowlist. A running sandbox keeps the network mode it was created with: create a new sandbox with overrides.network (allow / presets).',
        );
      }
      if ((d.privateExceptions?.length ?? 0) > 0) {
        const ex = checkPrivateExceptions(d.privateExceptions, f);
        invariant(f, {
          kind: 'private_address',
          reason: `exception(s) to the private-address block: ${ex.join(', ')}`,
          risk: 'The sandbox can reach devices on your local network (router, home automation, internal services).',
        });
      }
      break;
    }
    case 'mount': {
      const d = request.details;
      if (p.mounts === null) {
        f.deny(
          `additional mounts are denied for profile "${p.name}" (mounts: deny)`,
          'Copy the files into the sandbox instead, or ask the human to allow mounts in policy.yaml.',
        );
      } else {
        checkMount(ctx, d, d.paths, opts.checkHostPath ?? checkHostPath, f);
        if (!sandbox.isolation || !isolationAtLeast(sandbox.isolation, p.isolation.mounts)) {
          f.deny(
            `additional mounts need isolation "${p.isolation.mounts}" (profile "${p.name}", isolation.mounts); this sandbox runs with "${sandbox.isolation ?? 'unknown'}"`,
          );
        }
      }
      elevated(f, ctx, {
        kind: 'mount',
        reason: `additional host mount ${d.hostPath} (${d.access}) for sandbox ${sandbox.id}`,
        risk: 'The sandbox can read (and with rw modify) these host files.',
      });
      break;
    }
    case 'resources': {
      const d = request.details;
      if (d.cpus === undefined && d.memoryBytes === undefined)
        f.deny('resources request names neither cpus nor memory');
      if (d.cpus !== undefined) {
        if (!(Number.isFinite(d.cpus) && d.cpus > 0))
          f.deny(`requested cpus ${String(d.cpus)} is not a positive number`);
        else {
          if (d.cpus > p.limits.cpus)
            f.deny(
              `requested cpus ${d.cpus} exceeds the limit of ${p.limits.cpus} set by profile "${p.name}" (limits.cpus)`,
              `Request at most ${p.limits.cpus} cpus, or ask the human to raise limits.cpus.`,
            );
        }
      }
      if (d.memoryBytes !== undefined) {
        if (!(Number.isSafeInteger(d.memoryBytes) && d.memoryBytes > 0))
          f.deny(`requested memory ${String(d.memoryBytes)} is not a positive number of bytes`);
        else {
          if (d.memoryBytes > p.limits.memoryBytes)
            f.deny(
              `requested memory ${formatSize(d.memoryBytes)} exceeds the limit of ${formatSize(p.limits.memoryBytes)} set by profile "${p.name}" (limits.memory)`,
              `Request at most ${formatSize(p.limits.memoryBytes)}, or ask the human to raise limits.memory.`,
            );
        }
      }
      if (sandbox.host) {
        for (const v of hostQuotaViolations(
          sandbox.host,
          sandbox.hostUsage ?? { sandboxes: 0, cpus: 0, memoryBytes: 0 },
          {
            ...(d.cpus !== undefined && Number.isFinite(d.cpus) && d.cpus > 0
              ? { cpus: d.cpus }
              : {}),
            ...(d.memoryBytes !== undefined &&
            Number.isSafeInteger(d.memoryBytes) &&
            d.memoryBytes > 0
              ? { memoryBytes: d.memoryBytes }
              : {}),
          },
        ))
          f.deny(v.reason, v.hint);
      }
      break;
    }
    case 'ttl': {
      const t = request.details.ttlMs;
      if (!(Number.isFinite(t) && t > 0))
        f.deny(`requested ttl ${String(t)} is not a positive number of milliseconds`);
      else if (t > p.limits.ttlMs) {
        f.deny(
          `requested ttl ${formatDuration(t)} exceeds the limit of ${p.limits.ttl} set by profile "${p.name}" (limits.ttl)`,
          `Request a total lifetime of at most ${p.limits.ttl}, or ask the human to raise limits.ttl.`,
        );
      }
      break;
    }
    default: {
      f.deny(
        `unknown access request kind "${String((request as { kind?: unknown }).kind)}"`,
        'Supported kinds: network, mount, resources, ttl.',
      );
    }
  }

  if (p.approval === 'strict') {
    f.need({
      kind: 'strict_mode',
      reason: `profile "${p.name}" uses approval mode strict: every access request needs approval`,
      risk: 'No additional risk beyond the request itself.',
      invariant: false,
    });
  }

  return {
    ...f.decide(ctx, opts.humanConfirmed),
    requestDigest: {
      v: 1,
      kind: 'access_request',
      owner: ctx.owner,
      context: ctx.id,
      profile: p.name,
      sandbox: sandbox.id,
      request: normalizeRequestForDigest(request),
    },
  };
}

function normalizeRequestForDigest(r: AccessRequestSpec): unknown {
  const d = r.details as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = { ...d };
  for (const key of ['domains', 'privateExceptions']) {
    const v = out[key];
    if (Array.isArray(v)) out[key] = [...new Set(v.map(String))].sort();
  }
  return { kind: r.kind, details: out };
}
