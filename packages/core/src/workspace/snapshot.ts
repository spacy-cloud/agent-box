import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import type { FileHandle } from 'node:fs/promises';
import { AboxError } from '../errors.js';
import type { ExcludeMatcher } from './glob.js';
import {
  commitTree,
  hashFileBlob,
  initBareRepo,
  writeBufferBlob,
  writeFileBlob,
  writeTree,
  type EntryMode,
  type ObjectFormat,
  type TreeEntry,
} from './objstore.js';
import { runGit } from './git.js';
import { walkTree, type WalkLimits, type WalkResult } from './safefs.js';
import type { ManifestInfo } from './types.js';

export interface SnapshotEntry extends TreeEntry {
  size: number;
  /** Permission bits for regular files. */
  perm?: number;
  sha256?: string;
  /** Raw symlink target (utf8, lossy for exotic bytes). */
  linkTarget?: string;
}

export interface SnapshotResult {
  entries: Map<string, SnapshotEntry>;
  walk: WalkResult;
}

export interface SnapshotOptions {
  exclude?: ExcludeMatcher;
  limits?: WalkLimits;
  gitMode?: 'skip' | 'visit';
  withSha256?: boolean;
  /** Entries already present in the object database: identical files are not written again. */
  known?: ReadonlyMap<string, TreeEntry>;
  /** Called after every file with the bytes read so far. */
  onBytes?: (done: number) => void;
  signal?: AbortSignal;
}

/**
 * Reads a (hostile) tree without ever following links and stores every blob in the
 * host-owned repository `gitDir`. Returns path -> object id/mode.
 */
export async function snapshotTree(
  root: string,
  gitDir: string,
  fmt: ObjectFormat,
  opts: SnapshotOptions = {},
): Promise<SnapshotResult> {
  const entries = new Map<string, SnapshotEntry>();
  let doneBytes = 0;
  const walk = await walkTree(
    root,
    {
      async file(rel, fh, info) {
        throwIfAborted(opts.signal);
        const hashed = await hashFileBlob(fh, info.size, fmt, opts.withSha256);
        const mode: EntryMode = info.executable ? '100755' : '100644';
        const known = opts.known?.get(rel);
        const oid =
          known && known.oid === hashed.oid
            ? hashed.oid
            : await writeFileBlob(gitDir, fmt, fh, info.size, hashed.oid);
        entries.set(rel, {
          mode,
          oid,
          size: info.size,
          perm: info.mode,
          ...(hashed.sha256 ? { sha256: hashed.sha256 } : {}),
        });
        doneBytes += info.size;
        opts.onBytes?.(doneBytes);
      },
      async symlink(rel, target) {
        const oid = await writeBufferBlob(gitDir, fmt, target);
        entries.set(rel, {
          mode: '120000',
          oid,
          size: target.length,
          linkTarget: target.toString('utf8'),
          ...(opts.withSha256 ? { sha256: createHash('sha256').update(target).digest('hex') } : {}),
        });
      },
    },
    {
      ...(opts.exclude ? { exclude: opts.exclude } : {}),
      ...(opts.limits ? { limits: opts.limits } : {}),
      gitMode: opts.gitMode ?? 'skip',
    },
  );
  return { entries, walk };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AboxError('internal', 'create cancelled');
}

/** True when a symlink at `rel` with `target` points outside the tree (absolute or escaping with `..`). */
export function symlinkEscapes(rel: string, target: string): boolean {
  if (target.startsWith('/') || target.includes('\0')) return true;
  const joined = posix.normalize(posix.join(posix.dirname(rel), target));
  return joined === '..' || joined.startsWith('../');
}

// ---------------------------------------------------------------------------
// Baselines
// ---------------------------------------------------------------------------

export interface CreatedBaseline {
  commit: string;
  tree: string;
  snapshot: SnapshotResult;
}

/**
 * Creates a bare repository at `baselineGitDir` whose single root commit contains the
 * current contents of `treeRoot` (without any `.git` entries). The tree must be quiescent
 * (host-owned staging copy or a source directory the user owns).
 */
export async function createBaselineFromTree(
  treeRoot: string,
  baselineGitDir: string,
  scratchDir: string,
  opts: SnapshotOptions & { message?: string; fmt?: ObjectFormat } = {},
): Promise<CreatedBaseline> {
  const fmt = opts.fmt ?? 'sha1';
  await initBareRepo(baselineGitDir, fmt);
  const snapshot = await snapshotTree(treeRoot, baselineGitDir, fmt, opts);
  const tree = await writeTree(baselineGitDir, snapshot.entries, scratchDir);
  const commit = await commitTree(baselineGitDir, tree, [], opts.message ?? 'abox baseline');
  await runGit(['update-ref', 'refs/abox/base', commit], { gitDir: baselineGitDir });
  return { commit, tree, snapshot };
}

/** Writes the JSON manifest (path -> sha256, mode, link target) next to the baseline. */
export async function writeManifest(path: string, snapshot: SnapshotResult): Promise<ManifestInfo> {
  const out: Record<string, unknown> = {};
  let files = 0;
  let symlinks = 0;
  let bytes = 0;
  for (const [p, e] of [...snapshot.entries].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (e.mode === '120000') {
      symlinks++;
      out[p] = { type: 'symlink', target: e.linkTarget, sha256: e.sha256 };
    } else {
      files++;
      bytes += e.size;
      out[p] = {
        type: 'file',
        sha256: e.sha256,
        mode: (e.perm ?? 0o644).toString(8),
        size: e.size,
      };
    }
  }
  const text = `${JSON.stringify({ version: 1, algorithm: 'sha256', entries: out }, null, 1)}\n`;
  await writeFile(path, text, { mode: 0o600 });
  return { path, sha256: createHash('sha256').update(text).digest('hex'), files, symlinks, bytes };
}

/** Verifies a manifest file against its recorded digest. */
export async function verifyManifest(info: ManifestInfo): Promise<boolean> {
  try {
    const text = await readFile(info.path);
    return createHash('sha256').update(text).digest('hex') === info.sha256;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Copying (workspace staging)
// ---------------------------------------------------------------------------

export interface CopyTreeResult {
  walk: WalkResult;
  escapingSymlinks: string[];
}

/**
 * Copies `src` to the new directory `dest` without following symlinks: links stay links
 * (even when they point outside), sockets/devices/FIFOs are skipped, file modes are kept.
 */
export async function copyTreeSafely(
  src: string,
  dest: string,
  opts: {
    exclude?: ExcludeMatcher;
    limits?: WalkLimits;
    gitMode?: 'skip' | 'visit';
    /** Called as bytes are copied, with the total so far. */
    onBytes?: (done: number) => void;
    signal?: AbortSignal;
  } = {},
): Promise<CopyTreeResult> {
  const { onBytes, signal, ...walkOpts } = opts;
  let doneBytes = 0;
  await mkdir(dest, { recursive: true, mode: 0o700 });
  const escaping: string[] = [];
  const dirModes: Array<[string, number]> = [];
  const target = (rel: string): string => {
    const t = join(dest, ...rel.split('/'));
    if (!t.startsWith(dest + '/'))
      throw new AboxError('internal', 'path escapes the copy destination');
    return t;
  };
  const walk = await walkTree(
    src,
    {
      async directory(rel, mode) {
        const t = target(rel);
        await mkdir(t, { mode: 0o700 });
        dirModes.push([t, mode]);
      },
      async file(rel, fh: FileHandle, info) {
        throwIfAborted(signal);
        const t = target(rel);
        await mkdir(dirname(t), { recursive: true });
        const ws = createWriteStream(t, { flags: 'wx', mode: info.mode & 0o777 });
        if (info.size > 0) {
          await pipeline(
            Readable.from(
              readChunks(fh, info.size, signal, (n) => {
                doneBytes += n;
                onBytes?.(doneBytes);
              }),
            ),
            ws,
          );
        } else {
          ws.end();
          await new Promise<void>((res, rej) => ws.on('close', res).on('error', rej));
        }
        // umask may have stripped bits; restore the source permission bits (no setuid/setgid/sticky)
        await chmod(t, info.mode & 0o777);
      },
      async symlink(rel, linkTarget) {
        const t = target(rel);
        await mkdir(dirname(t), { recursive: true });
        await symlink(linkTarget.toString('utf8'), t);
        if (symlinkEscapes(rel, linkTarget.toString('utf8'))) escaping.push(rel);
      },
    },
    { ...walkOpts, gitMode: walkOpts.gitMode ?? 'visit' },
  );
  // restore directory modes bottom-up (children first), keeping owner rwx so abox can clean up
  for (const [p, mode] of dirModes.reverse()) await chmod(p, (mode & 0o777) | 0o700);
  return { walk, escapingSymlinks: escaping };
}

async function* readChunks(
  fh: FileHandle,
  size: number,
  signal?: AbortSignal,
  onChunk?: (bytes: number) => void,
): AsyncGenerator<Buffer> {
  let pos = 0;
  while (pos < size) {
    throwIfAborted(signal);
    const want = Math.min(1024 * 1024, size - pos);
    const buf = Buffer.allocUnsafe(want);
    const { bytesRead } = await fh.read(buf, 0, want, pos);
    if (bytesRead === 0) break;
    pos += bytesRead;
    onChunk?.(bytesRead);
    yield bytesRead === want ? buf : buf.subarray(0, bytesRead);
  }
}
