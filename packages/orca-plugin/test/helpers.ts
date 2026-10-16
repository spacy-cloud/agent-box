import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLUGIN_DIR = resolve(fileURLToPath(new URL('../plugin', import.meta.url)));
export const PACKAGE_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));

export interface FakeRun {
  stdout?: string;
  stderr?: string;
  code?: number | null;
  signal?: string | null;
  /** Emit a spawn error (e.g. ENOENT) instead of running. */
  error?: Error & { code?: string };
  /** Never exit on its own; exits only when killed. */
  hang?: boolean;
}

export interface SpawnCall {
  bin: string;
  argv: readonly string[];
  options: Record<string, unknown>;
  kills: string[];
}

/** A spawn() stand-in: records calls, plays back a scripted result, no process is started. */
export function fakeSpawn(script: (call: SpawnCall) => FakeRun) {
  const calls: SpawnCall[] = [];
  const spawn = (
    bin: string,
    argv: readonly string[],
    options: Record<string, unknown>,
  ): ChildProcess => {
    const call: SpawnCall = { bin, argv: [...argv], options, kills: [] };
    calls.push(call);
    const run = script(call);
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: (sig?: string) => boolean;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = (sig = 'SIGTERM') => {
      call.kills.push(sig);
      setImmediate(() => child.emit('close', null, sig));
      return true;
    };
    setImmediate(() => {
      if (run.error) {
        child.emit('error', run.error);
        return;
      }
      if (run.stdout) child.stdout.emit('data', Buffer.from(run.stdout));
      if (run.stderr) child.stderr.emit('data', Buffer.from(run.stderr));
      if (!run.hang) child.emit('close', run.code ?? 0, run.signal ?? null);
    });
    return child as unknown as ChildProcess;
  };
  return { spawn, calls };
}

export const ok = (data: unknown): FakeRun => ({
  stdout: JSON.stringify({ ok: true, data }),
  code: 0,
});
export const fail = (
  code: string,
  message: string,
  exit: number,
  extra: Record<string, unknown> = {},
): FakeRun => ({
  stdout: JSON.stringify({ ok: false, code, message, ...extra }),
  code: exit,
});

export const sandboxFixture = (over: Record<string, unknown> = {}) => ({
  id: 'local/ab12cd34',
  name: 'wt-feat-login',
  host: 'local',
  owner: 'human',
  template: 'node',
  state: 'running',
  ttlRemainingMs: 41 * 60_000,
  expiresAt: 1_900_000_000_000,
  expired: false,
  stale: false,
  workspace: {
    mode: 'worktree',
    sandboxPath: '/workspace',
    access: 'rw',
    source: '/home/u/orca/feat-login',
    branch: 'abox/x',
    remote: false,
  },
  ...over,
});
