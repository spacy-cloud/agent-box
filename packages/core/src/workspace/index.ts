export * from './types.js';
export { prepareWorkspace, cleanupWorkspace } from './prepare.js';
export { exportWorkspace, DEFAULT_EXPORT_EXCLUDE } from './export.js';
export {
  runGit,
  buildGitArgv,
  HARDENED_GIT_CONFIG,
  locateRepo,
  resolveCommit,
  type RunGitOptions,
  type GitResult,
} from './git.js';
export { compileExcludes, type ExcludeMatcher } from './glob.js';
export {
  GitignoreSession,
  GITIGNORE_LIMITS,
  IgnoreLayer,
  compileGitignoreSet,
  type PathIgnoreMatcher,
} from './gitignore.js';
export { readTrackedPaths, type TrackedPaths, type TrackedResult } from './gitindex.js';
export { classifyChange, type ChangeInfo, type ContentReader } from './flagged.js';
export {
  walkTree,
  isDotGitLike,
  type WalkOptions,
  type WalkResult,
  type WalkLimits,
} from './safefs.js';
export { copyTreeSafely, symlinkEscapes } from './snapshot.js';
export {
  scanTree,
  IGNORED_MEASURE_ENTRIES,
  copyLimitError,
  describeScan,
  formatCount,
  WORKSPACE_COPY_LIMITS,
  type ScanOptions,
  type ScanProgress,
  type ScanResult,
} from './scan.js';
