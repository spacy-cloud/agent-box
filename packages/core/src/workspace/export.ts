import { constants as fsc } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { AboxError } from '../errors.js';
import {
  classifyChange,
  flagSuspiciousName,
  type ChangeInfo,
  type ContentReader,
} from './flagged.js';
import { checkGitMarker, scanSandboxGitDir } from './gitmarker.js';
import { runGit } from './git.js';
import {
  compileGitignoreSet,
  GITIGNORE_LIMITS,
  GitignoreSession,
  type PathIgnoreMatcher,
} from './gitignore.js';
import { compileExcludes, type ExcludeMatcher } from './glob.js';
import {
  commitTree,
  createScratchRepo,
  listTree,
  writeTree,
  type ObjectFormat,
  type ScratchRepo,
  type TreeEntry,
} from './objstore.js';
import { hasControlChars, isDotGitLike, isRealDirectory } from './safefs.js';
import { snapshotTree, type SnapshotEntry } from './snapshot.js';
import {
  EXPORT_FORMATS,
  type ExportInput,
  type ExportResult,
  type ExportedFile,
  type FileStatus,
  type FlaggedPath,
  type WorkspaceRecord,
} from './types.js';

/**
 * Patterns excluded from exports by default (applied to baseline and sandbox tree alike,
 * so they never show up as additions or deletions). Pass `exclude: []` to export everything.
 */
export const DEFAULT_EXPORT_EXCLUDE: readonly string[] = [
  'node_modules/',
  '.venv/',
  '__pycache__/',
];

/**
 * Export of a sandbox workspace back to the host.
 *
 * A workspace that was copied with `.gitignore` applied (`record.gitignore`) leaves out, on the
 * sandbox side, what its ignore rules match and the baseline does not contain (a `node_modules`
 * that `npm install` created, build output, `.env` files…). The rules are the `.gitignore` files of
 * the baseline (host-owned, so the sandbox cannot widen them to hide changes) and the recorded
 * `.git/info/exclude`. Paths the baseline has are always compared, as git never ignores tracked files.
 *
 * Nothing from the sandbox tree is ever executed or interpreted by git:
 * the tree is read by abox itself (symlink-safe, see safefs.ts), contents are hashed into
 * loose blobs of a fresh host-owned scratch repository (which borrows the baseline objects
 * via alternates and has all attributes disabled), and only tree/commit objects built from
 * those ids are diffed. Sandbox `.git` directories/files, hooks, attributes and filters are
 * ignored entirely; for tree-bound modes the recorded `.git` marker is verified first.
 *
 * This holds for workspace mode `mount` as well: its live tree is only ever read by abox itself, git
 * is never run in it, so a `.gitattributes` the sandbox wrote cannot activate a filter, textconv or
 * diff driver that the (trusted) repository config defines. The one host-side git call that does look
 * at a mounted work tree, the status check when a mount workspace is created, switches those drivers
 * off (`driverNeutralizingEnv` in git.ts).
 */
export async function exportWorkspace(input: ExportInput): Promise<ExportResult> {
  const { record } = input;
  assertRecord(record);
  if (!EXPORT_FORMATS.includes(input.format)) {
    throw new AboxError('invalid_input', `unknown export format ${String(input.format)}`);
  }
  const paths = normalizePaths(input.paths);
  if (!isAbsolute(input.tmpDir))
    throw new AboxError('invalid_input', 'tmpDir must be an absolute path');
  await mkdir(input.tmpDir, { recursive: true, mode: 0o700 });
  const scratchRoot = await mkdtemp(join(input.tmpDir, 'export-'));
  try {
    return await doExport(input, paths, scratchRoot);
  } finally {
    await rm(scratchRoot, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------

function assertRecord(r: WorkspaceRecord): void {
  const ok =
    r &&
    r.version === 1 &&
    typeof r.mode === 'string' &&
    typeof r.short === 'string' &&
    /^[a-z0-9][a-z0-9-]*$/.test(r.short) &&
    typeof r.sandboxPath === 'string' &&
    r.baseline &&
    (r.baseline.kind === 'empty' ||
      (typeof r.baseline.gitDir === 'string' && /^[0-9a-f]{40,64}$/.test(r.baseline.commit)));
  if (!ok) throw new AboxError('invalid_input', 'invalid workspace record');
}

function normalizePaths(paths: string[] | undefined): string[] | undefined {
  if (!paths || paths.length === 0) return undefined;
  return paths.map((p) => {
    let q = p.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
    if (
      !q ||
      q.includes('\0') ||
      q.startsWith('/') ||
      q.split('/').some((s) => s === '..' || s === '' || s === '.')
    ) {
      throw new AboxError('invalid_input', `invalid export path ${JSON.stringify(p)}`, {
        hint: 'use paths relative to the workspace root without .. segments',
      });
    }
    q = q.normalize('NFC');
    return q;
  });
}

interface RawChange {
  status: string;
  oldMode: string;
  newMode: string;
  oldOid: string;
  newOid: string;
  path: string;
  oldPath?: string;
  similarity?: number;
}

function parseRaw(raw: string): RawChange[] {
  const out: RawChange[] = [];
  const tok = raw.split('\0');
  for (let i = 0; i < tok.length;) {
    const head = tok[i++];
    if (!head || !head.startsWith(':')) continue;
    const parts = head.slice(1).split(' ');
    const [oldMode = '', newMode = '', oldOid = '', newOid = '', st = ''] = parts;
    const status = st.charAt(0);
    if (status === 'R' || status === 'C') {
      const oldPath = tok[i++] ?? '';
      const path = tok[i++] ?? '';
      out.push({
        status,
        oldMode,
        newMode,
        oldOid,
        newOid,
        path,
        oldPath,
        similarity: Number(st.slice(1)),
      });
    } else {
      out.push({ status, oldMode, newMode, oldOid, newOid, path: tok[i++] ?? '' });
    }
  }
  return out;
}

function parseNumstat(raw: string): Map<string, { ins: number; del: number; binary: boolean }> {
  const map = new Map<string, { ins: number; del: number; binary: boolean }>();
  const tok = raw.split('\0');
  for (let i = 0; i < tok.length;) {
    const head = tok[i++];
    if (!head) continue;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(head);
    if (!m) continue;
    let path = m[3] ?? '';
    if (path === '') {
      i++; // old path
      path = tok[i++] ?? '';
    }
    const binary = m[1] === '-';
    map.set(path, { ins: binary ? 0 : Number(m[1]), del: binary ? 0 : Number(m[2]), binary });
  }
  return map;
}

function statusOf(c: RawChange): FileStatus {
  switch (c.status) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
    case 'C':
      return 'renamed';
    default:
      return 'modified';
  }
}

function nonZeroMode(m: string): string | undefined {
  return /^0+$/.test(m) ? undefined : m;
}

function kindOf(mode: string | undefined): ExportedFile['kind'] {
  if (!mode) return 'other';
  if (mode === '120000') return 'symlink';
  if (mode.startsWith('1006') || mode.startsWith('1007')) return 'file';
  return 'other';
}

// ---------------------------------------------------------------------------

async function doExport(
  input: ExportInput,
  paths: string[] | undefined,
  scratchRoot: string,
): Promise<ExportResult> {
  const { record } = input;
  const flagged: FlaggedPath[] = [];
  const warnings: string[] = [];
  const copySkipped: Array<{ path: string; reason: string }> = [];

  // 1. obtain the sandbox tree -------------------------------------------------
  let treeRoot: string;
  const live = record.liveTree !== undefined;
  if (record.liveTree) {
    if (!(await isRealDirectory(record.liveTree))) {
      throw new AboxError(
        'policy_denied',
        `export refused: workspace directory ${record.liveTree} is missing or was replaced by a link`,
      );
    }
    if (record.gitMarker) {
      const check = await checkGitMarker(record.liveTree, record.gitMarker);
      if (check.problems.length > 0) {
        const detail = check.problems.join('; ');
        if (!input.allowTamperedGit) {
          throw new AboxError(
            'policy_denied',
            `export refused: the read-only .git of the sandbox workspace was tampered with (${detail})`,
            {
              hint: 'treat this sandbox as compromised; inspect it, then re-run with allowTamperedGit only if you accept that .git is ignored',
              details: {
                tampered: true,
                path: join(record.liveTree, '.git'),
                problems: check.problems,
              },
            },
          );
        }
        flagged.push({
          path: '.git',
          reason: `TAMPERED (export continued by override): ${detail}`,
        });
      }
      flagged.push(...check.notes);
    }
    treeRoot = record.liveTree;
  } else {
    treeRoot = join(scratchRoot, 'out');
    // Private scratch tree: links (also absolute ones the project already had) are kept as links so
    // they can be compared with the baseline; the tree is only read with lstat/readlink and removed
    // afterwards, nothing in it is followed, and the user never receives it as is.
    // Entries the backend leaves out (file names that must not reach the host, links that point
    // nowhere) do not stop the export; they are reported like other skipped paths and flagged.
    await input.provider.copyOut(input.sandboxId, record.sandboxPath, treeRoot, {
      symlinks: 'preserve',
      onSkip: (path, reason) => copySkipped.push({ path, reason }),
    });
    if (!(await isRealDirectory(treeRoot))) {
      throw new AboxError(
        'backend_error',
        'copyOut did not produce a directory at the requested host path',
      );
    }
  }

  // 2. scratch repository ---------------------------------------------------------
  const fmt: ObjectFormat = record.baseline.objectFormat;
  const objectDirs: string[] = [];
  if (record.baseline.kind === 'git') objectDirs.push(join(record.baseline.gitDir, 'objects'));
  if (record.sourceGit) {
    if (record.sourceGit.objectFormat === fmt)
      objectDirs.push(join(record.sourceGit.gitDir, 'objects'));
  }
  const scratch: ScratchRepo = await createScratchRepo(scratchRoot, objectDirs, fmt);
  const git = scratch.gitDir;

  const baseEntries: Map<string, TreeEntry> =
    record.baseline.kind === 'git' ? await listTree(git, record.baseline.commit) : new Map();
  const gitlinks = [...baseEntries].filter(([, e]) => e.mode === '160000').map(([p]) => p);

  const blobText = async (oid: string | undefined): Promise<string | undefined> => {
    if (!oid || /^0+$/.test(oid)) return undefined;
    const r = await runGit(['cat-file', 'blob', oid], {
      gitDir: git,
      allowFailure: true,
      maxStdoutBytes: 2 * 1024 * 1024,
    });
    return r.code === 0 ? r.stdout : undefined;
  };

  // 3. read the sandbox tree -----------------------------------------------------
  const excludePatterns = input.exclude ?? [...DEFAULT_EXPORT_EXCLUDE];
  const matcher = compileExcludes(excludePatterns);
  const dirCache = new Map<string, boolean>();
  const isExcludedPath = (p: string): boolean => {
    const segs = p.split('/');
    let prefix = '';
    for (let i = 0; i < segs.length - 1; i++) {
      prefix = prefix ? `${prefix}/${segs[i]}` : (segs[i] as string);
      let v = dirCache.get(prefix);
      if (v === undefined) {
        v = matcher(prefix, true);
        dirCache.set(prefix, v);
      }
      if (v) return true;
    }
    return matcher(p, false);
  };

  // .gitignore rules of the workspace, from the baseline (see the note above exportWorkspace)
  let gitignored: PathIgnoreMatcher | undefined;
  const baseDirs = new Set<string>();
  let ignoredCount = 0;
  const ignoredPaths: string[] = [];
  if (record.gitignore?.enabled) {
    const texts = new Map<string, string>();
    for (const [p, e] of baseEntries) {
      if (p !== '.gitignore' && !p.endsWith('/.gitignore')) continue;
      if (e.mode !== '100644' && e.mode !== '100755') continue;
      const text = await blobText(e.oid);
      if (text === undefined || text.length > GITIGNORE_LIMITS.fileBytes) continue;
      texts.set(p === '.gitignore' ? '' : p.slice(0, -'/.gitignore'.length), text);
    }
    gitignored = compileGitignoreSet(texts, {
      ...(record.gitignore.infoExclude ? { infoExclude: record.gitignore.infoExclude } : {}),
      session: new GitignoreSession(),
    });
    for (const p of baseEntries.keys()) {
      for (let i = p.lastIndexOf('/'); i > 0; i = p.lastIndexOf('/', i - 1)) {
        if (baseDirs.has(p.slice(0, i))) break;
        baseDirs.add(p.slice(0, i));
      }
    }
  }
  const ignoredBy = gitignored;
  const walkExclude: ExcludeMatcher = ignoredBy
    ? (rel, isDir) => {
        if (matcher(rel, isDir)) return true;
        if (!ignoredBy(rel, isDir)) return false;
        if (isDir ? baseDirs.has(rel) : baseEntries.has(rel)) return false;
        ignoredCount++;
        if (ignoredPaths.length < 20) ignoredPaths.push(isDir ? `${rel}/` : rel);
        return true;
      }
    : matcher;

  const snap = await snapshotTree(treeRoot, git, fmt, {
    exclude: walkExclude,
    known: baseEntries,
    ...(input.limits ? { limits: input.limits } : {}),
    gitMode: 'skip',
  });
  const sandboxEntries: Map<string, SnapshotEntry> = snap.entries;
  const skipped = [...snap.walk.skipped, ...copySkipped];
  for (const s of copySkipped) flagged.push({ path: s.path, reason: `not exported: ${s.reason}` });
  // files below a submodule path cannot be represented next to the gitlink: ignore them
  if (gitlinks.length > 0) {
    for (const p of [...sandboxEntries.keys()]) {
      if (gitlinks.some((g) => p.startsWith(`${g}/`))) {
        sandboxEntries.delete(p);
        skipped.push({ path: p, reason: 'inside a submodule path (not exported)' });
      }
    }
  }

  // 4. .git-like entries and skipped items ----------------------------------------
  for (const g of snap.walk.gitEntries) {
    if (g === '.git') {
      if (live) continue; // verified through the marker above
      flagged.push(...(await scanSandboxGitDir(join(treeRoot, '.git'))));
      continue;
    }
    flagged.push({
      path: g,
      reason: 'nested .git-like entry in the sandbox tree (ignored, not exported)',
    });
    if (g.endsWith('/.git')) flagged.push(...(await scanSandboxGitDir(join(treeRoot, g), g)));
  }
  for (const s of skipped) {
    if (s.reason.startsWith('symlink named')) flagged.push({ path: s.path, reason: s.reason });
  }

  // 5. compute changes -----------------------------------------------------------
  const selected = (p: string): boolean =>
    !paths || paths.some((q) => p === q || p.startsWith(`${q}/`));
  const added: Array<[string, SnapshotEntry]> = [];
  const removed: string[] = [];
  for (const [p, e] of sandboxEntries) {
    if (!selected(p)) continue;
    const b = baseEntries.get(p);
    if (!b || b.oid !== e.oid || b.mode !== e.mode) added.push([p, e]);
  }
  for (const [p, b] of baseEntries) {
    if (b.mode === '160000' || !selected(p) || isExcludedPath(p)) continue;
    if (!sandboxEntries.has(p)) removed.push(p);
  }

  const finalEntries = new Map<string, TreeEntry>(baseEntries);
  for (const p of removed) finalEntries.delete(p);
  for (const [p, e] of added) finalEntries.set(p, { mode: e.mode, oid: e.oid });

  const baseTree =
    record.baseline.kind === 'git'
      ? record.baseline.tree
      : await writeTree(git, new Map<string, TreeEntry>(), scratchRoot);
  const newTree =
    added.length === 0 && removed.length === 0
      ? baseTree
      : await writeTree(git, finalEntries, scratchRoot);

  // 6. file list, stats ---------------------------------------------------------------
  let raw: RawChange[] = [];
  let numstat = new Map<string, { ins: number; del: number; binary: boolean }>();
  if (newTree !== baseTree) {
    const common = ['-r', '-M', '--no-abbrev', '--no-ext-diff', '--no-textconv'];
    raw = parseRaw(
      (await runGit(['diff-tree', ...common, '--raw', '-z', baseTree, newTree], { gitDir: git }))
        .stdout,
    );
    numstat = parseNumstat(
      (
        await runGit(['diff-tree', ...common, '--numstat', '-z', baseTree, newTree], {
          gitDir: git,
        })
      ).stdout,
    );
  }

  const files: ExportedFile[] = [];
  let insertions = 0;
  let deletions = 0;
  for (const c of raw) {
    const status = statusOf(c);
    const newMode = nonZeroMode(c.newMode);
    const oldMode = nonZeroMode(c.oldMode);
    const mode = newMode ?? oldMode;
    const kind = kindOf(newMode ?? oldMode);
    const ns = numstat.get(c.path);
    const entry = sandboxEntries.get(c.path);
    const f: ExportedFile = {
      path: c.path,
      status,
      kind,
      ...(c.oldPath ? { oldPath: c.oldPath } : {}),
      ...(newMode ? { mode: newMode } : mode ? { mode } : {}),
      ...(oldMode && oldMode !== newMode ? { oldMode } : {}),
      ...(c.status === 'T' ? { typeChanged: true } : {}),
      ...(kind === 'symlink' && entry?.linkTarget !== undefined && status !== 'deleted'
        ? { symlinkTarget: entry.linkTarget }
        : {}),
      ...(ns ? { binary: ns.binary, insertions: ns.ins, deletions: ns.del } : {}),
      ...(c.similarity !== undefined && !Number.isNaN(c.similarity)
        ? { similarity: c.similarity }
        : {}),
    };
    insertions += ns?.ins ?? 0;
    deletions += ns?.del ?? 0;
    files.push(f);

    const change: ChangeInfo = {
      path: c.path,
      ...(c.oldPath ? { oldPath: c.oldPath } : {}),
      status,
      ...(oldMode ? { oldMode } : {}),
      ...(newMode ? { newMode } : {}),
      ...(f.symlinkTarget !== undefined ? { symlinkTarget: f.symlinkTarget } : {}),
    };
    const reader: ContentReader = {
      oldContent: async () => blobText(nonZeroMode(c.oldOid) ? c.oldOid : undefined),
      newContent: async () => blobText(nonZeroMode(c.newOid) ? c.newOid : undefined),
    };
    flagged.push(...(await classifyChange(change, reader)));
    if (status !== 'deleted') {
      const sus = flagSuspiciousName(c.path, hasControlChars(c.path));
      if (sus) flagged.push(sus);
    }
  }
  const stats = {
    filesChanged: files.length,
    insertions,
    deletions,
    scannedEntries: snap.walk.entries,
    scannedBytes: snap.walk.bytes,
    excluded: snap.walk.excluded - ignoredCount,
    ...(gitignored ? { ignored: ignoredCount, ignoredPaths } : {}),
    skipped,
  };
  const result: ExportResult = {
    format: input.format,
    files,
    flagged: dedupe(flagged),
    stats,
    warnings,
  };
  if (ignoredCount > 0) {
    warnings.push(
      `${ignoredCount} path(s) of the sandbox are ignored by the workspace's .gitignore and were not exported (e.g. ${ignoredPaths.slice(0, 3).join(', ')})`,
    );
  }
  if (files.length === 0) warnings.push('no changes to export');

  // 7. format specific output ------------------------------------------------------
  const message = input.message ?? `abox export from ${input.sandboxId}`;
  switch (input.format) {
    case 'diff': {
      if (newTree === baseTree) {
        result.content = '';
        break;
      }
      const r = await runGit(
        [
          'diff-tree',
          '-p',
          '-r',
          '-M',
          '--binary',
          '--no-color',
          '--no-ext-diff',
          '--no-textconv',
          baseTree,
          newTree,
        ],
        { gitDir: git },
      );
      setContent(result, r.raw);
      break;
    }
    case 'patch': {
      if (newTree === baseTree) {
        result.content = '';
        break;
      }
      const parents = record.baseline.kind === 'git' ? [record.baseline.commit] : [];
      const commit = await commitTree(git, newTree, parents, message);
      const r = await runGit(
        [
          'format-patch',
          '--stdout',
          '--root',
          '-1',
          '--zero-commit',
          '--no-signature',
          '--binary',
          '-M',
          '--no-ext-diff',
          '--no-textconv',
          commit,
        ],
        { gitDir: git },
      );
      setContent(result, r.raw);
      break;
    }
    case 'branch': {
      await exportBranch(input, record, git, newTree, baseTree, message, scratchRoot, result);
      break;
    }
    case 'files': {
      if (input.outDir) {
        result.written = await writeOutFiles(input.outDir, files, git, sandboxEntries, warnings);
        // symlinks are never created in outDir: say so next to the other flagged paths
        for (const f of files) {
          if (f.kind === 'symlink' && f.status !== 'deleted')
            result.flagged.push({
              path: f.path,
              reason: `symlink${f.symlinkTarget !== undefined ? ` -> ${JSON.stringify(f.symlinkTarget.slice(0, 200))}` : ''} not written to outDir (the files format only writes regular files; use diff, patch or branch to carry links)`,
            });
        }
      }
      break;
    }
  }
  return result;
}

function setContent(result: ExportResult, raw: Buffer): void {
  const text = raw.toString('utf8');
  result.content = text;
  if (!Buffer.from(text, 'utf8').equals(raw)) result.contentLossy = true;
}

function dedupe(items: FlaggedPath[]): FlaggedPath[] {
  const seen = new Set<string>();
  const out: FlaggedPath[] = [];
  for (const f of items) {
    const k = `${f.path}\0${f.reason}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(f);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------

async function exportBranch(
  input: ExportInput,
  record: WorkspaceRecord,
  git: string,
  newTree: string,
  baseTree: string,
  message: string,
  scratchRoot: string,
  result: ExportResult,
): Promise<void> {
  const sg = record.sourceGit;
  if (!sg) {
    throw new AboxError('unsupported', 'branch export needs a git repository as workspace source', {
      hint: 'use the diff, patch or files format instead',
    });
  }
  if (sg.objectFormat !== record.baseline.objectFormat) {
    throw new AboxError(
      'unsupported',
      'branch export is not supported when baseline and source use different object formats',
    );
  }
  const name = input.branchName ?? `abox/${record.short}-export`;
  if (name.startsWith('-') || /[\0\n\r]/.test(name))
    throw new AboxError('invalid_input', `invalid branch name ${JSON.stringify(name)}`);
  const fmtCheck = await runGit(['check-ref-format', `refs/heads/${name}`], { allowFailure: true });
  if (fmtCheck.code !== 0)
    throw new AboxError('invalid_input', `invalid branch name ${JSON.stringify(name)}`);

  if (newTree === baseTree) return; // nothing to export, no branch is created

  const exists = await runGit(['show-ref', '--verify', '--quiet', `refs/heads/${name}`], {
    gitDir: sg.gitDir,
    allowFailure: true,
  });
  if (exists.code === 0 && !input.force) {
    throw new AboxError('conflict', `branch ${name} already exists in the source repository`, {
      hint: 'choose another branchName or pass force to overwrite it',
      details: { branch: name },
    });
  }
  const commit = await commitTree(git, newTree, [sg.head], message);
  await runGit(['update-ref', 'refs/abox/export', commit], { gitDir: git });
  // The source repo's working tree, index and HEAD are not touched: only refs/heads/<name> is written.
  try {
    await runGit(
      [
        'fetch',
        '--quiet',
        '--no-tags',
        '--no-recurse-submodules',
        git,
        `${input.force ? '+' : ''}refs/abox/export:refs/heads/${name}`,
      ],
      {
        gitDir: sg.gitDir,
        cwd: scratchRoot,
        config: ['transfer.fsckObjects=true', 'fetch.fsckObjects=true'],
      },
    );
  } catch (e) {
    throw new AboxError(
      'backend_error',
      `could not create branch ${name} in the source repository: ${(e as Error).message}`,
      {
        cause: e,
        hint: 'the branch may be checked out in a worktree, or the exported tree was rejected by git fsck',
      },
    );
  }
  result.branch = name;
  result.commit = commit;
}

// ---------------------------------------------------------------------------

async function writeOutFiles(
  outDir: string,
  files: ExportedFile[],
  git: string,
  entries: Map<string, SnapshotEntry>,
  warnings: string[],
): Promise<string[]> {
  if (!isAbsolute(outDir)) throw new AboxError('invalid_input', 'outDir must be an absolute path');
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  const st = await lstat(outDir);
  if (!st.isDirectory()) throw new AboxError('invalid_input', 'outDir is not a directory');
  if ((await readdir(outDir)).length > 0) {
    throw new AboxError('conflict', `outDir ${outDir} is not empty`, {
      hint: 'pass a new or empty directory',
    });
  }
  const written: string[] = [];
  for (const f of files) {
    if (f.status === 'deleted') continue;
    if (f.kind !== 'file') {
      warnings.push(
        f.kind === 'symlink'
          ? `${f.path}: symlink${f.symlinkTarget !== undefined ? ` -> ${JSON.stringify(f.symlinkTarget.slice(0, 200))}` : ''} is listed but never created in outDir`
          : `${f.path}: ${f.kind} entries are listed but not written to outDir`,
      );
      continue;
    }
    const entry = entries.get(f.path);
    if (!entry) continue;
    const segs = f.path.split('/');
    if (segs.some((s) => s === '' || s === '.' || s === '..' || isDotGitLike(s))) {
      warnings.push(`${f.path}: refused (unsafe path)`);
      continue;
    }
    // create parents one by one; every hop must be a real directory (never a link)
    let cur = outDir;
    for (const s of segs.slice(0, -1)) {
      cur = join(cur, s);
      try {
        await mkdir(cur, { mode: 0o755 });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
      if (!(await lstat(cur)).isDirectory())
        throw new AboxError('internal', `export path component ${cur} is not a directory`);
    }
    const dest = join(cur, segs[segs.length - 1] as string);
    const blob = await runGit(['cat-file', 'blob', entry.oid], {
      gitDir: git,
      maxStdoutBytes: 4 * 1024 * 1024 * 1024,
    });
    const fh = await open(
      dest,
      fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | fsc.O_NOFOLLOW,
      entry.mode === '100755' ? 0o755 : 0o644,
    );
    try {
      await fh.writeFile(blob.raw);
    } finally {
      await fh.close();
    }
    written.push(f.path);
  }
  return written;
}
