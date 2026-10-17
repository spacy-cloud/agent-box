import { lstatSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, posix } from 'node:path';
import { AboxError } from '../errors.js';

/**
 * Host path canonicalization and the forbidden-path check.
 *
 * Threat model: a template, an agent or a symlink in a workspace tries to make
 * abox mount or use a path that exposes credentials or the container engine.
 * All comparisons happen on canonical paths (symlinks resolved, `..` gone) and
 * additionally on a case-folded, NFKC-folded form so case-insensitive file
 * systems and Unicode look-alikes (fullwidth `\uff0e\uff53\uff53\uff48`) cannot slip through.
 *
 * POSIX only. Time-of-check/time-of-use races (a path replaced by a symlink
 * after the check) are out of scope here; providers must open mounts without
 * following symlinks in the final component.
 */

// Control characters (C0, DEL, C1), format characters (zero-width, bidi
// overrides/isolates, joiners, soft hyphen, BOM, ...), line/paragraph
// separators and a few invisible "filler" letters.
const REJECTED_CHARS =
  // eslint-disable-next-line no-misleading-character-class -- the combining/filler characters are rejected on purpose
  /[\p{Cc}\p{Cf}\u2028\u2029\u034f\u115f\u1160\u17b4\u17b5\u3164\uffa0\u2800]/u;

const MAX_PATH_LENGTH = 4096;
const MAX_SYMLINK_HOPS = 40;

function rejectBadChars(value: string, what: string): void {
  const m = REJECTED_CHARS.exec(value);
  if (m) {
    const cp = (m[0].codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0');
    throw new AboxError(
      'invalid_input',
      `${what} contains a forbidden character (U+${cp}: control, zero-width or bidirectional-override characters are not allowed)`,
      {
        hint: 'Use a plain path without invisible or control characters.',
      },
    );
  }
}

export interface CanonicalizeOptions {
  /** Absolute home directory used for `~`. */
  home: string;
  /** Absolute directory relative paths are resolved against. */
  cwd: string;
}

/**
 * Turns user input into a canonical absolute path:
 * 1. rejects NUL, control, zero-width and bidi-override characters,
 * 2. expands `~` (only the current user's home; `~user` is rejected),
 * 3. resolves relative paths against `cwd`,
 * 4. NFC-normalizes,
 * 5. resolves symlinks component by component (so `link/..` follows the
 *    physical parent, like the kernel) for the existing part of the path and
 *    appends the non-existing remainder normalized; `..` can never escape.
 * The result is absolute, has no trailing slash (except `/`), and is
 * idempotent: `canonicalizePath(canonicalizePath(x)) === canonicalizePath(x)`.
 */
export function canonicalizePath(input: string, opts: CanonicalizeOptions): string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new AboxError('invalid_input', 'path must be a non-empty string');
  }
  if (input.length > MAX_PATH_LENGTH)
    throw new AboxError('invalid_input', `path is longer than ${MAX_PATH_LENGTH} characters`);
  rejectBadChars(input, 'path');
  rejectBadChars(opts.home, 'home directory');
  rejectBadChars(opts.cwd, 'working directory');
  if (!isAbsolute(opts.home) || !isAbsolute(opts.cwd)) {
    throw new AboxError('invalid_input', 'home and cwd must be absolute paths');
  }

  let p = input.normalize('NFC');
  if (p === '~' || p.startsWith('~/')) {
    p = opts.home.normalize('NFC') + p.slice(1);
  } else if (p.startsWith('~')) {
    throw new AboxError('invalid_input', 'paths of the form ~user are not supported', {
      hint: 'Use an absolute path or ~/...',
    });
  }
  if (!isAbsolute(p)) p = `${opts.cwd.normalize('NFC')}/${p}`;

  return finalizeExisting(walk(p)).normalize('NFC');
}

/**
 * The path as the user wrote it, made absolute and normalized but *not* symlink-resolved (`~`
 * expanded, relative paths against `cwd`, NFC, `.` and double slashes removed). `undefined` when the
 * input contains `..`: its meaning depends on symlinks, so there is no trustworthy lexical form.
 * Only used to additionally accept a human's explicit root when the project is reached through a
 * symlink (see `CheckHostPathOptions.lexicalPath`); every other check runs on the canonical path.
 */
export function lexicalPath(input: string, opts: CanonicalizeOptions): string | undefined {
  if (typeof input !== 'string' || input.length === 0 || input.length > MAX_PATH_LENGTH)
    return undefined;
  if (REJECTED_CHARS.test(input) || !isAbsolute(opts.home) || !isAbsolute(opts.cwd))
    return undefined;
  let p = input.normalize('NFC');
  if (p === '~' || p.startsWith('~/')) p = opts.home.normalize('NFC') + p.slice(1);
  else if (p.startsWith('~')) return undefined;
  if (!isAbsolute(p)) p = `${opts.cwd.normalize('NFC')}/${p}`;
  if (p.split('/').includes('..')) return undefined;
  return `/${splitComponents(p).join('/')}`;
}

function splitComponents(p: string): string[] {
  return p.split('/').filter((c) => c !== '' && c !== '.');
}

/** Lexical walk that resolves each symlink in place (physical `..` semantics). */
function walk(abs: string): string {
  const pending = splitComponents(abs);
  const resolved: string[] = [];
  let hops = 0;
  while (pending.length > 0) {
    const comp = pending.shift() as string;
    if (comp === '..') {
      resolved.pop();
      continue;
    }
    const candidate = `/${[...resolved, comp].join('/')}`;
    let isLink: boolean;
    try {
      isLink = lstatSync(candidate).isSymbolicLink();
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        resolved.push(comp);
        continue;
      }
      throw new AboxError(
        'invalid_input',
        `cannot resolve path ${candidate}: ${code ?? (e as Error).message}`,
        { cause: e },
      );
    }
    if (!isLink) {
      resolved.push(comp);
      continue;
    }
    if (++hops > MAX_SYMLINK_HOPS)
      throw new AboxError('invalid_input', `too many levels of symbolic links in ${abs}`);
    const target = readlinkSync(candidate);
    rejectBadChars(target, `symlink target of ${candidate}`);
    if (target.startsWith('/')) resolved.length = 0;
    pending.unshift(...splitComponents(target));
  }
  return `/${resolved.join('/')}`;
}

/** realpath.native of the longest existing prefix, then the remainder appended. */
function finalizeExisting(p: string): string {
  const comps = splitComponents(p);
  for (let i = comps.length; i >= 0; i--) {
    const prefix = `/${comps.slice(0, i).join('/')}`;
    try {
      const real = realpathSync.native(prefix);
      const rest = comps.slice(i);
      return rest.length === 0 ? real : `${real === '/' ? '' : real}/${rest.join('/')}`;
    } catch {
      // not existing: try a shorter prefix
    }
  }
  return p;
}

/** True when `child` equals `parent` or lies below it. Both must be canonical absolute paths. */
export function isWithin(child: string, parent: string): boolean {
  if (child === parent) return true;
  const prefix = parent.endsWith('/') ? parent : `${parent}/`;
  return child.startsWith(prefix);
}

/** NFKC + lower-case + lexical normalization; used only for comparisons. */
export function foldPath(p: string): string {
  const folded = posix.normalize(p.normalize('NFKC').toLowerCase());
  return folded.length > 1 && folded.endsWith('/') ? folded.slice(0, -1) : folded;
}

/** `isWithin` on folded paths (case-insensitive, Unicode-folded). */
export function isWithinFolded(child: string, parent: string): boolean {
  return isWithin(foldPath(child), foldPath(parent));
}

// ---------------------------------------------------------------------------
// Forbidden paths
// ---------------------------------------------------------------------------

interface ForbiddenSpec {
  /** Absolute path or path relative to home. */
  path: string;
  relativeToHome: boolean;
  /** `tree`: the path and everything below it. `self`: only the path itself (and its ancestors). */
  mode: 'tree' | 'self';
}

const ABSOLUTE_FORBIDDEN: ForbiddenSpec[] = [
  { path: '/', relativeToHome: false, mode: 'self' },
  ...[
    '/etc',
    '/proc',
    '/sys',
    '/dev',
    '/boot',
    '/root',
    '/run',
    '/var/run',
    '/var/lib/docker',
    '/var/lib/containers',
  ].map((path): ForbiddenSpec => ({ path, relativeToHome: false, mode: 'tree' })),
];

const HOME_FORBIDDEN: ForbiddenSpec[] = [
  { path: '', relativeToHome: true, mode: 'self' },
  ...[
    '.ssh',
    '.gnupg',
    '.config',
    '.aws',
    '.azure',
    '.kube',
    '.docker',
    '.local/share/keyrings',
    '.password-store',
    '.mozilla',
    '.netrc',
    '.git-credentials',
    '.npmrc',
    '.pypirc',
    '.var/app',
    // additions beyond the concept list: more credential / history stores
    '.pgpass',
    '.gem/credentials',
    '.cargo/credentials.toml',
    '.local/share/kwalletd',
    '.thunderbird',
    '.bash_history',
    '.zsh_history',
  ].map((path): ForbiddenSpec => ({ path, relativeToHome: true, mode: 'tree' })),
];

/** Basenames that are container-engine control sockets, whatever the type of the file. */
const ENGINE_SOCKET_NAMES = new Set([
  'docker.sock',
  'podman.sock',
  'containerd.sock',
  'crio.sock',
  'buildkitd.sock',
]);

export const FORBIDDEN_HOME_RELATIVE: readonly string[] = HOME_FORBIDDEN.filter(
  (s) => s.path !== '',
).map((s) => s.path);
export const FORBIDDEN_ABSOLUTE: readonly string[] = ABSOLUTE_FORBIDDEN.map((s) => s.path);

interface ForbiddenEntry {
  label: string;
  mode: 'tree' | 'self';
  /** Lexical path and (when different) its real path, both folded. */
  folded: string[];
}

function tryReal(p: string): string | undefined {
  try {
    return realpathSync.native(p);
  } catch {
    return undefined;
  }
}

function makeEntry(
  label: string,
  abs: string,
  mode: 'tree' | 'self',
  extraVariants: string[] = [],
): ForbiddenEntry {
  const variants = new Set<string>([abs, ...extraVariants]);
  const real = tryReal(abs);
  if (real) variants.add(real);
  return { label, mode, folded: [...variants].map(foldPath) };
}

function buildForbidden(home: string, extra: readonly string[]): ForbiddenEntry[] {
  const entries: ForbiddenEntry[] = [];
  const homes = new Set<string>([home]);
  const homeReal = tryReal(home);
  if (homeReal) homes.add(homeReal);

  for (const s of ABSOLUTE_FORBIDDEN) entries.push(makeEntry(s.path, s.path, s.mode));
  for (const s of HOME_FORBIDDEN) {
    const lexical = s.path === '' ? home : posix.join(home, s.path);
    const variants = [...homes].map((h) => (s.path === '' ? h : posix.join(h, s.path)));
    entries.push(
      makeEntry(s.path === '' ? 'the home directory' : `~/${s.path}`, lexical, s.mode, variants),
    );
  }
  for (const e of extra) {
    if (typeof e !== 'string' || !isAbsolute(e)) continue;
    entries.push(makeEntry(e, posix.normalize(e), 'tree'));
  }
  return entries;
}

export type PathDenyCode = 'invalid' | 'forbidden' | 'socket' | 'outside_roots' | 'unverifiable';

export type PathCheck =
  { ok: true } | { ok: false; code: PathDenyCode; reason: string; hint?: string };

/**
 * Root entry meaning "any directory": no roots check (the forbidden-path list still applies). The
 * built-in `human` profile uses it; policy.yaml cannot spell it (roots must be paths).
 */
export const ANY_ROOT = '*';

export interface CheckHostPathOptions {
  /** Absolute home directory of the user (forbidden entries are derived from it). */
  home: string;
  /**
   * Canonical allowed roots; the path must lie within one of them. `['*']` (`ANY_ROOT`) = any
   * directory: no roots check, only the forbidden list.
   */
  roots: readonly string[];
  /**
   * Humans with explicit roots: the path as typed (see `lexicalPath`, not symlink-resolved). It is
   * accepted when it lies within a root even if the canonical path (which is what the forbidden
   * list is checked on) does not, so a root `~/projects` still covers `~/projects/app` when that
   * is a symlink to another disk. Never pass it for agents: their symlinks are not trusted.
   */
  lexicalPath?: string;
  kind: 'workspace' | 'mount';
  /** Additional canonical forbidden trees (abox config/data dirs, other sandboxes' dirs). */
  extraForbidden?: readonly string[];
  /**
   * Scan a directory tree for socket files (default: true for `mount`, false
   * for `workspace` - copy/clone/worktree never expose the original files).
   * Pass `true` for workspace mode `mount`.
   */
  scanSockets?: boolean;
  /**
   * Agents: refuse every path below a hidden (dot) directory directly under the home directory
   * (`~/.claude`, `~/.codex`, `~/.cache`, ...), whatever the roots say. Those hold credentials, tokens and
   * tool configuration that no sandbox needs. Humans are not subject to this rule.
   */
  denyHiddenHomeDirs?: boolean;
  /**
   * Agents: the path must lie strictly *below* a root, the root directory itself is refused (the
   * concept allows paths "unterhalb" the allowed roots: `~/projects` is the collection of
   * projects, not a project). Humans are not subject to this rule.
   */
  strictlyBelowRoots?: boolean;
}

const SOCKET_SCAN_MAX_ENTRIES = 250_000;
const SOCKET_SCAN_MAX_DEPTH = 24;

/**
 * Checks a canonical host path against the forbidden list and the allowed roots.
 * Forbidden wins over roots: a root of `~` never makes `~/.ssh` usable.
 *
 * A path is forbidden when it is, lies below, or *contains* a forbidden path
 * (so mounting `~` or `/home` is refused even though neither is listed
 * explicitly as a tree). The home directory itself and `/` are forbidden as a
 * whole, but their descendants (e.g. `~/projects/x`) are not.
 */
export function checkHostPath(canonical: string, opts: CheckHostPathOptions): PathCheck {
  const label = opts.kind === 'mount' ? 'mount' : 'workspace';
  if (
    typeof canonical !== 'string' ||
    !isAbsolute(canonical) ||
    canonical.split('/').includes('..') ||
    canonical.split('/').includes('.')
  ) {
    return {
      ok: false,
      code: 'invalid',
      reason: `${label} path is not a canonical absolute path`,
      hint: 'Canonicalize the path with canonicalizePath() first.',
    };
  }
  if (REJECTED_CHARS.test(canonical)) {
    return {
      ok: false,
      code: 'invalid',
      reason: `${label} path contains control, zero-width or bidirectional-override characters`,
    };
  }
  if (!isAbsolute(opts.home))
    return { ok: false, code: 'invalid', reason: 'home directory must be absolute' };

  const folded = foldPath(canonical);
  for (const entry of buildForbidden(opts.home, opts.extraForbidden ?? [])) {
    for (const f of entry.folded) {
      const inside = entry.mode === 'tree' ? isWithin(folded, f) : folded === f;
      const contains = isWithin(f, folded);
      if (inside || contains) {
        const how = folded === f ? 'is' : contains ? 'contains' : 'is inside';
        return {
          ok: false,
          code: 'forbidden',
          reason: `${label} path ${canonical} ${how} protected path ${entry.label}, which can never be used as a ${label}`,
          hint: `Use a dedicated project directory instead (for example a subdirectory of your projects folder).`,
        };
      }
    }
  }

  if (opts.denyHiddenHomeDirs) {
    const hidden = hiddenHomeDir(folded, opts.home);
    if (hidden) {
      return {
        ok: false,
        code: 'forbidden',
        reason: `${label} path ${canonical} is inside the hidden home directory ~/${hidden}; agents cannot use hidden directories of the home directory (credentials, tokens, tool configuration)`,
        hint: `Use a project directory outside hidden home folders, for example ~/projects/<name>.`,
      };
    }
  }

  const base = basename(folded);
  if (ENGINE_SOCKET_NAMES.has(base)) {
    return {
      ok: false,
      code: 'socket',
      reason: `${label} path ${canonical} is a container engine socket (${base}), which can never be used as a ${label}`,
    };
  }

  const scan = opts.scanSockets ?? opts.kind === 'mount';
  if (scan) {
    const found = findSocket(canonical);
    if (found === 'unverifiable') {
      return {
        ok: false,
        code: 'unverifiable',
        reason: `${label} path ${canonical} cannot be verified to contain no socket files (tree too large, too deep or not readable; limit ${SOCKET_SCAN_MAX_ENTRIES} entries)`,
        hint: 'Mount a smaller subdirectory, or use workspace mode copy/clone/worktree.',
      };
    }
    if (found) {
      return {
        ok: false,
        code: 'socket',
        reason: `${label} path ${canonical} contains the socket file ${found}; sockets can give a sandbox control over host services and can never be mounted`,
        hint: 'Mount a directory that does not contain socket files.',
      };
    }
  }

  if (opts.roots.includes(ANY_ROOT)) return { ok: true };
  if (opts.roots.length === 0) {
    return {
      ok: false,
      code: 'outside_roots',
      reason: `no ${label} roots are allowed by the profile`,
      hint: `Ask the human to add ${opts.kind === 'mount' ? 'mounts.roots' : 'workspace.roots'} to the profile with \`abox policy edit\`.`,
    };
  }
  const lexical = opts.lexicalPath;
  const inRoots = (p: string): boolean => opts.roots.some((r) => isWithin(p, r));
  if (!inRoots(canonical) && !(lexical !== undefined && inRoots(lexical))) {
    return {
      ok: false,
      code: 'outside_roots',
      reason: `${label} path ${canonical} is outside the allowed ${label} roots (${opts.roots.join(', ')})`,
      hint: `Use a path inside one of the allowed roots, or ask the human to add the project directory to ${opts.kind === 'mount' ? 'mounts.roots' : 'workspace.roots'} of the profile with \`abox policy edit\` (\`abox init --agent <name>\` shows the current roots).`,
    };
  }
  if (
    opts.strictlyBelowRoots &&
    !opts.roots.some((r) => isWithin(canonical, r) && canonical !== r)
  ) {
    return {
      ok: false,
      code: 'outside_roots',
      reason: `${label} path ${canonical} is an allowed ${label} root itself; agents may only use a directory below a root (${opts.roots.join(', ')})`,
      hint: `Use a project directory inside the root (for example ${canonical}/<project>), or ask the human to add the project directory itself to ${opts.kind === 'mount' ? 'mounts.roots' : 'workspace.roots'} of the profile with \`abox policy edit\`.`,
    };
  }
  return { ok: true };
}

/** The hidden directory directly below the home directory that `folded` lies in (e.g. `.claude`), if any. */
function hiddenHomeDir(folded: string, home: string): string | undefined {
  const homes = new Set<string>([foldPath(home)]);
  const real = tryReal(home);
  if (real) homes.add(foldPath(real));
  for (const h of homes) {
    if (!isWithin(folded, h) || folded === h) continue;
    const first = folded.slice(h === '/' ? 1 : h.length + 1).split('/')[0] ?? '';
    if (first.startsWith('.')) return first;
  }
  return undefined;
}

/** Returns the path of the first socket found, 'unverifiable' when the scan limit is hit or a directory is unreadable, else undefined. */
function findSocket(root: string): string | 'unverifiable' | undefined {
  let st;
  try {
    st = lstatSync(root);
  } catch {
    return undefined; // non-existing path: nothing to scan
  }
  if (st.isSocket()) return root;
  if (!st.isDirectory()) return undefined;

  let seen = 0;
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop() as { dir: string; depth: number };
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // Unreadable directory: it cannot be listed by the sandbox either, but a
      // later chmod could change that. Be strict.
      return 'unverifiable';
    }
    for (const e of entries) {
      if (++seen > SOCKET_SCAN_MAX_ENTRIES) return 'unverifiable';
      const full = `${dir === '/' ? '' : dir}/${e.name}`;
      if (e.isSocket()) return full;
      if (e.isDirectory()) {
        if (depth + 1 > SOCKET_SCAN_MAX_DEPTH) return 'unverifiable';
        stack.push({ dir: full, depth: depth + 1 });
      }
    }
  }
  return undefined;
}

/**
 * Trees inside the sandbox that nothing may be mounted onto (nor placed in by a template): system
 * locations the sandbox needs for itself. One list for the create-time check (`checkMountTarget`)
 * and the template validation.
 */
export const RESERVED_SANDBOX_TREES: readonly string[] = [
  '/proc',
  '/sys',
  '/dev',
  '/etc',
  '/run',
  '/var/run',
  '/boot',
  '/bin',
  '/sbin',
  '/usr',
  '/lib',
  '/lib64',
];

/**
 * Validates a path *inside* the sandbox used as mount target: absolute,
 * normalized, no control characters, and not one of the system locations a
 * sandbox needs for itself.
 */
export function checkMountTarget(target: string): { ok: true } | { ok: false; reason: string } {
  if (typeof target !== 'string' || !target.startsWith('/'))
    return {
      ok: false,
      reason: `mount target "${String(target)}" must be an absolute path inside the sandbox`,
    };
  if (REJECTED_CHARS.test(target))
    return {
      ok: false,
      reason: 'mount target contains control, zero-width or bidirectional-override characters',
    };
  const norm = posix.normalize(target);
  if (norm !== target && norm + '/' !== target) {
    return {
      ok: false,
      reason: `mount target "${target}" is not normalized (no "..", "." or double slashes; expected "${norm}")`,
    };
  }
  const t = foldPath(norm);
  const reserved = ['/', ...RESERVED_SANDBOX_TREES];
  for (const r of reserved) {
    if (r === '/' ? t === '/' : isWithin(t, r)) {
      return {
        ok: false,
        reason: `mount target ${target} would shadow the system location ${r} inside the sandbox`,
      };
    }
  }
  return { ok: true };
}
