import { constants as fsc } from 'node:fs';
import { lstat, open, readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

/**
 * The paths a git index tracks, read in-process (no git process, so nothing the repository
 * configures can run). `.gitignore` never applies to tracked files; the copy needs the set to keep
 * them, like git does.
 */
export interface TrackedPaths {
  /** Tracked paths as git stores them: files, links and submodule directories. */
  files: Set<string>;
  /** Every directory that contains a tracked path. */
  dirs: Set<string>;
}

/** An index bigger than this is not read (a million files take about 100 MiB). */
const MAX_INDEX_BYTES = 512 * 1024 * 1024;

const GITLINK = 0o160000;
const DIRECTORY = 0o040000;

/** Reasons the index cannot be used are returned as a message, never thrown. */
export type TrackedResult = { tracked: TrackedPaths } | { problem: string } | { none: true };

/**
 * Finds the index of the repository whose work tree root is `sourceDir` (`.git` directory, or a
 * `.git` file `gitdir: …` of a linked worktree / submodule checkout) and lists its paths.
 * `none`: there is no repository, so nothing is tracked.
 */
export async function readTrackedPaths(sourceDir: string): Promise<TrackedResult> {
  const dotGit = join(sourceDir, '.git');
  let st;
  try {
    st = await lstat(dotGit);
  } catch {
    return { none: true };
  }
  let gitDir: string;
  if (st.isDirectory()) {
    gitDir = dotGit;
  } else if (st.isFile() && st.size < 4096) {
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(await readFile(dotGit, 'utf8').catch(() => ''));
    if (!m) return { problem: '.git file has no gitdir line' };
    const target = m[1] as string;
    gitDir = isAbsolute(target) ? target : resolve(sourceDir, target);
  } else {
    return { problem: '.git is neither a directory nor a gitdir file' };
  }
  let buf: Buffer;
  try {
    const fh = await open(join(gitDir, 'index'), fsc.O_RDONLY | fsc.O_NOFOLLOW | fsc.O_NONBLOCK);
    try {
      const ist = await fh.stat();
      if (!ist.isFile()) return { problem: '.git/index is not a regular file' };
      if (ist.size > MAX_INDEX_BYTES) return { problem: '.git/index is too large to read' };
      buf = await fh.readFile();
    } finally {
      await fh.close();
    }
  } catch (e) {
    // a repository without commits or staged files has no index yet
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { tracked: emptyTracked() };
    return {
      problem: `.git/index could not be read (${(e as NodeJS.ErrnoException).code ?? 'error'})`,
    };
  }
  for (const hashLen of [20, 32]) {
    const r = parseIndex(buf, hashLen);
    if (r !== undefined) return 'problem' in r ? r : { tracked: r };
  }
  return { problem: '.git/index has an unknown format' };
}

function emptyTracked(): TrackedPaths {
  return { files: new Set(), dirs: new Set() };
}

/**
 * Parses index versions 2 to 4. `undefined`: does not parse with this hash size (try another);
 * `{problem}`: parses but uses a feature that is not supported (split or sparse index).
 */
function parseIndex(buf: Buffer, hashLen: number): TrackedPaths | { problem: string } | undefined {
  if (buf.length < 12 + hashLen || buf.toString('latin1', 0, 4) !== 'DIRC') return undefined;
  const version = buf.readUInt32BE(4);
  if (version < 2 || version > 4) return undefined;
  const count = buf.readUInt32BE(8);
  const end = buf.length - hashLen;
  const tracked = emptyTracked();
  let off = 12;
  let prev = '';
  for (let i = 0; i < count; i++) {
    const fixed = 40 + hashLen + 2;
    if (off + fixed > end) return undefined;
    const mode = buf.readUInt32BE(off + 24);
    const flags = buf.readUInt16BE(off + 40 + hashLen);
    let p = off + fixed;
    if (version >= 3 && (flags & 0x4000) !== 0) p += 2;
    let path: string;
    if (version === 4) {
      // offset-encoded varint: how many bytes to drop from the end of the previous path
      let c = buf[p++];
      if (c === undefined) return undefined;
      let strip = c & 127;
      while ((c & 128) !== 0) {
        c = buf[p++];
        if (c === undefined) return undefined;
        strip = ((strip + 1) << 7) + (c & 127);
      }
      const nul = buf.indexOf(0, p);
      if (nul < 0 || nul > end || strip > Buffer.byteLength(prev)) return undefined;
      const keep = Buffer.from(prev).subarray(0, Buffer.byteLength(prev) - strip);
      path = Buffer.concat([keep, buf.subarray(p, nul)]).toString('utf8');
      off = nul + 1;
    } else {
      const nul = buf.indexOf(0, p);
      if (nul < 0 || nul > end) return undefined;
      path = buf.toString('utf8', p, nul);
      off = off + Math.floor((nul - off + 8) / 8) * 8;
      // the entry (path included) is padded with NUL bytes to a multiple of 8
      if (off > end) return undefined;
    }
    prev = path;
    if (path === '' || path.startsWith('/')) return undefined;
    if (mode >>> 0 === DIRECTORY)
      return { problem: 'sparse index (directory entries) is not supported' };
    tracked.files.add(path);
    if ((mode & 0o170000) === GITLINK) tracked.dirs.add(path);
    for (let s = path.lastIndexOf('/'); s > 0; s = path.lastIndexOf('/', s - 1)) {
      const d = path.slice(0, s);
      if (tracked.dirs.has(d)) break;
      tracked.dirs.add(d);
    }
  }
  // extensions: 4 byte signature, 4 byte size, data; the hash of the file follows them
  while (off + 8 <= end) {
    const sig = buf.toString('latin1', off, off + 4);
    const size = buf.readUInt32BE(off + 4);
    if (sig === 'link') return { problem: 'split index is not supported' };
    if (sig === 'sdir') return { problem: 'sparse index is not supported' };
    off += 8 + size;
  }
  if (off !== end) return undefined;
  return tracked;
}
