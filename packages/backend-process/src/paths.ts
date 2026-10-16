import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { AboxError } from '@abox/core';
import { errno, isInside, mapFsError } from './fsutil.js';

/**
 * Sandbox path <-> host path mapping for the process backend.
 *
 * A sandbox path such as `/workspace/x` maps to `<sandbox dir>/root/workspace/x`.
 *
 * IMPORTANT (isolation level `none`): this confinement applies to the *file APIs*
 * (readFile, writeFile, listDir, copyIn, copyOut, `cwd`, spec files) only. Commands
 * run through `exec`/`spawn` are ordinary host processes: they see the whole host
 * filesystem and can follow any path or symlink. Nothing here makes them safe.
 *
 * Remaining limitation: the check (realpath) and the use happen in two steps. A
 * process running inside the sandbox can swap a path component for a symlink in
 * between (TOCTOU). The file APIs are therefore hygiene against accidental
 * escapes and against symlink tricks planted earlier, not a security boundary
 * against a concurrently running hostile process.
 */

function escapes(sandboxPath: string, why: string): AboxError {
  return new AboxError('invalid_input', `path '${sandboxPath}' escapes the sandbox root: ${why}`, {
    hint: 'Use a path inside the sandbox filesystem. The process backend does not follow links that leave the sandbox root.',
  });
}

/**
 * Lexically normalizes a sandbox path to an absolute POSIX path.
 * Relative paths are resolved against `base`. A `..` that would climb above `/`
 * is rejected (it is an escape attempt, not "stay at /").
 */
export function normalizeSandboxPath(input: string, base = '/'): string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new AboxError('invalid_input', 'sandbox path must be a non-empty string');
  }
  if (input.includes('\0')) throw new AboxError('invalid_input', 'sandbox path contains a NUL byte');
  const full = input.startsWith('/') ? input : `${base}/${input}`;
  const stack: string[] = [];
  for (const seg of full.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (stack.length === 0) throw escapes(input, "'..' climbs above the root");
      stack.pop();
    } else {
      stack.push(seg);
    }
  }
  return '/' + stack.join('/');
}

export interface Confined {
  /** Normalized absolute sandbox path. */
  sandboxPath: string;
  /** Real host path (symlinks resolved, verified to lie inside the root). */
  hostPath: string;
}

async function lstatExists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch (e) {
    if (errno(e) === 'ENOENT') return false;
    throw e;
  }
}

/**
 * Resolves a sandbox path to a verified host path.
 *
 * - `existing`: the path must exist (else `not_found`); the final component is resolved too.
 * - `create`:   the path may not exist yet. The deepest existing ancestor is resolved and
 *               must lie inside the root; a dangling symlink anywhere on the way is
 *               refused (writing through it would create the target outside the root).
 *
 * @param rootDir sandbox `root/` directory on the host
 * @param base    directory relative sandbox paths are resolved against (the workspace path)
 */
export async function confine(
  rootDir: string,
  sandboxPath: string,
  base: string,
  mode: 'existing' | 'create',
): Promise<Confined> {
  const normalized = normalizeSandboxPath(sandboxPath, base);
  let rootReal: string;
  try {
    rootReal = await realpath(rootDir);
  } catch (e) {
    throw mapFsError(e, 'sandbox root');
  }
  const segments = normalized.split('/').filter(Boolean);
  const target = segments.length ? join(rootReal, ...segments) : rootReal;

  if (mode === 'existing') {
    let real: string;
    try {
      real = await realpath(target);
    } catch (e) {
      throw mapFsError(e, `'${normalized}'`);
    }
    if (!isInside(rootReal, real)) throw escapes(normalized, 'a symlink points outside the root');
    return { sandboxPath: normalized, hostPath: real };
  }

  // create: walk up to the deepest existing ancestor.
  const tail: string[] = [];
  let cur = target;
  for (;;) {
    try {
      const real = await realpath(cur);
      if (!isInside(rootReal, real)) throw escapes(normalized, 'a symlink points outside the root');
      return { sandboxPath: normalized, hostPath: tail.length ? join(real, ...tail.reverse()) : real };
    } catch (e) {
      if (e instanceof AboxError) throw e;
      if (errno(e) !== 'ENOENT') throw mapFsError(e, `'${normalized}'`);
    }
    if (await lstatExists(cur)) throw escapes(normalized, 'dangling symlink');
    if (cur === rootReal) throw mapFsError(Object.assign(new Error('sandbox root is missing'), { code: 'ENOENT' }), 'sandbox root');
    tail.push(basename(cur));
    cur = dirname(cur);
  }
}
