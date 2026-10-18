import { constants as fsc } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { readTrackedPaths, type TrackedPaths } from './gitindex.js';
import { isDotGitLike } from './safefs.js';

/**
 * `.gitignore` support for workspace copies, in-process (git is never run on the host: a repository
 * can carry config, filters and attributes that must not execute here).
 *
 * What is applied, as git applies it:
 * - the `.gitignore` of every directory of the tree, for the entries below that directory; deeper
 *   files win over shallower ones, and within a file the last matching line wins;
 * - `.git/info/exclude` of the tree root (lowest precedence), when `.git` is a real directory;
 * - comments, blank lines, `\#` / `\!` escapes, trailing spaces (unless escaped), CRLF line ends;
 * - `!` negation, a leading or inner `/` (anchored to the directory of the file), a trailing `/`
 *   (directories only), `*`, `?`, `[a-z]` / `[!a]` / `[[:digit:]]`, `\` escapes and `**` as a whole
 *   segment (`**\/x`, `x/**`, `x/**\/y`).
 * - a directory that is ignored is not entered, so nothing below it can be re-included (git's rule).
 * - files tracked by git (read from `.git/index` in-process) are never ignored, whatever the rules
 *   say; an ignored directory that contains tracked files is entered and only those are kept.
 *
 * What is not: the user's global `core.excludesFile` (machine specific), `.gitignore` files of
 * directories above the tree root, `.git/info/exclude` of nested repositories, and
 * `core.ignorecase` (names are matched case-sensitively). `.git` entries are never evaluated and
 * nothing below a `.git` directory is looked at.
 *
 * Hostile or accidental input is bounded: a `.gitignore` that is a symbolic link, not a regular
 * file or larger than {@link GITIGNORE_LIMITS}.fileBytes is ignored with a warning; so are files
 * beyond the total budgets. Patterns are matched by a small linear-backtracking glob matcher (no
 * regular expressions), and over-long or over-complex patterns are skipped.
 */
export const GITIGNORE_LIMITS = {
  /** Bytes of one `.gitignore` file. */
  fileBytes: 1024 * 1024,
  /** Bytes of all `.gitignore` files of one walk. */
  totalBytes: 16 * 1024 * 1024,
  /** Number of `.gitignore` files of one walk. */
  files: 10_000,
  /** Rules of one file; a file with more is ignored. */
  fileRules: 5_000,
  /** Rules that apply to one entry (the files from the root down to its directory together). */
  chainRules: 10_000,
  /** Characters of one pattern line. */
  patternChars: 1024,
  /** `/`-separated segments of one pattern. */
  patternSegments: 64,
} as const;

/** At most this many warnings are kept; the rest is summed up in one line. */
const MAX_WARNINGS = 20;

type Atom =
  | { k: 'c'; c: string }
  | { k: '?' }
  | { k: '*' }
  | { k: '['; neg: boolean; ranges: Array<[string, string]>; classes: string[] };

interface Rule {
  negate: boolean;
  dirOnly: boolean;
  /** No `/` in the pattern: matched against the entry name at any depth below the file. */
  nameOnly: boolean;
  /** `nameOnly`: the whole pattern is a plain name. */
  literal?: string;
  /** `nameOnly`: the one glob. */
  glob?: Atom[];
  /** Otherwise: the path segments (`null` = `**`). */
  segs?: Array<Atom[] | null>;
}

const POSIX_CLASSES: Record<string, RegExp> = {
  alnum: /[A-Za-z0-9]/,
  alpha: /[A-Za-z]/,
  blank: /[ \t]/,
  // eslint-disable-next-line no-control-regex
  cntrl: /[\0-\x1f\x7f]/,
  digit: /[0-9]/,
  graph: /[!-~]/,
  lower: /[a-z]/,
  print: /[ -~]/,
  punct: /[!-/:-@[-`{-~]/,
  space: /[ \t\n\r\f\v]/,
  upper: /[A-Z]/,
  xdigit: /[0-9A-Fa-f]/,
};

function atomMatches(a: Atom, ch: string): boolean {
  switch (a.k) {
    case 'c':
      return a.c === ch;
    case '?':
      return true;
    case '[': {
      let hit = false;
      for (const [lo, hi] of a.ranges) {
        if (ch >= lo && ch <= hi) {
          hit = true;
          break;
        }
      }
      if (!hit) {
        for (const cl of a.classes) {
          if (POSIX_CLASSES[cl]?.test(ch)) {
            hit = true;
            break;
          }
        }
      }
      return hit !== a.neg;
    }
    default:
      return false;
  }
}

/** Glob match of one path segment (`*` and `?` never cross a `/`: segments contain none). */
function globMatch(atoms: readonly Atom[], s: string): boolean {
  let ti = 0;
  let si = 0;
  let starT = -1;
  let starS = 0;
  while (si < s.length) {
    const a = atoms[ti];
    if (a?.k === '*') {
      starT = ti++;
      starS = si;
    } else if (a && atomMatches(a, s.charAt(si))) {
      ti++;
      si++;
    } else if (starT >= 0) {
      ti = starT + 1;
      si = ++starS;
    } else {
      return false;
    }
  }
  while (atoms[ti]?.k === '*') ti++;
  return ti === atoms.length;
}

/** Matches path segments against pattern segments; a `null` pattern segment (`**`) takes zero or more. */
function segsMatch(pattern: ReadonlyArray<Atom[] | null>, path: readonly string[]): boolean {
  let pi = 0;
  let si = 0;
  let starP = -1;
  let starS = 0;
  while (si < path.length) {
    const p = pattern[pi];
    if (p === null) {
      starP = pi++;
      starS = si;
    } else if (p && globMatch(p, path[si] as string)) {
      pi++;
      si++;
    } else if (starP >= 0) {
      pi = starP + 1;
      si = ++starS;
    } else {
      return false;
    }
  }
  while (pattern[pi] === null) pi++;
  return pi === pattern.length;
}

/** One path segment of a pattern as atoms; `undefined` when git would never match it. */
function compileGlob(seg: string): Atom[] | undefined {
  const atoms: Atom[] = [];
  for (let i = 0; i < seg.length; i++) {
    const ch = seg.charAt(i);
    if (ch === '\\') {
      if (i + 1 >= seg.length) return undefined;
      atoms.push({ k: 'c', c: seg.charAt(++i) });
    } else if (ch === '*') {
      while (seg.charAt(i + 1) === '*') i++;
      atoms.push({ k: '*' });
    } else if (ch === '?') {
      atoms.push({ k: '?' });
    } else if (ch === '[') {
      let j = i + 1;
      let neg = false;
      if (seg.charAt(j) === '!' || seg.charAt(j) === '^') {
        neg = true;
        j++;
      }
      const ranges: Array<[string, string]> = [];
      const classes: string[] = [];
      let first = true;
      let closed = false;
      while (j < seg.length) {
        let c = seg.charAt(j);
        if (c === ']' && !first) {
          closed = true;
          break;
        }
        first = false;
        if (c === '[' && seg.charAt(j + 1) === ':') {
          const end = seg.indexOf(':]', j + 2);
          if (end > 0) {
            const name = seg.slice(j + 2, end);
            if (!(name in POSIX_CLASSES)) return undefined;
            classes.push(name);
            j = end + 2;
            continue;
          }
        }
        if (c === '\\') {
          j++;
          if (j >= seg.length) return undefined;
          c = seg.charAt(j);
        }
        if (seg.charAt(j + 1) === '-' && j + 2 < seg.length && seg.charAt(j + 2) !== ']') {
          let hi = seg.charAt(j + 2);
          j += 2;
          if (hi === '\\') {
            j++;
            if (j >= seg.length) return undefined;
            hi = seg.charAt(j);
          }
          ranges.push([c, hi]);
        } else {
          ranges.push([c, c]);
        }
        j++;
      }
      if (!closed) return undefined;
      atoms.push({ k: '[', neg, ranges, classes });
      i = j;
    } else {
      atoms.push({ k: 'c', c: ch });
    }
  }
  return atoms;
}

/** git's `trim_trailing_spaces`: trailing spaces go unless escaped with a backslash. */
function trimTrailingSpaces(s: string): string {
  let lastSpace = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    if (c === ' ') {
      if (lastSpace < 0) lastSpace = i;
    } else {
      if (c === '\\') {
        i++;
        if (i >= s.length) return s;
      }
      lastSpace = -1;
    }
  }
  return lastSpace >= 0 ? s.slice(0, lastSpace) : s;
}

/** Parses one pattern line. `undefined`: comment, blank, or a pattern that can never match / is refused. */
function parseLine(raw: string, tooComplex: () => void): Rule | undefined {
  let line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
  if (line === '' || line.startsWith('#')) return undefined;
  line = trimTrailingSpaces(line);
  if (line === '') return undefined;
  let negate = false;
  if (line.startsWith('!')) {
    negate = true;
    line = line.slice(1);
  }
  if (line.length > GITIGNORE_LIMITS.patternChars || line.includes('\0')) {
    tooComplex();
    return undefined;
  }
  let dirOnly = false;
  if (line.endsWith('/')) {
    dirOnly = true;
    line = line.slice(0, -1);
  }
  if (line === '') return undefined;
  const nameOnly = !line.includes('/');
  if (line.startsWith('/')) line = line.slice(1);
  if (line === '') return undefined;
  const parts = line.split('/');
  if (parts.length > GITIGNORE_LIMITS.patternSegments) {
    tooComplex();
    return undefined;
  }
  if (parts.some((p) => p === '')) return undefined; // `a//b` never matches in git

  if (nameOnly) {
    const glob = compileGlob(line);
    if (!glob) return undefined;
    const literal = glob.every((a) => a.k === 'c')
      ? glob.map((a) => (a as { c: string }).c).join('')
      : undefined;
    return { negate, dirOnly, nameOnly, glob, ...(literal !== undefined ? { literal } : {}) };
  }
  const segs: Array<Atom[] | null> = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i] as string;
    if (p === '**') {
      segs.push(null);
      // `x/**` matches what is inside x (at least one more segment), not x itself
      if (i === parts.length - 1) segs.splice(segs.length - 1, 1, [{ k: '*' }], null);
    } else {
      const g = compileGlob(p);
      if (!g) return undefined;
      segs.push(g);
    }
  }
  return { negate, dirOnly, nameOnly, segs };
}

/**
 * The rules in force inside one directory: its own `.gitignore` plus those of the directories above
 * (immutable chain; a directory without a `.gitignore` shares the layer of its parent).
 */
export class IgnoreLayer {
  constructor(
    readonly parent: IgnoreLayer | undefined,
    /** Segments of the directory of the file, relative to the tree root (0 for the root). */
    readonly depth: number,
    readonly rules: readonly Rule[],
    /** Rules in this layer and all layers above. */
    readonly chainRules: number,
    /** Inside an ignored directory that holds tracked files: everything is ignored (unless tracked). */
    readonly forced = false,
  ) {}

  /** The scope for the contents of an ignored directory that is entered because it holds tracked files. */
  forcedView(): IgnoreLayer {
    return new IgnoreLayer(this.parent, this.depth, this.rules, this.chainRules, true);
  }

  /**
   * True when git would ignore the entry. `rel` is the `/`-separated path from the tree root,
   * `name` its last segment, `isDir` true only for a real directory (a link to one is not).
   * The caller has already decided that the parent directories are not ignored.
   */
  ignores(rel: string, name: string, isDir: boolean): boolean {
    return layersIgnore(this, rel, name, isDir);
  }
}

function layersIgnore(top: IgnoreLayer, rel: string, name: string, isDir: boolean): boolean {
  if (top.forced) return true;
  let segs: string[] | undefined;
  for (let l: IgnoreLayer | undefined = top; l; l = l.parent) {
    const rules = l.rules;
    for (let i = rules.length - 1; i >= 0; i--) {
      const r = rules[i] as Rule;
      if (r.dirOnly && !isDir) continue;
      let hit: boolean;
      if (r.nameOnly) {
        hit = r.literal !== undefined ? r.literal === name : globMatch(r.glob as Atom[], name);
      } else {
        segs ??= rel.split('/');
        hit = segsMatch(r.segs as Array<Atom[] | null>, l.depth === 0 ? segs : segs.slice(l.depth));
      }
      if (hit) return !r.negate;
    }
  }
  return false;
}

/**
 * The state of one walk: budgets, warnings, and the loading of `.gitignore` files. Create one per
 * scan / copy and hand it to the walker; afterwards `warnings` says what could not be applied.
 */
export class GitignoreSession {
  readonly warnings: string[] = [];
  /** Content of `.git/info/exclude` of the tree root, when there was one (set by {@link root}). */
  infoExclude: string | undefined;
  /** Paths the git index of the tree root tracks (`undefined`: no repository, or unreadable, see the warnings). */
  tracked: TrackedPaths | undefined;
  filesLoaded = 0;
  private bytesLoaded = 0;
  private suppressed = 0;
  private readonly noRules = new IgnoreLayer(undefined, 0, [], 0);

  warn(message: string): void {
    if (this.warnings.length < MAX_WARNINGS) this.warnings.push(message);
    else this.suppressed++;
  }

  /** The warnings, plus one line for those beyond the cap. */
  allWarnings(): string[] {
    return this.suppressed > 0
      ? [...this.warnings, `${this.suppressed} more .gitignore warning(s) not shown`]
      : [...this.warnings];
  }

  /**
   * The layer of the tree root: `.git/info/exclude` (if `.git` is a real directory with one). Also
   * reads the git index of the tree root for the tracked paths.
   */
  async root(sourceDir: string): Promise<IgnoreLayer> {
    const idx = await readTrackedPaths(sourceDir);
    if ('tracked' in idx) this.tracked = idx.tracked;
    else if ('problem' in idx)
      this.warn(`${idx.problem}; files tracked by git that match a pattern are left out`);
    const path = join(sourceDir, '.git', 'info', 'exclude');
    try {
      for (const dir of [join(sourceDir, '.git'), join(sourceDir, '.git', 'info')]) {
        if (!(await lstat(dir)).isDirectory()) return this.noRules;
      }
    } catch {
      return this.noRules;
    }
    const read = await this.readFile(path, '.git/info/exclude');
    if (read === undefined) return this.noRules;
    this.infoExclude = read;
    return this.addText(this.noRules, '', read, '.git/info/exclude');
  }

  /**
   * The layer for a directory: `parent` plus the `.gitignore` at `filePath` (absolute, opened
   * without following links), or `parent` itself when the directory has none.
   */
  async load(
    parent: IgnoreLayer,
    relDir: string,
    filePath: string | undefined,
  ): Promise<IgnoreLayer> {
    if (filePath === undefined || parent.forced) return parent;
    const label = relDir ? `${relDir}/.gitignore` : '.gitignore';
    const text = await this.readFile(filePath, label);
    return text === undefined ? parent : this.addText(parent, relDir, text, label);
  }

  /** Adds the rules of a `.gitignore` text that applies below `relDir`. */
  addText(parent: IgnoreLayer, relDir: string, text: string, label: string): IgnoreLayer {
    const rules: Rule[] = [];
    let skipped = 0;
    const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split('\n');
    for (const line of lines) {
      const r = parseLine(line, () => skipped++);
      if (!r) continue;
      if (rules.length >= GITIGNORE_LIMITS.fileRules) {
        this.warn(
          `${label} has more than ${GITIGNORE_LIMITS.fileRules} patterns and was not applied`,
        );
        return parent;
      }
      rules.push(r);
    }
    if (skipped > 0) {
      this.warn(
        `${label}: ${skipped} pattern(s) skipped (longer than ${GITIGNORE_LIMITS.patternChars} characters or too many path segments)`,
      );
    }
    if (rules.length === 0) return parent;
    if (parent.chainRules + rules.length > GITIGNORE_LIMITS.chainRules) {
      this.warn(
        `${label} was not applied: more than ${GITIGNORE_LIMITS.chainRules} patterns apply to its directory`,
      );
      return parent;
    }
    const depth = relDir === '' ? 0 : relDir.split('/').length;
    return new IgnoreLayer(parent, depth, rules, parent.chainRules + rules.length);
  }

  /**
   * Reads one ignore file: never through a link, only a regular file, bounded in size and in
   * number. `undefined` when it is absent, unusable or over a budget (the last two with a warning).
   */
  private async readFile(path: string, label: string): Promise<string | undefined> {
    let fh;
    try {
      fh = await open(path, fsc.O_RDONLY | fsc.O_NOFOLLOW | fsc.O_NONBLOCK);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ELOOP') this.warn(`${label} is a symbolic link and was not applied`);
      else if (code !== 'ENOENT' && code !== 'ENOTDIR')
        this.warn(`${label} could not be read (${code ?? 'error'}) and was not applied`);
      return undefined;
    }
    try {
      const st = await fh.stat();
      if (!st.isFile()) return undefined; // a directory of that name: git ignores it, too
      if (st.size > GITIGNORE_LIMITS.fileBytes) {
        this.warn(
          `${label} is larger than ${GITIGNORE_LIMITS.fileBytes / 1024} KiB and was not applied`,
        );
        return undefined;
      }
      if (
        this.filesLoaded >= GITIGNORE_LIMITS.files ||
        this.bytesLoaded + st.size > GITIGNORE_LIMITS.totalBytes
      ) {
        this.warn(`${label} was not applied: too many or too large .gitignore files in this tree`);
        return undefined;
      }
      const buf = Buffer.allocUnsafe(st.size);
      let pos = 0;
      while (pos < st.size) {
        const { bytesRead } = await fh.read(buf, pos, st.size - pos, pos);
        if (bytesRead === 0) break;
        pos += bytesRead;
      }
      this.filesLoaded++;
      this.bytesLoaded += pos;
      return buf.toString('utf8', 0, pos);
    } finally {
      await fh.close();
    }
  }

  /** A layer without rules. */
  empty(): IgnoreLayer {
    return this.noRules;
  }

  /**
   * What to do with one entry of a directory whose rules are `scope`: `keep`, `ignore`, or
   * `forced` = keep this directory but only what git tracks below it (it is ignored itself, yet
   * holds tracked files). `.git` entries are always kept; the caller gives their contents no scope.
   */
  decide(
    scope: IgnoreLayer,
    rel: string,
    name: string,
    isDir: boolean,
  ): 'keep' | 'ignore' | 'forced' {
    if (isDotGitLike(name) || !scope.ignores(rel, name, isDir)) return 'keep';
    if (this.tracked) {
      if (this.tracked.files.has(rel)) return 'keep';
      if (isDir && this.tracked.dirs.has(rel)) return 'forced';
    }
    return 'ignore';
  }
}

/** True for a name that must never be evaluated (nor looked into): `.git` and its spellings. */
export function neverIgnored(name: string): boolean {
  return isDotGitLike(name);
}

export type PathIgnoreMatcher = (relPath: string, isDir: boolean) => boolean;

/**
 * A matcher over a fixed set of ignore files, for trees that are not walked file by file with the
 * rules read on the way (the export compares a sandbox tree against the files of its baseline).
 * `files` maps a directory (`''` for the root) to the text of its `.gitignore`. The matcher also
 * answers for entries below an ignored directory (those are ignored, too).
 */
export function compileGitignoreSet(
  files: ReadonlyMap<string, string>,
  opts: { infoExclude?: string; session?: GitignoreSession } = {},
): PathIgnoreMatcher {
  const session = opts.session ?? new GitignoreSession();
  const layers = new Map<string, IgnoreLayer>();
  const parentOf = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  const baseName = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
  const layerFor = (dir: string): IgnoreLayer => {
    const known = layers.get(dir);
    if (known) return known;
    let layer: IgnoreLayer;
    if (dir === '') {
      let base = session.empty();
      if (opts.infoExclude) base = session.addText(base, '', opts.infoExclude, '.git/info/exclude');
      const text = files.get('');
      layer = text !== undefined ? session.addText(base, '', text, '.gitignore') : base;
    } else {
      const parent = layerFor(parentOf(dir));
      const text = files.get(dir);
      layer = text !== undefined ? session.addText(parent, dir, text, `${dir}/.gitignore`) : parent;
    }
    layers.set(dir, layer);
    return layer;
  };
  const dirs = new Map<string, boolean>();
  const dirIgnored = (dir: string): boolean => {
    if (dir === '') return false;
    const known = dirs.get(dir);
    if (known !== undefined) return known;
    const parent = parentOf(dir);
    const v =
      !neverIgnored(baseName(dir)) &&
      (dirIgnored(parent) || layerFor(parent).ignores(dir, baseName(dir), true));
    dirs.set(dir, v);
    return v;
  };
  return (rel, isDir) => {
    if (rel.split('/').some(neverIgnored)) return false;
    const name = baseName(rel);
    const parent = parentOf(rel);
    if (dirIgnored(parent)) return true;
    return layerFor(parent).ignores(rel, name, isDir);
  };
}
