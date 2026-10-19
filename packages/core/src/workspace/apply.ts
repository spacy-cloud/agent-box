import { lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { AboxError } from '../errors.js';
import { driverNeutralizingEnv, locateRepo, runGit } from './git.js';
import { isDotGitLike, isRealDirectory } from './safefs.js';

/**
 * Applies a patch (built by `buildPatch` from the sandbox's own diff) to the project the sandbox was
 * created from. Nothing here parses sandbox data: the patch is host-built, the paths are checked again
 * and git does the writing.
 *
 * - `git apply` without `--index`, so the index, HEAD and refs are never touched; argv only, no shell,
 *   hardened git config (see git.ts), every filter/textconv driver of the repository switched off;
 * - `git apply` is all-or-nothing: it checks every file before it writes the first one. It is run
 *   with `--check` first, so a failure is reported before anything changes;
 * - no `--unsafe-paths`: git itself refuses `..`, absolute paths and paths beyond a symlink; this module
 *   additionally refuses `.git` components, existing links along a path and nested repositories;
 * - the paths git reports for the patch are compared with the expected set, so a header git reads
 *   differently than abox built it cannot widen the change.
 */

export type TargetKind = 'git' | 'plain';

export interface Target {
  /** Canonical absolute project directory. */
  dir: string;
  kind: TargetKind;
  gitDir?: string;
}

/** The project directory: must be a real directory; a git repository only when it is its own top level. */
export async function openTarget(dir: string): Promise<Target> {
  if (!(await isRealDirectory(dir))) {
    throw new AboxError('not_found', `the project directory ${dir} no longer exists`, {
      hint: 'The changes can only be applied to the project the sandbox was created from.',
    });
  }
  // locateRepo looks at `dir` itself only (its parent is a git ceiling): a project that is a
  // subdirectory of a repository counts as a plain directory.
  const repo = await locateRepo(dir);
  if (repo) return { dir, kind: 'git', gitDir: repo.gitDir };
  return { dir, kind: 'plain' };
}

function gitEnv(target: Target): Promise<Record<string, string>> {
  return target.gitDir ? driverNeutralizingEnv(target.gitDir) : Promise.resolve({});
}

function gitOpts(target: Target, env: Record<string, string>) {
  return {
    cwd: target.dir,
    ...(target.gitDir ? { gitDir: target.gitDir, workTree: target.dir } : {}),
    env: { GIT_CEILING_DIRECTORIES: dirname(target.dir), ...env },
  };
}

/**
 * The paths among `paths` that have uncommitted changes in the project (modified, staged, deleted,
 * untracked, conflicted). Only meaningful for a git target.
 */
export async function dirtyPaths(target: Target, paths: string[]): Promise<string[]> {
  if (target.kind !== 'git' || paths.length === 0) return [];
  const env = await gitEnv(target);
  const r = await runGit(
    [
      'status',
      '--porcelain=v1',
      '-z',
      '--no-renames',
      '--untracked-files=normal',
      '--ignore-submodules=all',
    ],
    { ...gitOpts(target, env), maxStdoutBytes: 64 * 1024 * 1024 },
  );
  const entries = r.raw
    .toString('utf8')
    .split('\0')
    .filter((e) => e.length > 3)
    .map((e) => e.slice(3));
  const dirty = new Set<string>();
  for (const p of paths) {
    for (const e of entries) {
      // an untracked directory is listed once, with a trailing slash
      if (e === p || (e.endsWith('/') && p.startsWith(e))) {
        dirty.add(p);
        break;
      }
    }
  }
  return [...dirty].sort();
}

/**
 * Refuses a path that would be written through a symbolic link, into `.git`, into a nested repository
 * or over something that is not a regular file. `rel` is the validated relative path.
 */
export async function checkTargetPath(
  target: Target,
  rel: string,
  mustExist: boolean,
  cache: Map<string, 'ok'>,
): Promise<void> {
  const segs = rel.split('/');
  for (const seg of segs) {
    if (seg === '' || seg === '.' || seg === '..' || isDotGitLike(seg)) {
      throw new AboxError('policy_denied', `refused path ${JSON.stringify(rel)}`, {
        hint: 'Paths with .., empty parts or .git are never written.',
      });
    }
  }
  let cur = target.dir;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i] as string;
    cur = join(cur, seg);
    const last = i === segs.length - 1;
    let st;
    try {
      st = await lstat(cur);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        if (last && mustExist) {
          throw new AboxError('conflict', `${rel} does not exist in the project`, {
            hint: 'The project changed since the sandbox was created; review the changes again.',
          });
        }
        return; // the rest does not exist yet; git creates it
      }
      throw e;
    }
    if (st.isSymbolicLink()) {
      throw new AboxError(
        'policy_denied',
        `refused: ${JSON.stringify(rel)} would be written through a symbolic link (${JSON.stringify(segs.slice(0, i + 1).join('/'))})`,
      );
    }
    if (!last) {
      if (!st.isDirectory()) {
        throw new AboxError('conflict', `${segs.slice(0, i + 1).join('/')} is not a directory`);
      }
      if (!cache.has(cur)) {
        const nested = await lstat(join(cur, '.git')).then(
          () => true,
          () => false,
        );
        if (nested) {
          throw new AboxError(
            'policy_denied',
            `refused: ${JSON.stringify(rel)} lies inside a nested repository (${JSON.stringify(segs.slice(0, i + 1).join('/'))})`,
          );
        }
        cache.set(cur, 'ok');
      }
    } else if (!st.isFile()) {
      throw new AboxError('conflict', `${rel} is not a regular file in the project`);
    }
  }
}

/** Runs the git checks of a patch without changing anything. Throws `conflict` when it does not apply. */
export async function checkPatch(
  target: Target,
  patch: Buffer,
  expectedNames: string[],
): Promise<void> {
  const env = await gitEnv(target);
  const o = gitOpts(target, env);
  const names = await runGit(['apply', '--numstat', '-z', '-'], { ...o, input: patch });
  const got = names.stdout
    .split('\0')
    .filter(Boolean)
    .map((e) => e.replace(/^(-|\d+)\t(-|\d+)\t/, ''))
    .sort();
  if (JSON.stringify(got) !== JSON.stringify(expectedNames)) {
    throw new AboxError('internal', 'refused: the patch touches other files than selected', {
      details: { expected: expectedNames.length, got: got.length },
    });
  }
  const r = await runGit(['apply', '--check', '--whitespace=nowarn', '-'], {
    ...o,
    input: patch,
    allowFailure: true,
  });
  if (r.code !== 0) {
    throw new AboxError(
      'conflict',
      `the changes do not apply to the project: ${r.stderr.trim().split('\n').slice(0, 4).join(' ').slice(0, 600)}`,
      {
        hint: 'The project differs from the state the sandbox started from. Nothing was changed.',
      },
    );
  }
}

/** Applies the patch. All files or none (git checks all of them before writing). */
export async function applyPatchToTarget(target: Target, patch: Buffer): Promise<void> {
  const env = await gitEnv(target);
  const r = await runGit(['apply', '--whitespace=nowarn', '-'], {
    ...gitOpts(target, env),
    input: patch,
    allowFailure: true,
  });
  if (r.code !== 0) {
    throw new AboxError(
      'backend_error',
      `applying the changes failed: ${r.stderr.trim().split('\n').slice(0, 4).join(' ').slice(0, 600)}`,
      {
        hint: 'git apply checks everything before it writes; check the project for a partial change.',
      },
    );
  }
}
