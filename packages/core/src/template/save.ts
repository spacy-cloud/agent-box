import { randomBytes } from 'node:crypto';
import { constants as fsc } from 'node:fs';
import { link, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, sep } from 'node:path';
import { AboxError } from '../errors.js';
import { MAX_TEMPLATE_BYTES } from './parse.js';
import { TEMPLATE_NAME_RE } from './schema.js';

/** Where a template is saved: abox's own template directory, or `.sandbox/` of a project. */
export type TemplateSaveTarget = 'user' | 'project';

/** Directory inside a project that holds its templates. */
export const PROJECT_TEMPLATE_DIR = '.sandbox';

function errno(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException)?.code;
}

/** `name` is a template name: nothing that could leave the directory (`..`, `/`, a leading dot) gets through. */
export function assertTemplateFileName(name: string): void {
  if (typeof name !== 'string' || !TEMPLATE_NAME_RE.test(name)) {
    throw new AboxError('invalid_input', `invalid template name "${String(name).slice(0, 80)}"`, {
      hint: 'Use lowercase letters, digits and "-" (max 63 characters).',
    });
  }
}

/**
 * The only place a project template is written to: `<project>/.sandbox/<name>.yaml`. The project folder has
 * to be the canonical absolute path (symbolic links already resolved, see `canonicalizePath`); the name is
 * checked against the template name grammar, which excludes `..`, separators and hidden files.
 */
export function projectTemplatePath(
  projectDir: string,
  name: string,
): { dir: string; path: string } {
  assertTemplateFileName(name);
  if (
    typeof projectDir !== 'string' ||
    !isAbsolute(projectDir) ||
    projectDir.includes('\0') ||
    projectDir.split(sep).includes('..')
  ) {
    throw new AboxError('invalid_input', 'the project folder must be an absolute path');
  }
  const dir = join(projectDir, PROJECT_TEMPLATE_DIR);
  return { dir, path: join(dir, `${name}.yaml`) };
}

/** `<templates dir>/<name>.yaml` for the user directory. */
export function userTemplatePath(userDir: string, name: string): { dir: string; path: string } {
  assertTemplateFileName(name);
  return { dir: userDir, path: join(userDir, `${name}.yaml`) };
}

/** The current text of a template file (`null` when there is none). Never follows a symbolic link. */
export async function readTemplateFile(path: string): Promise<string | null> {
  let st;
  try {
    st = await lstat(path);
  } catch (e) {
    if (errno(e) === 'ENOENT' || errno(e) === 'ENOTDIR') return null;
    throw new AboxError('invalid_input', `cannot read ${path}: ${(e as Error).message}`);
  }
  if (st.isSymbolicLink()) throw symlinkRefusal(path);
  if (!st.isFile()) {
    throw new AboxError('conflict', `${path} exists and is not a regular file`, {
      hint: 'Remove or rename it, then save again.',
    });
  }
  if (st.size > MAX_TEMPLATE_BYTES) {
    throw new AboxError('invalid_input', `${path} is larger than ${MAX_TEMPLATE_BYTES} bytes`);
  }
  let fh;
  try {
    fh = await open(path, fsc.O_RDONLY | (fsc.O_NOFOLLOW ?? 0) | (fsc.O_NONBLOCK ?? 0));
  } catch (e) {
    if (errno(e) === 'ELOOP') throw symlinkRefusal(path);
    throw new AboxError('invalid_input', `cannot open ${path}: ${(e as Error).message}`);
  }
  try {
    const fst = await fh.stat();
    if (!fst.isFile() || fst.ino !== st.ino || fst.dev !== st.dev) {
      throw new AboxError('conflict', `${path} changed while it was being read`);
    }
    return (await fh.readFile()).toString('utf8');
  } finally {
    await fh.close();
  }
}

function symlinkRefusal(path: string): AboxError {
  return new AboxError(
    'conflict',
    `${path} is a symbolic link; abox does not write through links`,
    {
      hint: 'Replace the link with a regular file or save to another place.',
      details: { path },
    },
  );
}

export interface WriteTemplateOptions {
  /** Directory the file goes to (`.sandbox` of a project, or the user template directory). */
  dir: string;
  /** Full target path; its directory must be `dir`. */
  path: string;
  text: string;
  /** Replace an existing file. Without it an existing file is a `conflict`, also when it appears meanwhile. */
  overwrite: boolean;
  /** Mode of the directory when it is created, and of the file. */
  dirMode: number;
  fileMode: number;
}

/**
 * Writes one template file safely: the directory must be a real directory (a symbolic link in its place is
 * refused, also when it is swapped in while writing), the text goes to a temporary file next to the target
 * which is fsynced, and the target is then created with `link` (never replaces a file that appeared meanwhile)
 * or, with `overwrite`, renamed over the old regular file. A symbolic link at the target is never followed.
 */
export async function writeTemplateFile(
  o: WriteTemplateOptions,
): Promise<{ created: boolean; bytes: number }> {
  if (dirname(o.path) !== o.dir) {
    throw new AboxError('internal', 'template path is not inside its directory');
  }
  const bytes = Buffer.from(o.text.endsWith('\n') ? o.text : `${o.text}\n`, 'utf8');
  if (bytes.length > MAX_TEMPLATE_BYTES) {
    throw new AboxError('invalid_input', `the template is larger than ${MAX_TEMPLATE_BYTES} bytes`);
  }
  const dirId = await ensureRealDir(o.dir, o.dirMode);
  const existing = await readTemplateFile(o.path);
  if (existing !== null && !o.overwrite) throw existsError(o.path);

  const tmp = join(o.dir, `.${randomBytes(8).toString('hex')}.tmp`);
  const fh = await open(tmp, 'wx', o.fileMode);
  try {
    await fh.writeFile(bytes);
    await fh.chmod(o.fileMode);
    await fh.sync();
  } catch (e) {
    await fh.close();
    await unlink(tmp).catch(() => undefined);
    throw e;
  }
  await fh.close();
  try {
    // The directory must still be the one that was checked: not swapped for a link while we wrote.
    const again = await lstat(o.dir);
    if (!again.isDirectory() || again.ino !== dirId.ino || again.dev !== dirId.dev) {
      throw new AboxError('conflict', `${o.dir} changed while the template was being written`);
    }
    if (existing !== null) {
      // never rename over anything but a regular file
      const now = await lstat(o.path).catch(() => undefined);
      if (!now?.isFile())
        throw now?.isSymbolicLink() ? symlinkRefusal(o.path) : existsError(o.path);
      await rename(tmp, o.path);
    } else {
      try {
        await link(tmp, o.path);
      } catch (e) {
        if (errno(e) === 'EEXIST') throw existsError(o.path);
        throw e;
      }
      await unlink(tmp);
    }
  } catch (e) {
    await unlink(tmp).catch(() => undefined);
    throw e;
  }
  await fsyncDir(o.dir);
  return { created: existing === null, bytes: bytes.length };
}

function existsError(path: string): AboxError {
  return new AboxError('conflict', `${path} already exists`, {
    hint: 'Confirm to overwrite it, or choose another name.',
    details: { path },
  });
}

/** The directory a template goes to is not a symbolic link (and is a directory) when it exists; nothing is created. */
export async function checkTemplateDir(dir: string): Promise<void> {
  let st;
  try {
    st = await lstat(dir);
  } catch (e) {
    if (errno(e) === 'ENOENT' || errno(e) === 'ENOTDIR') return;
    throw new AboxError('invalid_input', `cannot read ${dir}: ${(e as Error).message}`);
  }
  if (st.isSymbolicLink()) {
    throw new AboxError(
      'conflict',
      `${dir} is a symbolic link; abox does not write through links`,
      {
        hint: 'Make it a real directory.',
        details: { path: dir },
      },
    );
  }
  if (!st.isDirectory()) throw new AboxError('conflict', `${dir} exists and is not a directory`);
}

/** `dir` exists as a real directory (created when missing, one level, never through a link). */
async function ensureRealDir(dir: string, mode: number): Promise<{ ino: number; dev: number }> {
  let st = await lstat(dir).catch((e: unknown) => {
    if (errno(e) === 'ENOENT') return undefined;
    throw e;
  });
  if (!st) {
    // the parent has to exist already for a project (`.sandbox` is created inside it); the user directory is recursive
    await mkdir(dir, { recursive: true, mode });
    st = await lstat(dir);
  }
  if (st.isSymbolicLink()) {
    throw new AboxError(
      'conflict',
      `${dir} is a symbolic link; abox does not write through links`,
      {
        hint: 'Make it a real directory.',
        details: { path: dir },
      },
    );
  }
  if (!st.isDirectory()) throw new AboxError('conflict', `${dir} exists and is not a directory`);
  return { ino: st.ino, dev: st.dev };
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
    /* not supported everywhere */
  }
}

/** Does `<name>.yml` (the other spelling the catalog reads) exist? A second file would define the name twice. */
export async function otherSpellingExists(dir: string, name: string): Promise<boolean> {
  try {
    await lstat(join(dir, `${name}.yml`));
    return true;
  } catch {
    return false;
  }
}
