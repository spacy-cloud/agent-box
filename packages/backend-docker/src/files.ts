import * as path from 'node:path';
import { PassThrough, type Readable } from 'node:stream';
import { pipeline } from 'node:stream';
import type Docker from 'dockerode';
import { AboxError } from '@abox/core';
import { statusOf } from './errors.js';
import { INTERNAL_DIRS } from './labels.js';
import { tarFromEntries, readFirstEntry, reownArchive, type MemEntry } from './tar.js';
import type { SimpleExecResult } from './exec.js';

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

/** Kernel interfaces: not file locations, whatever the sandbox user may be allowed to do there. */
export const UNWRITABLE_TREES: readonly string[] = ['/proc', '/sys', '/dev'];

function underTree(p: string, tree: string): boolean {
  return p === tree || p.startsWith(`${tree}/`);
}

/**
 * Refuse a write to an abox-internal location. These files (the sandbox deadline, the proxy CA)
 * are written by the backend as root; letting the sandbox file APIs write there would let an agent
 * move its own deadline or replace the CA it is supposed to trust.
 */
export function assertWritablePath(p: string, what = 'path'): void {
  const kernel = UNWRITABLE_TREES.find((t) => underTree(p, t));
  if (kernel) {
    throw new AboxError(
      'policy_denied',
      `${what} ${p} is inside ${kernel}, which is a kernel interface and not a place for files`,
      { hint: 'Use a path in the workspace, the home directory or /tmp.' },
    );
  }
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
    let stream: Readable;
    try {
      stream = (await c.getArchive({ path: cur })) as unknown as Readable;
    } catch (e) {
      // A 404 here is the path, not the container (the caller has already loaded that).
      if (statusOf(e) === 404)
        throw new AboxError('not_found', `No such file: ${file}`, { cause: e });
      throw e;
    }
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

// ---------------------------------------------------------------------------
// Acting as the sandbox user
//
// The engine's archive API writes as root: it replaces root-owned files (the proxy CA, the
// deadline) and follows symlinks the sandbox planted. So while the sandbox runs, the file APIs run
// as the sandbox user inside it (an exec), and the kernel decides what that user may touch. A
// stopped sandbox has no processes to ask: there the path is checked statically (nothing can
// change it meanwhile) before the archive API is used.
// ---------------------------------------------------------------------------

/** `case` patterns for a list of trees: the tree itself and everything below. */
function casePatterns(trees: readonly string[]): string {
  return trees.flatMap((t) => [t, `${t}/*`]).join('|');
}

/** Resolved directories (`pwd -P`) the file APIs refuse: kernel interfaces and abox-managed locations. */
const DENIED_RESOLVED = casePatterns([...UNWRITABLE_TREES, ...INTERNAL_DIRS]);

/** Exit codes of the in-sandbox file scripts. */
export const FILE_EXIT = {
  mkdir: 10,
  resolve: 11,
  denied: 12,
  write: 13,
  rename: 14,
  isDir: 15,
  missing: 3,
  notRegular: 4,
  stat: 5,
  notDir: 6,
} as const;

/**
 * `sh -c` script (args: <file> <octal mode>; content on stdin) run as the sandbox user: creates
 * missing parents (755), resolves the directory physically and refuses kernel interfaces and
 * abox-managed locations, writes next to the target and renames over it (an existing symlink at
 * the target is removed first: it is replaced, never followed).
 */
export const WRITE_FILE_SCRIPT = `d=$(dirname -- "$1"); b=$(basename -- "$1")
( umask 022; mkdir -p -- "$d" ) || exit ${FILE_EXIT.mkdir}
r=$(cd -- "$d" && pwd -P) || exit ${FILE_EXIT.resolve}
case "$r" in ${DENIED_RESOLVED}) exit ${FILE_EXIT.denied};; esac
[ -d "$r/$b" ] && [ ! -L "$r/$b" ] && exit ${FILE_EXIT.isDir}
umask 077
t="$r/$b.abox-tmp"
cat > "$t" || { rm -f -- "$t"; exit ${FILE_EXIT.write}; }
chmod "$2" "$t" && { [ ! -L "$r/$b" ] || rm -f -- "$r/$b"; } && mv -f -- "$t" "$r/$b" || { rm -f -- "$t"; exit ${FILE_EXIT.rename}; }`;

/** `sh -c` script (arg: <dir>; tar stream on stdin) run as the sandbox user: same checks, then unpack. */
export const UNPACK_SCRIPT = `( umask 022; mkdir -p -- "$1" ) || exit ${FILE_EXIT.mkdir}
r=$(cd -- "$1" && pwd -P) || exit ${FILE_EXIT.resolve}
case "$r" in ${DENIED_RESOLVED}) exit ${FILE_EXIT.denied};; esac
exec tar -xpof - -C "$r"`;

/** `sh -c` script (args: <file> <max bytes>) run as the sandbox user: size line, then the first bytes. */
export const READ_FILE_SCRIPT = `[ -e "$1" ] || exit ${FILE_EXIT.missing}
[ -f "$1" ] || exit ${FILE_EXIT.notRegular}
stat -L -c %s -- "$1" || exit ${FILE_EXIT.stat}
head -c "$2" -- "$1"`;

/** Maps a failed file script to an error that says what went wrong. */
export function fileScriptError(
  what: string,
  file: string,
  r: Pick<SimpleExecResult, 'exitCode' | 'stderr'>,
): AboxError {
  const stderr = r.stderr.toString('utf8').trim().slice(0, 500);
  switch (r.exitCode) {
    case FILE_EXIT.missing:
      return new AboxError('not_found', `No such file or directory: ${file}`);
    case FILE_EXIT.notRegular:
      return new AboxError('invalid_input', `Not a regular file: ${file}`, {
        hint: 'Only regular files can be read (not directories, devices, sockets or pipes); list a directory with sandbox_list_dir.',
      });
    case FILE_EXIT.isDir:
      return new AboxError('invalid_input', `${file} is a directory`);
    case FILE_EXIT.denied:
      return new AboxError(
        'policy_denied',
        `${what} ${file} resolves into a kernel interface or an abox-managed location of the sandbox`,
        { hint: 'Use a path in the workspace, the home directory or /tmp.' },
      );
    case 127:
      return new AboxError(
        'unsupported',
        `${what} ${file}: a required tool is missing in the sandbox image`,
        {
          hint: 'The file API needs a POSIX shell, tar, stat and head in the image.',
          details: { stderr },
        },
      );
  }
  if (/permission denied|operation not permitted|read-only file system/i.test(stderr)) {
    return new AboxError(
      'policy_denied',
      `${what} ${file}: the sandbox user is not allowed to do that (${stderr.split('\n').pop() ?? 'permission denied'})`,
      {
        hint: 'The file APIs act as the sandbox user and cannot change root-owned or read-only files; use a path in the workspace, the home directory or /tmp.',
      },
    );
  }
  return new AboxError('backend_error', `${what} ${file} failed (exit ${r.exitCode})`, {
    ...(/no space left/i.test(stderr)
      ? { hint: 'The file system is full (/tmp is a small tmpfs).' }
      : {}),
    details: { stderr },
  });
}

interface PathHeader {
  type: 'file' | 'directory' | 'symlink' | 'other';
  uid: number;
  mode: number;
}

/** The archive header of `p` itself (symlinks are not followed), or undefined when it does not exist. */
async function headerOf(c: Docker.Container, p: string): Promise<PathHeader | undefined> {
  let stream: Readable;
  try {
    stream = (await c.getArchive({ path: p })) as unknown as Readable;
  } catch (e) {
    if (statusOf(e) === 404) return undefined;
    throw e;
  }
  try {
    const entry = await readFirstEntry(stream, 0);
    return entry ? { type: entry.type, uid: entry.uid, mode: entry.mode } : undefined;
  } finally {
    stream.destroy();
  }
}

/**
 * Static check for a write into a *stopped* sandbox (see above): the directory chain above
 * `target` is walked without following symlinks (the engine would follow them, out of the tree the
 * caller thinks of), and the deepest existing directory must be writable for the sandbox user,
 * as the kernel would decide while it runs. The final component may exist (it is replaced).
 */
export async function assertStoppedWriteAllowed(
  c: Docker.Container,
  target: string,
  uid: number,
): Promise<void> {
  const comps = path.posix
    .dirname(target)
    .split('/')
    .filter((s) => s !== '');
  let cur = '';
  let deepest: { path: string; header: PathHeader } | undefined;
  for (const comp of comps) {
    cur += `/${comp}`;
    const header = await headerOf(c, cur);
    if (!header) break;
    if (header.type === 'symlink') {
      throw new AboxError(
        'policy_denied',
        `${cur} is a symlink: files are not written through symlinks into a stopped sandbox`,
        { hint: 'Use the real path, or start the sandbox first.' },
      );
    }
    if (header.type !== 'directory') {
      throw new AboxError('invalid_input', `${cur} is not a directory`);
    }
    deepest = { path: cur, header };
  }
  const writable =
    deepest !== undefined &&
    (deepest.header.uid === uid
      ? (deepest.header.mode & 0o200) !== 0
      : (deepest.header.mode & 0o002) !== 0);
  if (!writable) {
    throw new AboxError(
      'policy_denied',
      `${deepest?.path ?? '/'} is not writable for the sandbox user, so the file API cannot create ${target} there`,
      { hint: 'Use a path in the workspace or the home directory.' },
    );
  }
}
