import { createHash } from 'node:crypto';
import { constants as fsc } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { FlaggedPath, GitMarker } from './types.js';

/**
 * The `.git` entry of a host directory that is exposed to a sandbox (`mount`, `worktree`)
 * is made read-only for the sandbox. abox records its identity at creation and verifies it
 * again before an export. Nothing is ever read *through* it by git — the check exists to
 * detect (and report) tampering attempts, e.g. a replaced `.git` file pointing to an
 * attacker-controlled git directory with hooks.
 */

const O_FILE = fsc.O_RDONLY | fsc.O_NOFOLLOW | fsc.O_NONBLOCK;

async function readSmallFile(path: string, maxBytes: number): Promise<Buffer | undefined> {
  try {
    const fh = await open(path, O_FILE);
    try {
      const st = await fh.stat();
      if (!st.isFile() || st.size > maxBytes) return undefined;
      const buf = Buffer.alloc(st.size);
      const { bytesRead } = await fh.read(buf, 0, st.size, 0);
      return buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  } catch {
    return undefined;
  }
}

async function listHooks(gitDir: string): Promise<string[]> {
  try {
    const hooksDir = join(gitDir, 'hooks');
    if (!(await lstat(hooksDir)).isDirectory()) return [];
    return (await readdir(hooksDir)).filter((n) => !n.endsWith('.sample')).sort();
  } catch {
    return [];
  }
}

/** Records the current state of `<dir>/.git`. Returns undefined when there is none. */
export async function captureGitMarker(dir: string): Promise<GitMarker | undefined> {
  const p = join(dir, '.git');
  let st;
  try {
    st = await lstat(p);
  } catch {
    return undefined;
  }
  if (st.isDirectory()) {
    const cfg = await readSmallFile(join(p, 'config'), 4 * 1024 * 1024);
    return {
      kind: 'dir',
      dev: String(st.dev),
      ino: String(st.ino),
      ...(cfg ? { configSha256: createHash('sha256').update(cfg).digest('hex') } : {}),
      hooks: await listHooks(p),
    };
  }
  if (st.isFile()) {
    const content = await readSmallFile(p, 64 * 1024);
    if (content) return { kind: 'file', content: content.toString('utf8') };
  }
  return undefined;
}

const RISKY_CONFIG: Array<[RegExp, string]> = [
  [/^\s*fsmonitor\s*=/im, 'core.fsmonitor'],
  [/^\s*hookspath\s*=/im, 'core.hooksPath'],
  [/^\s*pager\s*=/im, 'pager'],
  [/^\s*editor\s*=/im, 'editor'],
  [/^\s*sshcommand\s*=/im, 'core.sshCommand'],
  [/^\s*askpass\s*=/im, 'askPass'],
  [/^\s*gitproxy\s*=/im, 'core.gitProxy'],
  [/^\s*external\s*=/im, 'diff.external'],
  [/^\s*(textconv|clean|smudge|process|cmd|program)\s*=/im, 'filter/diff/merge driver command'],
  [/^\s*helper\s*=/im, 'credential helper'],
  [/^\s*\[\s*(alias|filter|include|includeif)\b/im, 'alias/filter/include section'],
  [/=\s*!/m, 'shell command value'],
];

/** Reports risky keys in the text of a git config. */
export function scanGitConfig(text: string): string[] {
  const found: string[] = [];
  for (const [re, name] of RISKY_CONFIG) if (re.test(text)) found.push(name);
  return found;
}

/**
 * Inspects a `.git` directory that came out of a sandbox (quiescent host copy). Nothing is
 * executed or interpreted; hooks and risky config keys are only reported.
 */
export async function scanSandboxGitDir(
  dotGit: string,
  relPrefix = '.git',
): Promise<FlaggedPath[]> {
  const out: FlaggedPath[] = [];
  try {
    if (!(await lstat(dotGit)).isDirectory()) return out;
  } catch {
    return out;
  }
  for (const h of await listHooks(dotGit)) {
    out.push({
      path: `${relPrefix}/hooks/${h}`,
      reason: 'git hook inside the sandbox repository (not exported; never run it on the host)',
    });
  }
  const cfg = await readSmallFile(join(dotGit, 'config'), 4 * 1024 * 1024);
  if (cfg) {
    const keys = scanGitConfig(cfg.toString('utf8'));
    if (keys.length > 0) {
      out.push({
        path: `${relPrefix}/config`,
        reason: `sandbox git config defines ${keys.join(', ')} (not exported; never use this repository on the host)`,
      });
    }
  }
  return out;
}

export interface MarkerCheck {
  /** Reasons why the marker no longer matches (empty = untouched). */
  problems: string[];
  /** Informational findings (changed config, new hooks). */
  notes: FlaggedPath[];
}

/** Verifies `<dir>/.git` against the recorded marker. Never reads anything through it except small text files. */
export async function checkGitMarker(dir: string, marker: GitMarker): Promise<MarkerCheck> {
  const p = join(dir, '.git');
  const problems: string[] = [];
  const notes: FlaggedPath[] = [];
  let st;
  try {
    st = await lstat(p);
  } catch {
    return { problems: ['.git no longer exists'], notes };
  }
  if (marker.kind === 'file') {
    if (!st.isFile()) {
      problems.push(
        `.git was a file (${JSON.stringify(marker.content.trim())}) and is now ${st.isSymbolicLink() ? 'a symlink' : st.isDirectory() ? 'a directory' : 'something else'}`,
      );
      return { problems, notes };
    }
    const now = await readSmallFile(p, 64 * 1024);
    if (!now || now.toString('utf8') !== marker.content) {
      problems.push(
        `.git file content changed (was ${JSON.stringify(marker.content.trim())}, now ${JSON.stringify((now?.toString('utf8') ?? '<unreadable>').trim().slice(0, 300))})`,
      );
    }
    return { problems, notes };
  }
  if (!st.isDirectory()) {
    problems.push(
      `.git was a directory and is now ${st.isSymbolicLink() ? 'a symlink' : 'a file or other entry'}`,
    );
    return { problems, notes };
  }
  if (String(st.ino) !== marker.ino || String(st.dev) !== marker.dev) {
    problems.push('.git directory was replaced (different inode)');
    return { problems, notes };
  }
  const cfg = await readSmallFile(join(p, 'config'), 4 * 1024 * 1024);
  const sha = cfg ? createHash('sha256').update(cfg).digest('hex') : undefined;
  if (sha !== marker.configSha256) {
    const keys = cfg ? scanGitConfig(cfg.toString('utf8')) : [];
    notes.push({
      path: '.git/config',
      reason: `.git/config changed since the workspace was created${keys.length ? ` and defines ${keys.join(', ')}` : ''}`,
    });
  }
  const hooks = await listHooks(p);
  for (const h of hooks) {
    if (!marker.hooks.includes(h))
      notes.push({
        path: `.git/hooks/${h}`,
        reason: 'git hook added since the workspace was created',
      });
  }
  return { problems, notes };
}
