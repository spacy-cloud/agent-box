import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createDeflate, deflateSync } from 'node:zlib';
import type { FileHandle } from 'node:fs/promises';
import { AboxError } from '../errors.js';
import { runGit } from './git.js';

/**
 * Host-owned git object handling.
 *
 * File contents of sandbox-written trees are never given to git as paths. abox reads
 * them itself (race-free, see safefs.ts), hashes them and writes loose blob objects
 * into a host-owned scratch repository. Git then only ever sees object ids, so no
 * attribute, filter, textconv or config of the sandbox tree can influence it.
 */

export type ObjectFormat = 'sha1' | 'sha256';

export type EntryMode = '100644' | '100755' | '120000' | '160000';

export interface TreeEntry {
  mode: EntryMode;
  oid: string;
}

const READ_CHUNK = 1024 * 1024;

async function* fileChunks(fh: FileHandle, size: number): AsyncGenerator<Buffer> {
  let pos = 0;
  while (pos < size) {
    const want = Math.min(READ_CHUNK, size - pos);
    const buf = Buffer.allocUnsafe(want);
    const { bytesRead } = await fh.read(buf, 0, want, pos);
    if (bytesRead === 0) break;
    pos += bytesRead;
    yield bytesRead === want ? buf : buf.subarray(0, bytesRead);
  }
}

function blobHeader(size: number): Buffer {
  return Buffer.from(`blob ${size}\0`);
}

/** Computes the git object id and (optionally) a sha256 of the plain content, streaming. */
export async function hashFileBlob(
  fh: FileHandle,
  size: number,
  fmt: ObjectFormat,
  withSha256 = false,
): Promise<{ oid: string; sha256?: string }> {
  const h = createHash(fmt);
  h.update(blobHeader(size));
  const s = withSha256 ? createHash('sha256') : undefined;
  let n = 0;
  for await (const c of fileChunks(fh, size)) {
    h.update(c);
    s?.update(c);
    n += c.length;
  }
  if (n !== size) throw new AboxError('conflict', 'file changed while it was read (size mismatch)');
  return { oid: h.digest('hex'), ...(s ? { sha256: s.digest('hex') } : {}) };
}

export function hashBufferBlob(data: Buffer, fmt: ObjectFormat): string {
  const h = createHash(fmt);
  h.update(blobHeader(data.length));
  h.update(data);
  return h.digest('hex');
}

function objectPath(gitDir: string, oid: string): { dir: string; file: string } {
  const dir = join(gitDir, 'objects', oid.slice(0, 2));
  return { dir, file: join(dir, oid.slice(2)) };
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function placeObject(gitDir: string, oid: string, tmp: string): Promise<void> {
  const { dir, file } = objectPath(gitDir, oid);
  if (await exists(file)) {
    await unlink(tmp);
    return;
  }
  await mkdir(dir, { recursive: true });
  await rename(tmp, file);
}

/** Writes a loose blob from a verified open file handle; returns the object id. */
export async function writeFileBlob(
  gitDir: string,
  fmt: ObjectFormat,
  fh: FileHandle,
  size: number,
  expectedOid?: string,
): Promise<string> {
  const tmp = join(gitDir, 'objects', `tmp_obj_${randomBytes(8).toString('hex')}`);
  await mkdir(join(gitDir, 'objects'), { recursive: true });
  const h = createHash(fmt);
  const header = blobHeader(size);
  h.update(header);
  let n = 0;
  async function* gen(): AsyncGenerator<Buffer> {
    yield header;
    for await (const c of fileChunks(fh, size)) {
      h.update(c);
      n += c.length;
      yield c;
    }
  }
  try {
    await pipeline(
      gen(),
      createDeflate({ level: 1 }),
      createWriteStream(tmp, { flags: 'wx', mode: 0o444 }),
    );
    if (n !== size)
      throw new AboxError('conflict', 'file changed while it was read (size mismatch)');
    const oid = h.digest('hex');
    if (expectedOid && oid !== expectedOid) {
      throw new AboxError('conflict', 'file changed while it was read (content mismatch)');
    }
    await placeObject(gitDir, oid, tmp);
    return oid;
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

/** Writes a loose blob from memory (used for symlink targets); returns the object id. */
export async function writeBufferBlob(
  gitDir: string,
  fmt: ObjectFormat,
  data: Buffer,
): Promise<string> {
  const oid = hashBufferBlob(data, fmt);
  const { file } = objectPath(gitDir, oid);
  if (await exists(file)) return oid;
  const tmp = join(gitDir, 'objects', `tmp_obj_${randomBytes(8).toString('hex')}`);
  await mkdir(join(gitDir, 'objects'), { recursive: true });
  await writeFile(tmp, deflateSync(Buffer.concat([blobHeader(data.length), data]), { level: 1 }), {
    flag: 'wx',
    mode: 0o444,
  });
  await placeObject(gitDir, oid, tmp);
  return oid;
}

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

/** Initialises an empty bare repository without templates (no hooks, no sample files). */
export async function initBareRepo(gitDir: string, fmt: ObjectFormat): Promise<void> {
  await mkdir(gitDir, { recursive: true, mode: 0o700 });
  await runGit(['init', '--quiet', '--bare', `--object-format=${fmt}`, '--template=', gitDir], {
    cwd: '/',
  });
}

export interface ScratchRepo {
  gitDir: string;
  objectFormat: ObjectFormat;
  dispose(): Promise<void>;
}

/**
 * Creates a throw-away host-owned bare repository that borrows objects from the given
 * object directories via alternates (read-only use) and ignores all attributes.
 */
export async function createScratchRepo(
  parentDir: string,
  objectDirs: string[],
  fmt: ObjectFormat,
): Promise<ScratchRepo> {
  await mkdir(parentDir, { recursive: true, mode: 0o700 });
  const gitDir = await mkdtemp(join(parentDir, 'scratch-'));
  await initBareRepo(gitDir, fmt);
  for (const d of objectDirs) {
    if (/[\n\r\0]/.test(d) || !d.startsWith('/')) {
      throw new AboxError('internal', 'invalid alternate object directory');
    }
  }
  if (objectDirs.length > 0) {
    await mkdir(join(gitDir, 'objects', 'info'), { recursive: true });
    await writeFile(
      join(gitDir, 'objects', 'info', 'alternates'),
      `${[...new Set(objectDirs)].join('\n')}\n`,
    );
  }
  await mkdir(join(gitDir, 'info'), { recursive: true });
  await writeFile(
    join(gitDir, 'info', 'attributes'),
    '* !filter !diff !merge !text !eol !ident !working-tree-encoding\n',
  );
  return {
    gitDir,
    objectFormat: fmt,
    dispose: () => rm(gitDir, { recursive: true, force: true }),
  };
}

/** Lists all blob/symlink/gitlink entries of a tree-ish recursively. Paths are raw (NUL-safe). */
export async function listTree(gitDir: string, treeish: string): Promise<Map<string, TreeEntry>> {
  const r = await runGit(['ls-tree', '-r', '-z', '--full-tree', '--end-of-options', treeish], {
    gitDir,
  });
  const map = new Map<string, TreeEntry>();
  for (const rec of r.stdout.split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    const meta = rec.slice(0, tab).split(' ');
    const mode = meta[0] as EntryMode | undefined;
    const oid = meta[2];
    if (!mode || !oid) continue;
    map.set(rec.slice(tab + 1), { mode, oid });
  }
  return map;
}

/** Builds a tree object from a complete entry list using a private temporary index. */
export async function writeTree(
  gitDir: string,
  entries: Iterable<[string, TreeEntry]>,
  scratchDir: string,
): Promise<string> {
  const indexFile = join(scratchDir, `index-${randomBytes(6).toString('hex')}`);
  const parts: string[] = [];
  for (const [path, e] of entries) {
    if (path.includes('\0')) continue;
    parts.push(`${e.mode} ${e.oid}\t${path}\0`);
  }
  try {
    await runGit(['update-index', '--add', '--replace', '-z', '--index-info'], {
      gitDir,
      input: Buffer.from(parts.join(''), 'utf8'),
      env: { GIT_INDEX_FILE: indexFile },
    });
    const r = await runGit(['write-tree'], { gitDir, env: { GIT_INDEX_FILE: indexFile } });
    return r.stdout.trim();
  } finally {
    await rm(indexFile, { force: true });
  }
}

export const EXPORT_IDENTITY: Record<string, string> = {
  GIT_AUTHOR_NAME: 'abox',
  GIT_AUTHOR_EMAIL: 'abox@localhost',
  GIT_COMMITTER_NAME: 'abox',
  GIT_COMMITTER_EMAIL: 'abox@localhost',
};

/** Creates a commit object for `tree` (parents optional). */
export async function commitTree(
  gitDir: string,
  tree: string,
  parents: string[],
  message: string,
  extraEnv: Record<string, string> = {},
): Promise<string> {
  const args = ['commit-tree', tree];
  for (const p of parents) args.push('-p', p);
  const r = await runGit(args, {
    gitDir,
    input: `${message}\n`,
    env: { ...EXPORT_IDENTITY, ...extraEnv },
  });
  return r.stdout.trim();
}
