import { join } from 'node:path';
import { AboxError } from '../errors.js';
import type { SandboxRecord } from '../state/sandbox-registry.js';
import { canonicalizePath, checkHostPath } from '../policy/index.js';
import type { AgentContext } from '../policy/index.js';
import {
  applyPatchToTarget,
  buildPatch,
  buildReviewModel,
  checkPatch,
  checkTargetPath,
  dirtyPaths,
  exportWorkspace,
  expectedPatchNames,
  openTarget,
} from '../workspace/index.js';
import type {
  BuiltPatch,
  ChangeFile,
  ReviewModel,
  Target,
  WorkspaceRecord,
} from '../workspace/index.js';
import { isRealDirectory } from '../workspace/safefs.js';
import { targetRelative } from '../workspace/changes.js';
import type { Internals } from './internals.js';
import { applyChangesSchema, changesSelectionSchema } from './schemas.js';
import type {
  ApplyChangesParams,
  ApplyChangesResult,
  ApplyConfirmationRequired,
  ApplyPlan,
  Caller,
  ChangesPatchResult,
  ChangesSelectionParams,
  ChangesTarget,
  ChangesView,
} from './types.js';
import { errMessage, parseInput } from './util.js';

/**
 * Review and selective apply of a sandbox's changes. Human only, never reachable by agents (no MCP
 * tool, no agent context): applying writes into the user's own project, which is the one thing an
 * export deliberately never does.
 *
 * The caller names files and hunks and the digest of the diff it reviewed. The diff itself is always
 * recomputed here from the sandbox; a different digest is refused, and the patch is built from the
 * recomputed bytes (see workspace/changes.ts), never from anything the caller sends.
 */

/** Longest file list written to an audit entry (the count is always complete). */
const AUDIT_FILES = 200;

interface Loaded {
  rec: SandboxRecord;
  wsRec: WorkspaceRecord;
  model: ReviewModel;
  stats: ChangesView['stats'];
  ignored: ChangesView['ignored'];
  warnings: string[];
}

async function load(I: Internals, ctx: AgentContext, id: string): Promise<Loaded> {
  const rec = I.lookup(ctx, id);
  const wsRec = rec.workspace as WorkspaceRecord | null;
  if (!wsRec || wsRec.version !== 1) {
    throw new AboxError('unsupported', `sandbox ${id} has no recorded workspace`, {
      hint: 'Only sandboxes created with a workspace have changes to review.',
    });
  }
  const provider = await I.providerForRecord(rec);
  const result = await exportWorkspace({
    record: wsRec,
    provider,
    sandboxId: id,
    format: 'diff',
    keepRaw: true,
    tmpDir: join(I.paths.cacheDir, 'export'),
  });
  const model = buildReviewModel(result);
  return {
    rec,
    wsRec,
    model,
    stats: {
      filesChanged: result.stats.filesChanged,
      insertions: result.stats.insertions,
      deletions: result.stats.deletions,
    },
    ...(result.stats.ignored
      ? { ignored: { count: result.stats.ignored, paths: result.stats.ignoredPaths ?? [] } }
      : { ignored: undefined }),
    warnings: result.warnings,
  };
}

type Resolved = { ok: true; target: Target } | { ok: false; view: ChangesTarget };

/** The project the sandbox came from, checked again against the paths a human may use today. */
async function resolveTarget(
  I: Internals,
  ctx: AgentContext,
  wsRec: WorkspaceRecord,
): Promise<Resolved> {
  const no = (
    reason: NonNullable<ChangesTarget['reason']>,
    message: string,
    path?: string,
  ): Resolved => ({
    ok: false,
    view: { kind: 'unavailable', reason, message, ...(path ? { path } : {}), dirtyPaths: [] },
  });
  if (wsRec.mode === 'mount') {
    return no(
      'mount',
      'This sandbox works directly in the project (mount): its changes are already there.',
    );
  }
  if (!wsRec.source) {
    return no(
      'no_source',
      'The sandbox has no source project (empty workspace): use the export instead.',
    );
  }
  let dir: string;
  try {
    dir = canonicalizePath(wsRec.source, { home: I.home, cwd: I.home });
  } catch (e) {
    return no('not_allowed', errMessage(e));
  }
  const check = checkHostPath(dir, {
    home: I.home,
    roots: ctx.workspaceRoots,
    kind: 'workspace',
    extraForbidden: I.forbiddenTrees(),
  });
  if (!check.ok) {
    return no('not_allowed', `The project ${dir} is not an allowed target: ${check.reason}`, dir);
  }
  if (!(await isRealDirectory(dir))) {
    return no('missing', `The project directory ${dir} no longer exists.`, dir);
  }
  return { ok: true, target: await openTarget(dir) };
}

function affectedPaths(files: Array<Pick<ChangeFile, 'path' | 'oldPath'>>): string[] {
  const out = new Set<string>();
  for (const f of files) {
    out.add(f.path);
    if (f.oldPath) out.add(f.oldPath);
  }
  return [...out];
}

function planOf(built: BuiltPatch): Omit<ApplyPlan, 'target' | 'targetKind'> {
  const files = built.files.map((s) => {
    const adds = s.hunks.reduce((n, i) => n + (s.file.hunks[i]?.additions ?? 0), 0);
    const dels = s.hunks.reduce((n, i) => n + (s.file.hunks[i]?.deletions ?? 0), 0);
    return {
      path: s.file.path,
      ...(s.file.oldPath ? { oldPath: s.file.oldPath } : {}),
      status: s.file.status,
      hunks: s.hunks.length,
      totalHunks: s.file.hunks.length,
      // a whole file keeps the numbers git counted (binary files have none)
      insertions: s.whole ? s.file.insertions : adds,
      deletions: s.whole ? s.file.deletions : dels,
      badges: s.file.badges,
      flagged: s.file.needsConfirmation,
    };
  });
  return {
    files,
    insertions: files.reduce((n, f) => n + f.insertions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
    hunks: files.reduce((n, f) => n + f.hunks, 0),
    flaggedPaths: files.filter((f) => f.flagged).map((f) => f.path),
  };
}

function auditFiles(plan: Omit<ApplyPlan, 'target' | 'targetKind'>) {
  return {
    fileCount: plan.files.length,
    files: plan.files.slice(0, AUDIT_FILES).map((f) => ({
      path: f.path,
      status: f.status,
      hunks: f.hunks,
      totalHunks: f.totalHunks,
    })),
    insertions: plan.insertions,
    deletions: plan.deletions,
    flagged: plan.flaggedPaths.slice(0, AUDIT_FILES),
  };
}

// ---------------------------------------------------------------------------
// review
// ---------------------------------------------------------------------------

/** Human only. The changes of the sandbox as files and hunks, with flags, and what the target looks like. */
export async function reviewChanges(
  I: Internals,
  caller: Caller,
  id: string,
): Promise<ChangesView> {
  const ctx = await I.context(caller);
  I.requireHuman(ctx, 'sandbox.changes');
  const l = await load(I, ctx, id);
  const resolved = await resolveTarget(I, ctx, l.wsRec);
  let target: ChangesTarget;
  if (resolved.ok) {
    target = {
      kind: resolved.target.kind,
      path: resolved.target.dir,
      dirtyPaths: await dirtyPaths(resolved.target, affectedPaths(l.model.files)).catch(() => []),
    };
  } else {
    target = resolved.view;
  }
  I.audit(ctx.owner, 'sandbox.changes', {
    sandboxId: id,
    decision: 'allow',
    details: {
      digest: l.model.digest,
      files: l.model.files.length,
      flagged: l.model.files.filter((f) => f.needsConfirmation).length,
      target: target.kind,
    },
  });
  return {
    sandboxId: id,
    digest: l.model.digest,
    files: l.model.files,
    notices: l.model.notices,
    stats: l.stats,
    ...(l.ignored ? { ignored: l.ignored } : {}),
    warnings: l.warnings,
    target,
  };
}

// ---------------------------------------------------------------------------
// selection
// ---------------------------------------------------------------------------

function denyApply(
  I: Internals,
  ctx: AgentContext,
  action: string,
  id: string,
  e: AboxError,
  extra: Record<string, unknown> = {},
): never {
  I.audit(ctx.owner, action, {
    sandboxId: id,
    decision: 'deny',
    details: { reason: e.message.slice(0, 300), code: e.code, ...extra },
  });
  throw e;
}

/** Recomputes the diff, refuses a changed state and builds the patch of the selection. */
async function select(
  I: Internals,
  ctx: AgentContext,
  id: string,
  action: string,
  raw: ChangesSelectionParams,
): Promise<{ l: Loaded; built: BuiltPatch }> {
  const l = await load(I, ctx, id);
  if (raw.digest !== l.model.digest) {
    denyApply(
      I,
      ctx,
      action,
      id,
      new AboxError('conflict', 'the sandbox changed since you reviewed its changes', {
        hint: 'Reload the changes and select again; nothing was applied.',
        details: { stale: true },
      }),
    );
  }
  try {
    return { l, built: buildPatch(l.model, raw.selection) };
  } catch (e) {
    if (e instanceof AboxError) denyApply(I, ctx, action, id, e);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// patch (save as file)
// ---------------------------------------------------------------------------

/** Human only. The `git apply` patch of a selection (the GUI saves it through a file dialog). */
export async function changesPatch(
  I: Internals,
  caller: Caller,
  id: string,
  rawParams: ChangesSelectionParams,
): Promise<ChangesPatchResult> {
  const ctx = await I.context(caller);
  I.requireHuman(ctx, 'sandbox.changes_patch', id);
  const params = parseInput(changesSelectionSchema, rawParams, 'patch request');
  const { l, built } = await select(I, ctx, id, 'sandbox.changes_patch', params);
  const plan = planOf(built);
  I.audit(ctx.owner, 'sandbox.changes_patch', {
    sandboxId: id,
    decision: 'allow',
    details: { digest: l.model.digest, bytes: built.patch.length, ...auditFiles(plan) },
  });
  return { sandboxId: id, digest: l.model.digest, patch: built.patch, plan };
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

/**
 * Human only. Applies the selected files / hunks to the project the sandbox was created from.
 *
 * Refused (nothing written): a digest that does not match the sandbox's current diff; files that cannot
 * be applied; flagged files the human did not confirm one by one (`acknowledgeFlagged`); a project that
 * is not a git repository unless `allowNonGit`; uncommitted changes in any affected file; paths with
 * `..`, `.git`, symbolic links or nested repositories; a patch that does not apply cleanly. The write is
 * all-or-nothing (`git apply`). Without `humanConfirmed` nothing is written either: the checked plan comes
 * back as `confirmation_required` and the call is repeated once the human accepted it. `dryRun` runs all
 * checks and reports the plan without asking and without writing.
 */
export async function applyChanges(
  I: Internals,
  caller: Caller,
  id: string,
  rawParams: ApplyChangesParams,
): Promise<ApplyChangesResult | ApplyConfirmationRequired> {
  const ctx = await I.context(caller);
  I.requireHuman(ctx, 'sandbox.apply', id);
  const params = parseInput(applyChangesSchema, rawParams, 'apply request');
  const { l, built } = await select(I, ctx, id, 'sandbox.apply', params);
  const plan = planOf(built);
  const fail: (e: AboxError) => never = (e) =>
    denyApply(I, ctx, 'sandbox.apply', id, e, { digest: l.model.digest, ...auditFiles(plan) });

  // flagged files: confirmed one by one
  const acknowledged = new Set(params.acknowledgeFlagged ?? []);
  const unconfirmed = plan.flaggedPaths.filter((p) => !acknowledged.has(p));
  if (unconfirmed.length > 0) {
    fail(
      new AboxError(
        'policy_denied',
        `${unconfirmed.length} selected file(s) need an explicit confirmation: ${unconfirmed.slice(0, 5).join(', ')}${unconfirmed.length > 5 ? ', …' : ''}`,
        {
          hint: 'Executables, dependency manifests, hooks, CI files, build scripts, links and binary files run or fetch code on your machine. Confirm each one, or deselect it.',
          details: { unconfirmed: unconfirmed.slice(0, 50) },
        },
      ),
    );
  }

  const resolved = await resolveTarget(I, ctx, l.wsRec);
  if (!resolved.ok) {
    fail(new AboxError('unsupported', resolved.view.message ?? 'no target to apply to'));
  }
  const target = resolved.target;
  if (target.kind === 'plain' && params.allowNonGit !== true) {
    fail(
      new AboxError(
        'policy_denied',
        `${target.dir} is not a git repository: uncommitted work in it cannot be detected, so applying needs an extra confirmation`,
        {
          hint: 'Commit-track the project with git, or confirm that the affected files hold no unsaved work (--allow-non-git).',
          details: { nonGit: true },
        },
      ),
    );
  }

  const affected = affectedPaths(built.files.map((s) => s.file));
  const dirty = await dirtyPaths(target, affected);
  if (dirty.length > 0) {
    fail(
      new AboxError(
        'conflict',
        `the project has uncommitted changes in ${dirty.length} affected file(s): ${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? ', …' : ''}`,
        {
          hint: 'Commit, stash or discard them first, or deselect these files. Nothing was written.',
          details: { dirty: dirty.slice(0, 50) },
        },
      ),
    );
  }

  const seen = new Map<string, 'ok'>();
  try {
    for (const s of built.files) {
      const f = s.file;
      await checkTargetPath(target, targetRelative(f.path), f.status !== 'added', seen);
      if (f.oldPath) await checkTargetPath(target, targetRelative(f.oldPath), true, seen);
    }
    await checkPatch(target, built.patch, expectedPatchNames(built.files));
  } catch (e) {
    if (e instanceof AboxError) fail(e);
    throw e;
  }

  const full: ApplyPlan = { target: target.dir, targetKind: target.kind, ...plan };
  const summary = `${plan.files.length} file(s), ${plan.hunks} hunk(s), +${plan.insertions} -${plan.deletions}`;

  if (params.dryRun === true) {
    I.audit(ctx.owner, 'sandbox.apply', {
      sandboxId: id,
      decision: 'allow',
      details: {
        dryRun: true,
        digest: l.model.digest,
        target: target.dir,
        targetKind: target.kind,
        ...auditFiles(plan),
      },
    });
    return {
      status: 'dry_run',
      sandboxId: id,
      digest: l.model.digest,
      plan: full,
      message: `Would apply ${summary} to ${target.dir}. Nothing was written.`,
    };
  }

  if (caller.humanConfirmed !== true) {
    const reasons = [`Apply ${summary} to ${target.dir}`];
    const risks: string[] = [];
    if (plan.flaggedPaths.length > 0) {
      risks.push(
        `Flagged files are included and can run or fetch code on this machine: ${plan.flaggedPaths.join(', ')}`,
      );
    }
    if (target.kind === 'plain') {
      risks.push(
        'The project is not a git repository: there is no history to restore the previous state from.',
      );
    }
    return {
      status: 'confirmation_required',
      reasons,
      risks,
      items: [],
      plan: full,
      message:
        'This writes into your project. Show the plan, then repeat the call with humanConfirmed: true.',
    };
  }

  try {
    await applyPatchToTarget(target, built.patch);
  } catch (e) {
    I.audit(ctx.owner, 'sandbox.apply', {
      sandboxId: id,
      decision: 'error',
      details: {
        digest: l.model.digest,
        target: target.dir,
        message: errMessage(e).slice(0, 500),
        ...auditFiles(plan),
      },
    });
    throw e;
  }
  I.audit(ctx.owner, 'sandbox.apply', {
    sandboxId: id,
    decision: 'allow',
    details: {
      dryRun: false,
      digest: l.model.digest,
      target: target.dir,
      targetKind: target.kind,
      acknowledged: plan.flaggedPaths.length,
      ...auditFiles(plan),
    },
  });
  return {
    status: 'applied',
    sandboxId: id,
    digest: l.model.digest,
    plan: full,
    message: `Applied ${summary} to ${target.dir}.`,
  };
}
