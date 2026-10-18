import { createHash } from 'node:crypto';
import { AboxError } from '../errors.js';
import type { SandboxProvider } from '../provider.js';
import {
  canonicalizePath,
  DEFAULT_CACHE_MAX_BYTES,
  resolveContext,
  type AgentContext,
} from '../policy/index.js';
import { parseDuration, parseSize } from '../template/schema.js';
import type { PackageCacheRecord } from '../state/package-caches.js';
import type { BackendKind, CacheMount, CacheVolume, ResolvedTemplate } from '../types.js';
import type { Internals } from './internals.js';
import type {
  Caller,
  CacheList,
  CacheRemoveResult,
  CacheSelector,
  CacheView,
  GcCacheEntry,
} from './types.js';
import { errMessage } from './util.js';

/** Backends whose providers can hold cache volumes (the container backends). */
const CACHE_BACKENDS: readonly BackendKind[] = ['docker', 'podman', 'python'];
/** A key prefix must be at least this long to select a cache by it. */
const MIN_PREFIX = 4;
/** Hex digits of a cache key (64 bits). */
export const CACHE_KEY_LENGTH = 16;

/**
 * The identity of a cache. Two sandboxes share a cache exactly when all five parts are equal:
 *
 * - `project`: the canonical (symlink-free) source path of the workspace, so a project never
 *   sees the cache of another project;
 * - `owner`: `human` or `agent:<context>`, so what an agent's sandbox writes into a cache is never
 *   read by the sandboxes of the human or of another agent;
 * - `stack`: the template name (`node-dev`), so tool versions of another template do not mix in;
 * - `name`: the cache name from the template (`pnpm-store`);
 * - `uid`: the user id the files are owned by.
 *
 * The result is the first 64 bits of a SHA-256 over the parts, lowercase hex.
 */
export function deriveCacheKey(id: {
  project: string;
  owner: string;
  stack: string;
  name: string;
  uid: number;
}): string {
  const h = createHash('sha256');
  for (const part of ['abox-cache-v1', id.project, id.owner, id.stack, id.name, String(id.uid)]) {
    h.update(part);
    h.update('\0');
  }
  return h.digest('hex').slice(0, CACHE_KEY_LENGTH);
}

export type CachePlanStatus =
  'none' | 'active' | 'opted_out' | 'disabled_by_policy' | 'no_project' | 'unsupported';

export interface CachePlan {
  status: CachePlanStatus;
  mounts: CacheMount[];
  /** Variables of the caches (`npm_config_store_dir`), set in the sandbox on top of the template's. */
  env: Record<string, string>;
}

/**
 * Decides which of the template's caches a create mounts. No cache when the template declares none,
 * the request opted out, the profile switched them off, there is no project (workspace mode
 * `empty`: nothing identifies what the cache would belong to), or the backend cannot keep them.
 */
export function planCaches(o: {
  ctx: AgentContext;
  template: ResolvedTemplate;
  supported: boolean;
  /** `request.cache === false`. */
  optOut: boolean;
  /** Canonical source path of the workspace; undefined for an empty workspace. */
  project: string | undefined;
}): CachePlan {
  const none = (status: CachePlanStatus): CachePlan => ({ status, mounts: [], env: {} });
  const t = o.template;
  if (t.caches.length === 0) return none('none');
  if (o.optOut) return none('opted_out');
  if (!o.ctx.profile.caches) return none('disabled_by_policy');
  if (o.project === undefined) return none('no_project');
  if (!o.supported || t.isolation === 'none') return none('unsupported');
  const mounts: CacheMount[] = [];
  const env: Record<string, string> = {};
  for (const c of t.caches) {
    mounts.push({
      key: deriveCacheKey({
        project: o.project,
        owner: o.ctx.owner,
        stack: t.name,
        name: c.name,
        uid: t.user.uid,
      }),
      name: c.name,
      path: c.path,
      project: o.project,
      stack: t.name,
      owner: o.ctx.owner,
    });
    Object.assign(env, c.env);
  }
  return { status: 'active', mounts, env };
}

/** `1.5 GiB`, `300 MiB`, `12 KiB`: sizes for messages. */
export function formatSize(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 || v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

// ---------------------------------------------------------------------------
// Looking at the caches of the hosts
// ---------------------------------------------------------------------------

interface Found {
  view: CacheView;
  provider: SandboxProvider;
}

interface Collected {
  found: Found[];
  unreachable: Array<{ host: string; error: string }>;
}

/** Hosts that may hold caches: `local`, every host with a sandbox, every host a cache was recorded for. */
function candidateHosts(I: Internals, only?: string): string[] {
  if (only !== undefined) return [only];
  const hosts = new Set<string>(['local']);
  for (const r of I.state.sandboxes.list({ includeRemoved: true })) hosts.add(r.host);
  for (const h of I.state.packageCaches.hosts()) hosts.add(h);
  return [...hosts];
}

function viewOf(host: string, v: CacheVolume, rec: PackageCacheRecord | undefined): CacheView {
  return {
    host,
    key: v.key,
    name: v.name,
    project: v.project || rec?.project || '',
    stack: v.stack || rec?.stack || '',
    owner: v.owner || rec?.owner || '',
    sizeBytes: v.sizeBytes,
    createdAt: v.createdAt || rec?.createdAt || 0,
    lastUsedAt: rec?.lastUsedAt ?? v.createdAt,
    inUse: v.inUse,
  };
}

/** Asks every container backend of the hosts for its cache volumes; one engine is asked once. */
async function collect(I: Internals, o: { host?: string; size?: boolean }): Promise<Collected> {
  const found: Found[] = [];
  const unreachable: Collected['unreachable'] = [];
  for (const hostId of candidateHosts(I, o.host)) {
    let host;
    try {
      host = await I.resolveHost(hostId);
    } catch (e) {
      unreachable.push({ host: hostId, error: errMessage(e) });
      continue;
    }
    const seen = new Set<string>();
    let asked = 0;
    const errors: string[] = [];
    for (const backend of host.backends) {
      if (!CACHE_BACKENDS.includes(backend) || !I.providerFactories[backend]) continue;
      let provider: SandboxProvider;
      try {
        provider = I.providerFor(host, backend);
      } catch (e) {
        errors.push(errMessage(e));
        continue;
      }
      if (!provider.listCaches) continue;
      try {
        const vols = await provider.listCaches(o.size ? { size: true } : {});
        asked++;
        for (const v of vols) {
          const id = `${v.engine}|${v.key}`;
          if (seen.has(id)) continue;
          seen.add(id);
          found.push({
            view: viewOf(hostId, v, I.state.packageCaches.get(hostId, v.key)),
            provider,
          });
        }
      } catch (e) {
        errors.push(errMessage(e));
      }
    }
    // A host is only unreachable when no backend of it could answer (a missing Podman is no problem).
    if (asked === 0 && errors.length > 0) unreachable.push({ host: hostId, error: errors[0]! });
  }
  found.sort(
    (a, b) =>
      a.view.host.localeCompare(b.view.host) ||
      a.view.project.localeCompare(b.view.project) ||
      a.view.stack.localeCompare(b.view.stack) ||
      a.view.name.localeCompare(b.view.name),
  );
  return { found, unreachable };
}

function totalOf(views: CacheView[]): number {
  return views.reduce((n, v) => n + (v.sizeBytes ?? 0), 0);
}

/** Human only. The caches on all hosts (or one) with size, last use and whether a sandbox holds them. */
export async function listCaches(
  I: Internals,
  caller: Caller,
  o: { host?: string; size?: boolean } = {},
): Promise<CacheList> {
  const ctx = await I.context(caller);
  I.requireHuman(ctx, 'cache.list');
  const { found, unreachable } = await collect(I, {
    ...(o.host ? { host: o.host } : {}),
    size: o.size ?? true,
  });
  const caches = found.map((f) => f.view);
  return { caches, totalBytes: totalOf(caches), unreachable };
}

function canonicalProject(I: Internals, raw: string): string {
  try {
    return canonicalizePath(raw, { home: I.home, cwd: I.projectDir ?? process.cwd() });
  } catch (e) {
    throw new AboxError('invalid_input', `invalid project path "${raw}": ${errMessage(e)}`);
  }
}

function removeOne(I: Internals, actor: string, f: Found, reason: string, extra: object = {}) {
  return f.provider.removeCache!(f.view.key).then((r) => {
    I.state.packageCaches.delete(f.view.host, f.view.key);
    I.audit(actor, 'cache.remove', {
      decision: 'allow',
      details: {
        host: f.view.host,
        key: f.view.key,
        name: f.view.name,
        project: f.view.project,
        stack: f.view.stack,
        owner: f.view.owner,
        sizeBytes: f.view.sizeBytes,
        reason,
        existed: r.removed,
        ...extra,
      },
    });
    return r;
  });
}

/**
 * Human only. Removes caches by key, project or all of them. A cache that a sandbox still
 * references is never removed: named explicitly it is a `conflict`, selected by project or `all`
 * it is reported as skipped. Wiping a cache loses nothing but the download time of the next install.
 */
export async function removeCaches(
  I: Internals,
  caller: Caller,
  sel: CacheSelector,
): Promise<CacheRemoveResult> {
  const ctx = await I.context(caller);
  I.requireHuman(ctx, 'cache.remove');
  const modes = [sel.keys !== undefined, sel.project !== undefined, sel.all === true].filter(
    Boolean,
  ).length;
  if (modes !== 1) {
    throw new AboxError('invalid_input', 'name the caches to remove: keys, a project, or all', {
      hint: 'abox cache rm <key>... | abox cache rm --project <path> | abox cache rm --all',
    });
  }
  const { found, unreachable } = await collect(I, sel.host ? { host: sel.host } : {});
  let chosen: Found[];
  const explicit = sel.keys !== undefined;
  if (sel.keys) {
    chosen = [];
    for (const k of sel.keys) {
      const needle = k.trim().toLowerCase();
      if (needle.length < MIN_PREFIX || !/^[0-9a-f]+$/.test(needle)) {
        throw new AboxError('invalid_input', `"${k}" is not a cache key`, {
          hint: `Keys are hexadecimal; "abox cache ls" lists them. A prefix needs at least ${MIN_PREFIX} characters.`,
        });
      }
      const hits = found.filter((f) => f.view.key.startsWith(needle));
      if (hits.length === 0) {
        throw new AboxError('not_found', `no cache with key ${k}`, {
          hint: '"abox cache ls" lists the caches.',
          ...(unreachable.length > 0
            ? { details: { unreachable: unreachable.map((u) => u.host) } }
            : {}),
        });
      }
      if (new Set(hits.map((h) => `${h.view.host}|${h.view.key}`)).size > 1) {
        throw new AboxError(
          'invalid_input',
          `"${k}" matches more than one cache; use more characters`,
        );
      }
      if (!chosen.includes(hits[0]!)) chosen.push(hits[0]!);
    }
  } else if (sel.project !== undefined) {
    const project = canonicalProject(I, sel.project);
    chosen = found.filter((f) => f.view.project === project);
  } else {
    chosen = found;
  }
  const result: CacheRemoveResult = { removed: [], skipped: [], errors: [] };
  for (const f of chosen) {
    if (f.view.inUse) {
      if (explicit) {
        throw new AboxError(
          'conflict',
          `cache ${f.view.key} (${f.view.name}) is in use by a sandbox`,
          { hint: 'Delete the sandbox that uses it first ("abox ls"), then remove the cache.' },
        );
      }
      result.skipped.push({ cache: f.view, reason: 'in use by a sandbox' });
      continue;
    }
    try {
      await removeOne(I, ctx.owner, f, 'manual');
      result.removed.push(f.view);
    } catch (e) {
      result.errors.push(`${f.view.key}: ${errMessage(e)}`);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Create / use
// ---------------------------------------------------------------------------

/** Keys of the caches that already exist on the engine of `provider` (best effort). */
export async function existingCacheKeys(provider: SandboxProvider): Promise<Set<string>> {
  try {
    return new Set((await provider.listCaches?.())?.map((v) => v.key) ?? []);
  } catch {
    return new Set();
  }
}

/** After a sandbox was created with caches: remember the use and audit it (`cache.create`, `cache.use`). */
export function recordCacheUse(
  I: Internals,
  o: {
    actor: string;
    host: string;
    sandboxId: string;
    mounts: CacheMount[];
    existing: Set<string>;
  },
): void {
  for (const m of o.mounts) {
    I.state.packageCaches.touch({
      host: o.host,
      key: m.key,
      project: m.project,
      stack: m.stack,
      name: m.name,
      owner: m.owner,
      sandbox: o.sandboxId,
    });
    const details = {
      host: o.host,
      key: m.key,
      name: m.name,
      project: m.project,
      stack: m.stack,
      owner: m.owner,
      path: m.path,
    };
    if (!o.existing.has(m.key))
      I.audit(o.actor, 'cache.create', { sandboxId: o.sandboxId, decision: 'allow', details });
    I.audit(o.actor, 'cache.use', { sandboxId: o.sandboxId, decision: 'allow', details });
  }
}

// ---------------------------------------------------------------------------
// gc and doctor
// ---------------------------------------------------------------------------

/** The size cap that applies to the caches of `owner`: the `cache_max_bytes` of its profile. */
function capFor(I: Internals, owner: string): number {
  try {
    // Not `I.context`: an agent context that no longer exists is no reason to write an audit entry.
    const id = owner === 'human' ? 'human' : owner.slice('agent:'.length);
    return resolveContext(I.policy, id, { home: I.home }).profile.cacheMaxBytes;
  } catch {
    return parseSize(DEFAULT_CACHE_MAX_BYTES);
  }
}

/**
 * Picks the caches `abox gc` removes: those no sandbox uses that were last used longer than
 * `maxAgeMs` ago, then, per project (and owner and host), the least recently used unused ones until
 * the rest fits into the project's cap. Pure; `caps` gives the cap per owner.
 */
export function selectCachesForGc(
  views: CacheView[],
  o: { now: number; maxAgeMs: number; caps: (owner: string) => number },
): Array<{ cache: CacheView; reason: 'age' | 'cap' }> {
  const out: Array<{ cache: CacheView; reason: 'age' | 'cap' }> = [];
  const gone = new Set<CacheView>();
  for (const c of views) {
    if (c.inUse) continue;
    if (o.now - c.lastUsedAt > o.maxAgeMs) {
      out.push({ cache: c, reason: 'age' });
      gone.add(c);
    }
  }
  const groups = new Map<string, CacheView[]>();
  for (const c of views) {
    if (gone.has(c)) continue;
    const k = `${c.host}\0${c.owner}\0${c.project}`;
    const list = groups.get(k) ?? [];
    list.push(c);
    groups.set(k, list);
  }
  for (const list of groups.values()) {
    const cap = o.caps(list[0]!.owner);
    let total = totalOf(list);
    if (total <= cap) continue;
    const candidates = list.filter((c) => !c.inUse).sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    for (const c of candidates) {
      if (total <= cap) break;
      out.push({ cache: c, reason: 'cap' });
      total -= c.sizeBytes ?? 0;
    }
  }
  return out;
}

/** The cache part of `abox gc`. Never fails the whole gc: problems are returned as `errors`. */
export async function gcCaches(
  I: Internals,
  actor: string,
  dryRun: boolean,
): Promise<{ removed: GcCacheEntry[]; errors: string[] }> {
  const removed: GcCacheEntry[] = [];
  const errors: string[] = [];
  let collected: Collected;
  try {
    collected = await collect(I, { size: true });
  } catch (e) {
    return { removed, errors: [`caches: ${errMessage(e)}`] };
  }
  const owners = new Set(collected.found.map((f) => f.view.owner));
  const capByOwner = new Map<string, number>();
  for (const o of owners) capByOwner.set(o, capFor(I, o));
  let maxAgeMs: number;
  try {
    maxAgeMs = parseDuration(I.config.caches.max_age);
  } catch {
    maxAgeMs = 30 * 86_400_000;
  }
  const picks = selectCachesForGc(
    collected.found.map((f) => f.view),
    { now: I.now(), maxAgeMs, caps: (owner) => capByOwner.get(owner) ?? 0 },
  );
  for (const p of picks) {
    const f = collected.found.find((x) => x.view === p.cache)!;
    const entry: GcCacheEntry = {
      host: f.view.host,
      key: f.view.key,
      name: f.view.name,
      project: f.view.project,
      stack: f.view.stack,
      owner: f.view.owner,
      sizeBytes: f.view.sizeBytes,
      reason: p.reason,
    };
    if (!dryRun) {
      try {
        await removeOne(I, actor, f, `gc-${p.reason}`);
      } catch (e) {
        errors.push(`cache ${f.view.key}: ${errMessage(e)}`);
        continue;
      }
    }
    removed.push(entry);
  }
  return { removed, errors };
}

/** Numbers and findings for `abox doctor`; never throws. */
export async function doctorCaches(I: Internals): Promise<{
  count: number;
  totalBytes: number | null;
  overCap: Array<{ project: string; owner: string; host: string; bytes: number; cap: number }>;
  unreachable: Array<{ host: string; error: string }>;
}> {
  try {
    const { found, unreachable } = await collect(I, { size: true });
    const views = found.map((f) => f.view);
    const known = views.every((v) => v.sizeBytes !== null);
    const overCap: Array<{
      project: string;
      owner: string;
      host: string;
      bytes: number;
      cap: number;
    }> = [];
    const groups = new Map<string, CacheView[]>();
    for (const v of views) {
      const k = `${v.host}\0${v.owner}\0${v.project}`;
      groups.set(k, [...(groups.get(k) ?? []), v]);
    }
    for (const list of groups.values()) {
      const bytes = totalOf(list);
      const cap = capFor(I, list[0]!.owner);
      if (bytes > cap)
        overCap.push({
          project: list[0]!.project,
          owner: list[0]!.owner,
          host: list[0]!.host,
          bytes,
          cap,
        });
    }
    return {
      count: views.length,
      totalBytes: views.length === 0 || known ? totalOf(views) : null,
      overCap,
      unreachable,
    };
  } catch (e) {
    return {
      count: 0,
      totalBytes: null,
      overCap: [],
      unreachable: [{ host: '*', error: errMessage(e) }],
    };
  }
}
