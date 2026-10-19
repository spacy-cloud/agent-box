import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { AboxError } from '../errors.js';
import { isDotGitLike, hasControlChars } from './safefs.js';
import { symlinkEscapes } from './snapshot.js';
import type { ExportResult, ExportedFile, FileStatus } from './types.js';

/**
 * Review model of a sandbox's changes: the diff of an export, parsed into files and hunks, with
 * the flags a reviewer needs, and the reverse step, building a patch from a *selection* of files
 * and hunks.
 *
 * Trust: the patch that is applied or saved is never taken from a caller. A caller names files and
 * hunks (by path and index) and the digest of the diff it was shown; the manager recomputes the diff
 * from the sandbox, refuses a digest that no longer matches and builds the patch here, from its own
 * bytes. The diff is handled as latin1 text so that every byte survives the round trip (patches may
 * contain binary data or text in any encoding).
 */

/** Hard and soft limits of the review. */
export const REVIEW_LIMITS = {
  /** Larger diffs are not reviewed at all (narrow the export instead). */
  maxDiffBytes: 64 * 1024 * 1024,
  /** A file whose diff is larger is listed with its flags but its lines are not delivered. */
  maxFileViewBytes: 256 * 1024,
  /** All delivered lines together; files beyond it are treated like large files. */
  maxViewBytes: 8 * 1024 * 1024,
  /** Longest line delivered (the patch itself is never shortened). */
  maxLineChars: 2000,
} as const;

export type ChangeBadge = 'dependency' | 'executable' | 'binary' | 'symlink' | 'large' | 'flagged';

/** Why a changed file cannot be applied (it stays visible, it cannot be selected). */
export type NotApplicableReason =
  'type_change' | 'unsafe_path' | 'unsafe_link' | 'unsupported_kind' | 'unmapped';

export interface ChangeHunk {
  /** Position in the file's diff, the identifier used in a selection. */
  index: number;
  /** The `@@ -a,b +c,d @@ heading` line. */
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  additions: number;
  deletions: number;
  /** One entry per line, first character `' '`, `'+'`, `'-'` or `'\\'`. Absent when the content is not delivered. */
  lines?: string[];
}

export interface ChangeFile {
  path: string;
  oldPath?: string;
  status: FileStatus;
  kind: ExportedFile['kind'];
  mode?: string;
  oldMode?: string;
  insertions: number;
  deletions: number;
  binary: boolean;
  symlinkTarget?: string;
  hunks: ChangeHunk[];
  /** Hunks can be chosen one by one (a plain content change of a regular file). */
  hunkSelectable: boolean;
  /** The lines are not part of the view (binary, or too large for the review). */
  contentOmitted: boolean;
  badges: ChangeBadge[];
  /** Reasons of the export's `flagged` list and of the badge rules. */
  flags: string[];
  /** Flagged files are not preselected and need an explicit confirmation to be applied. */
  needsConfirmation: boolean;
  applicable: boolean;
  notApplicable?: NotApplicableReason;
}

/** A parsed section of the diff (one `diff --git` block). */
interface Section {
  text: string;
  /** Everything before the first hunk. */
  header: string;
  hunks: ParsedHunk[];
}

interface ParsedHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** Text after the closing `@@` (function heading), with a leading space when present. */
  trailer: string;
  /** The hunk lines including the terminating newlines (and any `\ No newline` marker). */
  body: string;
  lines: string[];
  additions: number;
  deletions: number;
}

export interface ReviewModel {
  /** sha256 of the exact diff the view was built from. */
  digest: string;
  files: ChangeFile[];
  /** Per file: the sections of the diff (one, two for a type change). */
  sections: Map<string, Section[]>;
  /** Flagged paths that do not belong to a changed file (tampered `.git`, skipped entries…). */
  notices: Array<{ path: string; reason: string }>;
}

export function diffDigest(raw: Buffer): string {
  return createHash('sha256').update('abox-changes-v1\0').update(raw).digest('hex');
}

// ---------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

function bad(what: string): AboxError {
  return new AboxError('internal', `cannot read the diff of the sandbox: ${what}`, {
    hint: 'use sandbox export (format diff) to look at the raw diff',
  });
}

function splitSections(diff: string): string[] {
  if (diff === '') return [];
  if (!diff.startsWith('diff --git ')) throw bad('unexpected start');
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const next = diff.indexOf('\ndiff --git ', from);
    if (next < 0) {
      out.push(diff.slice(from));
      return out;
    }
    out.push(diff.slice(from, next + 1));
    from = next + 1;
  }
}

function parseSection(text: string): Section {
  const firstHunk = text.startsWith('@@ ') ? 0 : text.indexOf('\n@@ ') + 1;
  if (firstHunk <= 0) return { text, header: text, hunks: [] };
  const header = text.slice(0, firstHunk);
  const hunks: ParsedHunk[] = [];
  let pos = firstHunk;
  while (pos < text.length) {
    const eol = text.indexOf('\n', pos);
    if (eol < 0) throw bad('hunk header without a line end');
    const m = HUNK_RE.exec(text.slice(pos, eol));
    if (!m) throw bad('expected a hunk header');
    const oldStart = Number(m[1]);
    const oldCount = m[2] === undefined ? 1 : Number(m[2]);
    const newStart = Number(m[3]);
    const newCount = m[4] === undefined ? 1 : Number(m[4]);
    let oldLeft = oldCount;
    let newLeft = newCount;
    let cur = eol + 1;
    const bodyStart = cur;
    const lines: string[] = [];
    let additions = 0;
    let deletions = 0;
    while (oldLeft > 0 || newLeft > 0 || text.startsWith('\\', cur)) {
      if (cur >= text.length) throw bad('hunk ends early');
      const e = text.indexOf('\n', cur);
      if (e < 0) throw bad('hunk line without a line end');
      const line = text.slice(cur, e);
      const c = line.charAt(0);
      if (c === ' ') {
        oldLeft--;
        newLeft--;
      } else if (c === '-') {
        oldLeft--;
        deletions++;
      } else if (c === '+') {
        newLeft--;
        additions++;
      } else if (c !== '\\') {
        throw bad('unexpected line inside a hunk');
      }
      if (oldLeft < 0 || newLeft < 0) throw bad('hunk is longer than its header says');
      lines.push(line);
      cur = e + 1;
    }
    hunks.push({
      oldStart,
      oldCount,
      newStart,
      newCount,
      trailer: m[5] ?? '',
      body: text.slice(bodyStart, cur),
      lines,
      additions,
      deletions,
    });
    pos = cur;
  }
  return { text, header, hunks };
}

/** How git writes a path in a header: C-style quoted when it holds special bytes (core.quotePath on). */
function gitQuote(name: string): string {
  const bytes = Buffer.from(name, 'utf8');
  let need = false;
  for (const b of bytes) if (b < 0x20 || b === 0x22 || b === 0x5c || b >= 0x7f) need = true;
  if (!need) return name;
  let out = '"';
  for (const b of bytes) {
    if (b === 0x22) out += '\\"';
    else if (b === 0x5c) out += '\\\\';
    else if (b === 0x07) out += '\\a';
    else if (b === 0x08) out += '\\b';
    else if (b === 0x09) out += '\\t';
    else if (b === 0x0a) out += '\\n';
    else if (b === 0x0b) out += '\\v';
    else if (b === 0x0c) out += '\\f';
    else if (b === 0x0d) out += '\\r';
    else if (b < 0x20 || b >= 0x7f) out += `\\${b.toString(8).padStart(3, '0')}`;
    else out += String.fromCharCode(b);
  }
  return `${out}"`;
}

/** The `diff --git` line git writes for a path pair; compared with what the section really says. */
function expectedHeader(oldPath: string, newPath: string): string {
  const quoted = (p: string, side: 'a' | 'b'): string => gitQuote(`${side}/${p}`);
  return `diff --git ${quoted(oldPath, 'a')} ${quoted(newPath, 'b')}`;
}

function firstLine(s: string): string {
  const i = s.indexOf('\n');
  return i < 0 ? s : s.slice(0, i);
}

// ---------------------------------------------------------------------------
// flags
// ---------------------------------------------------------------------------

const DEPENDENCY_NAMES = new Set([
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'deno.json',
  'deno.jsonc',
  'deno.lock',
  'pyproject.toml',
  'poetry.lock',
  'uv.lock',
  'pipfile',
  'pipfile.lock',
  'requirements.txt',
  'constraints.txt',
  'setup.cfg',
  'setup.py',
  'cargo.toml',
  'cargo.lock',
  'go.mod',
  'go.sum',
  'go.work',
  'gemfile',
  'gemfile.lock',
  'composer.json',
  'composer.lock',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'settings.gradle.kts',
  'gradle.properties',
  'packages.config',
  'directory.packages.props',
  'package.swift',
  'package.resolved',
  'podfile',
  'podfile.lock',
  'mix.exs',
  'mix.lock',
  'pubspec.yaml',
  'pubspec.lock',
  'flake.nix',
  'flake.lock',
  'project.clj',
  'build.sbt',
  'cabal.project',
  'stack.yaml',
]);

/** Package manifests and lock files: changes there decide which code is fetched and run on the next install. */
export function isDependencyFile(path: string): boolean {
  const name = (path.split('/').pop() ?? '').toLowerCase();
  if (DEPENDENCY_NAMES.has(name)) return true;
  if (/^requirements([-_.][\w.-]+)?\.(txt|in)$/.test(name)) return true;
  return /\.(csproj|fsproj|vbproj|gemspec|nuspec)$/.test(name);
}

function pathProblem(path: string): boolean {
  if (!path || path.startsWith('/') || path.includes('\0') || hasControlChars(path)) return true;
  return path.split('/').some((s) => s === '' || s === '.' || s === '..' || isDotGitLike(s));
}

// ---------------------------------------------------------------------------
// model
// ---------------------------------------------------------------------------

/**
 * Builds the review model from an export with `format: 'diff'` and `keepRaw`.
 * `contentBytes` must be the diff the `files` list belongs to (same call).
 */
export function buildReviewModel(result: ExportResult): ReviewModel {
  const raw = result.contentBytes;
  if (!raw) throw new AboxError('internal', 'export result has no raw diff');
  if (raw.length > REVIEW_LIMITS.maxDiffBytes) {
    throw new AboxError(
      'unsupported',
      `the changes are too large to review here (${raw.length} bytes of diff, limit ${REVIEW_LIMITS.maxDiffBytes})`,
      { hint: 'Export a smaller part (sandbox export --path) or create a branch instead.' },
    );
  }
  const text = raw.toString('latin1');
  const chunks = splitSections(text);
  const sections = new Map<string, Section[]>();
  const files: ChangeFile[] = [];

  const flagsOf = new Map<string, string[]>();
  for (const f of result.flagged) {
    const list = flagsOf.get(f.path) ?? [];
    if (!list.includes(f.reason)) list.push(f.reason);
    flagsOf.set(f.path, list);
  }

  let next = 0;
  let viewBytes = 0;
  const take = (): Section => {
    const c = chunks[next++];
    if (c === undefined) throw bad('fewer diff sections than changed files');
    return parseSection(c);
  };

  for (const f of result.files) {
    const mine: Section[] = [];
    mine.push(take());
    if (f.typeChanged) mine.push(take());
    // the sections must belong to this file, or the diff and the file list disagree
    let unmapped = false;
    const wantOld = f.oldPath ?? f.path;
    for (const s of mine) {
      if (firstLine(s.text) !== expectedHeader(wantOld, f.path)) unmapped = true;
    }

    const flags = [...(flagsOf.get(f.path) ?? [])];
    const binary = f.binary === true;
    const section = mine[0] as Section;
    const textBytes = mine.reduce((n, s) => n + s.text.length, 0);
    let contentOmitted =
      binary ||
      textBytes > REVIEW_LIMITS.maxFileViewBytes ||
      viewBytes + textBytes > REVIEW_LIMITS.maxViewBytes;
    const large = !binary && contentOmitted;
    if (!contentOmitted) viewBytes += textBytes;

    const mode = f.mode;
    const executable = mode === '100755' && f.status !== 'deleted';
    const badges: ChangeBadge[] = [];
    if (isDependencyFile(f.path)) badges.push('dependency');
    if (executable) badges.push('executable');
    if (binary) badges.push('binary');
    if (f.kind === 'symlink') badges.push('symlink');
    if (large) badges.push('large');
    if (flags.length > 0) badges.push('flagged');

    let notApplicable: NotApplicableReason | undefined;
    if (unmapped) notApplicable = 'unmapped';
    else if (f.kind === 'other') notApplicable = 'unsupported_kind';
    else if (f.typeChanged) notApplicable = 'type_change';
    else if (pathProblem(f.path) || (f.oldPath !== undefined && pathProblem(f.oldPath)))
      notApplicable = 'unsafe_path';
    else if (
      f.kind === 'symlink' &&
      f.status !== 'deleted' &&
      (f.symlinkTarget === undefined || symlinkEscapes(f.path, f.symlinkTarget))
    )
      notApplicable = 'unsafe_link';

    const hunkSelectable =
      notApplicable === undefined &&
      f.status === 'modified' &&
      f.kind === 'file' &&
      !binary &&
      !contentOmitted &&
      (f.oldMode === undefined || f.oldMode === f.mode) &&
      section.hunks.length > 0;

    const hunks: ChangeHunk[] = section.hunks.map((h, index) => ({
      index,
      header:
        `@@ -${h.oldStart}${h.oldCount === 1 ? '' : `,${h.oldCount}`} +${h.newStart}${h.newCount === 1 ? '' : `,${h.newCount}`} @@${Buffer.from(h.trailer, 'latin1').toString('utf8')}`.slice(
          0,
          REVIEW_LIMITS.maxLineChars,
        ),
      oldStart: h.oldStart,
      oldCount: h.oldCount,
      newStart: h.newStart,
      newCount: h.newCount,
      additions: h.additions,
      deletions: h.deletions,
      ...(contentOmitted
        ? {}
        : {
            lines: h.lines.map((l) =>
              Buffer.from(l, 'latin1').toString('utf8').slice(0, REVIEW_LIMITS.maxLineChars),
            ),
          }),
    }));
    // A type change is not applicable, so its (two) sections are not shown either.
    if (notApplicable === 'type_change') contentOmitted = true;

    sections.set(f.path, mine);
    files.push({
      path: f.path,
      ...(f.oldPath !== undefined ? { oldPath: f.oldPath } : {}),
      status: f.status,
      kind: f.kind,
      ...(f.mode ? { mode: f.mode } : {}),
      ...(f.oldMode ? { oldMode: f.oldMode } : {}),
      insertions: f.insertions ?? 0,
      deletions: f.deletions ?? 0,
      binary,
      ...(f.symlinkTarget !== undefined ? { symlinkTarget: f.symlinkTarget.slice(0, 500) } : {}),
      hunks: notApplicable === 'type_change' ? [] : hunks,
      hunkSelectable,
      contentOmitted,
      badges,
      flags,
      needsConfirmation: badges.length > 0,
      applicable: notApplicable === undefined,
      ...(notApplicable ? { notApplicable } : {}),
    });
  }
  if (next !== chunks.length) throw bad('more diff sections than changed files');

  const known = new Set(files.map((f) => f.path));
  const notices = result.flagged
    .filter((f) => !known.has(f.path))
    .map((f) => ({ path: f.path, reason: f.reason }));
  return { digest: diffDigest(raw), files, sections, notices };
}

// ---------------------------------------------------------------------------
// selection -> patch
// ---------------------------------------------------------------------------

/** What a caller names: a file, optionally only some of its hunks (absent: the whole file). */
export interface ChangeSelection {
  path: string;
  hunks?: number[];
}

export interface SelectedFile {
  file: ChangeFile;
  /** Indexes of the hunks that are part of the patch (all of them for a whole-file selection). */
  hunks: number[];
  whole: boolean;
}

export interface BuiltPatch {
  patch: Buffer;
  files: SelectedFile[];
}

function rebuildHunks(all: ParsedHunk[], chosen: Set<number>): string {
  let out = '';
  let delta = 0;
  all.forEach((h, i) => {
    if (!chosen.has(i)) return;
    const effOld = h.oldCount === 0 ? h.oldStart + 1 : h.oldStart;
    const effNew = effOld + delta;
    const newStart = h.newCount === 0 ? effNew - 1 : effNew;
    const range = (start: number, count: number): string =>
      count === 1 ? `${start}` : `${start},${count}`;
    out += `@@ -${range(h.oldStart, h.oldCount)} +${range(newStart, h.newCount)} @@${h.trailer}\n${h.body}`;
    delta += h.newCount - h.oldCount;
  });
  return out;
}

/**
 * Builds the patch of a selection from the model's own sections. Refuses unknown paths, duplicates,
 * files that cannot be applied and hunk lists for files whose hunks cannot be chosen one by one.
 */
export function buildPatch(model: ReviewModel, selection: ChangeSelection[]): BuiltPatch {
  if (selection.length === 0) {
    throw new AboxError('invalid_input', 'nothing is selected');
  }
  const byPath = new Map(model.files.map((f) => [f.path, f]));
  const seen = new Set<string>();
  const picked: Array<{ file: ChangeFile; chosen: Set<number> | undefined }> = [];
  for (const s of selection) {
    const file = byPath.get(s.path);
    if (!file) {
      throw new AboxError('invalid_input', `${JSON.stringify(s.path)} is not a changed file`, {
        hint: 'Reload the changes: the sandbox may have changed since they were shown.',
      });
    }
    if (seen.has(s.path)) {
      throw new AboxError('invalid_input', `${JSON.stringify(s.path)} is selected twice`);
    }
    seen.add(s.path);
    if (!file.applicable) {
      throw new AboxError(
        'invalid_input',
        `${JSON.stringify(s.path)} cannot be applied (${file.notApplicable ?? 'not applicable'})`,
        { details: { path: s.path, reason: file.notApplicable } },
      );
    }
    let chosen: Set<number> | undefined;
    if (s.hunks !== undefined) {
      if (!file.hunkSelectable) {
        throw new AboxError(
          'invalid_input',
          `hunks of ${JSON.stringify(s.path)} cannot be chosen one by one; select the whole file`,
        );
      }
      chosen = new Set(s.hunks);
      if (chosen.size !== s.hunks.length || chosen.size === 0) {
        throw new AboxError('invalid_input', `invalid hunk list for ${JSON.stringify(s.path)}`);
      }
      for (const i of chosen) {
        if (!Number.isInteger(i) || i < 0 || i >= file.hunks.length) {
          throw new AboxError('invalid_input', `${JSON.stringify(s.path)} has no hunk ${i}`);
        }
      }
      if (chosen.size === file.hunks.length) chosen = undefined;
    }
    picked.push({ file, chosen });
  }
  // the patch lists files in the order of the diff, whatever order the caller used
  const order = new Map(model.files.map((f, i) => [f.path, i]));
  picked.sort((a, b) => (order.get(a.file.path) ?? 0) - (order.get(b.file.path) ?? 0));

  let text = '';
  const files: SelectedFile[] = [];
  for (const { file, chosen } of picked) {
    const sections = model.sections.get(file.path) as Section[];
    const section = sections[0] as Section;
    if (chosen === undefined) {
      text += section.text;
      files.push({ file, hunks: file.hunks.map((h) => h.index), whole: true });
    } else {
      text += section.header + rebuildHunks(section.hunks, chosen);
      files.push({ file, hunks: [...chosen].sort((a, b) => a - b), whole: false });
    }
  }
  return { patch: Buffer.from(text, 'latin1'), files };
}

/** Paths a patch touches, as git itself reads them (`git apply --numstat -z` prints one per file). */
export function expectedPatchNames(files: SelectedFile[]): string[] {
  return files.map((f) => f.file.path).sort();
}

/** Normalised, validated relative path of a file in the target project (never absolute, never `..`). */
export function targetRelative(path: string): string {
  if (pathProblem(path) || posix.normalize(path) !== path) {
    throw new AboxError('policy_denied', `refused path ${JSON.stringify(path)}`, {
      hint: 'Only plain relative paths inside the project are applied (no .., no .git).',
    });
  }
  return path;
}
