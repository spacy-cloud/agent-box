import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
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
      return new AboxError('invalid_input', msg, { cause: e });
    default:
      return new AboxError('backend_error', msg, { cause: e });
  }
}

export function randomSuffix(bytes = 4): string {
  return randomBytes(bytes).toString('hex');
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

export async function pathExists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  );
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return errno(e) === 'EPERM';
  }
}

/**
 * Cross-process lock based on an exclusive `mkdir`. A lock whose owner pid is gone is stolen.
 * Returns the release function.
 */
export async function acquireLock(
  lockDir: string,
  opts: { timeoutMs?: number; signal?: AbortSignal; onWait?: () => void } = {},
): Promise<() => Promise<void>> {
  const deadline = Date.now() + (opts.timeoutMs ?? 60 * 60 * 1000);
  await mkdir(dirname(lockDir), { recursive: true, mode: 0o700 });
  let waited = false;
  for (;;) {
    try {
      await mkdir(lockDir, { mode: 0o700 });
      await writeFile(join(lockDir, 'pid'), String(process.pid), { mode: 0o600 });
      return async () => {
        await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
      };
    } catch (e) {
      if (errno(e) !== 'EEXIST') throw e;
    }
    // Is the owner still alive?
    const owner = await readFile(join(lockDir, 'pid'), 'utf8')
      .then((s) => Number(s.trim()))
      .catch(() => undefined);
    if (owner !== undefined && Number.isInteger(owner) && owner > 0 && !isProcessAlive(owner)) {
      await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
      continue;
    }
    if (!waited) {
      waited = true;
      opts.onWait?.();
    }
    if (opts.signal?.aborted) throw new AboxError('timeout', 'aborted while waiting for a lock');
    if (Date.now() > deadline)
      throw new AboxError('timeout', `timed out waiting for lock ${lockDir}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** True when `lockDir` exists and its owner process is alive. */
export async function isLockHeld(lockDir: string): Promise<boolean> {
  const owner = await readFile(join(lockDir, 'pid'), 'utf8')
    .then((s) => Number(s.trim()))
    .catch(() => undefined);
  return owner !== undefined && Number.isInteger(owner) && owner > 0 && isProcessAlive(owner);
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
 * Exclude matcher for the workspace `exclude` list.
 * - A pattern without `/` (`node_modules`, `*.log`) excludes any entry with that name at any depth.
 * - A pattern with `/` (`build/cache`) is anchored at the copy root and excludes that entry and everything below it.
 * Returns a function `(relPath) => excluded`.
 */
export function makeExcludeMatcher(
  patterns: readonly string[] | undefined,
): (rel: string) => boolean {
  const names: RegExp[] = [];
  const anchored: RegExp[] = [];
  for (const raw of patterns ?? []) {
    const pat = raw.replace(/^\.\//, '').replace(/\/+$/, '');
    if (!pat) continue;
    if (pat.includes('/')) anchored.push(globToRegExp(pat.replace(/^\//, '')));
    else names.push(globToRegExp(pat));
  }
  if (names.length === 0 && anchored.length === 0) return () => false;
  return (rel: string): boolean => {
    const parts = relative('.', rel).split(sep).filter(Boolean);
    if (parts.some((part) => names.some((re) => re.test(part)))) return true;
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join('/');
      if (anchored.some((re) => re.test(prefix))) return true;
    }
    return false;
  };
}
