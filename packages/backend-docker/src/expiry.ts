import type Docker from 'dockerode';
import { AboxError } from '@abox/core';
import { statusOf } from './errors.js';
import { getFile, putFile } from './files.js';
import { EXPIRY_FILE, LABEL } from './labels.js';

/**
 * The deadline of a sandbox container. Labels are immutable, so the creation-time `abox.expires`
 * is only the lower bound: `extendExpiry` writes the later deadline into `EXPIRY_FILE` inside the
 * container, where the entrypoint (see `ttlEntrypoint`) and `start` read it.
 *
 * That file is a convenience that lets the container end itself on time, not the authority: a
 * process with root inside the container can write any file there. The deadline the manager
 * enforces is the one in its registry (`Internals.sweepTtl` stops the sandbox from the host).
 */

/** Epoch seconds the deadline is stored with. */
export const toEpochSeconds = (ms: number): number => Math.ceil(ms / 1000);

/** Does the container's entrypoint honour `EXPIRY_FILE` (created by a version that moves deadlines)? */
export function hasMovableExpiry(labels: Record<string, string> | null | undefined): boolean {
  return labels?.[LABEL.expiryFile] === '1';
}

/** Owned by root and writable by nobody else: only the backend (running as root) could have written it. */
export function isTrustedExpiryFile(uid: number, mode: number): boolean {
  return uid === 0 && (mode & 0o022) === 0;
}

/**
 * The deadline stored in the container in epoch seconds, or `undefined` when there is none. A file
 * that is not owned by root or that anyone but root can write is not the backend's and is ignored
 * (the entrypoint applies the same rule).
 */
async function readExpiryFile(c: Docker.Container): Promise<number | undefined> {
  try {
    const { data, uid, mode } = await getFile(c, EXPIRY_FILE, 64);
    if (!isTrustedExpiryFile(uid, mode)) return undefined;
    const text = data.toString('utf8').trim();
    return /^\d{1,15}$/.test(text) ? Number(text) : undefined;
  } catch (e) {
    if (statusOf(e) === 404 || (e instanceof AboxError && e.code === 'not_found')) return undefined;
    throw e;
  }
}

/**
 * The deadline (epoch ms) the sandbox really runs to: `abox.expires`, or the later one stored in
 * the container. Works for stopped containers. A deadline that was moved is reported with the
 * second resolution it is stored in; an unmoved one keeps the exact label value.
 */
export async function effectiveExpiresAt(
  c: Docker.Container,
  labels: Record<string, string> | null | undefined,
): Promise<number> {
  const created = Number(labels?.[LABEL.expires] ?? 0);
  if (!hasMovableExpiry(labels)) return created;
  const stored = await readExpiryFile(c);
  return stored !== undefined && stored > toEpochSeconds(created) ? stored * 1000 : created;
}

/** Store `expiresAtMs` as the container's deadline (root-owned, read-only for everyone else). */
export async function writeExpiryFile(c: Docker.Container, expiresAtMs: number): Promise<void> {
  await putFile(c, EXPIRY_FILE, Buffer.from(`${toEpochSeconds(expiresAtMs)}\n`), {
    mode: 0o644,
    uid: 0,
    gid: 0,
  });
}
