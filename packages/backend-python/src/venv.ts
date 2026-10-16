import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { AboxError } from '@abox/core';
import type { ProjectFiles } from './project.js';

/**
 * Venv mode helpers (isolation level `none`). Everything here runs on the HOST with the host's
 * `uv`; there is no security boundary. See README ("venv mode").
 */

const MAX_LOG = 16 * 1024;

export interface RunResult {
  code: number | null;
  output: string;
  timedOut: boolean;
  error?: NodeJS.ErrnoException;
}

/** Run a host program without a shell, capture the tail of stdout+stderr. */
export function run(
  file: string,
  args: string[],
  opts: { cwd?: string; env: Record<string, string>; timeoutMs: number; signal?: AbortSignal },
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = execFile(
      file,
      args,
      {
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        env: opts.env,
        timeout: opts.timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
      (err, stdout, stderr) => {
        const output = `${stdout}${stderr}`.slice(-MAX_LOG);
        if (!err) return resolve({ code: 0, output, timedOut: false });
        const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
        if (typeof e.code === 'string')
          return resolve({ code: null, output, timedOut: false, error: e });
        resolve({
          code: typeof e.code === 'number' ? e.code : 1,
          output,
          timedOut: e.killed === true,
        });
      },
    );
    child.stdin?.end();
  });
}

/** Environment passed to host `uv`: nothing but what it needs (no tokens or API keys of the host). */
export function hostUvEnv(extra: Record<string, string> = {}): Record<string, string> {
  const keep = [
    'PATH',
    'LANG',
    'LC_ALL',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
  ];
  const env: Record<string, string> = {};
  for (const k of keep) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  env['PATH'] ??= '/usr/local/bin:/usr/bin:/bin';
  return { ...env, ...extra };
}

/** `uv --version` of the host binary, or undefined if it cannot be run. */
export async function hostUvVersion(binary: string): Promise<string | undefined> {
  const r = await run(binary, ['--version'], { env: hostUvEnv(), timeoutMs: 15_000 });
  if (r.code !== 0) return undefined;
  return /uv\s+(\S+)/.exec(r.output)?.[1] ?? r.output.trim();
}

export interface VenvLayout {
  /** Host path of the sandbox root (`/` inside the sandbox). */
  root: string;
  venv: string;
  project: string;
}

export function venvLayout(root: string): VenvLayout {
  return {
    root,
    venv: path.join(root, 'opt', 'venv'),
    project: path.join(root, 'opt', 'abox', 'project'),
  };
}

/** Host directories shared by all venv sandboxes (uv cache, uv-managed pythons). */
export interface VenvShared {
  cacheDir: string;
  pythonDir: string;
}

/**
 * Environment for host `uv` and for commands run in a venv sandbox. `PATH` starts with the venv's
 * `bin`, so `python`, `pip` and installed tools resolve to the venv.
 */
export function venvEnv(layout: VenvLayout, shared: VenvShared): Record<string, string> {
  return {
    VIRTUAL_ENV: layout.venv,
    UV_PROJECT_ENVIRONMENT: layout.venv,
    UV_CACHE_DIR: shared.cacheDir,
    UV_PYTHON_INSTALL_DIR: shared.pythonDir,
    PATH: `${path.join(layout.venv, 'bin')}${path.delimiter}${process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin'}`,
  };
}

export interface SetupVenvOptions {
  uv: string;
  layout: VenvLayout;
  shared: VenvShared;
  home: string;
  pythonVersion: string;
  project?: ProjectFiles;
  timeoutMs: number;
  signal?: AbortSignal;
}

function failure(step: string, r: RunResult): AboxError {
  if (r.error?.code === 'ENOENT') {
    return new AboxError('backend_unavailable', 'uv was not found on the host', {
      hint: 'Install uv (https://docs.astral.sh/uv/) or use container mode (a template without isolation: none).',
    });
  }
  return new AboxError(
    'backend_error',
    `${step} failed${r.timedOut ? ' (timed out)' : ` with exit code ${String(r.code)}`}`,
    { details: { log: r.output }, hint: 'See details.log for the end of the uv output.' },
  );
}

/**
 * Creates `<root>/opt/venv` with the host's uv and, for a template project, installs its
 * dependencies (`uv sync --frozen` with a lock file, a plain `uv sync` without). The project files
 * are copied to `<root>/opt/abox/project`; the host project directory is never written to.
 */
export async function setupVenv(o: SetupVenvOptions): Promise<void> {
  await fs.mkdir(o.shared.cacheDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(o.shared.pythonDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(path.dirname(o.layout.venv), { recursive: true });
  // Not venvEnv(): no VIRTUAL_ENV (uv must not think it runs inside a venv) and the plain host PATH.
  const env = hostUvEnv({
    HOME: o.home,
    UV_PROJECT_ENVIRONMENT: o.layout.venv,
    UV_CACHE_DIR: o.shared.cacheDir,
    UV_PYTHON_INSTALL_DIR: o.shared.pythonDir,
  });
  const base = {
    cwd: o.layout.root,
    env,
    timeoutMs: o.timeoutMs,
    ...(o.signal ? { signal: o.signal } : {}),
  };
  const venv = await run(
    o.uv,
    ['venv', o.layout.venv, '--python', o.pythonVersion, '--no-project'],
    base,
  );
  if (venv.code !== 0) throw failure(`uv venv (python ${o.pythonVersion})`, venv);
  if (!o.project) return;
  await fs.mkdir(o.layout.project, { recursive: true });
  await fs.writeFile(path.join(o.layout.project, 'pyproject.toml'), o.project.pyproject);
  const args = ['sync', '--no-install-project', '--project', o.layout.project];
  if (o.project.lock) {
    await fs.writeFile(path.join(o.layout.project, 'uv.lock'), o.project.lock);
    args.push('--frozen');
  }
  const sync = await run(o.uv, args, { ...base, cwd: o.layout.project });
  if (sync.code !== 0) throw failure(`uv ${args.join(' ')}`, sync);
}
