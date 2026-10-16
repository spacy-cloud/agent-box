import { lstat, mkdir, rm, stat } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { AboxError } from '../errors.js';
import type { WorkspaceDelivery } from '../types.js';
import { compileExcludes } from './glob.js';
import { captureGitMarker } from './gitmarker.js';
import { assertSafeRev, locateRepo, resolveCommit, runGit, type RepoLocation } from './git.js';
import { initBareRepo, type ObjectFormat } from './objstore.js';
import { copyTreeSafely, createBaselineFromTree, writeManifest } from './snapshot.js';
import type { PrepareWorkspaceInput, PrepareWorkspaceResult, WorkspaceRecord } from './types.js';

/**
 * Host-side workspace preparation. See the per-mode notes below; the security model is:
 * the host never runs anything from a sandbox-writable directory, every git call uses
 * hardened settings (see git.ts) and explicit host-owned git dirs.
 *
 * - `empty`    nothing to prepare.
 * - `mount`    bind of the source. `.git` (and submodule `.git` entries) are read-only for the
 *              sandbox. Baseline = HEAD commit in the user's repository (non-git source:
 *              snapshot of the directory taken now). Not available on remote hosts.
 *              Uncommitted changes present at creation are part of the diff against HEAD.
 * - `worktree` `git worktree add -b abox/<short>` into `<sandboxDir>/worktree`, bound rw with the
 *              worktree `.git` file read-only. The `.git` file points to the host's admin dir
 *              which does not exist inside a container, so git does not work inside the sandbox
 *              (changes are plain file edits). Not available on remote hosts (yet).
 *              Filter drivers configured in the user's own repository config (e.g. git-lfs) are
 *              honoured by the checkout; tracked `.gitattributes` alone cannot run anything.
 * - `clone`    an independent repository at `<sandboxDir>/staging` (own objects via
 *              `--no-local`-equivalent fetch, no hooks, no remote, branch `abox/<short>`), delivered
 *              as `copy`. Baseline = pristine bare repo `<sandboxDir>/baseline.git`. Uncommitted
 *              changes of the source and submodule contents are not included. For remote hosts
 *              the staging dir is created locally and uploaded by the provider.
 * - `copy`     source copied to `<sandboxDir>/staging` without following symlinks. Default: nothing
 *   `sync`     excluded (so a source `.git` including hooks and remote URLs IS copied — pass
 *              `exclude: ['.git']` to avoid it; a warning is emitted). `sync` currently has initial-
 *              copy semantics (one-way, no later re-sync); it is meant for remote hosts.
 *              Baseline = snapshot commit of the staging dir + JSON manifest.
 */

const DEFAULT_LIMITS = {
  maxEntries: 2_000_000,
  maxFileBytes: 4 * 1024 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024 * 1024,
};

function sanitizeShort(raw: string): string {
  const s = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return s || 'sandbox';
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function treeOf(gitDir: string, commit: string): Promise<string> {
  return (
    await runGit(['rev-parse', '--verify', '--end-of-options', `${commit}^{tree}`], { gitDir })
  ).stdout.trim();
}

async function requireRepo(source: string): Promise<RepoLocation> {
  if (!(await pathExists(join(source, '.git')))) {
    throw new AboxError(
      'invalid_input',
      `source ${source} is not the top level of a git repository`,
      {
        hint: 'use workspace mode copy or mount for directories without .git',
      },
    );
  }
  const repo = await locateRepo(source);
  if (!repo) throw new AboxError('invalid_input', `source ${source} contains an unusable .git`);
  return repo;
}

export async function prepareWorkspace(
  input: PrepareWorkspaceInput,
): Promise<PrepareWorkspaceResult> {
  const { mode } = input;
  if (!isAbsolute(input.sandboxDir))
    throw new AboxError('invalid_input', 'sandboxDir must be an absolute path');
  if (!input.sandboxPath.startsWith('/') || input.sandboxPath.includes('\0')) {
    throw new AboxError('invalid_input', 'sandboxPath must be an absolute path inside the sandbox');
  }
  if (mode !== 'empty') {
    if (!input.source || !isAbsolute(input.source)) {
      throw new AboxError('invalid_input', `workspace mode ${mode} needs an absolute source path`);
    }
    if (!(await isDir(input.source))) {
      throw new AboxError('invalid_input', `workspace source ${input.source} is not a directory`);
    }
  }
  if (input.remote && mode === 'mount') {
    throw new AboxError(
      'unsupported',
      'workspace mode mount is not available on remote hosts; use clone, copy or sync',
    );
  }
  if (input.remote && mode === 'worktree') {
    throw new AboxError(
      'unsupported',
      'workspace mode worktree is not available on remote hosts yet; use clone, copy or sync',
    );
  }
  if (input.ref !== undefined) assertSafeRev(input.ref, 'workspace ref');

  const short = sanitizeShort(input.short ?? basename(input.sandboxDir));
  await mkdir(input.sandboxDir, { recursive: true, mode: 0o700 });
  const scratch = join(input.sandboxDir, 'tmp');
  await mkdir(scratch, { recursive: true, mode: 0o700 });

  const rollback: Array<() => Promise<void>> = [];
  const warnings: string[] = [];
  const base = {
    version: 1 as const,
    mode,
    short,
    sandboxDir: input.sandboxDir,
    sandboxPath: input.sandboxPath,
    access: input.access,
    remote: input.remote,
    ...(input.source ? { source: input.source } : {}),
    ...(input.ref ? { ref: input.ref } : {}),
    exclude: [...(input.exclude ?? [])],
    createdAt: Date.now(),
  };

  try {
    let result: { delivery: WorkspaceDelivery; record: WorkspaceRecord };
    switch (mode) {
      case 'empty':
        result = {
          delivery: { kind: 'none', sandboxPath: input.sandboxPath },
          record: { ...base, baseline: { kind: 'empty', objectFormat: 'sha1' } },
        };
        break;
      case 'mount':
        result = await prepareMount(input, base, warnings, scratch, rollback);
        break;
      case 'worktree':
        result = await prepareWorktree(input, base, warnings, rollback);
        break;
      case 'clone':
        result = await prepareClone(input, base, warnings, rollback);
        break;
      case 'copy':
      case 'sync':
        result = await prepareCopy(input, base, warnings, scratch, rollback);
        break;
      default:
        throw new AboxError('invalid_input', `unknown workspace mode ${String(mode)}`);
    }
    await rm(scratch, { recursive: true, force: true });
    return { ...result, warnings };
  } catch (e) {
    for (const undo of rollback.reverse()) {
      try {
        await undo();
      } catch {
        /* best effort */
      }
    }
    await rm(scratch, { recursive: true, force: true });
    throw e;
  }
}

type RecordBase = Omit<WorkspaceRecord, 'baseline'>;

// ---------------------------------------------------------------------------

async function prepareMount(
  input: PrepareWorkspaceInput,
  base: RecordBase,
  warnings: string[],
  scratch: string,
  rollback: Array<() => Promise<void>>,
): Promise<{ delivery: WorkspaceDelivery; record: WorkspaceRecord }> {
  const source = input.source as string;
  const hasGit = await pathExists(join(source, '.git'));
  if (!hasGit) {
    // Non-git directory: take a snapshot now so that an export has something to compare with.
    const baselineDir = join(input.sandboxDir, 'baseline.git');
    rollback.push(() => rm(baselineDir, { recursive: true, force: true }));
    const created = await createBaselineFromTree(source, baselineDir, scratch, {
      withSha256: true,
      limits: DEFAULT_LIMITS,
      message: 'abox baseline (mount)',
    });
    const manifest = await writeManifest(
      join(input.sandboxDir, 'baseline-manifest.json'),
      created.snapshot,
    );
    warnings.push(
      `source is not a git repository: baseline snapshot of ${manifest.files} files taken`,
    );
    return {
      delivery: {
        kind: 'bind',
        hostPath: source,
        sandboxPath: input.sandboxPath,
        access: input.access,
      },
      record: {
        ...base,
        liveTree: source,
        baseline: {
          kind: 'git',
          gitDir: baselineDir,
          commit: created.commit,
          tree: created.tree,
          objectFormat: 'sha1',
        },
        manifest,
      },
    };
  }

  const repo = await requireRepo(source);
  const head = await resolveCommit(repo.gitDir, 'HEAD');
  const tree = await treeOf(repo.gitDir, head);
  const marker = await captureGitMarker(source);

  // read-only subpaths: .git plus the .git entry of every submodule checkout
  const readonlySubpaths = ['.git'];
  const ls = await runGit(['ls-files', '-s', '-z'], {
    gitDir: repo.gitDir,
    workTree: source,
    allowFailure: true,
  });
  if (ls.code === 0) {
    for (const rec of ls.stdout.split('\0')) {
      const tab = rec.indexOf('\t');
      if (tab < 0 || !rec.startsWith('160000 ')) continue;
      const sub = rec.slice(tab + 1);
      if (sub.startsWith('/') || sub.split('/').includes('..')) continue;
      if (await pathExists(join(source, sub, '.git'))) readonlySubpaths.push(`${sub}/.git`);
    }
  }
  const st = await runGit(['status', '--porcelain', '-z', '--untracked-files=no'], {
    gitDir: repo.gitDir,
    workTree: source,
    allowFailure: true,
  });
  if (st.code === 0 && st.stdout.length > 0) {
    warnings.push(
      'source has uncommitted changes; an export diff (against HEAD) will include them',
    );
  }
  warnings.push(
    'untracked nested git repositories inside the source stay writable for the sandbox',
  );

  return {
    delivery: {
      kind: 'bind',
      hostPath: source,
      sandboxPath: input.sandboxPath,
      access: input.access,
      readonlySubpaths,
    },
    record: {
      ...base,
      liveTree: source,
      baseline: {
        kind: 'git',
        gitDir: repo.commonDir,
        commit: head,
        tree,
        objectFormat: repo.objectFormat,
      },
      sourceGit: { gitDir: repo.commonDir, head, objectFormat: repo.objectFormat },
      ...(marker ? { gitMarker: marker } : {}),
      readonlySubpaths,
    },
  };
}

// ---------------------------------------------------------------------------

async function prepareWorktree(
  input: PrepareWorkspaceInput,
  base: RecordBase,
  warnings: string[],
  rollback: Array<() => Promise<void>>,
): Promise<{ delivery: WorkspaceDelivery; record: WorkspaceRecord }> {
  const source = input.source as string;
  const repo = await requireRepo(source);
  const commit = await resolveCommit(repo.gitDir, input.ref ?? 'HEAD');
  const tree = await treeOf(repo.gitDir, commit);
  const branch = `abox/${base.short}`;
  const wt = join(input.sandboxDir, 'worktree');
  if (await pathExists(wt)) throw new AboxError('conflict', `worktree path ${wt} already exists`);
  const exists = await runGit(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
    gitDir: repo.commonDir,
    allowFailure: true,
  });
  if (exists.code === 0) {
    throw new AboxError('conflict', `branch ${branch} already exists in ${source}`, {
      hint: 'remove the stale branch or pick another sandbox name',
    });
  }

  rollback.push(async () => {
    await runGit(['worktree', 'remove', '--force', wt], {
      gitDir: repo.gitDir,
      allowFailure: true,
    });
    await rm(wt, { recursive: true, force: true });
    await runGit(['worktree', 'prune'], { gitDir: repo.gitDir, allowFailure: true });
    await runGit(['branch', '-D', '--', branch], { gitDir: repo.commonDir, allowFailure: true });
  });
  await runGit(['worktree', 'add', '--quiet', '--no-track', '-b', branch, wt, commit], {
    gitDir: repo.gitDir,
    cwd: input.sandboxDir,
  });

  const marker = await captureGitMarker(wt);
  if (!marker || marker.kind !== 'file') {
    throw new AboxError('internal', 'git worktree add did not create a .git file');
  }
  const m = /^gitdir:\s*(.+)$/m.exec(marker.content);
  const adminDir = m?.[1]?.trim() ?? '';
  warnings.push(
    'git does not work inside the sandbox in worktree mode (the worktree .git file points to a host path)',
  );
  if (repo.gitDir !== repo.commonDir)
    warnings.push('source is itself a linked worktree; branch is created in the main repository');

  return {
    delivery: {
      kind: 'bind',
      hostPath: wt,
      sandboxPath: input.sandboxPath,
      access: input.access,
      readonlySubpaths: ['.git'],
    },
    record: {
      ...base,
      liveTree: wt,
      baseline: {
        kind: 'git',
        gitDir: repo.commonDir,
        commit,
        tree,
        objectFormat: repo.objectFormat,
      },
      sourceGit: { gitDir: repo.commonDir, head: commit, objectFormat: repo.objectFormat },
      branch,
      worktree: { path: wt, adminDir },
      gitMarker: marker,
      readonlySubpaths: ['.git'],
    },
  };
}

// ---------------------------------------------------------------------------

async function prepareClone(
  input: PrepareWorkspaceInput,
  base: RecordBase,
  warnings: string[],
  rollback: Array<() => Promise<void>>,
): Promise<{ delivery: WorkspaceDelivery; record: WorkspaceRecord }> {
  const source = input.source as string;
  const repo = await requireRepo(source);
  const commit = await resolveCommit(repo.gitDir, input.ref ?? 'HEAD');
  const tree = await treeOf(repo.gitDir, commit);
  const fmt: ObjectFormat = repo.objectFormat;
  const branch = `abox/${base.short}`;
  const baselineDir = join(input.sandboxDir, 'baseline.git');
  const staging = join(input.sandboxDir, 'staging');
  if (await pathExists(staging))
    throw new AboxError('conflict', `staging path ${staging} already exists`);
  if (await pathExists(baselineDir))
    throw new AboxError('conflict', `baseline path ${baselineDir} already exists`);

  rollback.push(async () => {
    await rm(baselineDir, { recursive: true, force: true });
    await rm(staging, { recursive: true, force: true });
  });

  // 1. host-owned pristine baseline: only the base commit and its history, copied (not hardlinked)
  await initBareRepo(baselineDir, fmt);
  await runGit(
    [
      'fetch',
      '--quiet',
      '--no-tags',
      '--no-recurse-submodules',
      source,
      `${commit}:refs/abox/base`,
    ],
    {
      gitDir: baselineDir,
      cwd: input.sandboxDir,
    },
  );

  // 2. the sandbox's own repository: no template (no hooks), no remote, hooks disabled for checkout
  await mkdir(staging, { mode: 0o700 });
  const stagingGit = join(staging, '.git');
  await runGit(['init', '--quiet', '--template=', staging], { cwd: input.sandboxDir });
  await runGit(['fetch', '--quiet', '--no-tags', baselineDir, '+refs/abox/base:refs/abox/base'], {
    gitDir: stagingGit,
    cwd: staging,
  });
  await runGit(['checkout', '--quiet', '-b', branch, commit], {
    gitDir: stagingGit,
    workTree: staging,
    cwd: staging,
  });
  await runGit(['update-ref', '-d', 'refs/abox/base'], { gitDir: stagingGit, allowFailure: true });

  warnings.push(
    'clone contains committed state only: uncommitted changes and submodule contents of the source are not included',
  );
  return {
    delivery: { kind: 'copy', hostPath: staging, sandboxPath: input.sandboxPath },
    record: {
      ...base,
      baseline: { kind: 'git', gitDir: baselineDir, commit, tree, objectFormat: fmt },
      sourceGit: { gitDir: repo.commonDir, head: commit, objectFormat: fmt },
      branch,
      staging,
    },
  };
}

// ---------------------------------------------------------------------------

async function prepareCopy(
  input: PrepareWorkspaceInput,
  base: RecordBase,
  warnings: string[],
  scratch: string,
  rollback: Array<() => Promise<void>>,
): Promise<{ delivery: WorkspaceDelivery; record: WorkspaceRecord }> {
  const source = input.source as string;
  const staging = join(input.sandboxDir, 'staging');
  const baselineDir = join(input.sandboxDir, 'baseline.git');
  if (await pathExists(staging))
    throw new AboxError('conflict', `staging path ${staging} already exists`);
  rollback.push(async () => {
    await rm(staging, { recursive: true, force: true });
    await rm(baselineDir, { recursive: true, force: true });
    await rm(join(input.sandboxDir, 'baseline-manifest.json'), { force: true });
  });

  const exclude = compileExcludes(input.exclude);
  const copied = await copyTreeSafely(source, staging, {
    exclude,
    limits: DEFAULT_LIMITS,
    gitMode: 'visit',
  });

  // optional link to the user's repository (target of branch exports)
  let sourceGit: WorkspaceRecord['sourceGit'];
  let repo: RepoLocation | undefined;
  if (await pathExists(join(source, '.git'))) {
    repo = await locateRepo(source);
    if (repo) {
      const head = await runGit(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], {
        gitDir: repo.gitDir,
        allowFailure: true,
      });
      if (head.code === 0)
        sourceGit = {
          gitDir: repo.commonDir,
          head: head.stdout.trim(),
          objectFormat: repo.objectFormat,
        };
    }
  }

  const created = await createBaselineFromTree(staging, baselineDir, scratch, {
    fmt: repo?.objectFormat ?? 'sha1',
    withSha256: true,
    limits: DEFAULT_LIMITS,
    message: `abox baseline (${base.mode})`,
  });
  const manifest = await writeManifest(
    join(input.sandboxDir, 'baseline-manifest.json'),
    created.snapshot,
  );

  if (await pathExists(join(staging, '.git'))) {
    warnings.push(
      'the source .git was copied into the sandbox (history, config with remote URLs, hooks); use exclude: [".git"] to avoid this',
    );
  }
  if (copied.escapingSymlinks.length > 0) {
    warnings.push(
      `${copied.escapingSymlinks.length} symlink(s) point outside the source and were copied as links (e.g. ${copied.escapingSymlinks[0]})`,
    );
  }
  for (const s of copied.walk.skipped) warnings.push(`not copied: ${s.path} (${s.reason})`);
  if (sourceGit) {
    const headTree = await treeOf(sourceGit.gitDir, sourceGit.head).catch(() => '');
    if (headTree !== created.tree) {
      warnings.push(
        'the copied files differ from the source HEAD (uncommitted changes, excludes or ignored files); a branch export will contain those differences',
      );
    }
  }
  if (base.mode === 'sync' && !input.remote)
    warnings.push('sync is meant for remote hosts; behaving like copy');

  return {
    delivery: { kind: 'copy', hostPath: staging, sandboxPath: input.sandboxPath },
    record: {
      ...base,
      baseline: {
        kind: 'git',
        gitDir: baselineDir,
        commit: created.commit,
        tree: created.tree,
        objectFormat: repo?.objectFormat ?? 'sha1',
      },
      ...(sourceGit ? { sourceGit } : {}),
      manifest,
      staging,
    },
  };
}

// ---------------------------------------------------------------------------

/**
 * Removes host-side artifacts of a workspace (worktree registration and branch, baseline,
 * staging, manifest). The `abox/<short>` branch is only deleted when it still points at the
 * base commit (no work would be lost). Does not remove `sandboxDir` itself.
 */
export async function cleanupWorkspace(record: WorkspaceRecord): Promise<void> {
  if (record.worktree && record.sourceGit) {
    const wt = record.worktree.path;
    await runGit(['worktree', 'remove', '--force', wt], {
      gitDir: record.sourceGit.gitDir,
      allowFailure: true,
    });
    await rm(wt, { recursive: true, force: true });
    await runGit(['worktree', 'prune'], { gitDir: record.sourceGit.gitDir, allowFailure: true });
    if (record.branch) {
      const tip = await runGit(
        ['rev-parse', '--verify', '--quiet', `refs/heads/${record.branch}`],
        {
          gitDir: record.sourceGit.gitDir,
          allowFailure: true,
        },
      );
      if (tip.code === 0 && tip.stdout.trim() === record.sourceGit.head) {
        await runGit(['branch', '-D', '--', record.branch], {
          gitDir: record.sourceGit.gitDir,
          allowFailure: true,
        });
      }
    }
  }
  const dirs = [
    record.staging,
    join(record.sandboxDir, 'baseline.git'),
    join(record.sandboxDir, 'tmp'),
  ];
  for (const d of dirs) if (d) await rm(d, { recursive: true, force: true });
  if (record.manifest) await rm(record.manifest.path, { force: true });
}
