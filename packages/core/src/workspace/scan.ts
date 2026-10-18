import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { AboxError } from '../errors.js';
import { formatBytesHuman } from '../policy/units.js';
import type { GitignoreSession, IgnoreLayer } from './gitignore.js';
import type { ExcludeMatcher } from './glob.js';
import { isDotGitLike } from './safefs.js';

/**
 * Hard limits of a workspace copy (`copy` / `sync`, and the baseline snapshot of a non-git `mount`).
 * They are the same for everybody; the policy's soft limit (`workspace.max_copy_bytes` /
 * `max_copy_entries`) sits far below them and only decides who may copy what without asking.
 */
export const WORKSPACE_COPY_LIMITS = {
  maxEntries: 2_000_000,
  maxFileBytes: 4 * 1024 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024 * 1024,
  maxDepth: 128,
} as const;

export interface ScanProgress {
  /** Files, links and directories seen so far (same unit as the walk limit `maxEntries`). */
  entries: number;
  files: number;
  /** Sum of the sizes of the regular files seen so far. */
  bytes: number;
}

export interface ScanOptions {
  exclude?: ExcludeMatcher;
  /**
   * Leave out what `.gitignore` files ignore, like the copy does. The session carries the budgets
   * and collects warnings (`.gitignore` that is a link, too large…).
   */
  gitignore?: GitignoreSession;
  /**
   * With `gitignore`: also measure what lies below the ignored entries (`ScanResult.ignoredTotals`),
   * for the "x GiB ignored" part of an estimate. Costs a walk of those trees (bounded, see
   * {@link IGNORED_MEASURE_ENTRIES}); never counts towards the totals or limits.
   */
  measureIgnored?: boolean;
  /** `visit` (default, as the copy does) counts `.git`; `skip` leaves it out. */
  gitMode?: 'skip' | 'visit';
  /** Files above this size are skipped by the copy and therefore not counted. Default: the copy limit. */
  maxFileBytes?: number;
  /** Stop as soon as the totals exceed one of these (default: the hard copy limits). */
  stopAbove?: { bytes?: number; entries?: number };
  maxDepth?: number;
  signal?: AbortSignal;
  /** Called at most once per `progressIntervalMs` while walking. */
  onProgress?: (p: ScanProgress) => void;
  /** Default 1000. */
  progressIntervalMs?: number;
}

export interface ScanResult extends ScanProgress {
  directories: number;
  symlinks: number;
  /** Entries a copy would not take (special files, too large, unreadable, invalid names). */
  skipped: number;
  excluded: number;
  /** Entries left out by `.gitignore` (an ignored directory counts once, not its contents). */
  ignored: number;
  /** With `measureIgnored`: the files below the ignored entries. `partial`: measuring stopped at its bound. */
  ignoredTotals?: { files: number; bytes: number; partial: boolean };
  /**
   * Set when the walk stopped early because a limit was exceeded; the counts are then lower bounds
   * ("at least").
   */
  stoppedBy?: 'bytes' | 'entries' | 'depth';
  durationMs: number;
}

const LSTAT_BATCH = 32;

/** Entries visited below ignored directories at most, when they are measured. */
export const IGNORED_MEASURE_ENTRIES = 1_000_000;

interface Pending {
  path: string;
  rel: string;
  depth: number;
  /** Rules in force (`undefined`: none, e.g. inside `.git`). */
  ignore?: IgnoreLayer;
  /** Below an ignored directory: only measured, never counted as workspace. */
  ignoredTree?: boolean;
}

/**
 * Fast, read-only size estimate of a directory tree: `readdir` + `lstat` only. File contents are
 * never opened (except the `.gitignore` files, when asked to apply them) and symbolic links are
 * never followed (a link counts as one entry). It applies the same exclude patterns, `.gitignore`
 * rules and entry rules as the copy, so the numbers are what the copy will move.
 * Sparse files count with their apparent size, like the copy. The walk is advisory (no race
 * protection); the copy itself enforces its limits again.
 */
export async function scanTree(root: string, opts: ScanOptions = {}): Promise<ScanResult> {
  const started = Date.now();
  const stopBytes = opts.stopAbove?.bytes ?? WORKSPACE_COPY_LIMITS.maxTotalBytes;
  const stopEntries = opts.stopAbove?.entries ?? WORKSPACE_COPY_LIMITS.maxEntries;
  const maxFileBytes = opts.maxFileBytes ?? WORKSPACE_COPY_LIMITS.maxFileBytes;
  const maxDepth = opts.maxDepth ?? WORKSPACE_COPY_LIMITS.maxDepth;
  const gitMode = opts.gitMode ?? 'visit';
  const exclude = opts.exclude ?? (() => false);
  const interval = opts.progressIntervalMs ?? 1000;
  const session = opts.gitignore;
  const measure = session !== undefined && opts.measureIgnored === true;
  const r: ScanResult = {
    entries: 0,
    files: 0,
    bytes: 0,
    directories: 0,
    symlinks: 0,
    skipped: 0,
    excluded: 0,
    ignored: 0,
    ...(measure ? { ignoredTotals: { files: 0, bytes: 0, partial: false } } : {}),
    durationMs: 0,
  };
  let measured = 0;
  let lastReport = started;
  const report = (force: boolean): void => {
    if (!opts.onProgress) return;
    const now = Date.now();
    if (!force && now - lastReport < interval) return;
    lastReport = now;
    opts.onProgress({ entries: r.entries, files: r.files, bytes: r.bytes });
  };
  const stopIfOver = (): boolean => {
    if (r.bytes > stopBytes) r.stoppedBy = 'bytes';
    else if (r.entries > stopEntries) r.stoppedBy = 'entries';
    return r.stoppedBy !== undefined;
  };

  const stack: Pending[] = [
    { path: root, rel: '', depth: 0, ...(session ? { ignore: await session.root(root) } : {}) },
  ];
  while (stack.length > 0) {
    if (opts.signal?.aborted) throw new AboxError('internal', 'create cancelled');
    const dir = stack.pop() as Pending;
    if (dir.ignoredTree) {
      await measureIgnoredDir(dir);
      continue;
    }
    if (dir.depth > maxDepth) {
      r.stoppedBy = 'depth';
      break;
    }
    let names;
    try {
      names = await readdir(dir.path, { withFileTypes: true });
    } catch (e) {
      if (dir.depth === 0) throw e;
      r.skipped++;
      continue;
    }
    const ignore =
      dir.ignore && session
        ? await session.load(
            dir.ignore,
            dir.rel,
            names.some((n) => n.name === '.gitignore') ? join(dir.path, '.gitignore') : undefined,
          )
        : undefined;
    const files: Array<{ path: string }> = [];
    const ignoredFiles: string[] = [];
    for (const ent of names) {
      const name = ent.name;
      const rel = dir.rel ? `${dir.rel}/${name}` : name;
      if (name.includes('�')) {
        r.skipped++;
        continue;
      }
      if (gitMode === 'skip' && isDotGitLike(name)) continue;
      const isDir = ent.isDirectory();
      if (exclude(rel, isDir)) {
        r.excluded++;
        continue;
      }
      let childIgnore = ignore;
      const verdict = ignore && session ? session.decide(ignore, rel, name, isDir) : 'keep';
      if (verdict === 'forced') childIgnore = ignore?.forcedView();
      else if (verdict === 'keep' && isDotGitLike(name)) childIgnore = undefined;
      if (verdict === 'ignore') {
        r.ignored++;
        if (measure) {
          if (isDir) {
            stack.push({
              path: join(dir.path, name),
              rel,
              depth: dir.depth + 1,
              ignoredTree: true,
            });
          } else if (ent.isFile()) {
            ignoredFiles.push(join(dir.path, name));
          }
        }
        continue;
      }
      r.entries++;
      if (isDir) {
        r.directories++;
        stack.push({
          path: join(dir.path, name),
          rel,
          depth: dir.depth + 1,
          ...(childIgnore ? { ignore: childIgnore } : {}),
        });
      } else if (ent.isSymbolicLink()) {
        r.symlinks++;
      } else if (ent.isFile()) {
        files.push({ path: join(dir.path, name) });
      } else {
        r.skipped++;
      }
    }
    if (ignoredFiles.length > 0) await measureIgnoredFiles(ignoredFiles);
    // sizes: lstat in small parallel batches (a directory can hold hundreds of thousands of files)
    for (let i = 0; i < files.length; i += LSTAT_BATCH) {
      if (opts.signal?.aborted) throw new AboxError('internal', 'create cancelled');
      const batch = files.slice(i, i + LSTAT_BATCH);
      const stats = await Promise.all(batch.map((f) => lstat(f.path).catch(() => undefined)));
      for (const st of stats) {
        if (!st || !st.isFile()) {
          r.skipped++;
          continue;
        }
        if (st.size > maxFileBytes) {
          r.skipped++;
          continue;
        }
        r.files++;
        r.bytes += st.size;
      }
      if (stopIfOver()) break;
      report(false);
    }
    if (stopIfOver()) break;
    report(false);
  }
  r.durationMs = Date.now() - started;
  report(true);
  return r;

  /** Sizes of files below ignored entries: only added to `ignoredTotals`. */
  async function measureIgnoredFiles(paths: string[]): Promise<void> {
    const totals = r.ignoredTotals as NonNullable<ScanResult['ignoredTotals']>;
    for (let i = 0; i < paths.length; i += LSTAT_BATCH) {
      const stats = await Promise.all(
        paths.slice(i, i + LSTAT_BATCH).map((p) => lstat(p).catch(() => undefined)),
      );
      for (const st of stats) {
        if (!st || !st.isFile()) continue;
        totals.files++;
        totals.bytes += st.size;
      }
    }
  }

  async function measureIgnoredDir(dir: Pending): Promise<void> {
    const totals = r.ignoredTotals as NonNullable<ScanResult['ignoredTotals']>;
    if (totals.partial || dir.depth > maxDepth) {
      totals.partial = true;
      return;
    }
    let names;
    try {
      names = await readdir(dir.path, { withFileTypes: true });
    } catch {
      return;
    }
    const files: string[] = [];
    for (const ent of names) {
      if (++measured > IGNORED_MEASURE_ENTRIES) {
        totals.partial = true;
        break;
      }
      if (ent.isDirectory()) {
        stack.push({
          path: join(dir.path, ent.name),
          rel: `${dir.rel}/${ent.name}`,
          depth: dir.depth + 1,
          ignoredTree: true,
        });
      } else if (ent.isFile()) {
        files.push(join(dir.path, ent.name));
      }
    }
    await measureIgnoredFiles(files);
  }
}

/** `12 345` style number for messages (thin grouping is avoided: plain ASCII space). */
export function formatCount(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/** `12 345 files, 1.2 GiB` */
export function describeScan(s: Pick<ScanProgress, 'files' | 'bytes'>): string {
  return `${formatCount(s.files)} file${s.files === 1 ? '' : 's'}, ${formatBytesHuman(s.bytes)}`;
}

export type CopyLimitPurpose = 'copy' | 'baseline';

/**
 * The error for a workspace folder beyond the hard limits. `scan` is the (possibly early-stopped)
 * result: "found so far" because the walk stops at the limit.
 */
export function copyLimitError(
  folder: string,
  scan: ScanResult,
  purpose: CopyLimitPurpose = 'copy',
): AboxError {
  const limits = WORKSPACE_COPY_LIMITS;
  const what = purpose === 'copy' ? 'the copy limit' : 'the limit for a baseline snapshot';
  let detail: string;
  switch (scan.stoppedBy) {
    case 'entries':
      detail = `${formatCount(scan.entries)} entries found so far, limit ${formatCount(limits.maxEntries)}`;
      break;
    case 'depth':
      detail = `directories nested deeper than ${limits.maxDepth} levels`;
      break;
    default:
      detail = `${formatBytesHuman(scan.bytes)} found so far, limit ${formatBytesHuman(limits.maxTotalBytes)}`;
  }
  const hint =
    purpose === 'copy'
      ? 'Choose the project folder itself, use workspace mode "mount" or "clone" for big repositories, or exclude large directories (create option exclude: abox create --exclude node_modules, MCP workspace.exclude, "Exclude" field in the GUI). What .gitignore ignores is already left out unless gitignore is switched off.'
      : 'Mount a git repository instead (its HEAD commit is the baseline, no snapshot is taken), choose a smaller folder, or use workspace mode "empty".';
  return new AboxError(
    'invalid_input',
    `workspace folder ${folder} is larger than ${what} (${detail})`,
    {
      hint,
      details: {
        reasons: [`workspace folder ${folder} is larger than ${what}`],
        folder,
        foundBytes: scan.bytes,
        foundEntries: scan.entries,
        limitBytes: limits.maxTotalBytes,
        limitEntries: limits.maxEntries,
        stoppedBy: scan.stoppedBy,
      },
    },
  );
}
