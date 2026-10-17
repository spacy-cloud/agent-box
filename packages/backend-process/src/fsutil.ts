import { chmod, cp, lstat, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { AboxError } from '@abox/core';

export function errno(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && 'code' in e
    ? String((e as { code: unknown }).code)
    : undefined;
}

/** Maps a Node fs error to a stable AboxError code. AboxErrors pass through. */
export function mapFsError(e: unknown, what: string): AboxError {
  if (e instanceof AboxError) return e;
  const msg = `${what}: ${e instanceof Error ? e.message : String(e)}`;
  switch (errno(e)) {
    case 'ENOENT':
      return new AboxError('not_found', msg, { cause: e });
    case 'EEXIST':
    case 'ENOTEMPTY':
      return new AboxError('conflict', msg, { cause: e });
    case 'ENOTDIR':
    case 'EISDIR':
    case 'EINVAL':
    case 'ELOOP':
    case 'ERR_FS_CP_DIR_TO_NON_DIR':
    case 'ERR_FS_CP_NON_DIR_TO_DIR':
    case 'ERR_FS_CP_EINVAL':
      return new AboxError('invalid_input', msg, { cause: e });
    default:
      return new AboxError('backend_error', msg, { cause: e });
  }
}

export function randomSuffix(): string {
  return randomBytes(4).toString('hex');
}

/** True when `child` is `parent` or lies below it (both absolute, normalized). */
export function isInside(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/** Writes a file atomically (temp file + rename) so readers never see partial JSON. */
export async function writeFileAtomic(
  file: string,
  data: string | Buffer,
  mode = 0o644,
): Promise<void> {
  const tmp = join(dirname(file), `.${basename(file)}.${randomSuffix()}.tmp`);
  try {
    await writeFile(tmp, data, { mode });
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}

async function makeWritable(p: string): Promise<void> {
  const st = await lstat(p).catch(() => undefined);
  if (!st || st.isSymbolicLink() || !st.isDirectory()) return;
  await chmod(p, st.mode | 0o700).catch(() => undefined);
  for (const name of await readdir(p).catch(() => [] as string[]))
    await makeWritable(join(p, name));
}

/**
 * `rm -rf` that also removes trees containing directories the sandbox made read-only.
 * Never follows symlinks (fs.rm unlinks them).
 */
export async function rmTree(p: string): Promise<void> {
  try {
    await rm(p, { recursive: true, force: true });
  } catch (e) {
    const code = errno(e);
    if (code !== 'EACCES' && code !== 'EPERM' && code !== 'ENOTEMPTY') throw e;
    await makeWritable(p);
    await rm(p, { recursive: true, force: true });
  }
}

function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * Builds a `fs.cp` filter for the workspace `exclude` list.
 * - A pattern without `/` (`node_modules`, `*.log`) excludes any entry with that name at any depth.
 * - A pattern with `/` (`build/cache`) is anchored at the copy root and excludes that entry and everything below it.
 * Returns undefined when there is nothing to exclude.
 */
export function makeExcludeFilter(
  patterns: readonly string[] | undefined,
  srcRoot: string,
): ((src: string) => boolean) | undefined {
  if (!patterns || patterns.length === 0) return undefined;
  const names: RegExp[] = [];
  const anchored: RegExp[] = [];
  for (const raw of patterns) {
    const pat = raw.replace(/^\.\//, '').replace(/\/+$/, '');
    if (!pat) continue;
    if (pat.includes('/')) anchored.push(globToRegExp(pat.replace(/^\//, '')));
    else names.push(globToRegExp(pat));
  }
  return (src: string): boolean => {
    const rel = relative(srcRoot, src);
    if (rel === '') return true;
    const parts = rel.split(sep);
    if (parts.some((part) => names.some((re) => re.test(part)))) return false;
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join('/');
      if (anchored.some((re) => re.test(prefix))) return false;
    }
    return true;
  };
}

/**
 * Recursive copy that never follows symlinks (they are copied verbatim as symlinks),
 * merges into existing directories and preserves modes and timestamps.
 */
export async function copyTree(
  src: string,
  dest: string,
  filter?: (src: string) => boolean,
): Promise<void> {
  await cp(src, dest, {
    recursive: true,
    force: true,
    dereference: false,
    verbatimSymlinks: true,
    preserveTimestamps: true,
    ...(filter ? { filter } : {}),
  });
}
