import * as path from 'node:path';
import type Docker from 'dockerode';
import { AboxError } from '@abox/core';
import type { CacheMount, CacheVolume } from '@abox/core';
import { statusOf } from './errors.js';
import { LABEL } from './labels.js';
import { tarFromEntries } from './tar.js';

/**
 * Package cache volumes. One named engine volume per cache key (plus the user id when the sandbox
 * runs as the host user, see `cacheVolumeName`), labelled `abox.managed=1`, `abox.role=cache`,
 * `abox.instance=<id>` and `abox.cache=<key>`. A sandbox mounts the volume read-write at the path the
 * template declared and nowhere else. The labels are what lists and removes them, so volumes of
 * another installation on the same engine are never touched.
 */

const KEY_RE = /^[0-9a-f]{8,64}$/;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Cache labels beyond the common ones. */
export const CACHE_LABEL = {
  name: 'abox.cache-name',
  project: 'abox.cache-project',
  stack: 'abox.cache-stack',
  owner: 'abox.cache-owner',
  uid: 'abox.cache-uid',
} as const;

/**
 * Engine volume name of a cache. Includes the instance id (two installations on one engine never
 * share a volume) and, when the sandbox runs under another uid than the template user (a writable
 * bind mount of the host), that uid: the files of a cache belong to one uid, so the two never mix.
 */
export function cacheVolumeName(instanceId: string | undefined, key: string, uid?: number): string {
  return `abox-cache-${instanceId !== undefined ? `${instanceId}-` : ''}${key}${uid !== undefined ? `-u${uid}` : ''}`;
}

export function assertCacheMount(m: CacheMount): void {
  if (!KEY_RE.test(m.key))
    throw new AboxError('invalid_input', `Invalid cache key "${m.key}" (hexadecimal expected)`);
  if (!NAME_RE.test(m.name)) throw new AboxError('invalid_input', `Invalid cache name "${m.name}"`);
}

/** Labels of a cache volume; `extra` carries the instance id and the labels of the provider. */
export function cacheVolumeLabels(
  m: CacheMount,
  extra: Record<string, string>,
  uid: number | undefined,
  now: number,
): Record<string, string> {
  return {
    ...extra,
    [LABEL.managed]: '1',
    [LABEL.role]: 'cache',
    [LABEL.cache]: m.key,
    [CACHE_LABEL.name]: m.name,
    [CACHE_LABEL.project]: m.project,
    [CACHE_LABEL.stack]: m.stack,
    [CACHE_LABEL.owner]: m.owner,
    ...(uid !== undefined ? { [CACHE_LABEL.uid]: String(uid) } : {}),
    [LABEL.created]: String(now),
  };
}

/**
 * Makes sure the volume exists and is ours: created with the labels when missing, otherwise checked
 * (managed, same instance, same key) so that a foreign volume which happens to carry the name is
 * never mounted. Returns whether it was created now.
 */
export async function ensureCacheVolume(
  docker: Docker,
  name: string,
  labels: Record<string, string>,
  owns: (labels: Record<string, string> | null | undefined) => boolean,
): Promise<{ created: boolean }> {
  const check = async (): Promise<void> => {
    const info = await docker.getVolume(name).inspect();
    const l = info.Labels ?? {};
    if (
      l[LABEL.managed] !== '1' ||
      l[LABEL.role] !== 'cache' ||
      !owns(l) ||
      l[LABEL.cache] !== labels[LABEL.cache]
    ) {
      throw new AboxError(
        'conflict',
        `Volume ${name} exists but is not a package cache of this abox installation`,
        { hint: 'Remove or rename that volume; abox never mounts a volume it did not create.' },
      );
    }
  };
  try {
    await check();
    return { created: false };
  } catch (e) {
    if (e instanceof AboxError || statusOf(e) !== 404) throw e;
  }
  try {
    await docker.createVolume({ Name: name, Driver: 'local', Labels: labels });
  } catch (e) {
    if (statusOf(e) !== 409) throw e; // created concurrently
    await check();
    return { created: false };
  }
  return { created: true };
}

interface EngineVolume {
  Name: string;
  Labels?: Record<string, string> | null;
  CreatedAt?: string;
}

/** Volume sizes of the engine (`/system/df`, volumes only), by name; empty when it cannot tell. */
async function volumeSizes(docker: Docker): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  try {
    const modem = (
      docker as unknown as {
        modem: { dial: (o: object, cb: (e: unknown, d: unknown) => void) => void };
      }
    ).modem;
    const data = await new Promise<{
      Volumes?: Array<{ Name: string; UsageData?: { Size?: number } | null }>;
    }>((resolve, reject) =>
      modem.dial(
        {
          path: '/system/df?',
          method: 'GET',
          statusCodes: { 200: true, 500: 'server error' },
          options: { type: 'volume' },
        },
        (err, d) =>
          err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve(d as never),
      ),
    );
    for (const v of data.Volumes ?? []) {
      const size = v.UsageData?.Size;
      if (typeof size === 'number' && size >= 0) sizes.set(v.Name, size);
    }
  } catch {
    /* size unknown */
  }
  return sizes;
}

/** All cache volumes of this installation; volumes of one key (the uid variants) are summed. */
export async function listCacheVolumes(
  docker: Docker,
  engine: 'docker' | 'podman',
  owns: (labels: Record<string, string> | null | undefined) => boolean,
  o: { size?: boolean } = {},
): Promise<CacheVolume[]> {
  const res = await docker.listVolumes({
    filters: { label: [`${LABEL.managed}=1`, `${LABEL.role}=cache`] },
  });
  const volumes = ((res.Volumes ?? []) as EngineVolume[]).filter(
    (v) => owns(v.Labels) && KEY_RE.test(v.Labels?.[LABEL.cache] ?? ''),
  );
  if (volumes.length === 0) return [];
  const used = new Set<string>();
  for (const c of await docker.listContainers({ all: true })) {
    for (const m of c.Mounts ?? []) if (m.Type === 'volume' && m.Name) used.add(m.Name);
  }
  const sizes = o.size ? await volumeSizes(docker) : new Map<string, number>();
  const byKey = new Map<string, CacheVolume>();
  for (const v of volumes) {
    const l = v.Labels ?? {};
    const key = l[LABEL.cache]!;
    const created = Date.parse(v.CreatedAt ?? '');
    const size = o.size ? (sizes.get(v.Name) ?? null) : null;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, {
        key,
        name: l[CACHE_LABEL.name] ?? '',
        project: l[CACHE_LABEL.project] ?? '',
        stack: l[CACHE_LABEL.stack] ?? '',
        owner: l[CACHE_LABEL.owner] ?? '',
        createdAt: Number.isFinite(created) ? created : 0,
        sizeBytes: size,
        inUse: used.has(v.Name),
        engine,
      });
    } else {
      prev.inUse ||= used.has(v.Name);
      if (Number.isFinite(created) && (prev.createdAt === 0 || created < prev.createdAt))
        prev.createdAt = created;
      prev.sizeBytes = prev.sizeBytes === null || size === null ? null : prev.sizeBytes + size;
    }
  }
  return [...byKey.values()];
}

/** Removes every volume of cache `key` of this installation; refuses while a container uses one. */
export async function removeCacheVolumes(
  docker: Docker,
  key: string,
  owns: (labels: Record<string, string> | null | undefined) => boolean,
): Promise<{ removed: boolean }> {
  if (!KEY_RE.test(key)) throw new AboxError('invalid_input', `Invalid cache key "${key}"`);
  const res = await docker.listVolumes({
    filters: { label: [`${LABEL.managed}=1`, `${LABEL.role}=cache`, `${LABEL.cache}=${key}`] },
  });
  const volumes = ((res.Volumes ?? []) as EngineVolume[]).filter((v) => owns(v.Labels));
  let removed = false;
  for (const v of volumes) {
    try {
      await docker.getVolume(v.Name).remove();
      removed = true;
    } catch (e) {
      const s = statusOf(e);
      if (s === 404) continue;
      if (s === 409)
        throw new AboxError('conflict', `Cache ${key} is in use by a sandbox`, {
          hint: 'Delete the sandbox that uses it first.',
          cause: e,
        });
      throw e;
    }
  }
  return { removed };
}

/**
 * Hands the mount points of the caches to the sandbox user. The engine creates a mount point (and
 * the directories above it that the image lacks) owned by root, and a new volume takes the owner of
 * its mount point, so without this the user could not write to its own cache. The directories
 * between the home directory and a cache are re-owned too (`~/.local/share/pnpm` must be writable
 * for a global install); outside the home only the mount point itself changes. The archive API
 * applies the owner of a directory entry to an existing directory but ignores the root entry of an
 * extraction, so every directory is named relative to its parent. Content is never touched.
 */
export async function ownCachePaths(
  c: Docker.Container,
  paths: string[],
  home: string,
  uid: number,
  gid: number,
): Promise<void> {
  const underHome = new Map<string, true>();
  const outside: string[] = [];
  for (const p of paths) {
    if (p.startsWith(`${home}/`)) {
      const segs = p.slice(home.length + 1).split('/');
      for (let i = 1; i <= segs.length; i++) underHome.set(segs.slice(0, i).join('/'), true);
    } else outside.push(p);
  }
  const dir = (name: string) => ({ name, type: 'directory' as const, uid, gid, mode: 0o755 });
  if (underHome.size > 0)
    await c.putArchive(await tarFromEntries([...underHome.keys()].map(dir)), { path: home });
  for (const p of outside)
    await c.putArchive(await tarFromEntries([dir(path.posix.basename(p))]), {
      path: path.posix.dirname(p),
    });
}
