import { createHash, randomBytes } from 'node:crypto';
import { constants as fsc } from 'node:fs';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { AboxError } from '../errors.js';
import type { FileFingerprint } from './types.js';

/** A config file bigger than this is not read (a settings file is a few KiB; ~/.claude.json a few MiB). */
export const MAX_CONFIG_BYTES = 32 * 1024 * 1024;

export const sha256 = (data: string | Uint8Array): string =>
  createHash('sha256').update(data).digest('hex');

export interface Snapshot {
  fp: FileFingerprint;
  /** Content without a byte order mark; null when the file does not exist. */
  text: string | null;
  bom: boolean;
}

const ABSENT: FileFingerprint = { exists: false, size: 0, mtimeMs: 0, mode: 0, hash: '' };

function errno(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException)?.code;
}

async function symlinkRefusal(path: string): Promise<AboxError> {
  let target = '';
  try {
    target = await realpath(path);
  } catch {
    /* dangling */
  }
  return new AboxError(
    'conflict',
    `${path} is a symbolic link; setup does not write through links`,
    {
      hint: target
        ? `Edit the real file (${target}) by hand, or replace the link with a regular file. "abox init --agent <name>" prints the entry.`
        : 'Replace the link with a regular file, or edit its target by hand.',
      details: { path, ...(target ? { target } : {}) },
    },
  );
}

/**
 * Reads a config file without ever following a symbolic link: `lstat` first, then `open` with
 * O_NOFOLLOW and a check that the opened file is the one that was looked at.
 */
export async function readSnapshot(path: string, maxBytes = MAX_CONFIG_BYTES): Promise<Snapshot> {
  let st;
  try {
    st = await lstat(path);
  } catch (e) {
    if (errno(e) === 'ENOENT' || errno(e) === 'ENOTDIR')
      return { fp: ABSENT, text: null, bom: false };
    throw new AboxError('invalid_input', `cannot read ${path}: ${(e as Error).message}`, {
      cause: e,
    });
  }
  if (st.isSymbolicLink()) throw await symlinkRefusal(path);
  if (!st.isFile())
    throw new AboxError('unsupported', `${path} is not a regular file`, {
      hint: 'Setup only edits regular files.',
    });
  if (st.size > maxBytes)
    throw new AboxError('unsupported', `${path} is larger than ${maxBytes} bytes`, {
      hint: 'Edit the file by hand.',
    });
  let fh;
  try {
    fh = await open(path, fsc.O_RDONLY | (fsc.O_NOFOLLOW ?? 0) | (fsc.O_NONBLOCK ?? 0));
  } catch (e) {
    if (errno(e) === 'ELOOP') throw await symlinkRefusal(path);
    throw new AboxError('invalid_input', `cannot open ${path}: ${(e as Error).message}`, {
      cause: e,
    });
  }
  try {
    const fst = await fh.stat();
    if (!fst.isFile() || fst.ino !== st.ino || fst.dev !== st.dev)
      throw new AboxError('conflict', `${path} changed while it was being read`, {
        hint: 'Run setup again.',
      });
    const buf = await fh.readFile();
    if (buf.length > maxBytes)
      throw new AboxError('unsupported', `${path} is larger than ${maxBytes} bytes`);
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf);
    } catch {
      throw new AboxError('unsupported', `${path} is not valid UTF-8 text`, {
        hint: 'Edit the file by hand.',
      });
    }
    const bom = text.startsWith('\uFEFF');
    return {
      fp: {
        exists: true,
        size: buf.length,
        mtimeMs: fst.mtimeMs,
        mode: fst.mode & 0o7777,
        hash: sha256(buf),
      },
      text: bom ? text.slice(1) : text,
      bom,
    };
  } finally {
    await fh.close();
  }
}

export function sameFingerprint(a: FileFingerprint, b: FileFingerprint): boolean {
  if (a.exists !== b.exists) return false;
  if (!a.exists) return true;
  return a.hash === b.hash && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}

async function fsyncDir(dir: string): Promise<void> {
  try {
    const fh = await open(dir, fsc.O_RDONLY);
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
  } catch {
    /* not supported on every platform */
  }
}

function changedError(path: string): AboxError {
  return new AboxError('conflict', `${path} changed since the preview`, {
    hint: 'Nothing was written to it. Run setup again to see the current state.',
    details: { path },
  });
}

export interface GuardedWrite {
  path: string;
  /** New content (without byte order mark). */
  text: string;
  bom: boolean;
  /** The file as the preview saw it. */
  expected: FileFingerprint;
  stagingDir: string;
  /** Called with the staged copy read back from disk; throws when it is not what was intended. */
  verify: (text: string) => void;
}

/**
 * Replaces (or creates) a file atomically: the new content is staged and verified in a private
 * directory, written to a temporary file next to the target (0600, fsynced, mode of the old file
 * restored), the target is checked once more (same size, mtime and hash as in the preview; not a
 * symbolic link) and then renamed over the old file. A file that did not exist is created with
 * `link`, which refuses to replace one that appeared meanwhile.
 */
export async function writeGuarded(w: GuardedWrite): Promise<{ hash: string }> {
  const { path } = w;
  const bytes = Buffer.from((w.bom ? '\uFEFF' : '') + w.text, 'utf8');
  const hash = sha256(bytes);
  const current = await readSnapshot(path);
  if (!sameFingerprint(current.fp, w.expected)) throw changedError(path);

  // 1. stage and verify in the private directory
  await ensurePrivateDir(w.stagingDir);
  const stage = await mkdtemp(join(w.stagingDir, 's-'));
  try {
    const staged = join(stage, basename(path));
    await writeFile(staged, bytes, { mode: 0o600, flag: 'wx' });
    const raw = await readFile(staged, 'utf8');
    const back = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    w.verify(back);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }

  // 2. write next to the target
  const dir = dirname(path);
  if (!w.expected.exists) await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.${basename(path)}.abox-${randomBytes(6).toString('hex')}.tmp`);
  const mode = w.expected.exists ? w.expected.mode : 0o600;
  const fh = await open(tmp, 'wx', 0o600);
  try {
    await fh.writeFile(bytes);
    await fh.chmod(mode);
    await fh.sync();
  } catch (e) {
    await fh.close();
    await unlink(tmp).catch(() => undefined);
    throw e;
  }
  await fh.close();

  try {
    // 3. nothing may have happened to the target since the preview
    const again = await readSnapshot(path);
    if (!sameFingerprint(again.fp, w.expected)) throw changedError(path);
    if (w.expected.exists) {
      await rename(tmp, path);
    } else {
      try {
        await link(tmp, path);
      } catch (e) {
        if (errno(e) === 'EEXIST') throw changedError(path);
        throw e;
      }
      await unlink(tmp);
    }
  } catch (e) {
    await unlink(tmp).catch(() => undefined);
    throw e;
  }
  await fsyncDir(dir);

  // 4. what is on disk is what was meant
  const final = await readSnapshot(path);
  if (final.fp.hash !== hash)
    throw new AboxError('internal', `${path} does not have the expected content after writing`, {
      hint: 'The file was changed again right after setup wrote it. Check it and run setup again.',
    });
  return { hash };
}

/** Deletes a file setup created, if it is still exactly what the preview saw. */
export async function deleteGuarded(path: string, expected: FileFingerprint): Promise<void> {
  const current = await readSnapshot(path);
  if (!sameFingerprint(current.fp, expected)) throw changedError(path);
  await unlink(path);
  await fsyncDir(dirname(path));
}

// -- first-snapshot backups --------------------------------------------------------------------

interface ManifestEntry {
  existed: boolean;
  /** File name inside the backup directory. */
  backup?: string;
  hash?: string;
  size?: number;
  at: number;
}
interface Manifest {
  version: 1;
  files: Record<string, ManifestEntry>;
}

const MANIFEST = 'manifest.json';

export async function loadManifest(backupDir: string): Promise<Manifest> {
  try {
    const raw = JSON.parse(await readFile(join(backupDir, MANIFEST), 'utf8')) as Partial<Manifest>;
    if (raw && raw.version === 1 && raw.files && typeof raw.files === 'object')
      return { version: 1, files: raw.files };
  } catch {
    /* none yet */
  }
  return { version: 1, files: {} };
}

async function saveManifest(backupDir: string, m: Manifest): Promise<void> {
  const tmp = join(backupDir, `.${MANIFEST}.${randomBytes(4).toString('hex')}.tmp`);
  await writeFile(tmp, `${JSON.stringify(m, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(tmp, join(backupDir, MANIFEST));
}

/** Does a first snapshot of `path` need to be taken? */
export async function needsBackup(
  backupDir: string,
  path: string,
  exists: boolean,
): Promise<boolean> {
  if (!exists) return false;
  return (await loadManifest(backupDir)).files[path] === undefined;
}

/**
 * Keeps a copy of a file as it was before setup first touched it. Only the first snapshot is kept:
 * later runs leave it alone, so it always shows the state before abox. Returns the backup file, or
 * undefined when nothing needed saving (the file did not exist, or a snapshot is there already). A
 * file that did not exist is remembered as such, so that `--uninstall` can remove what setup created.
 */
export async function ensureBackup(
  backupDir: string,
  path: string,
  snap: Snapshot,
  now: number,
): Promise<string | undefined> {
  await ensurePrivateDir(backupDir);
  const m = await loadManifest(backupDir);
  const known = m.files[path];
  if (known) return known.existed && known.backup ? join(backupDir, known.backup) : undefined;
  if (!snap.fp.exists) {
    m.files[path] = { existed: false, at: now };
    await saveManifest(backupDir, m);
    return undefined;
  }
  const name = `${sha256(path).slice(0, 12)}-${basename(path)}`;
  const data = Buffer.from((snap.bom ? '\uFEFF' : '') + (snap.text ?? ''), 'utf8');
  await writeFile(join(backupDir, name), data, { mode: 0o600, flag: 'w' });
  m.files[path] = { existed: true, backup: name, hash: snap.fp.hash, size: snap.fp.size, at: now };
  await saveManifest(backupDir, m);
  return join(backupDir, name);
}

/** The file setup created was removed again: the next change starts from a fresh first snapshot. */
export async function forgetCreated(backupDir: string, path: string): Promise<void> {
  const m = await loadManifest(backupDir);
  if (m.files[path] && !m.files[path]!.existed) {
    delete m.files[path];
    await saveManifest(backupDir, m);
  }
}

/** Did the first snapshot find no file there (so setup created it)? */
export async function createdBySetup(backupDir: string, path: string): Promise<boolean> {
  const e = (await loadManifest(backupDir)).files[path];
  return e !== undefined && !e.existed;
}

export async function backupPathOf(backupDir: string, path: string): Promise<string | undefined> {
  const e = (await loadManifest(backupDir)).files[path];
  return e?.existed && e.backup ? join(backupDir, e.backup) : undefined;
}
