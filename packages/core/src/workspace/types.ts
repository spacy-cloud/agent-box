import type { AccessMode, WorkspaceDelivery, WorkspaceMode } from '../types.js';
import type { SandboxProvider } from '../provider.js';
import type { ScanResult } from './scan.js';

// ---------------------------------------------------------------------------
// Preparation
// ---------------------------------------------------------------------------

/** Structured side of a progress line, for surfaces that draw a bar. Units are bytes. */
export interface ProgressInfo {
  phase: 'scan' | 'copy' | 'baseline' | 'deliver';
  done?: number;
  /** Known total (from the pre-scan); absent while it is still being measured. */
  total?: number;
}

export interface PrepareWorkspaceInput {
  mode: WorkspaceMode;
  /** Canonical, policy-checked host path of the project (required for every mode except `empty`). */
  source?: string;
  /** abox-owned host directory for this sandbox; staging copies, baselines and worktrees live below it. */
  sandboxDir: string;
  /** Absolute path of the workspace inside the sandbox. */
  sandboxPath: string;
  access: AccessMode;
  /** Branch, tag or commit for `worktree` / `clone`. Default `HEAD`. */
  ref?: string;
  /** True when the sandbox runs on a remote host (no host paths can be bound there). */
  remote: boolean;
  /**
   * Exclude patterns for `copy` / `sync` (and `clone` is unaffected). Default: nothing is excluded.
   * Syntax: see `compileExcludes` (gitignore-like, no negation). They apply on top of `gitignore`.
   */
  exclude?: string[];
  /**
   * `copy` / `sync` only (other modes ignore it): leave out what the `.gitignore` files of the
   * source (and its `.git/info/exclude`) ignore, see gitignore.ts. Default `true`. Does not touch
   * `.git` itself.
   */
  gitignore?: boolean;
  /** Short sandbox id used for branch names (`abox/<short>`). Default: derived from the basename of `sandboxDir`. */
  short?: string;
  /** Progress lines while scanning, copying and recording the baseline of a `copy` / `sync` workspace. */
  onProgress?: (line: string, info?: ProgressInfo) => void;
  /** Aborts scanning and copying (the preparation then fails with "create cancelled" and rolls back). */
  signal?: AbortSignal;
  /**
   * A complete pre-scan (`scanTree`) of `source` with the same excludes, taken a moment ago. Saves
   * the copy a second walk; only used for its totals (progress), the copy enforces its limits itself.
   * Must have been taken with the same `gitignore` setting.
   */
  scan?: ScanResult;
}

export interface PrepareWorkspaceResult {
  delivery: WorkspaceDelivery;
  record: WorkspaceRecord;
  /** Non-fatal observations worth showing to the user (dirty source, `.git` copied, escaping symlinks…). */
  warnings: string[];
}

export type ObjectFormatName = 'sha1' | 'sha256';

/** Host-owned baseline an export is compared against. */
export type WorkspaceBaseline =
  | {
      kind: 'git';
      /** Host-owned git dir holding the baseline objects (user's repo, or `<sandboxDir>/baseline.git`). */
      gitDir: string;
      commit: string;
      tree: string;
      objectFormat: ObjectFormatName;
    }
  | { kind: 'empty'; objectFormat: ObjectFormatName };

/** Identity of the `.git` entry of a host directory that is exposed to the sandbox (read-only there). */
export type GitMarker =
  | {
      kind: 'dir';
      dev: string;
      ino: string;
      /** sha256 of `.git/config` at creation (changes are reported, not refused: users edit it too). */
      configSha256?: string;
      /** Non-sample hook files present at creation. */
      hooks: string[];
    }
  | { kind: 'file'; content: string };

export interface ManifestInfo {
  /** Host path of the JSON manifest (path → sha256, mode, link target). */
  path: string;
  /** sha256 of the manifest file. */
  sha256: string;
  files: number;
  symlinks: number;
  bytes: number;
}

/**
 * JSON-serializable, secret-free description of a prepared workspace. The core stores it
 * with the sandbox and hands it back to `exportWorkspace`.
 */
export interface WorkspaceRecord {
  version: 1;
  mode: WorkspaceMode;
  short: string;
  sandboxDir: string;
  sandboxPath: string;
  access: AccessMode;
  remote: boolean;
  source?: string;
  ref?: string;
  /**
   * Host directory the sandbox works in directly (`mount`, `worktree`). Export reads this tree;
   * for all other modes the tree is fetched with `provider.copyOut`.
   */
  liveTree?: string;
  baseline: WorkspaceBaseline;
  /** The user's repository, when there is one (target of branch exports). */
  sourceGit?: { gitDir: string; head: string; objectFormat: ObjectFormatName };
  /** Branch created by abox (`worktree`: the worktree's branch; `clone`: the branch inside the staging clone). */
  branch?: string;
  worktree?: { path: string; adminDir: string };
  /** Expected state of the `.git` entry in `liveTree`. */
  gitMarker?: GitMarker;
  /** Sandbox-relative `.git` paths made read-only for the sandbox. */
  readonlySubpaths?: string[];
  manifest?: ManifestInfo;
  /** Directory delivered to the sandbox with `copy` delivery. */
  staging?: string;
  exclude: string[];
  /**
   * `copy` / `sync`: whether `.gitignore` rules were applied to the copy, how many entries they left
   * out, and the `.git/info/exclude` that was in force (the export applies the same rules, with the
   * `.gitignore` files of the baseline, to what the sandbox created). Absent in older records and
   * in other modes.
   */
  gitignore?: { enabled: boolean; ignored: number; infoExclude?: string };
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const EXPORT_FORMATS = ['diff', 'patch', 'branch', 'files'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export interface ExportInput {
  record: WorkspaceRecord;
  /** Only `copyOut` is used. */
  provider: Pick<SandboxProvider, 'copyOut'>;
  sandboxId: string;
  format: ExportFormat;
  /** Restrict the export to these paths (files or directories, relative to the workspace root). */
  paths?: string[];
  /** Host-owned directory for scratch data; a private subdirectory is created and removed again. */
  tmpDir: string;
  /** `files` format: copy added/modified regular files into this (new or empty) host directory. */
  outDir?: string;
  /** `branch` format: overwrite an existing export branch. */
  force?: boolean;
  /** `branch` format: branch name. Default `abox/<short>-export`. */
  branchName?: string;
  /**
   * Exclude patterns applied to both baseline and sandbox tree
   * (default: {@link DEFAULT_EXPORT_EXCLUDE}). Pass `[]` to include everything.
   */
  exclude?: string[];
  /** Continue although the host-side `.git` entry was modified (it is ignored anyway; result is flagged). */
  allowTamperedGit?: boolean;
  /** Message of the exported commit / patch. Default `abox export from <sandboxId>`. */
  message?: string;
  /** Resource limits for the walk of the sandbox tree. */
  limits?: { maxEntries?: number; maxFileBytes?: number; maxTotalBytes?: number };
}

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface ExportedFile {
  path: string;
  status: FileStatus;
  /** Previous path for `renamed`. */
  oldPath?: string;
  /** Git file modes (`100644`, `100755`, `120000`). */
  mode?: string;
  oldMode?: string;
  kind: 'file' | 'symlink' | 'other';
  /** Target of a symlink entry (the link is never followed). */
  symlinkTarget?: string;
  typeChanged?: boolean;
  binary?: boolean;
  insertions?: number;
  deletions?: number;
  similarity?: number;
}

export interface FlaggedPath {
  path: string;
  reason: string;
}

export interface ExportStats {
  filesChanged: number;
  insertions: number;
  deletions: number;
  /** Entries scanned in the sandbox tree. */
  scannedEntries: number;
  scannedBytes: number;
  /** Entries dropped by exclude patterns. */
  excluded: number;
  /**
   * Entries of the sandbox tree that `.gitignore` rules of the workspace ignore and that did not
   * exist in the baseline (a `node_modules` that `npm install` created…): not exported. Only set
   * when the workspace was copied with `gitignore` on.
   */
  ignored?: number;
  /** The first of those paths (a directory stands for everything below it). */
  ignoredPaths?: string[];
  /** Entries that could not be exported (special files, too large, refused names…). */
  skipped: Array<{ path: string; reason: string }>;
}

export interface ExportResult {
  format: ExportFormat;
  /** `diff` / `patch`: the text. Lossy (U+FFFD) when `contentLossy`. */
  content?: string;
  contentLossy?: boolean;
  /** `branch`: created branch in the source repository and its commit. */
  branch?: string;
  commit?: string;
  /** Changed files (filled for every format). */
  files: ExportedFile[];
  /** Changed paths that can lead to code execution on the host once used there. */
  flagged: FlaggedPath[];
  stats: ExportStats;
  /** `files` format with `outDir`: paths written. */
  written?: string[];
  warnings: string[];
}
