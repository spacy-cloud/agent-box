import { constants as fsc, existsSync } from 'node:fs';
import { open, readdir, readlink, lstat, realpath, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { AboxError } from '../errors.js';
import type { ExcludeMatcher } from './glob.js';

/**
 * Symlink-safe tree walking.
 *
 * Trees written by a sandbox are hostile. The walker therefore
 * - never follows a symlink (links are reported as links, with their raw target),
 * - opens every directory and file with `O_NOFOLLOW` and checks `fstat` against
 *   `lstat` (device + inode) to detect entries swapped during the walk,
 * - on Linux resolves children relative to an already-open directory fd through
 *   `/proc/self/fd/<n>/<name>`, which emulates `openat()` and makes the walk
 *   race-free even while the sandbox keeps writing. Without `/proc` it falls back to
 *   plain paths (narrow race window; documented limitation),
 * - skips sockets, FIFOs and devices,
 * - skips `.git` entries (and spellings git treats as `.git` on other file systems)
 *   unless `gitMode: 'visit'` is requested,
 * - enforces hard limits so a hostile tree cannot exhaust the host.
 */

export interface SkippedEntry {
  path: string;
  reason: string;
}

export interface WalkLimits {
  /** Maximum number of visited entries (files, links, directories). Default 1_000_000. */
  maxEntries?: number;
  /** Files larger than this are skipped (reported). Default 512 MiB. */
  maxFileBytes?: number;
  /** Abort when the sum of visited file sizes exceeds this. Default 16 GiB. */
  maxTotalBytes?: number;
  /** Maximum directory depth. Default 128. */
  maxDepth?: number;
}

export interface FileInfo {
  size: number;
  /** Permission bits (`st_mode & 0o7777`). */
  mode: number;
  executable: boolean;
}

export interface WalkVisitor {
  directory?(rel: string, mode: number): Promise<void> | void;
  /** Receives an already opened, verified regular file. The walker closes the handle afterwards. */
  file(rel: string, fh: FileHandle, info: FileInfo): Promise<void> | void;
  symlink?(rel: string, target: Buffer): Promise<void> | void;
}

export interface WalkOptions {
  exclude?: ExcludeMatcher;
  limits?: WalkLimits;
  /** `skip` (default): ignore `.git`-like entries and report them. `visit`: treat `.git` as ordinary content. */
  gitMode?: 'skip' | 'visit';
  /** Skip symlinks named like git config files that git's fsck rejects as links (`.gitmodules`, …). Default true. */
  skipGitConfigSymlinks?: boolean;
}

export interface WalkResult {
  skipped: SkippedEntry[];
  /** Relative paths of `.git`-like entries that were not visited. */
  gitEntries: string[];
  excluded: number;
  entries: number;
  files: number;
  symlinks: number;
  directories: number;
  bytes: number;
}

const HAVE_PROC_FD = process.platform === 'linux' && existsSync('/proc/self/fd');

const O_DIR_FLAGS = fsc.O_RDONLY | fsc.O_DIRECTORY | fsc.O_NOFOLLOW;
const O_FILE_FLAGS = fsc.O_RDONLY | fsc.O_NOFOLLOW | fsc.O_NONBLOCK;

const IGNORABLE = /[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g;

/**
 * True for names git refuses or treats as its own metadata directory on some file
 * systems: `.git`, `.GIT`, `.git ` / `.git.` (NTFS), `git~1` (8.3 name), and HFS+
 * ignorable-codepoint variants.
 */
export function isDotGitLike(name: string): boolean {
  const n = name
    .normalize('NFC')
    .replace(IGNORABLE, '')
    .toLowerCase()
    .replace(/[. ]+$/, '');
  return n === '.git' || n === 'git~1';
}

const GIT_CONFIG_LINK_NAMES = new Set(['.gitmodules', '.gitattributes', '.gitignore', '.mailmap']);

export function hasControlChars(name: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(name);
}

interface DirRef {
  fh: FileHandle | undefined;
  /** Path used to address children. */
  base: string;
}

function child(dir: DirRef, name: string): string {
  return dir.fh && HAVE_PROC_FD ? `/proc/self/fd/${dir.fh.fd}/${name}` : join(dir.base, name);
}

function dirListPath(dir: DirRef): string {
  return dir.fh && HAVE_PROC_FD ? `/proc/self/fd/${dir.fh.fd}` : dir.base;
}

function limitError(what: string, limit: number): AboxError {
  return new AboxError('invalid_input', `workspace tree exceeds the ${what} limit (${limit})`, {
    hint: 'the sandbox produced an unusually large tree; inspect it inside the sandbox or export selected paths only',
  });
}

/** Walks `root` according to the rules above, calling the visitor in sorted (deterministic) order. */
export async function walkTree(
  root: string,
  visitor: WalkVisitor,
  opts: WalkOptions = {},
): Promise<WalkResult> {
  const limits = {
    maxEntries: opts.limits?.maxEntries ?? 1_000_000,
    maxFileBytes: opts.limits?.maxFileBytes ?? 512 * 1024 * 1024,
    maxTotalBytes: opts.limits?.maxTotalBytes ?? 16 * 1024 * 1024 * 1024,
    maxDepth: opts.limits?.maxDepth ?? 128,
  };
  const gitMode = opts.gitMode ?? 'skip';
  const skipLinks = opts.skipGitConfigSymlinks ?? true;
  const exclude = opts.exclude ?? (() => false);
  const result: WalkResult = {
    skipped: [],
    gitEntries: [],
    excluded: 0,
    entries: 0,
    files: 0,
    symlinks: 0,
    directories: 0,
    bytes: 0,
  };

  const realRoot = await realpath(root);
  const rootHandle = await open(realRoot, O_DIR_FLAGS);

  async function visitDir(dir: DirRef, relPrefix: string, depth: number): Promise<void> {
    if (depth > limits.maxDepth) throw limitError('directory depth', limits.maxDepth);
    const names = (await readdir(dirListPath(dir))).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const name of names) {
      const rel = relPrefix ? `${relPrefix}/${name}` : name;
      if (name.includes('�')) {
        result.skipped.push({ path: rel, reason: 'file name is not valid UTF-8' });
        continue;
      }
      if (gitMode === 'skip' && isDotGitLike(name)) {
        result.gitEntries.push(rel);
        continue;
      }
      const p = child(dir, name);
      let st;
      try {
        st = await lstat(p);
      } catch {
        result.skipped.push({ path: rel, reason: 'vanished during walk' });
        continue;
      }
      const isDir = st.isDirectory();
      if (exclude(rel, isDir)) {
        result.excluded++;
        continue;
      }
      if (++result.entries > limits.maxEntries) throw limitError('entry count', limits.maxEntries);

      if (st.isSymbolicLink()) {
        if (skipLinks && gitMode === 'skip' && GIT_CONFIG_LINK_NAMES.has(name.toLowerCase())) {
          result.skipped.push({
            path: rel,
            reason: `symlink named ${name} is refused (git rejects it)`,
          });
          continue;
        }
        let target: Buffer;
        try {
          target = await readlink(p, { encoding: 'buffer' });
        } catch {
          result.skipped.push({ path: rel, reason: 'symlink vanished during walk' });
          continue;
        }
        result.symlinks++;
        await visitor.symlink?.(rel, target);
      } else if (isDir) {
        let fh: FileHandle;
        try {
          fh = await open(p, O_DIR_FLAGS);
        } catch {
          result.skipped.push({
            path: rel,
            reason: 'directory replaced or unreadable during walk',
          });
          continue;
        }
        try {
          const fst = await fh.stat();
          if (fst.ino !== st.ino || fst.dev !== st.dev) {
            result.skipped.push({ path: rel, reason: 'directory replaced during walk' });
            continue;
          }
          result.directories++;
          await visitor.directory?.(rel, st.mode & 0o7777);
          await visitDir({ fh, base: join(dir.base, name) }, rel, depth + 1);
        } finally {
          await fh.close();
        }
      } else if (st.isFile()) {
        if (st.size > limits.maxFileBytes) {
          result.skipped.push({
            path: rel,
            reason: `file larger than ${limits.maxFileBytes} bytes`,
          });
          continue;
        }
        let fh: FileHandle;
        try {
          fh = await open(p, O_FILE_FLAGS);
        } catch {
          result.skipped.push({ path: rel, reason: 'file replaced or unreadable during walk' });
          continue;
        }
        try {
          const fst = await fh.stat();
          if (!fst.isFile() || fst.ino !== st.ino || fst.dev !== st.dev) {
            result.skipped.push({ path: rel, reason: 'file replaced during walk' });
            continue;
          }
          if (fst.size > limits.maxFileBytes) {
            result.skipped.push({
              path: rel,
              reason: `file larger than ${limits.maxFileBytes} bytes`,
            });
            continue;
          }
          result.bytes += fst.size;
          if (result.bytes > limits.maxTotalBytes)
            throw limitError('total size', limits.maxTotalBytes);
          result.files++;
          await visitor.file(rel, fh, {
            size: fst.size,
            mode: fst.mode & 0o7777,
            executable: (fst.mode & 0o100) !== 0,
          });
        } finally {
          await fh.close();
        }
      } else {
        result.skipped.push({ path: rel, reason: 'special file (socket, fifo or device)' });
      }
    }
  }

  try {
    await visitDir({ fh: rootHandle, base: realRoot }, '', 0);
  } finally {
    await rootHandle.close();
  }
  return result;
}

/** True when `p` exists as a real directory (not a symlink to one). */
export async function isRealDirectory(p: string): Promise<boolean> {
  try {
    return (await lstat(p)).isDirectory();
  } catch {
    return false;
  }
}
