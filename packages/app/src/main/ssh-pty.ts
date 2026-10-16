import { homedir } from 'node:os';
import { AboxError, auditSession, sshBinary, sshSessionArgs } from '@abox/core';
import type { HostProfile, HostsEnv } from '@abox/core';
import type { TerminalBackend, TtySize } from './tty';

/** The pieces of node-pty this file uses (the real module is loaded lazily, see `loadPty`). */
export interface PtyProcess {
  onData(cb: (data: Uint8Array) => void): { dispose(): void };
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}
export interface PtyModule {
  spawn(
    file: string,
    args: string[],
    opts: {
      name: string;
      cols: number;
      rows: number;
      cwd: string;
      env: Record<string, string>;
      encoding: null;
    },
  ): PtyProcess;
}

let ptyModule: PtyModule | undefined;

/**
 * node-pty is a native (N-API) module. It is loaded on first use so that a missing or broken build only
 * disables SSH terminals, not the whole app.
 */
export async function loadPty(): Promise<PtyModule> {
  if (ptyModule) return ptyModule;
  try {
    const m = (await import('node-pty')) as unknown as PtyModule & { default?: PtyModule };
    ptyModule = m.default ?? m;
    return ptyModule;
  } catch (e) {
    throw new AboxError(
      'backend_unavailable',
      `SSH terminals need the native module node-pty, which could not be loaded: ${(e as Error).message}`,
      { hint: 'Run "pnpm --filter @abox/app run native" to build it, then restart the app.' },
    );
  }
}

export interface SshPtyDeps {
  profile: HostProfile;
  env: HostsEnv;
  size: TtySize;
  pty?: PtyModule;
  /** Environment of the ssh process (default: this process's environment). */
  processEnv?: NodeJS.ProcessEnv;
}

/** `user@host:port` for labels. Never contains anything secret (profiles hold no secrets). */
export function sshLabel(p: HostProfile): string {
  const target = p.sshConfigAlias ?? p.hostname ?? p.id;
  return `${p.user ? `${p.user}@` : ''}${target}${p.port && p.port !== 22 ? `:${p.port}` : ''}`;
}

/**
 * Starts the system `ssh` for a host profile in a pty. Passphrase and FIDO prompts therefore happen inside
 * the terminal. The Hosts view checks the host key and asks for the explicit confirmation before it opens a tab.
 * No scan happens here (servers with PerSourcePenalties throttle repeated scans): `sshSessionArgs` makes ssh itself
 * strict (`StrictHostKeyChecking=yes` against abox's own known_hosts, no agent forwarding), so an unknown or changed
 * key can never connect silently, not even on a reconnect.
 */
export async function openSshPty(d: SshPtyDeps): Promise<TerminalBackend> {
  const { profile, env } = d;
  const args = sshSessionArgs(profile, env);
  const pty = d.pty ?? (await loadPty());
  const penv: Record<string, string> = {};
  for (const [k, v] of Object.entries(d.processEnv ?? process.env)) {
    if (typeof v === 'string' && k !== 'ELECTRON_RUN_AS_NODE') penv[k] = v;
  }
  penv['TERM'] = 'xterm-256color';
  penv['COLORTERM'] = 'truecolor';

  const proc = pty.spawn(sshBinary(env), args, {
    name: 'xterm-256color',
    cols: d.size.cols,
    rows: d.size.rows,
    cwd: homedir(),
    env: penv,
    encoding: null,
  });
  const audit = auditSession(profile, env);
  let exitCb: ((code: number | null, reason?: string) => void) | undefined;
  let result: number | null | undefined;
  let closed = false;
  proc.onExit(({ exitCode }) => {
    audit.end();
    result = closed ? null : exitCode;
    exitCb?.(result);
  });
  return {
    label: sshLabel(profile),
    write: (data) => {
      try {
        proc.write(data);
      } catch {
        /* process already gone */
      }
    },
    resize: (cols, rows) => {
      try {
        proc.resize(cols, rows);
      } catch {
        /* process already gone */
      }
    },
    close: () => {
      closed = true;
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
      audit.end();
    },
    onData: (cb) => {
      proc.onData((data) => cb(typeof data === 'string' ? Buffer.from(data) : data));
    },
    onExit: (cb) => {
      exitCb = cb;
      if (result !== undefined) cb(result);
    },
  };
}
