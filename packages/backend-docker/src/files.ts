import * as path from 'node:path';
import { PassThrough, type Readable } from 'node:stream';
import { pipeline } from 'node:stream';
import type Docker from 'dockerode';
import { AboxError } from '@abox/core';
import { statusOf } from './errors.js';
import { INTERNAL_DIRS } from './labels.js';
import { tarFromEntries, readFirstEntry, reownArchive, type MemEntry } from './tar.js';

/** Validate and normalise an absolute path inside a sandbox. */
export function sandboxPath(p: string, what = 'path'): string {
  if (typeof p !== 'string' || !p.startsWith('/') || p.includes('\0')) {
    throw new AboxError('invalid_input', `Sandbox ${what} must be absolute: ${p}`);
  }
  const norm = path.posix.normalize(p);
  return norm.length > 1 ? norm.replace(/\/+$/, '') : norm;
}

/**
 * Does `p` (normalized, absolute) lie in, or contain, a location the backend manages inside the
 * container (see `INTERNAL_DIRS`)? An ancestor counts too: a directory copied onto `/usr/local`
 * would merge into the internal directory.
 */
export function touchesInternalPath(p: string): boolean {
  return (
    p === '/' ||
    INTERNAL_DIRS.some((d) => p === d || p.startsWith(`${d}/`) || d.startsWith(`${p}/`))
  );
}

/**
 * Refuse a write to an abox-internal location. These files (the sandbox deadline, the proxy CA)
 * are written by the backend as root; letting the sandbox file APIs write there would let an agent
 * move its own deadline or replace the CA it is supposed to trust.
 */
export function assertWritablePath(p: string, what = 'path'): void {
  if (touchesInternalPath(p)) {
    throw new AboxError(
      'policy_denied',
      `${what} ${p} is managed by abox and cannot be written through the sandbox file API`,
      { hint: 'Use a path in the workspace or the home directory.' },
    );
  }
}

/** Does a path exist inside the container (works for stopped containers)? */
export async function pathExists(c: Docker.Container, p: string): Promise<boolean> {
  try {
    const res = (await c.infoArchive({ path: p })) as unknown as Readable | undefined;
    res?.resume?.();
    return true;
  } catch (e) {
    if (statusOf(e) === 404) return false;
    throw e;
  }
}

/** PUT an archive stream; a failing source stream aborts the request instead of hanging it. */
export async function putArchiveStream(
  c: Docker.Container,
  source: Readable | Buffer,
  dir: string,
): Promise<void> {
  if (Buffer.isBuffer(source)) {
    await c.putArchive(source, { path: dir });
    return;
  }
  const ac = new AbortController();
  const body = new PassThrough();
  let failure: Error | undefined;
  pipeline(source, body, (err) => {
    if (err) {
      failure = err;
      ac.abort();
    }
  });
  try {
    await c.putArchive(body, { path: dir, abortSignal: ac.signal } as unknown as { path: string });
  } catch (e) {
    throw failure ?? e;
  }
}

/**
 * Give everything below `dir` to `uid:gid` (content and modes unchanged), and `dir` itself when
 * `includeRoot` is set; a missing `dir` is ignored. Works on a created, not yet started container
 * and needs no capability inside it. The engine applies the ownership of a directory entry only
 * to directories it extracts below the target, so the root is re-owned through its parent, which
 * is impossible when `dir` is a volume on a read-only root filesystem (`includeRoot: false`).
 */
export async function reownDir(
  c: Docker.Container,
  dir: string,
  uid: number,
  gid: number,
  includeRoot: boolean,
): Promise<void> {
  const parent = path.posix.dirname(dir);
  let archive: Readable;
  try {
    archive = (await c.getArchive({
      path: includeRoot ? dir : `${dir}/.`,
    })) as unknown as Readable;
  } catch (e) {
    if (statusOf(e) === 404) return;
    throw e;
  }
  await putArchiveStream(c, reownArchive(archive, { uid, gid }), includeRoot ? parent : dir);
}

/** Create `dir` and missing parents (owned by uid:gid) without needing a running container. */
export async function mkdirP(
  c: Docker.Container,
  dir: string,
  uid: number,
  gid: number,
  mode = 0o755,
): Promise<void> {
  const missing: string[] = [];
  let cur = dir;
  while (cur !== '/' && !(await pathExists(c, cur))) {
    missing.unshift(path.posix.basename(cur));
    cur = path.posix.dirname(cur);
  }
  if (missing.length === 0) return;
  const entries: MemEntry[] = [];
  let rel = '';
  for (const seg of missing) {
    rel = rel ? `${rel}/${seg}` : seg;
    entries.push({ name: rel, type: 'directory', uid, gid, mode });
  }
  await c.putArchive(await tarFromEntries(entries), { path: cur });
}

/** Write one file (parents created) with explicit ownership. */
export async function putFile(
  c: Docker.Container,
  file: string,
  data: Buffer,
  opts: { mode: number; uid: number; gid: number; dirUid?: number; dirGid?: number },
): Promise<void> {
  const dir = path.posix.dirname(file);
  await mkdirP(c, dir, opts.dirUid ?? opts.uid, opts.dirGid ?? opts.gid);
  await c.putArchive(
    await tarFromEntries([
      { name: path.posix.basename(file), data, mode: opts.mode, uid: opts.uid, gid: opts.gid },
    ]),
    { path: dir },
  );
}

/** Read a regular file via the archive API, following symlinks inside the container (max 8 hops). */
export async function getFile(
  c: Docker.Container,
  file: string,
  maxBytes: number,
): Promise<{ data: Buffer; truncated: boolean; size: number; uid: number; mode: number }> {
  let cur = file;
  for (let hop = 0; hop < 9; hop++) {
    const stream = (await c.getArchive({ path: cur })) as unknown as Readable;
    const entry = await readFirstEntry(stream, maxBytes);
    if (!entry) throw new AboxError('not_found', `No such file: ${file}`);
    if (entry.type === 'symlink') {
      cur = path.posix.resolve(path.posix.dirname(cur), entry.linkname ?? '');
      continue;
    }
    if (entry.type !== 'file') throw new AboxError('invalid_input', `Not a regular file: ${file}`);
    return {
      data: entry.data,
      truncated: entry.truncated,
      size: entry.size,
      uid: entry.uid,
      mode: entry.mode,
    };
  }
  throw new AboxError('invalid_input', `Too many symlinks while resolving ${file}`);
}
