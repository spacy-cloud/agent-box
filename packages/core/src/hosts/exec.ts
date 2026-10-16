import { spawn } from 'node:child_process';

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface RunOptions {
  timeoutMs?: number;
  input?: string;
  env?: NodeJS.ProcessEnv;
  /** Max bytes kept per stream (default 1 MiB). */
  maxBytes?: number;
}

/**
 * Runs a program with an argv array (never through a shell). Resolves also for non-zero exit
 * codes; rejects only when the program cannot be started. Stable English messages
 * (`LC_ALL=C`) because callers classify ssh errors from stderr.
 */
export function run(
  file: string,
  args: readonly string[],
  opts: RunOptions = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const max = opts.maxBytes ?? 1024 * 1024;
    const child = spawn(file, args, {
      stdio: [opts.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      env: { ...process.env, LC_ALL: 'C', LANG: 'C', ...opts.env },
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, opts.timeoutMs)
      : undefined;
    child.stdout!.setEncoding('utf8').on('data', (d: string) => {
      if (stdout.length < max) stdout += d;
    });
    child.stderr!.setEncoding('utf8').on('data', (d: string) => {
      if (stderr.length < max) stderr += d;
    });
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut, durationMs: Date.now() - started });
    });
    if (opts.input !== undefined) {
      child.stdin!.on('error', () => undefined);
      child.stdin!.end(opts.input);
    }
  });
}
