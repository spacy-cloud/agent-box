import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { AboxError } from '../errors.js';

/**
 * Hardened host-side git invocation.
 *
 * Every git process abox starts on the host goes through `runGit`:
 *
 * - argv only, no shell, no inherited environment (only PATH is taken over);
 * - system and global config are disabled, hooks/fsmonitor/pager/external diff/
 *   attribute files/credential helpers/network protocols are switched off on the
 *   command line (command-line config beats any repository config);
 * - callers pass an explicit `gitDir` (and `workTree`) pointing to a host-owned
 *   location whenever a work tree may have been touched by a sandbox, so git never
 *   performs repository discovery inside sandbox-writable directories.
 */

/** Config applied to every invocation via `-c`. */
export const HARDENED_GIT_CONFIG: readonly string[] = [
  'core.hooksPath=/dev/null',
  'core.fsmonitor=false',
  'core.untrackedCache=false',
  'core.attributesFile=/dev/null',
  'core.excludesFile=/dev/null',
  'core.editor=true',
  'core.askPass=',
  'core.symlinks=true',
  'core.autocrlf=false',
  'core.safecrlf=false',
  'core.protectNTFS=true',
  'core.sshCommand=/bin/false',
  // fail closed: a `git diff` without --no-ext-diff must not run a repo-configured program
  'diff.external=/bin/false',
  'credential.helper=',
  'protocol.allow=never',
  'protocol.file.allow=user',
  'submodule.recurse=false',
  'fetch.recurseSubmodules=false',
  'gc.auto=0',
  'maintenance.auto=false',
  'commit.gpgsign=false',
  'tag.gpgsign=false',
];

export interface RunGitOptions {
  /** Working directory of the process. Defaults to the OS temp dir (never a repo). */
  cwd?: string;
  /** Explicit git directory (`--git-dir`). Required for every command except init/clone-like ones. */
  gitDir?: string;
  /** Explicit work tree (`--work-tree`). */
  workTree?: string;
  /** Treat pathspecs literally (`--literal-pathspecs`). */
  literalPathspecs?: boolean;
  /** Data written to stdin. */
  input?: string | Buffer;
  /** Extra environment entries, e.g. `GIT_INDEX_FILE`, `GIT_AUTHOR_NAME`. */
  env?: Record<string, string>;
  /** Additional `-c key=value` entries (applied after the hardened ones). */
  config?: string[];
  /** Do not throw on a non-zero exit code. */
  allowFailure?: boolean;
  /** Maximum stdout size in bytes (default 512 MiB). */
  maxStdoutBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Raw stdout (for NUL-separated or binary output). */
  raw: Buffer;
}

function baseEnv(): Record<string, string> {
  return {
    PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: '/nonexistent',
    XDG_CONFIG_HOME: '/nonexistent',
    LC_ALL: 'C',
    LANG: 'C',
    LANGUAGE: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_EDITOR: 'true',
    GIT_PAGER: 'cat',
    GIT_NO_REPLACE_OBJECTS: '1',
  };
}

/** Builds the full argv (without the `git` executable) for a hardened invocation. */
export function buildGitArgv(args: string[], opts: RunGitOptions = {}): string[] {
  const argv: string[] = ['--no-pager', '--no-replace-objects'];
  for (const c of HARDENED_GIT_CONFIG) argv.push('-c', c);
  for (const c of opts.config ?? []) argv.push('-c', c);
  if (opts.gitDir) argv.push(`--git-dir=${opts.gitDir}`);
  if (opts.workTree) argv.push(`--work-tree=${opts.workTree}`);
  if (opts.literalPathspecs) argv.push('--literal-pathspecs');
  return [...argv, ...args];
}

function describeFailure(args: string[], code: number | null, stderr: string): string {
  const sub = args.find((a) => !a.startsWith('-')) ?? args[0] ?? '';
  const msg = stderr.trim().split('\n').slice(0, 6).join('\n').slice(0, 1500);
  return `git ${sub} failed (exit ${code ?? 'signal'})${msg ? `: ${msg}` : ''}`;
}

/** Runs git with hardened settings. Throws `AboxError('backend_error')` on failure unless `allowFailure`. */
export async function runGit(args: string[], opts: RunGitOptions = {}): Promise<GitResult> {
  for (const a of args) {
    if (a.includes('\0')) throw new AboxError('invalid_input', 'git argument contains a NUL byte');
  }
  const argv = buildGitArgv(args, opts);
  const env = { ...baseEnv(), ...(opts.env ?? {}) };
  const maxOut = opts.maxStdoutBytes ?? 512 * 1024 * 1024;

  return await new Promise<GitResult>((resolve, reject) => {
    const child = spawn('git', argv, {
      cwd: opts.cwd ?? '/',
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}),
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let overflow = false;
    child.stdout.on('data', (c: Buffer) => {
      outBytes += c.length;
      if (outBytes > maxOut) {
        overflow = true;
        child.kill('SIGKILL');
        return;
      }
      out.push(c);
    });
    child.stderr.on('data', (c: Buffer) => {
      errBytes += c.length;
      if (errBytes <= 64 * 1024) err.push(c);
    });
    child.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') {
        reject(
          new AboxError('backend_unavailable', 'git executable not found', {
            hint: 'install git and make sure it is on PATH',
            cause: e,
          }),
        );
      } else {
        reject(new AboxError('backend_error', `failed to run git: ${e.message}`, { cause: e }));
      }
    });
    child.stdin.on('error', () => {
      /* git may exit before reading stdin */
    });
    child.on('close', (code) => {
      const raw = Buffer.concat(out);
      const stderr = Buffer.concat(err).toString('utf8');
      if (overflow) {
        reject(
          new AboxError(
            'backend_error',
            `git ${args[0] ?? ''} produced more than ${maxOut} bytes of output`,
          ),
        );
        return;
      }
      const result: GitResult = { code: code ?? -1, stdout: raw.toString('utf8'), stderr, raw };
      if (code !== 0 && !opts.allowFailure) {
        reject(
          new AboxError('backend_error', describeFailure(args, code, stderr), {
            details: { args: args.slice(0, 4) },
          }),
        );
        return;
      }
      resolve(result);
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

const DRIVER_KEY_RE =
  /^(?:(filter)\.(.+)\.(clean|smudge|process|required)|(diff)\.(.+)\.(textconv|command)|(merge)\.(.+)\.(driver|recursive))$/i;

/**
 * Environment (`GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n`) that switches off every
 * filter, textconv, external diff and merge driver defined in the repository's configuration.
 *
 * Why: the repository config is the user's own and trusted, but `.gitattributes` files in a work
 * tree a sandbox could write (workspace mode `mount`, rw) decide *which path uses which driver*. A
 * host-side `git status`/`diff`/`checkout` on such a work tree would therefore run a command the
 * user configured (for example `filter.lfs.clean`) on content the sandbox chose. With the drivers
 * empty (and `required` off) the attributes name drivers that do nothing. Command-line style
 * overrides cannot carry every subsection name, the environment form can.
 *
 * Reading the keys does not execute anything. Pass the result as `env` to `runGit`.
 */
export async function driverNeutralizingEnv(gitDir: string): Promise<Record<string, string>> {
  const r = await runGit(
    ['config', '--no-includes', '--name-only', '--get-regexp', '^(filter|diff|merge)\\.'],
    { gitDir, allowFailure: true },
  );
  const keys = new Set<string>();
  if (r.code === 0) {
    for (const line of r.stdout.split('\n')) {
      const key = line.trim();
      if (key && !/[\0]/.test(key) && DRIVER_KEY_RE.test(key)) keys.add(key);
    }
  }
  // includes are followed by git itself; read them too (the key list is the same either way)
  const withIncludes = await runGit(
    ['config', '--name-only', '--get-regexp', '^(filter|diff|merge)\\.'],
    { gitDir, allowFailure: true },
  );
  if (withIncludes.code === 0) {
    for (const line of withIncludes.stdout.split('\n')) {
      const key = line.trim();
      if (key && DRIVER_KEY_RE.test(key)) keys.add(key);
    }
  }
  const env: Record<string, string> = {};
  let n = 0;
  for (const key of keys) {
    env[`GIT_CONFIG_KEY_${n}`] = key;
    env[`GIT_CONFIG_VALUE_${n}`] = /\.required$/i.test(key) ? 'false' : '';
    n++;
  }
  if (n > 0) env['GIT_CONFIG_COUNT'] = String(n);
  return env;
}

/** Rejects revision-like input that git could interpret as an option. */
export function assertSafeRev(value: string, what: string): void {
  if (!value || value.startsWith('-') || /[\0\n\r]/.test(value)) {
    throw new AboxError('invalid_input', `invalid ${what}: ${JSON.stringify(value.slice(0, 80))}`);
  }
}

/** Resolves a revision to a full commit id inside a host-owned git dir. */
export async function resolveCommit(gitDir: string, rev: string): Promise<string> {
  assertSafeRev(rev, 'git revision');
  const r = await runGit(
    ['rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{commit}`],
    {
      gitDir,
      allowFailure: true,
    },
  );
  const oid = r.stdout.trim();
  if (r.code !== 0 || !/^[0-9a-f]{40,64}$/.test(oid)) {
    throw new AboxError('invalid_input', `cannot resolve git revision '${rev}' to a commit`, {
      hint: 'check the workspace ref; the repository needs at least one commit',
    });
  }
  return oid;
}

export interface RepoLocation {
  /** Absolute git dir of the checkout (for a linked worktree: its private admin dir). */
  gitDir: string;
  /** Absolute common git dir (object database and refs). */
  commonDir: string;
  objectFormat: 'sha1' | 'sha256';
}

/**
 * Locates the repository of a host directory the user owns (the policy-checked source).
 * Never call this on a directory a sandbox may have written to.
 */
export async function locateRepo(dir: string): Promise<RepoLocation | undefined> {
  const r = await runGit(
    [
      'rev-parse',
      '--path-format=absolute',
      '--absolute-git-dir',
      '--git-common-dir',
      '--show-object-format',
    ],
    { cwd: dir, allowFailure: true, env: { GIT_CEILING_DIRECTORIES: dirname(dir) } },
  );
  if (r.code !== 0) return undefined;
  const lines = r.stdout.split('\n').filter(Boolean);
  const [gitDir, commonDir, fmt] = lines;
  if (!gitDir || !commonDir) return undefined;
  return { gitDir, commonDir, objectFormat: fmt === 'sha256' ? 'sha256' : 'sha1' };
}
