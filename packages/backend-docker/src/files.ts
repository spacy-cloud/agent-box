import * as path from 'node:path';
import { PassThrough, type Readable } from 'node:stream';
import { pipeline } from 'node:stream';
import type Docker from 'dockerode';
import { AboxError } from '@abox/core';
import { statusOf } from './errors.js';
import { tarFromEntries, readFirstEntry, type MemEntry } from './tar.js';

/** Validate and normalise an absolute path inside a sandbox. */
export function sandboxPath(p: string, what = 'path'): string {
  if (typeof p !== 'string' || !p.startsWith('/') || p.includes('\0')) {
    throw new AboxError('invalid_input', `Sandbox ${what} must be absolute: ${p}`);
  }
  const norm = path.posix.normalize(p);
  return norm.length > 1 ? norm.replace(/\/+$/, '') : norm;
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
): Promise<{ data: Buffer; truncated: boolean; size: number }> {
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
    return { data: entry.data, truncated: entry.truncated, size: entry.size };
  }
  throw new AboxError('invalid_input', `Too many symlinks while resolving ${file}`);
}
