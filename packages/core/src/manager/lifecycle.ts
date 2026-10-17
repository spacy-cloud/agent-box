import { rm } from 'node:fs/promises';
import { AboxError, isAboxError } from '../errors.js';
import type { SandboxProvider } from '../provider.js';
import { hashJson } from '../state/canonical.js';
import type { SandboxRecord, SandboxRegistry } from '../state/sandbox-registry.js';
import {
  canonicalizePath,
  lexicalPath,
  evaluateCreate,
  hostQuotaViolations,
  isWithinFolded,
  type AgentContext,
  type CreateEvaluation,
} from '../policy/index.js';
import { domainCovered } from '../policy/domains.js';
import { tryParseDuration, tryParseSize } from '../policy/units.js';
import {
  buildEnvSecrets,
  buildFileSecrets,
  buildProxyInjections,
  normalizeHost,
} from '../secrets/inject.js';
import { expandNetworkPresets } from '../template/network-presets.js';
import { isolationAtLeast, makeSandboxId } from '../types.js';
import type {
  AccessMode,
  NetworkMode,
  NetworkSpec,
  ResolvedTemplate,
  SandboxId,
  SandboxInfo,
  SandboxSpec,
  WorkspaceDelivery,
  WorkspaceMode,
} from '../types.js';
import {
  cleanupWorkspace,
  compileExcludes,
  copyLimitError,
  describeScan,
  prepareWorkspace,
  scanTree,
} from '../workspace/index.js';
import type { ScanResult, WorkspaceRecord } from '../workspace/index.js';
import { confirmationRequired, consumeApproval, gate } from './approvals.js';
import { collectNetworkEvents } from './network-audit.js';
import type { Internals, StoredEffective } from './internals.js';
import { createRequestSchema } from './schemas.js';
import { requireNotTakenOver } from './takeover.js';
import {
  checkTemplateForProvider,
  isTrusted,
  loadTemplate,
  projectDirCandidates,
  throwForIssues,
} from './templates.js';
import type {
  Caller,
  CreateOptions,
  CreateSandboxRequest,
  CreateResult,
  InspectResult,
  OrphanView,
  ProcessView,
  SandboxFilterInput,
  SandboxList,
  SandboxView,
} from './types.js';
import { errMessage, newShortId, parseInput, sleep } from './util.js';

const WAIT_FOR_PEER_MS = 120_000;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function toSize(v: string | number, what: string): number {
  const n = typeof v === 'number' ? v : tryParseSize(v);
  if (n === undefined || !Number.isSafeInteger(n) || n <= 0) {
    throw new AboxError(
      'invalid_input',
      `invalid ${what} ${JSON.stringify(v)} (examples: 512m, 4g)`,
    );
  }
  return n;
}

export function toDuration(v: string | number, what: string): number {
  const n = typeof v === 'number' ? v : tryParseDuration(v);
  if (n === undefined || !Number.isFinite(n) || n <= 0) {
    throw new AboxError(
      'invalid_input',
      `invalid ${what} ${JSON.stringify(v)} (examples: 30m, 2h, 1d)`,
    );
  }
  return n;
}

/** Hosts that `inject: proxy` secrets will be sent to (config can only narrow the template's list). */
export function proxyInjectionHosts(I: Internals, secrets: ResolvedTemplate['secrets']): string[] {
  const hosts = new Set<string>();
  for (const s of secrets) {
    if (s.inject !== 'proxy') continue;
    let list = s.hosts.map(normalizeHost);
    const cfg = I.config.secrets[s.ref];
    if (cfg?.hosts) {
      const allowed = new Set(cfg.hosts.map(normalizeHost));
      list = list.filter((h) => allowed.has(h));
    }
    for (const h of list) hosts.add(h);
  }
  return [...hosts].sort();
}

function deliveryKindFor(mode: WorkspaceMode): WorkspaceDelivery['kind'] {
  switch (mode) {
    case 'empty':
      return 'none';
    case 'mount':
    case 'worktree':
      return 'bind';
    default:
      return 'copy';
  }
}

async function safeProviderList(
  provider: SandboxProvider,
): Promise<{ ok: true; infos: SandboxInfo[] } | { ok: false; error: string }> {
  try {
    return { ok: true, infos: await provider.list() };
  } catch (e) {
    return { ok: false, error: errMessage(e) };
  }
}

/** View of one record with live backend information (best effort). */
export async function viewFor(I: Internals, rec: SandboxRecord): Promise<SandboxView> {
  if (rec.state === 'removed' || rec.state === 'failed' || rec.state === 'preparing')
    return I.toView(rec);
  try {
    const provider = await I.providerForRecord(rec);
    const info = await provider.inspect(rec.id);
    I.state.sandboxes.markSeen(rec.id);
    return I.toView(syncRecord(I, rec, info), { info });
  } catch (e) {
    if (isAboxError(e) && e.code === 'not_found') {
      I.state.sandboxes.markStale(rec.id);
      return I.toView({ ...rec, stale: true }, { missing: true });
    }
    if (
      isAboxError(e) &&
      (e.code === 'host_unreachable' ||
        e.code === 'backend_unavailable' ||
        e.code === 'backend_error')
    ) {
      return I.toView({ ...rec, stale: true }, { hostReachable: false });
    }
    throw e;
  }
}

/** Registry follows the backend for lifecycle state (the backend is the truth about existence and state). */
function syncRecord(I: Internals, rec: SandboxRecord, info: SandboxInfo): SandboxRecord {
  if (
    info.state !== rec.state &&
    (rec.state === 'created' || rec.state === 'running' || rec.state === 'stopped') &&
    (info.state === 'created' || info.state === 'running' || info.state === 'stopped')
  ) {
    I.state.sandboxes.transition(rec.id, [rec.state], info.state);
    return { ...rec, state: info.state };
  }
  return rec;
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

/**
 * Fingerprints of a create request. `raw` is the request as sent (cheap, known up front);
 * `effective` is the request after template resolution and merging of the overrides (known once
 * the template is loaded), so equivalent requests (`ttl: 30m` equal to the template default vs. no
 * `ttl`) are the same request - the same view approvals are bound to.
 */
interface RequestHashes {
  raw: string;
  effective?: string;
}

async function waitForPeer(
  I: Internals,
  owner: string,
  requestId: string,
  hashes: RequestHashes,
): Promise<SandboxRecord | undefined> {
  const deadline = Date.now() + WAIT_FOR_PEER_MS;
  for (;;) {
    const rec = I.state.sandboxes.findByRequestId(owner, requestId);
    if (!rec) return undefined;
    const stored = rec.effective as StoredEffective | null;
    const differs =
      stored?.requestHash !== undefined &&
      stored.requestHash !== hashes.raw &&
      !(
        hashes.effective !== undefined &&
        stored.effectiveRequestHash !== undefined &&
        stored.effectiveRequestHash === hashes.effective
      );
    if (differs && hashes.effective === undefined) {
      // Not the same text; whether it is the same request needs the resolved request (see createSandbox).
      return undefined;
    }
    if (differs) {
      throw new AboxError(
        'conflict',
        `request id '${requestId}' was already used for a different create request (sandbox ${rec.id})`,
        {
          hint: 'Use a new requestId for a different request, or repeat the identical request to get the same sandbox.',
        },
      );
    }
    if (rec.state === 'removed') {
      throw new AboxError(
        'conflict',
        `request id '${requestId}' belonged to sandbox ${rec.id}, which has been removed`,
        {
          hint: 'Use a new requestId.',
        },
      );
    }
    if (rec.state !== 'preparing') return rec;
    if (I.isInterrupted(rec)) {
      // The creating process died (e.g. kill -9): free the key so this call can create it.
      if (
        I.state.sandboxes.transition(rec.id, ['preparing'], 'failed', {
          error: 'create interrupted: the creating process is gone',
        })
      ) {
        I.state.sandboxes.releaseRequestId(rec.id);
        I.audit('system', 'sandbox.create_interrupted', {
          sandboxId: rec.id,
          decision: 'error',
          details: {
            owner: rec.owner,
            note: 'leftovers are reported by doctor and removed by reconcile --apply',
          },
        });
      }
      continue;
    }
    if (Date.now() > deadline) {
      throw new AboxError('timeout', `sandbox ${rec.id} is still being created by another call`, {
        hint: 'Retry with the same requestId in a moment.',
      });
    }
    await sleep(100);
  }
}

export async function createSandbox(
  I: Internals,
  caller: Caller,
  rawReq: CreateSandboxRequest,
  opts: CreateOptions = {},
): Promise<CreateResult> {
  const ctx = await I.context(caller);
  I.requirePolicyValid(ctx, 'sandbox.create', 'creating sandboxes');
  const req = parseInput(createRequestSchema, rawReq, 'create request');
  const owner = ctx.owner;
  const requestHash = hashJson({ ...req, requestId: undefined });
  const waitMs = Math.max(0, opts.waitForApprovalMs ?? I.config.limits.approvalWaitMs);

  // 1. idempotency
  if (req.requestId) {
    const existing = await waitForPeer(I, owner, req.requestId, { raw: requestHash });
    if (existing) return existingResult(I, existing);
  }

  // 2. host
  const hostId = req.host ?? 'local';
  if (
    ctx.kind === 'agent' &&
    !ctx.allowedHosts.includes('*') &&
    !ctx.allowedHosts.includes(hostId)
  ) {
    const msg = `host "${hostId}" is not allowed for context "${ctx.id}" (allowed hosts: ${ctx.allowedHosts.join(', ') || 'none'})`;
    I.audit(owner, 'sandbox.create', {
      decision: 'deny',
      details: { reasons: [msg], host: hostId, template: req.template },
    });
    throw new AboxError('policy_denied', msg, {
      hint: 'Only a human can allow additional hosts, in policy.yaml.',
      details: { reasons: [msg] },
    });
  }
  const host = await I.resolveHost(hostId);

  // 3. template, provider, capabilities
  const wsRequested = req.workspace;
  const { template } = await loadTemplate(
    I,
    ctx,
    req.template,
    projectDirCandidates(I, ctx, req.projectDir, wsRequested?.path),
  );
  const trusted = isTrusted(I, template);
  if (!host.backends.includes(template.backend) || !I.providerFactories[template.backend]) {
    throw new AboxError(
      'backend_unavailable',
      `template '${template.name}' needs backend '${template.backend}', which is not available on host '${hostId}'`,
      {
        hint: 'Run `abox doctor` to see which backends are available, or choose a template for an available backend.',
      },
    );
  }
  const provider = I.providerFor(host, template.backend);
  const caps = provider.capabilities();
  throwForIssues(template, checkTemplateForProvider(template, provider).issues);

  // 4. merge overrides
  const ov = req.overrides ?? {};
  const cpus = ov.cpus ?? template.resources.cpus;
  const memoryBytes =
    ov.memory !== undefined ? toSize(ov.memory, 'memory') : template.resources.memoryBytes;
  const ttlMs = ov.ttl !== undefined ? toDuration(ov.ttl, 'ttl') : template.resources.ttlMs;
  const netMode: NetworkMode = ov.network?.mode ?? template.network.mode;
  if (!caps.networkModes.includes(netMode)) {
    throw new AboxError(
      'unsupported',
      `backend '${template.backend}' does not support network mode '${netMode}' (supported: ${caps.networkModes.join(', ')})`,
      {
        hint: 'Use a template/backend that supports this network mode.',
      },
    );
  }
  if (netMode === 'allowlist' && !caps.networkFilter) {
    throw new AboxError(
      'unsupported',
      `backend '${template.backend}' cannot enforce a domain allowlist`,
      { hint: 'Use network mode none, or a container backend with the egress proxy.' },
    );
  }
  const injectionHosts = proxyInjectionHosts(I, template.secrets);
  if (injectionHosts.length > 0 && netMode !== 'allowlist') {
    throw new AboxError(
      'invalid_input',
      `secrets with inject: proxy need network mode allowlist (requested: ${netMode})`,
      {
        hint: 'The egress proxy injects the header; without an allowlist there is no proxy.',
      },
    );
  }
  let allow: string[] = [];
  if (netMode === 'allowlist') {
    const extra = [
      ...(ov.network?.allow ?? []),
      ...expandNetworkPresets(ov.network?.presets ?? []),
    ];
    allow = [...new Set([...template.network.allow, ...extra])];
    // Backend/proxy deny injection hosts that are not in the allowlist: the manager adds them (and policy sees them).
    for (const h of injectionHosts) if (!allow.includes(h)) allow.push(h);
  }
  const privateExceptions = ov.network?.privateExceptions ?? [];

  const base = I.projectDir ?? process.cwd();
  const mountSpecs = [
    ...template.mounts.map((m) => ({ source: m.source, target: m.target, access: m.access })),
    ...(ov.mounts ?? []).map((m) => ({
      source: m.source,
      target: m.target,
      access: (m.access ?? 'ro') as AccessMode,
    })),
  ];
  const mounts = mountSpecs.map((m) => ({
    hostPath: canonicalizePath(m.source, { home: I.home, cwd: base }),
    target: m.target,
    access: m.access,
  }));
  // As typed, for the policy check of a human's explicit roots only (see `lexicalPath`).
  const mountsLexical = mountSpecs.map((m) => lexicalPath(m.source, { home: I.home, cwd: base }));
  if (mounts.length > 0 && !caps.mounts) {
    throw new AboxError(
      'unsupported',
      `backend '${template.backend}' does not support additional host mounts`,
      { hint: 'Copy the files into the workspace instead.' },
    );
  }

  const wsMode: WorkspaceMode = wsRequested?.mode ?? template.workspace.mode;
  const wsAccess: AccessMode = wsRequested?.access ?? template.workspace.access;
  let wsHostPath: string | undefined;
  let wsLexicalPath: string | undefined;
  if (wsMode !== 'empty') {
    const raw = wsRequested?.path ?? I.projectDir;
    if (!raw) {
      throw new AboxError(
        'invalid_input',
        `workspace mode '${wsMode}' needs a host path (workspace.path)`,
        {
          hint: "Pass workspace.path, or use workspace mode 'empty' for a throw-away workspace.",
        },
      );
    }
    wsHostPath = canonicalizePath(raw, { home: I.home, cwd: base });
    wsLexicalPath = lexicalPath(raw, { home: I.home, cwd: base });
  }
  // Idempotency by effective request: the same sandbox however the request spelled its defaults.
  const effectiveRequestHash = hashJson({
    template: template.name,
    templateHash: template.hash,
    backend: template.backend,
    host: hostId,
    name: req.name ?? null,
    workspace: {
      mode: wsMode,
      access: wsAccess,
      hostPath: wsHostPath ?? null,
      ref: wsRequested?.ref ?? null,
      exclude: [...(wsRequested?.exclude ?? [])].sort(),
    },
    resources: { cpus, memoryBytes, ttlMs },
    network: {
      mode: netMode,
      allow: [...allow].sort(),
      privateExceptions: [...privateExceptions].sort(),
    },
    mounts: mounts.map((m) => `${m.target}\0${m.hostPath}\0${m.access}`).sort(),
  });
  if (req.requestId) {
    const existing = await waitForPeer(I, owner, req.requestId, {
      raw: requestHash,
      effective: effectiveRequestHash,
    });
    if (existing) return existingResult(I, existing);
  }
  if (wsHostPath) {
    // Early answer (before any approval is asked for); the authoritative check is the one inside the claim below.
    // (Another owner's sandbox is not named here: the policy's protected-path denial answers generically.)
    const used = workspaceInUse(I, I.state.sandboxes, ctx, wsHostPath);
    if (used?.visible) {
      const err = workspaceInUseError(wsHostPath, used);
      I.audit(owner, 'sandbox.create', {
        decision: 'deny',
        details: {
          template: req.template,
          host: hostId,
          reasons: [err.message],
          code: 'workspace_in_use',
        },
      });
      throw err;
    }
  }
  const deliveryKind = deliveryKindFor(wsMode);
  if (!caps.workspaceDelivery.includes(deliveryKind)) {
    // On a remote host a bind of a local directory cannot exist: say so, and name what works there.
    const bindOnRemote = caps.remote && deliveryKind === 'bind';
    throw new AboxError(
      'unsupported',
      bindOnRemote
        ? `workspace mode '${wsMode}' is not possible on host '${hostId}': it is a remote host and cannot bind-mount a directory of this machine`
        : `backend '${template.backend}' cannot deliver workspace mode '${wsMode}' (needs delivery '${deliveryKind}')`,
      {
        hint: bindOnRemote
          ? "Use workspace mode 'copy' (the directory is uploaded) or 'clone' (a git clone of the repository is uploaded); bring the results back with 'abox export'."
          : `Use workspace mode ${caps.workspaceDelivery.includes('copy') ? "'copy' or 'clone'" : "'empty'"} with this template.`,
      },
    );
  }

  // 5. policy
  const secretDecl = template.secrets.map((s) => ({ ref: s.ref, inject: s.inject }));
  const hostInfo = I.hostInfo(host, caps.remote);
  let copyScan: ScanResult | undefined;
  const evaluate = (confirmed: boolean | undefined): CreateEvaluation => {
    const hostUsage = I.hostUsage(hostId);
    return evaluateCreate({
      context: ctx,
      template,
      templateTrusted: trusted,
      templateSource: template.source,
      host: hostInfo,
      providerIsolation: caps.isolation,
      workspace: {
        mode: wsMode,
        ...(wsHostPath ? { hostPath: wsHostPath } : {}),
        ...(wsLexicalPath ? { lexicalPath: wsLexicalPath } : {}),
        ...(copyScan ? { copy: { bytes: copyScan.bytes, entries: copyScan.entries } } : {}),
      },
      mounts: mounts.map((m, i) => {
        const lexical = mountsLexical[i];
        return lexical ? { ...m, lexicalPath: lexical } : m;
      }),
      network: { mode: netMode, allow, privateExceptions },
      secrets: secretDecl,
      resources: { cpus, memoryBytes },
      ttlMs,
      currentSandboxCount: I.countActive(owner),
      currentHostSandboxCount: hostUsage.sandboxes,
      hostUsage,
      paths: { home: I.home, extraForbidden: I.forbiddenTrees() },
      ...(confirmed !== undefined ? { humanConfirmed: confirmed } : {}),
    });
  };
  const confirmedByHuman =
    caller.humanConfirmed === true && ctx.kind === 'human' ? true : undefined;
  let ev = evaluate(confirmedByHuman);
  const auditBase = {
    template: template.name,
    templateHash: template.hash,
    host: hostId,
    backend: template.backend,
    requestId: req.requestId,
  };

  // A copied folder is measured before anything is built or copied (read-only walk, no file is
  // opened): beyond the hard limit this fails within seconds, beyond the policy's soft limit it needs
  // a human's confirmation (agents: denial). Only after the policy accepted the path, so a forbidden
  // folder is never walked.
  if ((wsMode === 'copy' || wsMode === 'sync') && wsHostPath && ev.decision !== 'deny') {
    const onProgress = opts.onProgress;
    try {
      copyScan = await scanTree(wsHostPath, {
        exclude: compileExcludes(wsRequested?.exclude),
        gitMode: 'visit',
        ...(opts.signal ? { signal: opts.signal } : {}),
        onProgress: (p) =>
          onProgress?.(`scanning workspace … ${describeScan(p)}`, { phase: 'scan', done: p.bytes }),
      });
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      throw new AboxError(
        'invalid_input',
        `workspace folder ${wsHostPath} cannot be read: ${errMessage(e)}`,
        {
          hint: 'Check that the folder exists and that you may read it.',
        },
      );
    }
    onProgress?.(`workspace: ${describeScan(copyScan)}`, { phase: 'scan', done: copyScan.bytes });
    if (copyScan.stoppedBy) {
      const err = copyLimitError(wsHostPath, copyScan);
      I.audit(owner, 'sandbox.create', {
        decision: 'deny',
        details: {
          ...auditBase,
          reasons: [err.message],
          hint: err.hint,
          code: 'workspace_too_large',
        },
      });
      throw err;
    }
    ev = evaluate(confirmedByHuman);
  }

  if (ev.decision === 'deny') {
    I.audit(owner, 'sandbox.create', {
      decision: 'deny',
      details: { ...auditBase, reasons: ev.reasons, hint: ev.hint },
    });
    // A hardened runtime that is configured but not in the engine is the usual cause of an
    // isolation shortfall on a host that requires `hardened`: name it.
    const wantedRuntime = (provider as { hardenedRuntime?: string }).hardenedRuntime;
    const runtimeNote =
      wantedRuntime !== undefined &&
      !isolationAtLeast(caps.isolation, 'hardened') &&
      ev.reasons.some((r) => r.startsWith('isolation '))
        ? `The hardened runtime "${wantedRuntime}" configured for host '${hostId}' is not available in its engine, so the isolation stays "${caps.isolation}" ("abox host test" / "abox doctor" show what the engine offers).`
        : undefined;
    const denyHint = [ev.hint, runtimeNote].filter(Boolean).join(' ');
    throw new AboxError('policy_denied', ev.reasons.join('; '), {
      ...(denyHint ? { hint: denyHint } : {}),
      details: { reasons: ev.reasons },
    });
  }

  let approvalId: string | undefined;
  let approvalToConsume: Parameters<typeof consumeApproval>[1] | undefined;
  if (ev.decision === 'approval') {
    if (ctx.kind === 'human') {
      I.audit(owner, 'sandbox.create', {
        decision: 'info',
        details: { ...auditBase, note: 'confirmation required', reasons: ev.reasons },
      });
      return confirmationRequired(ev.reasons, ev.risks, ev.items);
    }
    const digest = ev.requestDigest as { template: Record<string, unknown> } & Record<
      string,
      unknown
    >;
    const { trusted: _t, ...tpl } = digest.template;
    const request = {
      ...digest,
      template: tpl,
      policy: I.policy.contentHash,
      extra: {
        name: req.name ?? null,
        workspace: {
          ref: wsRequested?.ref ?? null,
          access: wsAccess,
          exclude: wsRequested?.exclude ?? [],
        },
        backend: template.backend,
      },
    };
    const g = await gate(I, {
      ctx,
      kind: ev.kinds.includes('template_trust') ? 'template_trust' : 'create',
      request,
      reasons: ev.reasons,
      risks: ev.risks,
      items: ev.items,
      waitMs,
      signal: opts.signal,
      action: 'sandbox.create',
    });
    if (g.outcome === 'pending') return g.pending;
    approvalToConsume = g.approval;
    approvalId = g.approval.id;
  }

  // 6. claim the registry row (idempotent, quota re-checked atomically)
  const short = newShortId();
  const id: SandboxId = makeSandboxId(hostId, short);
  const now = I.now();
  const name = req.name ?? `${template.name}-${short}`;
  const preEffective: StoredEffective = {
    network: { mode: netMode, allow, privateExceptions },
    mounts,
    resources: { cpus, memoryBytes, ttlMs, pids: template.resources.pids },
    keyringRefs: template.secrets.map((s) => ({
      ref: s.ref,
      inject: s.inject,
      hosts: s.hosts,
      ...(s.path ? { path: s.path } : {}),
    })),
    requestHash,
    effectiveRequestHash,
    creator: I.creatorStamp(),
  };
  // The claim is the one place where every quota is decided for good: the check runs in the same
  // write transaction as the insert, so parallel creates (also from other processes) cannot all pass
  // a check that only one of them satisfies. What the policy evaluation above saw is advisory.
  let claim: ReturnType<SandboxRegistry['claim']>;
  try {
    claim = I.state.sandboxes.claim(
      {
        id,
        host: hostId,
        name,
        owner,
        template: template.name,
        templateHash: template.hash,
        backend: template.backend,
        isolation: caps.isolation,
        state: 'preparing',
        createdAt: now,
        expiresAt: now + ttlMs,
        requestId: req.requestId ?? null,
        effective: preEffective as unknown as Record<string, unknown>,
        // A mount-mode workspace is held from here on, before it is prepared (see `workspaceInUse`).
        ...(wsMode === 'mount' && wsHostPath
          ? { workspace: { mode: 'mount', claim: wsHostPath } }
          : {}),
      },
      (registry) => {
        const active = registry
          .list({ owner, state: ['preparing', 'created', 'running', 'stopped'] })
          .filter((r) => !r.stale && !I.isInterrupted(r)).length;
        if (active >= ctx.profile.limits.sandboxes) {
          throw new AboxError(
            'policy_denied',
            `${owner} already has ${active} sandbox(es); profile "${ctx.profile.name}" allows at most ${ctx.profile.limits.sandboxes} (limits.sandboxes)`,
            {
              hint: 'Delete a sandbox you no longer need (or wait until it expires), then retry.',
              details: { claim: 'owner_quota' },
            },
          );
        }
        const violations = hostQuotaViolations(hostInfo, I.hostUsage(hostId, { registry }), {
          sandbox: true,
          cpus,
          memoryBytes,
        });
        if (violations.length > 0) {
          throw new AboxError('policy_denied', violations.map((v) => v.reason).join('; '), {
            hint: [...new Set(violations.map((v) => v.hint))].join(' '),
            details: { reasons: violations.map((v) => v.reason), claim: 'host_quota' },
          });
        }
        if (wsHostPath) {
          const used = workspaceInUse(I, registry, ctx, wsHostPath);
          if (used) throw workspaceInUseError(wsHostPath, used);
        }
      },
    );
  } catch (e) {
    if (isAboxError(e) && typeof e.details?.['claim'] === 'string') {
      I.audit(owner, 'sandbox.create', {
        decision: 'deny',
        details: {
          ...auditBase,
          reasons: Array.isArray(e.details['reasons']) ? e.details['reasons'] : [e.message],
          code: e.details['claim'],
        },
      });
    }
    throw e;
  }
  if (!claim.created) {
    // lost the race against a concurrent create with the same requestId
    const winner = await waitForPeer(I, owner, req.requestId!, {
      raw: requestHash,
      effective: effectiveRequestHash,
    });
    if (winner) return existingResult(I, winner);
    return createSandbox(I, caller, rawReq, opts);
  }
  if (approvalToConsume) {
    try {
      consumeApproval(I, approvalToConsume);
    } catch (e) {
      I.state.sandboxes.transition(id, ['preparing'], 'failed', { error: errMessage(e) });
      I.state.sandboxes.releaseRequestId(id);
      throw e;
    }
  }

  // 7. build everything; on any failure remove what exists so far
  const sandboxDir = I.sandboxDir(short);
  let providerTouched = false;
  let wsRecord: WorkspaceRecord | undefined;
  try {
    if (opts.signal?.aborted) throw new AboxError('internal', 'create cancelled');

    // image (its own audited step: builds run with network access)
    const pin = I.state.templatePins.get(template.hash);
    const t0 = Date.now();
    const image = await provider.prepare(template, {
      ...(pin?.pinnedBase ? { pinnedBase: pin.pinnedBase } : {}),
      ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (image.pinnedBase && image.pinnedBase !== pin?.pinnedBase) {
      I.state.templatePins.put({
        templateHash: template.hash,
        template: template.name,
        backend: template.backend,
        pinnedBase: image.pinnedBase,
        imageRef: image.ref,
      });
    }
    if (!image.cached) {
      I.audit(owner, 'image.build', {
        sandboxId: id,
        decision: 'allow',
        details: {
          template: template.name,
          templateHash: template.hash,
          backend: template.backend,
          durationMs: Date.now() - t0,
          pinnedBase: image.pinnedBase,
          imageRef: image.ref,
          networkAccess: true,
          note: 'image build runs with network access, independent of the sandbox network policy',
        },
      });
    }

    // workspace
    const prepared = await prepareWorkspace({
      ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(copyScan ? { scan: copyScan } : {}),
      mode: wsMode,
      ...(wsHostPath ? { source: wsHostPath } : {}),
      sandboxDir,
      sandboxPath: template.workspace.path,
      access: wsAccess,
      ...((wsRequested?.ref ?? template.workspace.ref)
        ? { ref: wsRequested?.ref ?? template.workspace.ref }
        : {}),
      remote: caps.remote,
      ...(wsRequested?.exclude ? { exclude: wsRequested.exclude } : {}),
      short,
    });
    wsRecord = prepared.record;
    // Persist the workspace record now so a crash from here on can still be cleaned up (worktree registrations etc.).
    I.state.sandboxes.upsert({
      id,
      host: hostId,
      name,
      owner,
      template: template.name,
      templateHash: template.hash,
      backend: template.backend,
      isolation: caps.isolation,
      state: 'preparing',
      createdAt: now,
      expiresAt: now + ttlMs,
      workspace: prepared.record as unknown as Record<string, unknown>,
    });
    if (opts.signal?.aborted) throw new AboxError('internal', 'create cancelled');

    // secrets (values only live in memory and in the SandboxSpec)
    let injections: NetworkSpec['injections'] = [];
    let envSecrets: Record<string, string> = {};
    let files: SandboxSpec['files'] = [];
    if (template.secrets.length > 0) {
      for (const s of template.secrets) {
        try {
          const v = await I.secretStore.get(s.ref);
          if (v) I.noteSecrets([v]);
        } catch {
          /* reported by the build* calls below */
        }
      }
      injections = await buildProxyInjections(template.secrets, I.secretStore, I.config.secrets);
      envSecrets = await buildEnvSecrets(template.secrets, I.secretStore, I.config.secrets);
      files = await buildFileSecrets(template.secrets, I.secretStore);
      I.noteSecrets([
        ...Object.values(envSecrets),
        ...files.map((f) => f.content.toString('utf8')),
        ...injections.map((i) => i.value),
      ]);
      for (const inj of injections) {
        if (!domainCovered(inj.host, allow)) allow.push(inj.host);
      }
    }
    const network: NetworkSpec = {
      mode: netMode,
      allow: netMode === 'allowlist' ? allow : [],
      blockPrivate: true,
      privateExceptions,
      injections,
    };

    const createdAt = I.now();
    const expiresAt = createdAt + ttlMs;
    const spec: SandboxSpec = {
      id,
      host: hostId,
      name,
      owner,
      template,
      image,
      workspace: prepared.delivery,
      mounts: mounts.map((m) => ({
        hostPath: m.hostPath,
        sandboxPath: m.target,
        access: m.access,
      })),
      resources: { ...template.resources, cpus, memoryBytes, ttlMs },
      network,
      env: { ...template.env, ...envSecrets },
      files,
      user: template.user,
      createdAt,
      expiresAt,
      labels: {
        ...template.labels,
        'abox.managed': 'true',
        'abox.id': id,
        'abox.template': template.name,
        'abox.owner': owner,
        'abox.created': String(createdAt),
        'abox.expires': String(expiresAt),
        // Template label keys starting with "abox." are reserved, so the opt-in is a plain label that the manager maps.
        ...(template.labels['readonly-rootfs'] === 'true'
          ? { 'abox.readonly-rootfs': 'true' }
          : {}),
      },
    };
    providerTouched = true;
    if (prepared.delivery.kind === 'copy') {
      opts.onProgress?.('delivering workspace into the sandbox …', { phase: 'deliver' });
    }
    const created = await provider.create(spec);
    if (opts.signal?.aborted) throw new AboxError('internal', 'create cancelled');
    await provider.start(id);
    const info = await provider.inspect(id).catch(() => created);

    const policyEffective: Record<string, unknown> = {
      ...ev.effective,
      keyringRefs: ev.effective.secrets,
    };
    delete policyEffective['secrets'];
    const effective: StoredEffective = {
      ...preEffective,
      policy: policyEffective,
      provider: info.effective,
      imageRef: image.ref,
      ...(prepared.warnings.length > 0 ? { workspaceWarnings: prepared.warnings } : {}),
    };
    delete effective.creator;
    const rec = I.state.sandboxes.upsert({
      id,
      host: hostId,
      name,
      owner,
      template: template.name,
      templateHash: template.hash,
      backend: template.backend,
      isolation: info.isolation,
      state: 'running',
      createdAt,
      expiresAt,
      workspace: wsRecord as unknown as Record<string, unknown>,
      effective: effective as unknown as Record<string, unknown>,
    });
    I.state.sandboxes.markSeen(id);
    I.audit(owner, 'sandbox.create', {
      sandboxId: id,
      decision: approvalId ? 'approved' : 'allow',
      details: {
        ...auditBase,
        isolation: info.isolation,
        workspace: {
          mode: wsMode,
          hostPath: wsHostPath,
          access: wsAccess,
          ref: wsRequested?.ref ?? template.workspace.ref,
        },
        network: { mode: netMode, allow: network.allow },
        mounts,
        resources: { cpus, memoryBytes, ttlMs },
        keyringRefs: effective.keyringRefs,
        approvalId,
        notes: ev.decision === 'allow' ? ev.notes : [],
        policy: policyEffective,
        effective: info.effective,
        warnings: prepared.warnings,
      },
    });
    I.emit('sandbox.created', { sandboxId: id, owner });
    return {
      status: 'created',
      sandbox: I.toView(rec, { info }),
      idempotent: false,
      warnings: prepared.warnings,
    };
  } catch (e) {
    await cleanupFailedCreate(I, {
      id,
      short,
      owner,
      provider,
      providerTouched,
      wsRecord,
      sandboxDir,
      error: e,
      auditBase,
    });
    throw e;
  }
}

async function existingResult(I: Internals, rec: SandboxRecord): Promise<CreateResult> {
  return { status: 'created', sandbox: await viewFor(I, rec), idempotent: true, warnings: [] };
}

async function cleanupFailedCreate(
  I: Internals,
  c: {
    id: SandboxId;
    short: string;
    owner: string;
    provider: SandboxProvider;
    providerTouched: boolean;
    wsRecord: WorkspaceRecord | undefined;
    sandboxDir: string;
    error: unknown;
    auditBase: Record<string, unknown>;
  },
): Promise<void> {
  const problems: string[] = [];
  if (c.providerTouched) {
    try {
      await c.provider.remove(c.id);
    } catch (e) {
      problems.push(`backend remove: ${errMessage(e)}`);
    }
  }
  if (c.wsRecord) {
    try {
      await cleanupWorkspace(c.wsRecord);
    } catch (e) {
      problems.push(`workspace cleanup: ${errMessage(e)}`);
    }
  }
  try {
    await rm(c.sandboxDir, { recursive: true, force: true });
  } catch (e) {
    problems.push(`sandbox dir: ${errMessage(e)}`);
  }
  const msg = errMessage(c.error).slice(0, 500);
  I.state.sandboxes.transition(c.id, ['preparing', 'created', 'running'], 'failed', { error: msg });
  I.state.sandboxes.releaseRequestId(c.id);
  I.audit(c.owner, 'sandbox.create', {
    sandboxId: c.id,
    decision: 'error',
    details: {
      ...c.auditBase,
      message: msg,
      code: isAboxError(c.error) ? c.error.code : 'internal',
      cleanupProblems: problems,
    },
  });
}

/**
 * A project directory that another live sandbox works on directly (workspace mode `mount`) cannot
 * be used as a workspace again. Callers see the sandbox id only for their own sandboxes (humans:
 * all); for other owners the generic policy denial applies, so agents learn nothing about them.
 *
 * A mount-mode sandbox holds its directory from the moment its registry row is claimed (`claim`
 * in the workspace column) until it is removed or failed; once the workspace is prepared the
 * record's `liveTree` takes over. Called inside the claim transaction, so of several parallel
 * creates for one directory exactly one gets it.
 */
function workspaceInUse(
  I: Internals,
  registry: SandboxRegistry,
  ctx: { kind: 'human' | 'agent'; owner: string },
  path: string,
): { id: SandboxId; visible: boolean } | undefined {
  for (const r of registry.list({ includeRemoved: false })) {
    // (a create whose process died holds nothing: `reconcile --apply` cleans its row up)
    if (r.state === 'failed' || r.state === 'removed' || I.isInterrupted(r)) continue;
    const ws = r.workspace as (Partial<WorkspaceRecord> & { claim?: string }) | null;
    if (ws?.mode !== 'mount') continue;
    const tree = ws.liveTree ?? ws.claim;
    if (!tree) continue;
    if (isWithinFolded(path, tree) || isWithinFolded(tree, path)) {
      if (ctx.kind === 'human' || r.owner === ctx.owner) return { id: r.id, visible: true };
      return { id: r.id, visible: false };
    }
  }
  return undefined;
}

function workspaceInUseError(path: string, used: { id: SandboxId; visible: boolean }): AboxError {
  if (!used.visible) {
    // Lost the race against another owner's create: say nothing about who holds the directory.
    return new AboxError('policy_denied', `workspace ${path} is not available`, {
      hint: 'Choose another path.',
      details: { reasons: [`workspace ${path} is not available`], claim: 'workspace_in_use' },
    });
  }
  const by = `sandbox ${used.id}`;
  return new AboxError(
    'conflict',
    `workspace ${path} is already used by ${by}; remove it or choose another path/mode`,
    {
      hint: `A sandbox in workspace mode "mount" works on the directory itself; "abox rm ${used.id}" frees it.`,
      details: { path, claim: 'workspace_in_use', sandboxId: used.id },
    },
  );
}

// ---------------------------------------------------------------------------
// list / inspect
// ---------------------------------------------------------------------------

export async function listSandboxes(
  I: Internals,
  caller: Caller,
  filter: SandboxFilterInput = {},
): Promise<SandboxList> {
  const ctx = await I.context(caller);
  const states =
    filter.state === undefined
      ? undefined
      : Array.isArray(filter.state)
        ? filter.state
        : [filter.state];
  const recs = I.state.sandboxes.list({
    ...(ctx.kind === 'agent' ? { owner: ctx.owner } : filter.owner ? { owner: filter.owner } : {}),
    ...(filter.host ? { host: filter.host } : {}),
    ...(filter.includeRemoved || states?.includes('removed') ? { includeRemoved: true } : {}),
  });

  // group by host+backend: one provider.list() each
  const groups = new Map<string, { host: string; backend: SandboxRecord['backend'] }>();
  for (const r of recs) groups.set(`${r.host}|${r.backend}`, { host: r.host, backend: r.backend });
  if (ctx.kind === 'human' && !filter.owner) {
    try {
      const local = await I.resolveHost('local');
      for (const b of local.backends)
        if (I.providerFactories[b]) groups.set(`local|${b}`, { host: 'local', backend: b });
    } catch {
      /* no local host */
    }
  }
  // An explicit host filter must name a configured host (unknown -> not_found); a configured host
  // that cannot be resolved, or has no usable backend, is reported instead of an empty list.
  const hostProblems: Record<string, string> = {};
  if (filter.host) {
    try {
      const h = await I.resolveHost(filter.host);
      const usable = h.backends.filter((b) => I.providerFactories[b]);
      if (usable.length === 0) {
        hostProblems[filter.host] = `host '${filter.host}' has no usable backend`;
      } else if (ctx.kind === 'human' && !filter.owner) {
        for (const b of usable)
          groups.set(`${filter.host}|${b}`, { host: filter.host, backend: b });
      }
    } catch (e) {
      if (isAboxError(e) && e.code === 'not_found') {
        throw new AboxError('not_found', `unknown host '${filter.host}'`, {
          hint: 'List the configured hosts with "abox host ls".',
          cause: e,
        });
      }
      hostProblems[filter.host] = errMessage(e);
    }
  }
  const listed = new Map<string, Map<SandboxId, SandboxInfo> | { error: string }>();
  for (const [key, g] of groups) {
    if (hostProblems[g.host] !== undefined) {
      listed.set(key, { error: hostProblems[g.host]! });
      continue;
    }
    try {
      const host = await I.resolveHost(g.host);
      const provider = I.providerFor(host, g.backend);
      const r = await safeProviderList(provider);
      listed.set(key, r.ok ? new Map(r.infos.map((i) => [i.id, i])) : { error: r.error });
    } catch (e) {
      listed.set(key, { error: errMessage(e) });
    }
  }

  const unreachable = new Set<string>(Object.keys(hostProblems));
  if (filter.host && hostProblems[filter.host] === undefined) {
    // all backends of the filtered host failed to list: say so instead of showing an empty list
    const own = [...listed].filter(([k]) => groups.get(k)?.host === filter.host);
    const failed = own.flatMap(([, l]) => ('error' in l ? [l.error] : []));
    if (own.length > 0 && failed.length === own.length) {
      unreachable.add(filter.host);
      hostProblems[filter.host] = failed[0]!;
    }
  }
  const knownIds = new Set(recs.map((r) => r.id));
  const sandboxes: SandboxView[] = [];
  for (const r of recs) {
    const l = listed.get(`${r.host}|${r.backend}`);
    const live = r.state !== 'removed' && r.state !== 'failed' && r.state !== 'preparing';
    if (!live || !l) {
      sandboxes.push(I.toView(r));
    } else if ('error' in l) {
      unreachable.add(r.host);
      hostProblems[r.host] ??= l.error;
      sandboxes.push(I.toView({ ...r, stale: true }, { hostReachable: false }));
    } else {
      const info = l.get(r.id);
      if (info) {
        I.state.sandboxes.markSeen(r.id);
        sandboxes.push(I.toView(syncRecord(I, r, info), { info }));
      } else {
        I.state.sandboxes.markStale(r.id);
        sandboxes.push(I.toView({ ...r, stale: true }, { missing: true }));
      }
    }
  }

  const orphans: OrphanView[] = [];
  if (ctx.kind === 'human' && !filter.owner) {
    for (const [key, l] of listed) {
      if ('error' in l) continue;
      const g = groups.get(key)!;
      for (const info of l.values()) {
        if (!knownIds.has(info.id) && !I.state.sandboxes.get(info.id)) {
          orphans.push({
            id: info.id,
            name: info.name,
            host: info.host,
            backend: g.backend,
            template: info.template,
            owner: info.owner,
            state: info.state,
            createdAt: info.createdAt,
          });
        }
      }
    }
  }

  const out = sandboxes.filter(
    (v) =>
      (!states || states.includes(v.state)) &&
      (!filter.template || v.template === filter.template) &&
      (filter.includeRemoved ||
        states?.includes('removed') ||
        (v.state !== 'removed' && (v.state !== 'failed' || states?.includes('failed')))),
  );
  return {
    sandboxes: out,
    orphans,
    unreachableHosts: [...unreachable],
    ...(Object.keys(hostProblems).length > 0 ? { hostProblems } : {}),
  };
}

export async function inspectSandbox(
  I: Internals,
  caller: Caller,
  id: string,
): Promise<InspectResult> {
  const ctx = await I.context(caller);
  const rec = I.lookup(ctx, id, { allowRemoved: true });
  await collectNetworkEvents(I, rec);
  const view = await viewFor(I, rec);
  const processes: ProcessView[] = I.state.processes.list(rec.id).map((p) => ({
    id: p.id,
    sandboxId: p.sandboxId,
    command: p.command,
    status: p.status,
    exitCode: p.exitCode,
    startedAt: p.startedAt,
    endedAt: p.endedAt,
  }));
  const pendingApprovals = I.state.approvals.list({ status: 'pending', sandboxId: rec.id }).length;
  return { ...view, processes, pendingApprovals };
}

// ---------------------------------------------------------------------------
// start / stop / remove
// ---------------------------------------------------------------------------

export async function startSandbox(I: Internals, caller: Caller, id: string): Promise<SandboxView> {
  const ctx = await I.context(caller);
  const rec = I.lookup(ctx, id);
  requireNotTakenOver(I, ctx, rec, 'sandbox.start');
  if (rec.state === 'failed' || rec.state === 'preparing') {
    throw new AboxError('conflict', `sandbox ${id} is ${rec.state} and cannot be started`);
  }
  if (rec.state === 'expired' || rec.expiresAt <= I.now()) {
    I.audit(ctx.owner, 'sandbox.start', {
      sandboxId: id,
      decision: 'deny',
      details: { reason: 'expired' },
    });
    throw new AboxError('conflict', `sandbox ${id} has expired and cannot be started`, {
      hint: 'Create a new sandbox, or extend the TTL before it expires (extendTtl / access_request kind=ttl).',
    });
  }
  const provider = await I.providerForRecord(rec);
  await provider.start(id);
  I.state.sandboxes.transition(id, ['created', 'running', 'stopped'], 'running');
  I.audit(ctx.owner, 'sandbox.start', { sandboxId: id, decision: 'allow' });
  I.emit('sandbox.state', { sandboxId: id, owner: rec.owner, data: { state: 'running' } });
  return viewFor(I, I.state.sandboxes.get(id)!);
}

export async function stopSandbox(I: Internals, caller: Caller, id: string): Promise<SandboxView> {
  const ctx = await I.context(caller);
  const rec = I.lookup(ctx, id);
  // Stopping would kill the terminal the human is working in.
  requireNotTakenOver(I, ctx, rec, 'sandbox.stop');
  const provider = await I.providerForRecord(rec);
  await collectNetworkEvents(I, rec);
  await provider.stop(id);
  I.state.sandboxes.transition(id, ['created', 'running', 'stopped'], 'stopped');
  for (const p of I.state.processes.list(id))
    if (p.status === 'running') I.state.processes.setStatus(p.id, 'killed');
  I.audit(ctx.owner, 'sandbox.stop', { sandboxId: id, decision: 'allow' });
  I.emit('sandbox.state', { sandboxId: id, owner: rec.owner, data: { state: 'stopped' } });
  return viewFor(I, I.state.sandboxes.get(id)!);
}

/** Remove backend sandbox, host-side workspace artifacts and the sandbox directory. Shared with gc/reconcile. */
export async function destroySandbox(
  I: Internals,
  rec: SandboxRecord,
  actor: string,
  action: string,
  opts: { markRemoved?: boolean } = {},
): Promise<void> {
  const provider = await I.providerForRecord(rec);
  await collectNetworkEvents(I, rec); // the proxy and its log disappear with the sandbox
  try {
    await provider.stop(rec.id);
  } catch {
    /* not running, already gone or unsupported */
  }
  await provider.remove(rec.id);
  I.state.snapshots.deleteAll(rec.id);
  I.state.humanSessions.deleteAll(rec.id);
  const ws = rec.workspace as WorkspaceRecord | null;
  const problems: string[] = [];
  if (ws && ws.version === 1) {
    try {
      await cleanupWorkspace(ws);
    } catch (e) {
      problems.push(`workspace cleanup: ${errMessage(e)}`);
    }
  }
  const short = rec.id.slice(rec.id.indexOf('/') + 1);
  if (/^[0-9a-f]{8}$/.test(short)) {
    await rm(I.sandboxDir(short), { recursive: true, force: true }).catch((e) =>
      problems.push(`dir: ${errMessage(e)}`),
    );
  }
  for (const p of I.state.processes.list(rec.id))
    if (p.status === 'running') I.state.processes.setStatus(p.id, 'killed');
  if (opts.markRemoved !== false) I.state.sandboxes.remove(rec.id);
  I.audit(actor, action, {
    sandboxId: rec.id,
    decision: 'allow',
    details: {
      owner: rec.owner,
      template: rec.template,
      ...(problems.length > 0 ? { cleanupProblems: problems } : {}),
    },
  });
  I.emit('sandbox.removed', { sandboxId: rec.id, owner: rec.owner });
}

export async function removeSandbox(
  I: Internals,
  caller: Caller,
  id: string,
): Promise<{ id: SandboxId; removed: boolean }> {
  const ctx = await I.context(caller);
  const rec = I.lookup(ctx, id, { allowRemoved: true });
  if (rec.state === 'removed') return { id, removed: false };
  requireNotTakenOver(I, ctx, rec, 'sandbox.remove');
  if (rec.state === 'preparing' && !I.isInterrupted(rec)) {
    throw new AboxError('conflict', `sandbox ${id} is still being created`, {
      hint: 'Wait until the create call returns.',
    });
  }
  await destroySandbox(I, rec, ctx.owner, 'sandbox.remove');
  return { id, removed: true };
}

export type { AgentContext };
