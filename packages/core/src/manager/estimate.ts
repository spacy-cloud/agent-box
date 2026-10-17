import { stat } from 'node:fs/promises';
import { AboxError } from '../errors.js';
import { canonicalizePath, checkHostPath } from '../policy/index.js';
import { compileExcludes, scanTree, WORKSPACE_COPY_LIMITS } from '../workspace/index.js';
import { describeScan } from '../workspace/index.js';
import type { ProgressInfo } from '../workspace/index.js';
import type { Internals } from './internals.js';
import { workspaceEstimateSchema } from './schemas.js';
import type { Caller, WorkspaceEstimate, WorkspaceEstimateInput } from './types.js';
import { errMessage, parseInput } from './util.js';

/**
 * Human only. The fast, read-only pre-scan of a workspace folder (`readdir` + `lstat`, no file is
 * opened, no link followed) that a create runs before it copies: the GUI shows the result when the
 * folder is picked. The folder has to pass the same path check as a workspace (forbidden paths,
 * roots), so nothing is walked that a create would refuse.
 */
export async function estimateWorkspace(
  I: Internals,
  caller: Caller,
  input: WorkspaceEstimateInput,
  opts: { signal?: AbortSignal; onProgress?: (line: string, info?: ProgressInfo) => void } = {},
): Promise<WorkspaceEstimate> {
  const ctx = await I.context(caller);
  I.requireHuman(ctx, 'workspace.estimate');
  const req = parseInput(workspaceEstimateSchema, input, 'workspace estimate request');
  const mode = req.mode ?? 'copy';
  const base = I.projectDir ?? process.cwd();
  const path = canonicalizePath(req.path, { home: I.home, cwd: base });
  const check = checkHostPath(path, {
    home: I.home,
    roots: ctx.workspaceRoots,
    kind: 'workspace',
    extraForbidden: I.forbiddenTrees(),
  });
  if (!check.ok) throw new AboxError('policy_denied', check.reason, { hint: check.hint });
  let isDir: boolean;
  try {
    isDir = (await stat(path)).isDirectory();
  } catch (e) {
    throw new AboxError(
      'invalid_input',
      `workspace folder ${path} cannot be read: ${errMessage(e)}`,
    );
  }
  if (!isDir) throw new AboxError('invalid_input', `workspace source ${path} is not a directory`);

  const soft = {
    bytes: ctx.profile.workspace.maxCopyBytes,
    entries: ctx.profile.workspace.max_copy_entries,
  };
  const hard = {
    bytes: WORKSPACE_COPY_LIMITS.maxTotalBytes,
    entries: WORKSPACE_COPY_LIMITS.maxEntries,
  };
  if (mode !== 'copy' && mode !== 'sync') {
    return {
      path,
      mode,
      applicable: false,
      bytes: 0,
      entries: 0,
      files: 0,
      truncated: false,
      overSoftLimit: false,
      overHardLimit: false,
      soft,
      hard,
      durationMs: 0,
    };
  }
  const scan = await scanTree(path, {
    exclude: compileExcludes(req.exclude),
    gitMode: 'visit',
    ...(opts.signal ? { signal: opts.signal } : {}),
    onProgress: (p) =>
      opts.onProgress?.(`scanning workspace … ${describeScan(p)}`, {
        phase: 'scan',
        done: p.bytes,
      }),
  });
  return {
    path,
    mode,
    applicable: true,
    bytes: scan.bytes,
    entries: scan.entries,
    files: scan.files,
    truncated: scan.stoppedBy !== undefined,
    overSoftLimit: scan.bytes > soft.bytes || scan.entries > soft.entries,
    overHardLimit: scan.stoppedBy !== undefined,
    soft,
    hard,
    durationMs: scan.durationMs,
  };
}
