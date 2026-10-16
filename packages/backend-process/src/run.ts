import { spawn } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { errno } from './fsutil.js';

/**
 * Process execution for the process backend.
 *
 * Every command runs as its own process group (`detached: true`), so a timeout, an
 * abort or `stop()` can kill the command *and everything it started* with
 * `kill(-pgid)`. For each group a marker file `run/<pid>` is kept while the group is
 * alive; `stop()` and `remove()` use these markers to find what the sandbox started
 * (also across abox invocations, there is no daemon).
 *
 * This is process hygiene, not isolation: the processes run with the privileges of
 * the host user and see the whole host.
 */

export function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (e) {
    // EPERM: the group exists but belongs to someone else (cannot happen for our own children)
    return errno(e) === 'EPERM';
  }
}

export function groupAlive(pid: number): boolean {
  return signalGroup(pid, 0);
}

/** Process start time (clock ticks since boot) from /proc, used to detect pid reuse. Linux only. */
export function procStartTime(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return rest[19]; // field 22 (starttime); `rest` starts at field 3
  } catch {
    return undefined;
  }
}

function writeMarker(runDir: string, pid: number): void {
  try {
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, String(pid)), procStartTime(pid) ?? '');
  } catch {
    /* tracking is best effort; the command itself must not fail because of it */
  }
}

function removeMarker(runDir: string, pid: number): void {
  rmSync(join(runDir, String(pid)), { force: true });
}

interface Marker {
  pid: number;
  started: string;
}

function readMarkers(runDir: string): Marker[] {
  let names: string[];
  try {
    names = readdirSync(runDir);
  } catch {
    return [];
  }
  const out: Marker[] = [];
  for (const name of names) {
    const pid = Number(name);
    if (!Number.isInteger(pid) || pid <= 1) continue;
    let started = '';
    try {
      started = readFileSync(join(runDir, name), 'utf8');
    } catch {
      /* raced with removal */
    }
    out.push({ pid, started });
  }
  return out;
}

/** Marker whose leader pid now belongs to a different process (pid reuse) is stale. */
function isStale(m: Marker): boolean {
  const current = procStartTime(m.pid);
  return current !== undefined && m.started !== '' && current !== m.started;
}

const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Kills every process group recorded for a sandbox. SIGTERM first when `graceMs > 0`,
 * then SIGKILL for survivors. Removes the markers. Returns the number of groups killed.
 */
export async function killTracked(runDir: string, graceMs: number): Promise<number> {
  const live = readMarkers(runDir).filter((m) => {
    if (isStale(m) || !groupAlive(m.pid)) {
      removeMarker(runDir, m.pid);
      return false;
    }
    return true;
  });
  if (live.length === 0) return 0;
  if (graceMs > 0) {
    for (const m of live) signalGroup(m.pid, 'SIGTERM');
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline && live.some((m) => groupAlive(m.pid))) await sleepMs(25);
  }
  for (const m of live) if (groupAlive(m.pid)) signalGroup(m.pid, 'SIGKILL');
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && live.some((m) => groupAlive(m.pid))) await sleepMs(10);
  for (const m of live) removeMarker(runDir, m.pid);
  return live.length;
}

export interface RunConfig {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  stdin?: string | Buffer;
  timeoutMs?: number;
  signal?: AbortSignal;
  runDir: string;
  onStdout(data: Buffer): void;
  onStderr(data: Buffer): void;
}

export interface RunOutcome {
  exitCode: number;
  timedOut: boolean;
  aborted: boolean;
}

/** Time we wait for stdio to close after the command's leader exited (background children may keep pipes open). */
const STDIO_GRACE_MS = 250;

function exitCodeOf(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  const num = signal ? (osConstants.signals[signal] ?? 0) : 0;
  return 128 + num;
}

/**
 * Runs one command to completion. Resolves with the exit code (128+signal when killed).
 * A command that cannot be started yields 127 (not found) or 126 (not executable) plus a
 * message on stderr, mirroring what a shell does.
 */
export function runProcess(cfg: RunConfig): Promise<RunOutcome> {
  return new Promise<RunOutcome>((resolve) => {
    const [cmd, ...args] = cfg.argv as [string, ...string[]];
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const child = spawn(cmd, args, {
      cwd: cfg.cwd,
      env: cfg.env,
      detached: true,
      stdio: [cfg.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    const pid = child.pid;

    const timer =
      cfg.timeoutMs !== undefined && cfg.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            if (pid) signalGroup(pid, 'SIGKILL');
          }, cfg.timeoutMs)
        : undefined;
    const onAbort = (): void => {
      aborted = true;
      if (pid) signalGroup(pid, 'SIGKILL');
    };
    if (cfg.signal) {
      if (cfg.signal.aborted) onAbort();
      else cfg.signal.addEventListener('abort', onAbort, { once: true });
    }

    if (pid) writeMarker(cfg.runDir, pid);

    child.stdout?.on('data', (d: Buffer) => cfg.onStdout(d));
    child.stderr?.on('data', (d: Buffer) => cfg.onStderr(d));
    if (cfg.stdin !== undefined && child.stdin) {
      child.stdin.on('error', () => undefined); // EPIPE when the command does not read its stdin
      child.stdin.end(cfg.stdin);
    }

    const finish = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      cfg.signal?.removeEventListener('abort', onAbort);
      child.stdout?.destroy();
      child.stderr?.destroy();
      // Keep the marker while background children of the group are still alive: stop() must find them.
      if (pid && !groupAlive(pid)) removeMarker(cfg.runDir, pid);
      resolve({ exitCode, timedOut, aborted });
    };

    child.once('error', (err) => {
      // spawn failure (ENOENT, EACCES, ...): the 'exit' event never fires
      const code = errno(err);
      const exit = code === 'EACCES' ? 126 : 127;
      const reason =
        code === 'EACCES'
          ? 'permission denied'
          : code === 'ENOENT'
            ? 'command not found'
            : err.message;
      cfg.onStderr(Buffer.from(`abox: ${cmd}: ${reason}\n`));
      finish(exit);
    });
    child.once('exit', (code, signal) => {
      const exitCode = exitCodeOf(code, signal);
      let closed = false;
      const grace = setTimeout(() => {
        if (!closed) finish(exitCode);
      }, STDIO_GRACE_MS);
      child.once('close', () => {
        closed = true;
        clearTimeout(grace);
        finish(exitCode);
      });
    });
  });
}
