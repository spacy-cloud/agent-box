import { isAboxError } from '../errors.js';
import type { SandboxProvider } from '../provider.js';
import {
  canonicalizePath,
  domainCovered,
  evaluateCreate,
  profileDomains,
  resolveContext,
  type AgentContext,
  type CreateEvaluation,
} from '../policy/index.js';
import { NETWORK_PRESETS } from '../template/network-presets.js';
import { BUILD_SPACE_FACTOR, estimateImageBytes } from '../template/image-size.js';
import { isolationAtLeast } from '../types.js';
import type {
  BackendKind,
  DiskSpace,
  ImageStatus,
  ProviderCapabilities,
  ResolvedTemplate,
} from '../types.js';
import { formatSize, planCaches } from './caches.js';
import { capacityOf, estimateFit } from './capacity.js';
import {
  classifyWorkingBackend,
  legacyLevel,
  startHint,
  summarizeChecks,
} from './doctor-severity.js';
import type { Internals } from './internals.js';
import { deliveryKindFor } from './lifecycle.js';
import { doctorForSchema } from './schemas.js';
import {
  checkTemplateForProvider,
  isTrusted,
  loadTemplate,
  projectDirCandidates,
  templateAllowed,
} from './templates.js';
import type {
  Caller,
  DoctorCheck,
  DoctorForInput,
  DoctorNote,
  ResolvedHost,
  ScopedDoctorReport,
} from './types.js';
import { errMessage, parseInput } from './util.js';

const GIB = 1024 ** 3;
/** Below this the disk is full for all practical purposes: images and sandboxes will fail. */
const DISK_ERROR_BYTES = 2 * GIB;
/** Free space that should remain after the first build, for sandboxes, caches and the next image. */
const DISK_HEADROOM_BYTES = 5 * GIB;
/** Free space below which a host is reported as getting full. */
const HOST_DISK_WARN_BYTES = 10 * GIB;
/** A reservation this share of a host limit (or more) is reported as nearly full. */
const NEARLY_FULL = 0.9;
/** At most this many agent contexts are evaluated for one template check. */
const MAX_AGENT_CONTEXTS = 32;
/** The check on a remote host opens a connection; the first one of a burst is audited. */
const AUDIT_WINDOW_MS = 10 * 60_000;

type CheckInput = Omit<DoctorCheck, 'level'>;

class Checks {
  readonly list: DoctorCheck[] = [];
  add(c: CheckInput): void {
    this.list.push({ ...c, level: legacyLevel(c.severity) });
  }
}

function report(scope: ScopedDoctorReport['scope'], checks: Checks): ScopedDoctorReport {
  return {
    scope,
    ok: !checks.list.some((c) => c.severity === 'error'),
    summary: summarizeChecks(checks.list),
    checks: checks.list,
  };
}

/** The wording of a failure as the hint a human can act on. */
function hintOf(e: unknown): string | undefined {
  return isAboxError(e) ? e.hint : undefined;
}

/**
 * Human only. A scoped readiness check: "can I run *this*?". For a template: the template itself, the
 * backend and its isolation on the chosen host, the environment image, free disk space, the network
 * destinations against the profile of the caller and of the agent contexts, package caches, the rules of
 * `policy.yaml` for a create from it and how many sandboxes of its size fit. For a host: whether it can be
 * reached, which engines run there (rootless or not), its limits and capacity.
 *
 * Read-only and cheap by design: it asks the engine API to inspect (never to build or pull), reads
 * `/proc` numbers through the same paths as `hostCapacity`, and never starts or creates anything. It
 * reports problems as checks instead of throwing; only an invalid request throws. Not available to
 * agents (see `docs/internal/manager-api.md`): the answer includes how much room a host has and what the
 * policy allows other contexts.
 */
export async function doctorFor(
  I: Internals,
  caller: Caller,
  input: DoctorForInput,
): Promise<ScopedDoctorReport> {
  const ctx = await I.context(caller);
  I.requireHuman(ctx, 'doctor.for');
  const req = parseInput(doctorForSchema, input, 'doctor request');
  const hostId = 'host' in req ? req.host : (req.hostId ?? 'local');
  if (I.firstWithin(`doctor-for|${hostId}`, AUDIT_WINDOW_MS) && hostId !== 'local') {
    // a check of a remote host opens (or reuses) the connection to it; nothing is changed there
    I.audit('human', 'doctor.for', {
      decision: 'info',
      details: { host: hostId, ...('template' in req ? { template: req.template } : {}) },
    });
  }
  const checks = new Checks();
  if ('host' in req) {
    await checkHost(I, caller, ctx, hostId, checks);
    return report({ kind: 'host', host: hostId }, checks);
  }
  await checkTemplate(I, caller, ctx, req, hostId, checks);
  return report({ kind: 'template', name: req.template, host: hostId }, checks);
}

// ---------------------------------------------------------------------------
// shared pieces
// ---------------------------------------------------------------------------

/** The host, or a failed check that names why it cannot be used. */
async function resolveOrFail(
  I: Internals,
  hostId: string,
  checks: Checks,
): Promise<{ host: ResolvedHost; ms: number } | undefined> {
  const t0 = Date.now();
  try {
    const host = await I.resolveHost(hostId);
    return { host, ms: Date.now() - t0 };
  } catch (e) {
    const hint = hintOf(e);
    checks.add({
      id: `host.${hostId}`,
      severity: 'error',
      title: `host ${hostId} cannot be used`,
      detail: errMessage(e),
      details: [errMessage(e)],
      ...(hint ? { hint } : {}),
    });
    return undefined;
  }
}

/** `provider.status()` that never throws. */
async function statusOf(provider: SandboxProvider): ReturnType<SandboxProvider['status']> {
  try {
    return await provider.status();
  } catch (e) {
    return { ok: false, details: [errMessage(e)], warnings: [] };
  }
}

function describeDisk(d: DiskSpace): string {
  return `${formatSize(d.freeBytes)} free of ${formatSize(d.totalBytes)} in ${d.path}`;
}

/** Agent contexts of the policy (everything but the human), in a stable order. */
function agentContexts(I: Internals): AgentContext[] {
  const out: AgentContext[] = [];
  for (const id of Object.keys(I.policy.contexts).sort()) {
    if (id === 'human') continue;
    try {
      out.push(resolveContext(I.policy, id, { home: I.home }));
    } catch {
      /* a context that refers to a missing profile is reported by the policy checks */
    }
    if (out.length >= MAX_AGENT_CONTEXTS) break;
  }
  return out;
}

function hostMayBeUsedBy(ctx: AgentContext, hostId: string): boolean {
  return ctx.allowedHosts.includes('*') || ctx.allowedHosts.includes(hostId);
}

// ---------------------------------------------------------------------------
// --for host:<id>
// ---------------------------------------------------------------------------

async function checkHost(
  I: Internals,
  caller: Caller,
  ctx: AgentContext,
  hostId: string,
  checks: Checks,
): Promise<void> {
  const resolved = await resolveOrFail(I, hostId, checks);
  if (!resolved) return;
  const { host } = resolved;
  const remote = host.connection.kind !== 'local';
  const facts = [
    remote ? 'remote host over ssh' : 'this machine',
    `zone ${host.zone}`,
    ...(host.minIsolation ? [`minimum isolation ${host.minIsolation}`] : []),
    ...(remote ? [`reached in ${resolved.ms} ms`] : []),
  ];
  checks.add({
    id: `host.${hostId}`,
    severity: 'ok',
    title: `host ${hostId}: ${remote ? 'reachable' : 'available'}`,
    detail: facts.join('; '),
    details: facts,
  });

  // backends
  const kinds = (Object.keys(I.providerFactories) as BackendKind[]).filter((k) =>
    host.backends.includes(k),
  );
  let usable = 0;
  let satisfying = 0;
  let cachesOn: BackendKind | undefined;
  let diskOf: SandboxProvider | undefined;
  const notShown = new Set<string>();
  for (const kind of kinds) {
    let provider: SandboxProvider;
    try {
      provider = I.providerFor(host, kind);
    } catch (e) {
      checks.add({
        id: `backend.${hostId}.${kind}`,
        severity: 'warning',
        title: `backend ${kind} on ${hostId}: not usable`,
        detail: errMessage(e),
        details: [errMessage(e)],
      });
      continue;
    }
    const status = await statusOf(provider);
    if (!status.ok) {
      // another backend of the host can still serve; only "none works" is a failure (below)
      checks.add({
        id: `backend.${hostId}.${kind}`,
        severity: 'info',
        title: `backend ${kind} on ${hostId}: not installed or not running (optional)`,
        details: [...status.details, ...status.warnings],
        detail: [...status.details, ...status.warnings].join('; '),
        hint: startHint(kind),
      });
      continue;
    }
    usable++;
    const caps = provider.capabilities();
    const classified = classifyWorkingBackend(status);
    const notes = classified.notes.filter(
      (n) => n.severity === 'warning' || !notShown.has(n.message),
    );
    for (const n of notes) notShown.add(n.message);
    const modeLine =
      status.rootless === undefined
        ? undefined
        : status.rootless
          ? 'engine runs rootless'
          : 'engine runs as root (rootful)';
    const details = [
      ...(modeLine ? [modeLine] : []),
      `isolation ${caps.isolation}`,
      `network modes: ${caps.networkModes.join(', ')}${caps.networkFilter ? ' (domain allowlist available)' : ''}`,
      `package caches: ${caps.caches === true ? 'supported' : 'not supported'}`,
    ];
    if (caps.caches === true) cachesOn ??= kind;
    const short = isolationAtLeast(caps.isolation, host.minIsolation ?? 'none')
      ? undefined
      : host.minIsolation;
    if (short === undefined) satisfying++;
    checks.add({
      id: `backend.${hostId}.${kind}`,
      severity: short !== undefined ? 'warning' : classified.severity,
      title:
        short !== undefined
          ? `backend ${kind} on ${hostId}: isolation ${caps.isolation}, but the host requires ${short}`
          : `backend ${kind} on ${hostId}: ok${status.version ? ` (${status.version}${status.rootless ? ', rootless' : ''})` : ''}`,
      detail: details.join('; '),
      details,
      ...(notes.length > 0 ? { notes } : {}),
      ...(short !== undefined
        ? {
            hint: hardenedHint(provider, caps),
          }
        : {}),
    });
    diskOf ??= typeof provider.diskSpace === 'function' ? provider : undefined;
  }
  if (usable === 0) {
    checks.add({
      id: `backend.${hostId}`,
      severity: 'error',
      title:
        kinds.length === 0
          ? `host ${hostId} offers no backend`
          : `no backend on ${hostId} is usable`,
      hint:
        kinds.length === 0
          ? 'Set the backends (and engine_socket) of the host in hosts.yaml; "abox host test" shows what the host offers.'
          : 'Start the engine on the host; "abox host test" and "abox doctor" show why it is not usable.',
    });
  } else if (satisfying === 0) {
    checks.add({
      id: `backend.${hostId}.isolation`,
      severity: 'error',
      title: `no backend on ${hostId} delivers the isolation the host requires (${host.minIsolation})`,
      hint: 'Sandboxes are refused here until a stronger runtime is available (see the backend lines above).',
    });
  }

  // disk
  if (diskOf?.diskSpace) {
    const d = await diskOf.diskSpace().catch(() => undefined);
    if (d) {
      checks.add({
        id: `disk.${hostId}`,
        severity:
          d.freeBytes < DISK_ERROR_BYTES
            ? 'error'
            : d.freeBytes < HOST_DISK_WARN_BYTES
              ? 'warning'
              : 'ok',
        title: `disk space: ${describeDisk(d)}`,
        ...(d.freeBytes < HOST_DISK_WARN_BYTES
          ? {
              hint: 'Images and sandboxes need room: free some space or run `abox gc` and `abox cache rm`.',
            }
          : {}),
      });
    } else {
      checks.add({
        id: `disk.${hostId}`,
        severity: 'info',
        title:
          'disk space cannot be measured from here (the engine is on another machine or its storage is not visible)',
      });
    }
  } else if (usable > 0) {
    checks.add({
      id: `disk.${hostId}`,
      severity: 'info',
      title: 'disk space is not reported by the backends of this host',
    });
  }

  // limits and capacity
  try {
    const cap = await capacityOf(I, caller, hostId, { usage: false });
    const c = cap.capacity;
    const machine =
      c.cpus === null && c.memoryBytes === null
        ? 'size of the machine is unknown'
        : `${c.cpus ?? '?'} cpus, ${c.memoryBytes === null ? '?' : formatSize(c.memoryBytes)} memory (from ${c.source})`;
    const live = cap.live;
    const liveLines: string[] = [];
    let liveSeverity: DoctorCheck['severity'] = 'ok';
    if (live.available) {
      if (live.cpuPercent !== null) liveLines.push(`cpu busy ${Math.round(live.cpuPercent)}%`);
      if (live.memoryAvailableBytes !== null && live.memoryTotalBytes !== null) {
        liveLines.push(
          `memory available ${formatSize(live.memoryAvailableBytes)} of ${formatSize(live.memoryTotalBytes)}`,
        );
        if (live.memoryAvailableBytes < GIB) liveSeverity = 'warning';
      }
      if (live.cpuPercent !== null && live.cpuPercent >= 90) liveSeverity = 'warning';
    } else {
      liveLines.push(`utilisation unknown${live.reason ? ` (${live.reason})` : ''}`);
    }
    checks.add({
      id: `capacity.${hostId}`,
      severity: live.available ? liveSeverity : 'info',
      title: `machine: ${machine}`,
      details: liveLines,
      detail: liveLines.join('; '),
      ...(liveSeverity === 'warning'
        ? { hint: 'The machine is busy or short of memory: new sandboxes will be slow.' }
        : {}),
    });
    const limitLines: string[] = [];
    let limitSeverity: DoctorCheck['severity'] = 'ok';
    const lim = cap.limits;
    const rows: Array<
      [string, { limit: number; reserved: number } | undefined, (n: number) => string]
    > = [
      ['sandboxes', lim.sandboxes, (n) => String(n)],
      ['cpus', lim.cpus, (n) => String(Math.round(n * 100) / 100)],
      ['memory', lim.memoryBytes, formatSize],
    ];
    for (const [name, u, fmt] of rows) {
      if (!u) continue;
      limitLines.push(`${name}: ${fmt(u.reserved)} reserved of ${fmt(u.limit)}`);
      if (u.reserved >= u.limit) limitSeverity = 'error';
      else if (u.reserved >= u.limit * NEARLY_FULL && limitSeverity === 'ok')
        limitSeverity = 'warning';
    }
    if (limitLines.length === 0) {
      checks.add({
        id: `limits.${hostId}`,
        severity: 'info',
        title: `no limits set for ${hostId}`,
        detail: `${cap.abox.sandboxes} sandbox(es) of abox here (${cap.abox.running} running)`,
        hint: 'Limits cap all sandboxes on the host together: `abox host limits` (or hosts.yaml).',
      });
    } else {
      checks.add({
        id: `limits.${hostId}`,
        severity: limitSeverity,
        title:
          limitSeverity === 'error'
            ? `limits of ${hostId} are reached: a new sandbox is refused`
            : limitSeverity === 'warning'
              ? `limits of ${hostId} are nearly reached`
              : `limits of ${hostId}: room left`,
        details: [
          ...limitLines,
          `${cap.abox.sandboxes} sandbox(es) of abox here (${cap.abox.running} running)`,
        ],
        detail: limitLines.join('; '),
        ...(limitSeverity !== 'ok'
          ? { hint: 'Delete sandboxes you no longer need, or raise the limits of the host.' }
          : {}),
      });
    }
  } catch (e) {
    checks.add({
      id: `capacity.${hostId}`,
      severity: 'warning',
      title: 'capacity and limits could not be read',
      detail: errMessage(e),
      details: [errMessage(e)],
    });
  }

  // who may use it
  const agents = agentContexts(I).filter((a) => hostMayBeUsedBy(a, hostId));
  checks.add({
    id: `agents.${hostId}`,
    severity: 'info',
    title:
      agents.length === 0
        ? `no agent context may use ${hostId}`
        : `agent contexts that may use ${hostId}: ${agents.map((a) => a.id).join(', ')}`,
    ...(agents.length === 0
      ? {
          hint: 'Allow it per profile or context (`hosts:`) in policy.yaml if agents should run here.',
        }
      : {}),
  });
  void ctx;
}

function hardenedHint(provider: SandboxProvider, caps: ProviderCapabilities): string {
  const runtime = (provider as { hardenedRuntime?: string }).hardenedRuntime;
  return runtime !== undefined && !isolationAtLeast(caps.isolation, 'hardened')
    ? `The hardened runtime "${runtime}" of this host is not installed in its engine ("abox host test" shows what the engine offers).`
    : 'Pick a backend that delivers the isolation, or lower the requirement of the host.';
}

// ---------------------------------------------------------------------------
// --for <template>
// ---------------------------------------------------------------------------

async function checkTemplate(
  I: Internals,
  caller: Caller,
  ctx: AgentContext,
  req: Extract<DoctorForInput, { template: string }>,
  hostId: string,
  checks: Checks,
): Promise<void> {
  // 1. the template
  let template: ResolvedTemplate;
  let shadows: Array<{ kind: string; path: string }>;
  try {
    const loaded = await loadTemplate(
      I,
      ctx,
      req.template,
      projectDirCandidates(I, ctx, req.projectDir, req.workspacePath),
    );
    template = loaded.template;
    shadows = (await loaded.catalog.getShadowed(template.name).catch(() => ({ hidden: [] })))
      .hidden;
  } catch (e) {
    if (!isAboxError(e)) throw e;
    const issues = e.issues.map((i) => `${i.path ? `${i.path}: ` : ''}${i.message}`);
    checks.add({
      id: 'template',
      severity: 'error',
      title:
        e.code === 'not_found'
          ? `template ${req.template}: not found`
          : `template ${req.template}: cannot be used`,
      detail: [e.message, ...issues].join('; '),
      details: [e.message, ...issues],
      ...(e.hint ? { hint: e.hint } : {}),
    });
    return;
  }
  const trusted = isTrusted(I, template);
  const templateLines = [
    `source ${template.source.kind}${template.source.path ? ` (${template.source.path})` : ''}`,
    `backend ${template.backend}, isolation ${template.isolation}`,
    ...shadows.map((s) => `hides the ${s.kind} template of the same name`),
  ];
  checks.add({
    id: 'template',
    severity: trusted ? (shadows.length > 0 ? 'info' : 'ok') : 'warning',
    title: trusted
      ? `template ${template.name}: found and valid`
      : `template ${template.name}: found and valid, but this project template is not trusted yet`,
    detail: templateLines.join('; '),
    details: templateLines,
    ...(trusted
      ? {}
      : {
          hint: `Read what it does with \`abox template review ${template.name}\`; the first create asks you to trust it, an agent needs your approval.`,
        }),
  });
  if (I.policyProblem) {
    checks.add({
      id: 'policy.invalid',
      severity: 'error',
      title: 'policy.yaml is invalid: creating sandboxes is refused until it is repaired',
      detail: I.policyProblem.message,
      details: [I.policyProblem.message],
      hint: '`abox policy validate` lists the problems, `abox policy edit` repairs the file.',
    });
  }

  // 2. the host
  const resolved = await resolveOrFail(I, hostId, checks);
  if (!resolved) return;
  const { host } = resolved;
  const remote = host.connection.kind !== 'local';

  // 3. the backend on the host
  if (!host.backends.includes(template.backend) || !I.providerFactories[template.backend]) {
    checks.add({
      id: 'backend',
      severity: 'error',
      title: `backend ${template.backend} is not available on host ${hostId}`,
      detail: `the host offers: ${host.backends.join(', ') || 'nothing'}`,
      hint: 'Pick a template for a backend the host offers, or another host (`abox doctor --for host:<id>`).',
    });
    return;
  }
  let provider: SandboxProvider;
  try {
    provider = I.providerFor(host, template.backend);
  } catch (e) {
    checks.add({
      id: 'backend',
      severity: 'error',
      title: `backend ${template.backend} on ${hostId}: not usable`,
      detail: errMessage(e),
      details: [errMessage(e)],
    });
    return;
  }
  const status = await statusOf(provider);
  if (!status.ok) {
    checks.add({
      id: 'backend',
      severity: 'error',
      title: `backend ${template.backend} on ${hostId}: not usable`,
      details: [...status.details, ...status.warnings],
      detail: [...status.details, ...status.warnings].join('; '),
      hint: startHintFor(template.backend),
    });
    return;
  }
  const caps = provider.capabilities();
  const classified = classifyWorkingBackend(status);
  checks.add({
    id: 'backend',
    severity: classified.severity,
    title: `backend ${template.backend} on ${hostId}: ok${status.version ? ` (${status.version}${status.rootless === true ? ', rootless' : status.rootless === false ? ', rootful' : ''})` : ''}`,
    detail: status.details.join('; '),
    details: status.details,
    ...(classified.notes.length > 0 ? { notes: classified.notes } : {}),
  });

  // 4. what the template needs from the backend: capabilities, isolation, network mode, workspace
  const compat = checkTemplateForProvider(template, provider);
  const needs: string[] = compat.issues.map((i) => `${i.path ? `${i.path}: ` : ''}${i.message}`);
  const netMode = template.network.mode;
  if (!caps.networkModes.includes(netMode))
    needs.push(
      `backend ${template.backend} does not support network mode ${netMode} (supported: ${caps.networkModes.join(', ')})`,
    );
  else if (netMode === 'allowlist' && !caps.networkFilter)
    needs.push(
      `backend ${template.backend} cannot enforce a domain allowlist (no egress proxy runtime)`,
    );
  const delivery = deliveryKindFor(template.workspace.mode);
  if (!caps.workspaceDelivery.includes(delivery))
    needs.push(
      caps.remote && delivery === 'bind'
        ? `the default workspace mode ${template.workspace.mode} cannot bind a folder of this machine on remote host ${hostId} (use copy or clone)`
        : `backend ${template.backend} cannot deliver the default workspace mode ${template.workspace.mode}`,
    );
  if (needs.length > 0) {
    checks.add({
      id: 'compat',
      severity: 'error',
      title: `template ${template.name} cannot run on ${template.backend} here`,
      detail: needs.join('; '),
      details: needs,
      hint: 'Pick a different template or backend, or change the template (`abox template validate`).',
    });
  } else {
    checks.add({
      id: 'compat',
      severity: compat.warnings.length > 0 ? 'info' : 'ok',
      title: `template ${template.name} fits what ${template.backend} on ${hostId} offers`,
      ...(compat.warnings.length > 0
        ? {
            notes: compat.warnings.map((message): DoctorNote => ({ severity: 'info', message })),
          }
        : {}),
    });
  }

  // 5. isolation (template and host; the profile's own minimum is part of the policy check below)
  const required =
    host.minIsolation && !isolationAtLeast(template.isolation, host.minIsolation)
      ? host.minIsolation
      : template.isolation;
  if (!isolationAtLeast(caps.isolation, required)) {
    checks.add({
      id: 'isolation',
      severity: 'error',
      title: `isolation: ${template.backend} on ${hostId} delivers ${caps.isolation}, ${required} is required${required === template.isolation ? ' by the template' : ` by host ${hostId} (zone ${host.zone})`}`,
      hint: hardenedHint(provider, caps),
    });
  } else {
    checks.add({
      id: 'isolation',
      severity: caps.isolation === 'none' ? 'warning' : 'ok',
      title:
        caps.isolation === 'none'
          ? 'isolation: none, commands run with your permissions on the host'
          : `isolation: ${caps.isolation}${required !== 'none' ? ` (required: ${required})` : ''}`,
    });
  }

  // 6. the environment image and the disk
  await checkImage(provider, template, checks, remote);

  // 7. network
  checkNetwork(I, ctx, template, caps, checks);

  // 8. package caches
  if (template.caches.length > 0) {
    const plan = planCaches({
      ctx,
      template,
      supported: caps.caches === true,
      optOut: false,
      project: '/project',
    });
    const names = template.caches.map((c) => `${c.name} (${c.path})`);
    if (plan.status === 'active') {
      checks.add({
        id: 'caches',
        severity: 'ok',
        title: `package caches: ${template.caches.map((c) => c.name).join(', ')} kept per project`,
        details: [
          ...names,
          `size cap per project: ${formatSize(ctx.profile.cacheMaxBytes)} (profile "${ctx.profileName}")`,
        ],
      });
    } else {
      const why =
        plan.status === 'unsupported'
          ? `backend ${template.backend} cannot keep them`
          : plan.status === 'disabled_by_policy'
            ? `profile "${ctx.profileName}" switches them off (caches: false)`
            : 'there is no project folder';
      checks.add({
        id: 'caches',
        severity: 'info',
        title: `package caches: not used (${why}); every sandbox downloads its packages again`,
        details: names,
      });
    }
  }

  // 9. what policy.yaml says to a create from it
  const hostUsage = I.hostUsage(hostId);
  const info = I.hostInfo(host, remote);
  const evaluate = (c: AgentContext): CreateEvaluation | undefined => {
    const base = I.projectDir ?? process.cwd();
    const mounts = template.mounts.flatMap((m) => {
      try {
        return [
          {
            hostPath: canonicalizePath(m.source, { home: I.home, cwd: base }),
            target: m.target,
            access: m.access,
          },
        ];
      } catch {
        return [];
      }
    });
    try {
      return evaluateCreate({
        context: c,
        template,
        templateTrusted: trusted,
        templateSource: template.source,
        host: info,
        providerIsolation: caps.isolation,
        mounts,
        network: { mode: netMode, allow: template.network.allow },
        secrets: template.secrets.map((s) => ({ ref: s.ref, inject: s.inject })),
        resources: { cpus: template.resources.cpus, memoryBytes: template.resources.memoryBytes },
        ttlMs: template.resources.ttlMs,
        currentSandboxCount: I.countActive(c.owner),
        currentHostSandboxCount: hostUsage.sandboxes,
        hostUsage,
        paths: { home: I.home, extraForbidden: I.forbiddenTrees() },
      });
    } catch {
      return undefined;
    }
  };
  if (!I.policyProblem) {
    checkPolicy(I, ctx, template, hostId, evaluate, checks);
  }

  // 10. how many fit
  try {
    const fit = await estimateFit(I, caller, {
      hostId,
      template: template.name,
      ...(req.projectDir ? { projectDir: req.projectDir } : {}),
      ...(req.workspacePath ? { workspacePath: req.workspacePath } : {}),
    });
    const lines = [...fit.blocked.map((b) => b.reason), ...fit.warnings.map((w) => w.message)];
    const want = `${template.resources.cpus} cpus, ${formatSize(template.resources.memoryBytes)} memory`;
    if (fit.blocked.length > 0 || fit.fits === 0) {
      checks.add({
        id: 'capacity',
        // the refusal itself is the policy check's error; this says what it is about
        severity: 'warning',
        title: `host ${hostId} has no room for a sandbox of ${want}`,
        details: lines,
        detail: lines.join('; '),
        hint: fit.blocked.find((b) => b.hint)?.hint ?? 'Delete sandboxes you no longer need.',
      });
    } else if (fit.warnings.length > 0 || fit.tone === 'warn') {
      checks.add({
        id: 'capacity',
        severity: 'warning',
        title: `host ${hostId} has room for a sandbox of ${want}, but it is tight`,
        details: lines,
        detail: lines.join('; '),
      });
    } else {
      checks.add({
        id: 'capacity',
        severity: fit.fits === null ? 'info' : 'ok',
        title:
          fit.fits === null
            ? `host ${hostId}: no limit or measurement bounds a sandbox of ${want}`
            : `host ${hostId} has room for ${fit.fits} sandbox${fit.fits === 1 ? '' : 'es'} of ${want}`,
      });
    }
  } catch (e) {
    checks.add({
      id: 'capacity',
      severity: 'warning',
      title: 'capacity of the host could not be estimated',
      detail: errMessage(e),
      details: [errMessage(e)],
    });
  }
}

function startHintFor(kind: BackendKind): string {
  return kind === 'podman'
    ? 'Start it with `systemctl --user start podman.socket`.'
    : kind === 'docker'
      ? 'Start the engine (`systemctl start docker`), or install Docker.'
      : 'See `abox doctor` for why it is not usable.';
}

// -- image and disk -----------------------------------------------------------------------------

async function checkImage(
  provider: SandboxProvider,
  template: ResolvedTemplate,
  checks: Checks,
  remote: boolean,
): Promise<void> {
  const build = `abox template build ${template.name}`;
  let image: ImageStatus | undefined;
  let imageError: string | undefined;
  if (typeof provider.imageStatus === 'function') {
    try {
      image = await provider.imageStatus(template);
    } catch (e) {
      imageError = errMessage(e);
    }
  }
  const estimate = estimateImageBytes(template);
  const approx = `about ${formatSize(estimate.bytes)}${estimate.source === 'hint' ? '' : ' (estimated)'}`;
  if (image?.present) {
    checks.add({
      id: 'image',
      severity: 'ok',
      title: `environment image is built${image.sizeBytes ? ` (${formatSize(image.sizeBytes)})` : ''}: a create starts without a build`,
      detail: image.ref,
      details: [image.ref],
    });
  } else if (image) {
    const lines = [
      `image ${image.ref} does not exist yet; the first create builds it (${approx})`,
      template.base.dockerfile
        ? `built from your Dockerfile ${template.base.dockerfile}${template.buildContext ? ` (${template.buildContext.fileCount} file(s), ${formatSize(template.buildContext.totalBytes)} of build context)` : ''}`
        : image.base
          ? image.base.present
            ? `base image ${image.base.ref} is already on the engine`
            : `base image ${image.base.ref} is pulled first: the engine host needs internet access to its registry`
          : '',
      'the build downloads packages and tools; nothing is downloaded by this check',
    ].filter((l) => l !== '');
    checks.add({
      id: 'image',
      severity: 'info',
      title: 'environment image is not built yet: the first create builds it',
      details: lines,
      detail: lines.join('; '),
      hint: `\`${build}\` builds it ahead of time.`,
    });
  } else if (imageError !== undefined) {
    checks.add({
      id: 'image',
      severity: 'warning',
      title: 'the environment image could not be looked up',
      detail: imageError,
      details: [imageError],
    });
  } else {
    checks.add({
      id: 'image',
      severity: 'info',
      title: `backend ${template.backend} does not report whether its environment is built`,
    });
  }

  // disk
  let disk: DiskSpace | undefined;
  if (typeof provider.diskSpace === 'function') {
    disk = await provider.diskSpace().catch(() => undefined);
  }
  const needsBuild = image === undefined ? false : !image.present;
  const need = estimate.bytes * BUILD_SPACE_FACTOR;
  const needText = `${formatSize(need)} (image ${approx}, twice that while building)`;
  if (!disk) {
    if (needsBuild)
      checks.add({
        id: 'disk',
        severity: 'info',
        title: `disk space: the first build needs ${needText}; free space cannot be measured ${remote ? 'on a remote host' : 'from here'}`,
      });
    return;
  }
  if (!needsBuild) {
    checks.add({
      id: 'disk',
      severity: disk.freeBytes < DISK_ERROR_BYTES ? 'warning' : 'ok',
      title: `disk space: ${describeDisk(disk)}`,
      ...(disk.freeBytes < DISK_ERROR_BYTES
        ? { hint: 'Sandboxes need room: free some space (`abox gc`, `abox cache rm`).' }
        : {}),
    });
    return;
  }
  if (disk.freeBytes < need) {
    checks.add({
      id: 'disk',
      severity: 'error',
      title: `not enough disk space for the first build: ${describeDisk(disk)}, it needs ${needText}`,
      hint: 'Free some space (`abox gc`, `abox cache rm`, `docker image prune` for images you know) or move the engine storage to a bigger disk.',
    });
  } else if (disk.freeBytes < need + DISK_HEADROOM_BYTES) {
    checks.add({
      id: 'disk',
      severity: 'warning',
      title: `disk space is tight: ${describeDisk(disk)}, the first build needs ${needText}`,
      hint: 'The build fits, but little remains for sandboxes and caches afterwards.',
    });
  } else {
    checks.add({
      id: 'disk',
      severity: 'ok',
      title: `disk space: ${describeDisk(disk)}; the first build needs ${needText}`,
    });
  }
}

// -- network ------------------------------------------------------------------------------------

function checkNetwork(
  I: Internals,
  ctx: AgentContext,
  template: ResolvedTemplate,
  caps: ProviderCapabilities,
  checks: Checks,
): void {
  const mode = template.network.mode;
  if (mode !== 'allowlist') {
    checks.add({
      id: 'network',
      severity: 'ok',
      title:
        mode === 'none'
          ? 'network: none, the sandbox has no network access'
          : 'network: open, the sandbox can reach any destination',
      ...(mode === 'open' ? { detail: 'Profiles need to allow network mode "open".' } : {}),
    });
    return;
  }
  const allow = new Set(template.network.allow);
  const presets = Object.entries(NETWORK_PRESETS).filter(([, ds]) => ds.every((d) => allow.has(d)));
  const inPreset = new Set(presets.flatMap(([, ds]) => ds));
  const extra = [...allow].filter((d) => !inPreset.has(d));
  const notes: DoctorNote[] = [];
  const gaps = (c: AgentContext): string[] => {
    const allowed = profileDomains(c);
    const out: string[] = [];
    for (const [name, ds] of presets)
      if (!ds.every((d) => domainCovered(d, allowed))) out.push(`preset ${name}`);
    for (const d of extra) if (!domainCovered(d, allowed)) out.push(d);
    return out;
  };
  const yours = gaps(ctx);
  const modeAllowed = (c: AgentContext): boolean => c.profile.network.modes.includes('allowlist');
  notes.push({
    severity: 'info',
    message: !modeAllowed(ctx)
      ? `your profile "${ctx.profileName}" does not allow network mode allowlist (network.modes)`
      : yours.length === 0
        ? `your profile "${ctx.profileName}" allows all of it`
        : `your profile "${ctx.profileName}" does not cover ${yours.join(', ')}: a create asks you to confirm them (add them to network.allow_presets / network.allow of the profile to skip that)`,
  });
  // one line per agent profile, the contexts that use it named
  const byProfile = new Map<string, AgentContext[]>();
  for (const a of agentContexts(I))
    byProfile.set(a.profileName, [...(byProfile.get(a.profileName) ?? []), a]);
  for (const [profile, list] of byProfile) {
    const first = list[0]!;
    const who = `agent profile "${profile}" (${list.map((a) => a.id).join(', ')})`;
    if (!templateAllowed(first, template.name)) {
      notes.push({ severity: 'info', message: `${who} does not list this template` });
      continue;
    }
    const g = gaps(first);
    notes.push({
      severity: 'info',
      message: !modeAllowed(first)
        ? `${who} may not use network mode allowlist`
        : g.length === 0
          ? `${who} allows all of it`
          : `${who} does not cover ${g.join(', ')}: a create needs your approval`,
    });
  }
  checks.add({
    id: 'network',
    severity: modeAllowed(ctx) && yours.length === 0 ? 'ok' : 'info',
    title: `network: allowlist of ${template.network.allow.length} destination(s)${presets.length > 0 ? `, presets ${presets.map(([n]) => n).join(', ')}` : ''}${extra.length > 0 ? `, plus ${extra.join(', ')}` : ''}`,
    notes,
    details: template.network.allow,
  });
  void caps;
}

// -- policy ---------------------------------------------------------------------------------------

function checkPolicy(
  I: Internals,
  ctx: AgentContext,
  template: ResolvedTemplate,
  hostId: string,
  evaluate: (c: AgentContext) => CreateEvaluation | undefined,
  checks: Checks,
): void {
  const mine = evaluate(ctx);
  const who = `you (profile "${ctx.profileName}")`;
  if (!mine) {
    checks.add({
      id: 'policy',
      severity: 'warning',
      title: 'the policy rules for a create could not be evaluated',
    });
  } else if (mine.decision === 'deny') {
    checks.add({
      id: 'policy',
      severity: 'error',
      title: `policy: a create from ${template.name} on ${hostId} is refused for ${who}`,
      details: mine.reasons,
      detail: mine.reasons.join('; '),
      ...(mine.hint ? { hint: mine.hint } : {}),
    });
  } else if (mine.decision === 'approval') {
    checks.add({
      id: 'policy',
      severity: 'warning',
      title: `policy: a create from ${template.name} on ${hostId} asks you to confirm first (${who})`,
      details: mine.reasons,
      detail: mine.reasons.join('; '),
      hint: 'Confirm it in the dialog of the GUI or with `abox create --yes`.',
    });
  } else {
    checks.add({
      id: 'policy',
      severity: 'ok',
      title: `policy: ${who} may create from ${template.name} on ${hostId}`,
    });
  }

  // the agent contexts, grouped by what they would be told
  const groups = new Map<
    string,
    { contexts: string[]; profiles: Set<string>; outcome: string; reasons: string[] }
  >();
  for (const a of agentContexts(I)) {
    const ev = evaluate(a);
    if (!ev) continue;
    const outcome =
      ev.decision === 'allow'
        ? 'may create it without asking'
        : ev.decision === 'approval'
          ? 'needs your approval to create it'
          : 'cannot create it';
    const reasons = ev.decision === 'allow' ? [] : ev.reasons;
    const key = `${outcome}\n${reasons.join('\n')}`;
    const g = groups.get(key) ?? { contexts: [], profiles: new Set(), outcome, reasons };
    g.contexts.push(a.id);
    g.profiles.add(a.profileName);
    groups.set(key, g);
  }
  if (groups.size === 0) return;
  const notes: DoctorNote[] = [...groups.values()].map((g) => ({
    severity: 'info',
    message: `${g.contexts.join(', ')} (profile ${[...g.profiles].map((p) => `"${p}"`).join(', ')}): ${g.outcome}${g.reasons.length > 0 ? `: ${g.reasons.join('; ')}` : ''}`,
  }));
  checks.add({
    id: 'policy.agents',
    severity: 'info',
    title: `policy for agents: ${[...groups.values()]
      .map((g) => `${g.contexts.length} ${g.outcome.replace(' it', '').replace(' to create', '')}`)
      .join(', ')}`,
    notes,
  });
}
