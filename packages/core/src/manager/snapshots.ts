import { AboxError } from '../errors.js';
import type { SandboxProvider } from '../provider.js';
import type { SandboxRecord } from '../state/sandbox-registry.js';
import { BACKEND_KINDS, parseSandboxId } from '../types.js';
import type {
  BackendKind,
  ProviderCapabilities,
  ProviderSnapshot,
  ResolvedTemplate,
  SandboxId,
} from '../types.js';
import { backendGroups } from './backends.js';
import type { Internals, StoredEffective } from './internals.js';
import type {
  Caller,
  DeleteSnapshotsResult,
  GcSnapshotEntry,
  SnapshotEntry,
  SnapshotOverview,
  SnapshotRef,
  SnapshotSource,
  SnapshotView,
} from './types.js';
import { SANDBOX_ID_RE, errMessage } from './util.js';

/** How many snapshots one `deleteSnapshots` call may name. */
const MAX_DELETE = 500;

// ---------------------------------------------------------------------------
// what a snapshot may be used for
// ---------------------------------------------------------------------------

/**
 * Does the snapshot hold secrets that were placed inside its sandbox (`inject: env` / `file`)?
 * The backend records that on the snapshot; for a snapshot of a sandbox from before that was
 * recorded the registry knows what the sandbox was created with. Anything not known counts as yes.
 */
function holdsSecrets(snap: ProviderSnapshot, rec: SandboxRecord | undefined): boolean {
  if (snap.carriesSecrets !== undefined) return snap.carriesSecrets;
  const refs = (rec?.effective as Partial<StoredEffective> | null | undefined)?.keyringRefs;
  if (!rec || !Array.isArray(refs)) return true;
  return refs.some((r) => r.inject !== 'proxy');
}

function cloneAbility(
  caps: ProviderCapabilities,
  provider: SandboxProvider,
  snap: ProviderSnapshot,
  rec: SandboxRecord | undefined,
): Pick<SnapshotView, 'cloneable' | 'cloneBlocked'> {
  if (!caps.snapshotClone || !provider.listSnapshots) {
    return { cloneable: false, cloneBlocked: 'backend' };
  }
  if (holdsSecrets(snap, rec)) return { cloneable: false, cloneBlocked: 'secrets' };
  return { cloneable: true };
}

function viewOf(
  provider: SandboxProvider,
  caps: ProviderCapabilities,
  snap: ProviderSnapshot,
  rec: SandboxRecord | undefined,
): SnapshotView {
  return {
    id: snap.snapshotId,
    name: snap.name,
    createdAt: snap.createdAt,
    ...(snap.sizeBytes !== undefined ? { sizeBytes: snap.sizeBytes } : {}),
    deletable: provider.deleteSnapshot !== undefined,
    ...cloneAbility(caps, provider, snap, rec),
  };
}

/** Snapshots the manager recorded, for a backend that cannot list its own: no sizes, no deleting, no clone. */
function indexedView(s: { snapshotId: string; name: string; createdAt: number }): SnapshotView {
  return {
    id: s.snapshotId,
    name: s.name,
    createdAt: s.createdAt,
    deletable: false,
    cloneable: false,
    cloneBlocked: 'backend',
  };
}

const sandboxAlive = (rec: SandboxRecord | undefined): rec is SandboxRecord =>
  rec !== undefined && rec.state !== 'removed';

// ---------------------------------------------------------------------------
// listing
// ---------------------------------------------------------------------------

/** Snapshots of one sandbox, oldest first. Owner (or human). */
export async function listSnapshots(
  I: Internals,
  caller: Caller,
  id: string,
): Promise<SnapshotView[]> {
  const ctx = await I.context(caller);
  const rec = I.lookup(ctx, id);
  let provider: SandboxProvider | undefined;
  try {
    provider = await I.providerForRecord(rec);
  } catch {
    provider = undefined; // host not reachable: what the manager recorded is still worth showing
  }
  if (provider?.listSnapshots) {
    try {
      const caps = provider.capabilities();
      return (await provider.listSnapshots({ sandboxId: rec.id })).map((s) =>
        viewOf(provider, caps, s, rec),
      );
    } catch {
      /* the engine cannot be asked right now: fall back to the record */
    }
  }
  return I.state.snapshots.list(rec.id).map(indexedView);
}

/** Every snapshot of every backend, including those of sandboxes that are gone. Human only. */
export async function listAllSnapshots(I: Internals, caller: Caller): Promise<SnapshotOverview> {
  const ctx = await I.context(caller);
  I.requireHuman(ctx, 'snapshot.list');
  return collectSnapshots(I);
}

async function collectSnapshots(I: Internals): Promise<SnapshotOverview> {
  const out: SnapshotOverview = { snapshots: [], totalBytes: 0, unreachable: [] };
  const recs = I.state.sandboxes.list({ includeRemoved: true });
  const byId = new Map(recs.map((r) => [r.id, r]));
  const seen = new Set<string>();
  const push = (e: SnapshotEntry): void => {
    // One engine can be reached through several backends: list a snapshot once.
    const key = `${e.host}|${e.sandboxId}|${e.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.snapshots.push(e);
    out.totalBytes += e.sizeBytes ?? 0;
  };
  const live = recs.filter(sandboxAlive);
  for (const g of await backendGroups(I, live)) {
    let provider: SandboxProvider;
    try {
      provider = I.providerFor(await I.resolveHost(g.host), g.backend);
    } catch (e) {
      out.unreachable.push({ host: g.host, backend: g.backend, error: errMessage(e) });
      continue;
    }
    const caps = provider.capabilities();
    // A sandbox the registry has forgotten but the backend still has (a lost state database) is not
    // gone: its snapshots are not leftovers. Asked only where there are snapshots to judge.
    let inBackend = new Set<string>();
    if (provider.listSnapshots) {
      try {
        inBackend = new Set((await provider.list()).map((i) => i.id));
      } catch (e) {
        out.unreachable.push({ host: g.host, backend: g.backend, error: errMessage(e) });
        continue;
      }
    }
    const entry = (view: SnapshotView, sandboxId: SandboxId): SnapshotEntry => {
      const rec = byId.get(sandboxId);
      const alive = sandboxAlive(rec) || inBackend.has(sandboxId);
      return {
        ...view,
        host: g.host,
        backend: g.backend,
        sandboxId,
        ...(sandboxAlive(rec) ? { sandboxName: rec.name } : {}),
        ...(rec?.template ? { template: rec.template } : {}),
        orphaned: !alive,
      };
    };
    if (provider.listSnapshots) {
      let found: ProviderSnapshot[];
      try {
        found = await provider.listSnapshots();
      } catch (e) {
        out.unreachable.push({ host: g.host, backend: g.backend, error: errMessage(e) });
        continue;
      }
      for (const s of found) {
        // Only this host's sandboxes: a remote engine's ids carry its host.
        if (parseSandboxId(s.sandboxId).host !== g.host) continue;
        const view = viewOf(provider, caps, s, byId.get(s.sandboxId));
        const e = entry(view, s.sandboxId);
        if (s.template && !e.template) e.template = s.template;
        push(e);
      }
    } else {
      for (const rec of live.filter((r) => r.host === g.host && r.backend === g.backend)) {
        for (const s of I.state.snapshots.list(rec.id)) push(entry(indexedView(s), rec.id));
      }
    }
  }
  out.snapshots.sort(
    (a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return out;
}

// ---------------------------------------------------------------------------
// deleting
// ---------------------------------------------------------------------------

function parseRef(raw: unknown): SnapshotRef {
  const r = raw as Partial<SnapshotRef> | null;
  if (
    !r ||
    typeof r !== 'object' ||
    typeof r.sandboxId !== 'string' ||
    !SANDBOX_ID_RE.test(r.sandboxId) ||
    typeof r.snapshotId !== 'string' ||
    r.snapshotId.length === 0 ||
    r.snapshotId.length > 200 ||
    typeof r.backend !== 'string' ||
    !(BACKEND_KINDS as readonly string[]).includes(r.backend)
  ) {
    throw new AboxError(
      'invalid_input',
      'a snapshot is named by backend, sandboxId and snapshotId',
    );
  }
  return { backend: r.backend as BackendKind, sandboxId: r.sandboxId, snapshotId: r.snapshotId };
}

async function deleteOne(
  I: Internals,
  actor: string,
  ref: SnapshotRef,
  action: string,
): Promise<void> {
  const host = parseSandboxId(ref.sandboxId).host;
  const provider = I.providerFor(await I.resolveHost(host), ref.backend);
  if (!provider.deleteSnapshot) {
    throw new AboxError('unsupported', `backend '${ref.backend}' cannot delete snapshots`, {
      hint: 'Remove the sandbox to remove its snapshots.',
    });
  }
  // What the audit entry shows: the backend's view first, the record as a fallback.
  const known = provider.listSnapshots
    ? (await provider.listSnapshots({ sandboxId: ref.sandboxId }).catch(() => [])).find(
        (s) => s.snapshotId === ref.snapshotId,
      )
    : undefined;
  const recorded = I.state.snapshots.get(ref.sandboxId, ref.snapshotId);
  await provider.deleteSnapshot(ref.sandboxId, ref.snapshotId);
  I.state.snapshots.delete(ref.sandboxId, ref.snapshotId);
  const rec = I.state.sandboxes.get(ref.sandboxId);
  I.audit(actor, action, {
    ...(sandboxAlive(rec) ? { sandboxId: ref.sandboxId } : {}),
    decision: 'allow',
    details: {
      sandboxId: ref.sandboxId,
      snapshotId: ref.snapshotId,
      name: known?.name ?? recorded?.name ?? null,
      backend: ref.backend,
      sizeBytes: known?.sizeBytes ?? null,
      sandboxGone: !sandboxAlive(rec),
    },
  });
}

/**
 * Deletes snapshots (the sandboxes they were taken of are not touched, nor are other snapshots).
 * Human only. One that cannot be deleted does not stop the others; its error is returned.
 */
export async function deleteSnapshots(
  I: Internals,
  caller: Caller,
  refs: unknown,
): Promise<DeleteSnapshotsResult> {
  const ctx = await I.context(caller);
  I.requireHuman(ctx, 'snapshot.delete');
  if (!Array.isArray(refs) || refs.length === 0 || refs.length > MAX_DELETE) {
    throw new AboxError('invalid_input', `name 1 to ${MAX_DELETE} snapshots`);
  }
  const parsed = refs.map(parseRef);
  const result: DeleteSnapshotsResult = { removed: [], errors: [] };
  for (const ref of parsed) {
    try {
      await deleteOne(I, ctx.owner, ref, 'snapshot.delete');
      result.removed.push(ref);
    } catch (e) {
      const code = e instanceof AboxError ? e.code : undefined;
      result.errors.push({ ref, message: errMessage(e), ...(code ? { code } : {}) });
      I.audit(ctx.owner, 'snapshot.delete', {
        decision: 'error',
        details: { ...ref, message: errMessage(e) },
      });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// gc
// ---------------------------------------------------------------------------

/**
 * Snapshots whose sandbox no longer exists, i.e. what removing the sandbox could not take with it
 * (an engine that was down, an image that was in use). Nothing else refers to them, so `abox gc`
 * removes them; with `dryRun` they are only listed.
 */
export async function gcSnapshots(
  I: Internals,
  actor: string,
  dryRun: boolean,
): Promise<{ found: GcSnapshotEntry[]; errors: string[] }> {
  const overview = await collectSnapshots(I);
  const found: GcSnapshotEntry[] = [];
  const errors: string[] = overview.unreachable.map(
    (u) => `snapshots of ${u.backend} on ${u.host}: ${u.error}`,
  );
  for (const e of overview.snapshots) {
    if (!e.orphaned || !e.deletable) continue;
    const ref: SnapshotRef = { backend: e.backend, sandboxId: e.sandboxId, snapshotId: e.id };
    try {
      if (!dryRun) await deleteOne(I, actor, ref, 'snapshot.gc');
      found.push({
        host: e.host,
        backend: e.backend,
        sandboxId: e.sandboxId,
        snapshotId: e.id,
        name: e.name,
        ...(e.sizeBytes !== undefined ? { sizeBytes: e.sizeBytes } : {}),
      });
    } catch (err) {
      errors.push(`snapshot ${e.id}: ${errMessage(err)}`);
    }
  }
  return { found, errors };
}

// ---------------------------------------------------------------------------
// clone
// ---------------------------------------------------------------------------

/**
 * Checks that `source` may be the starting point of a new sandbox made from `template` and
 * returns the id the backend takes (`SandboxSpec.fromSnapshot`). Everything about the new sandbox
 * (policy, limits, network, secrets, TTL) is decided by the normal create path; this only decides
 * whether the snapshot is a suitable filesystem for it:
 * - the backend can create from a snapshot at all and knows this one,
 * - it was taken with the same template (user, workspace path and layout fit),
 * - it holds no secrets (they would reach a sandbox the policy never gave them to).
 */
export async function resolveCloneSource(
  I: Internals,
  provider: SandboxProvider,
  template: ResolvedTemplate,
  source: SnapshotSource,
): Promise<string> {
  const caps = provider.capabilities();
  if (!caps.snapshotClone || !provider.listSnapshots) {
    throw new AboxError(
      'unsupported',
      `backend '${template.backend}' cannot create a sandbox from a snapshot`,
      { hint: 'Only the Docker and Podman backends can.' },
    );
  }
  const snaps = await provider.listSnapshots({ sandboxId: source.sandboxId });
  const snap = snaps.find((s) => s.snapshotId === source.snapshotId);
  if (!snap) {
    throw new AboxError(
      'not_found',
      `snapshot ${source.snapshotId} of ${source.sandboxId} not found`,
      {
        hint: 'List the snapshots with `abox snapshot ls --all`.',
      },
    );
  }
  if (snap.template !== undefined && snap.template !== template.name) {
    throw new AboxError(
      'invalid_input',
      `the snapshot was taken of a sandbox from template '${snap.template}', not '${template.name}'`,
      { hint: `Create the sandbox with the template '${snap.template}'.` },
    );
  }
  if (holdsSecrets(snap, I.state.sandboxes.get(source.sandboxId))) {
    throw new AboxError(
      'policy_denied',
      'the snapshot may hold secrets of the sandbox it was taken of, so no new sandbox is created from it',
      {
        hint: 'Secrets reach a sandbox only through its own template and the policy. Take the snapshot of a sandbox without env/file secrets, or restore it into its own sandbox.',
      },
    );
  }
  return snap.snapshotId;
}

export function validateSnapshotSource(raw: unknown): SnapshotSource {
  const r = raw as Partial<SnapshotSource> | null;
  if (
    !r ||
    typeof r !== 'object' ||
    typeof r.sandboxId !== 'string' ||
    !SANDBOX_ID_RE.test(r.sandboxId) ||
    typeof r.snapshotId !== 'string' ||
    r.snapshotId.length === 0 ||
    r.snapshotId.length > 200
  ) {
    throw new AboxError('invalid_input', 'name the snapshot by sandboxId and snapshotId');
  }
  return { sandboxId: r.sandboxId, snapshotId: r.snapshotId };
}
