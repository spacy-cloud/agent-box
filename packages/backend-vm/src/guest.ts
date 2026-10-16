import { randomBytes } from 'node:crypto';
import { AboxError } from '@abox/core';
import { guestExec, guestExecStatus, mapQgaError, QgaError, type QgaClient } from './qga.js';

/**
 * Process execution and file transfer inside the guest, built on the QEMU guest agent.
 *
 * Why not `guest-exec` with `capture-output`: the agent only returns the output when the
 * process has exited (no streaming), caps it at 16 MiB, reads it at ~1 MB/s and waits for EOF
 * on the pipes (a background child that keeps stdout open blocks the call). Instead every
 * command runs through a small root wrapper that redirects stdout/stderr into files below a
 * private directory; we poll `guest-exec-status` for the exit and read the files with
 * `guest-file-read` (~9 MB/s, incremental, no cap, no pipe-EOF problem).
 */

/** Output directories for ordinary commands (RAM, fast) and for bulk transfers (disk). */
export const GUEST_RUN_DIR = '/run/abox/x';
export const GUEST_BULK_DIR = '/var/lib/abox/x';

/**
 * Wrapper executed by the agent as root (via `setsid`, so the wrapper is the leader of a new
 * process group that can be killed as a whole).
 *   $1 = private output directory, $2 = file to use as stdin ("-" = the agent's stdin pipe),
 *   rest = the command line (already prefixed with the privilege drop).
 */
const WRAPPER = [
  'd=$1; i=$2; shift 2',
  'umask 077',
  'b=${d%/*}',
  'mkdir -p -m 700 "$b" "$d" || exit 126',
  'exec 3>"$d/out" 4>"$d/err" || exit 126',
  // remove the output of long finished commands (the host also deletes what it has read)
  `find "$b" -mindepth 2 -maxdepth 2 -name done -mmin +0.5 -printf '%h\\0' 2>/dev/null | xargs -0 -r rm -rf --`,
  'umask 022',
  // commands of the sandbox user run in a cgroup with the pids limit (set up at boot); internal root commands do not
  'case "$1" in /usr/bin/setpriv) echo $$ > /sys/fs/cgroup/abox-sandbox/cgroup.procs 2>/dev/null;; esac',
  'if [ "$i" = - ]; then "$@" >&3 2>&4 3>&- 4>&-; else "$@" <"$i" >&3 2>&4 3>&- 4>&-; fi',
  'rc=$?',
  ': > "$d/done"',
  'exit $rc',
].join('\n');

export interface GuestCommand {
  /** The command (argv[0] is looked up in PATH by `env`). */
  argv: string[];
  /** Run as this user ('root' = no privilege drop). */
  user: string;
  cwd?: string;
  env?: Record<string, string>;
  /** Small stdin, delivered through the agent. */
  stdin?: Buffer;
  /** Guest file (readable by root) used as stdin instead. */
  stdinFile?: string;
  /** Keep the output files on disk instead of RAM (large outputs). */
  bulk?: boolean;
}

export interface GuestRunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Per-stream cap for the collected output (ignored in streaming mode). */
  maxOutputBytes?: number;
  /** When set, output is delivered incrementally to this callback instead of being collected. */
  onData?: (stream: 'stdout' | 'stderr', data: Buffer) => void;
  /**
   * Leave the output files in the guest and report their directory (`result.dir`); the caller
   * reads `<dir>/out` with `streamGuestFile` and removes `<dir>` with `removeGuestPath`.
   */
  keepOutput?: boolean;
  /** Upper bound of the polling interval in ms (default 100; interactive terminals use less). */
  pollMaxMs?: number;
}

export interface GuestRunResult {
  exitCode: number;
  timedOut: boolean;
  aborted: boolean;
  stdout: Buffer;
  stderr: Buffer;
  truncated: boolean;
  /** Guest directory holding `out` and `err` (only with `keepOutput`). */
  dir?: string;
}

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
const READ_CHUNK = 512 * 1024;
const WRITE_CHUNK = 384 * 1024;
const INLINE_STDIN_MAX = 256 * 1024;

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function buildArgv(cmd: GuestCommand): string[] {
  if (cmd.argv.length === 0 || cmd.argv.some((a) => typeof a !== 'string' || a.includes('\0'))) {
    throw new AboxError(
      'invalid_input',
      'argv must be a non-empty list of strings without NUL bytes',
    );
  }
  const first = cmd.argv[0] as string;
  if (first === '' || first.includes('=') || first.startsWith('-')) {
    throw new AboxError(
      'invalid_input',
      `unsupported command name '${first}' (empty, option-like or containing '=')`,
    );
  }
  const env: string[] = [];
  for (const [k, v] of Object.entries(cmd.env ?? {})) {
    if (!ENV_NAME_RE.test(k))
      throw new AboxError('invalid_input', `invalid environment variable name '${k}'`);
    if (v.includes('\0'))
      throw new AboxError('invalid_input', `environment variable '${k}' contains a NUL byte`);
    env.push(`${k}=${v}`);
  }
  if (cmd.cwd !== undefined && (cmd.cwd.includes('\0') || cmd.cwd === '')) {
    throw new AboxError('invalid_input', 'invalid working directory');
  }
  const out: string[] = [];
  if (cmd.user !== 'root') {
    if (!USER_RE.test(cmd.user))
      throw new AboxError('invalid_input', `invalid user name '${cmd.user}'`);
    out.push(
      '/usr/bin/setpriv',
      `--reuid=${cmd.user}`,
      `--regid=${cmd.user}`,
      '--init-groups',
      '--reset-env',
    );
  }
  out.push('/usr/bin/env');
  if (cmd.cwd !== undefined) out.push(`--chdir=${cmd.cwd}`);
  out.push(...env, ...cmd.argv);
  return out;
}

/** Reads a (growing) file in the guest through an agent file handle. */
class RemoteFile {
  private handle: number | undefined;
  private offset = 0;
  private needSeek = false;

  constructor(
    private readonly qga: QgaClient,
    readonly path: string,
  ) {}

  /** Opens the file if it exists. Returns false while it does not. */
  private async ensureOpen(): Promise<boolean> {
    if (this.handle !== undefined) return true;
    try {
      const h = await this.qga.call<number>('guest-file-open', { path: this.path, mode: 'r' });
      this.handle = h;
      return true;
    } catch (e) {
      if (e instanceof QgaError && e.kind === 'agent_error') return false;
      throw e;
    }
  }

  /**
   * Reads what is currently available, at most `limit` bytes in total. Calls `sink` per chunk.
   * Returns the number of bytes delivered.
   */
  async drain(sink: (data: Buffer) => void, limit = Number.POSITIVE_INFINITY): Promise<number> {
    if (!(await this.ensureOpen())) return 0;
    const handle = this.handle as number;
    let delivered = 0;
    while (delivered < limit) {
      if (this.needSeek) {
        // The stdio EOF flag in the agent is sticky; seeking clears it.
        await this.qga.call('guest-file-seek', { handle, offset: this.offset, whence: 0 });
        this.needSeek = false;
      }
      const want = Math.min(READ_CHUNK, limit - delivered);
      const r = await this.qga.call<{ count: number; 'buf-b64'?: string; eof: boolean }>(
        'guest-file-read',
        {
          handle,
          count: want,
        },
      );
      if (r.count > 0 && r['buf-b64']) {
        const data = Buffer.from(r['buf-b64'], 'base64');
        sink(data);
        this.offset += data.length;
        delivered += data.length;
      }
      if (r.eof || r.count === 0) {
        this.needSeek = true;
        break;
      }
    }
    return delivered;
  }

  /** Current file size (does not disturb the read position). */
  async size(): Promise<number> {
    if (!(await this.ensureOpen())) return 0;
    const handle = this.handle as number;
    const end = await this.qga.call<{ position: number }>('guest-file-seek', {
      handle,
      offset: 0,
      whence: 2,
    });
    this.needSeek = true;
    return end.position;
  }

  async close(): Promise<void> {
    if (this.handle === undefined) return;
    const handle = this.handle;
    this.handle = undefined;
    await this.qga.call('guest-file-close', { handle }).catch(() => undefined);
  }
}

class Collector {
  private readonly chunks: Buffer[] = [];
  bytes = 0;
  push(b: Buffer): void {
    this.chunks.push(b);
    this.bytes += b.length;
  }
  toBuffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

async function killGroup(qga: QgaClient, pid: number): Promise<void> {
  try {
    const killer = await guestExec(qga, {
      path: '/bin/sh',
      arg: ['-c', 'kill -9 "-$0" 2>/dev/null; exit 0', String(pid)],
    });
    // The agent keeps the entry until its status was fetched; one short poll reaps it.
    for (let i = 0; i < 20; i++) {
      const s = await guestExecStatus(qga, killer);
      if (s.exited) return;
      await sleep(10);
    }
  } catch {
    /* the process may be gone already */
  }
}

/**
 * Runs `cmd` in the guest and waits for it. Never throws for non-zero exit codes; throws
 * `AboxError` when the agent can not be reached.
 */
export async function runInGuest(
  qga: QgaClient,
  cmd: GuestCommand,
  opts: GuestRunOptions = {},
): Promise<GuestRunResult> {
  const argv = buildArgv(cmd);
  if (cmd.stdin && cmd.stdin.length > INLINE_STDIN_MAX) {
    throw new AboxError(
      'internal',
      'stdin larger than the inline limit must be uploaded to a guest file first',
    );
  }
  const dir = `${cmd.bulk ? GUEST_BULK_DIR : GUEST_RUN_DIR}/${randomBytes(6).toString('hex')}`;
  const streaming = opts.onData !== undefined;
  const cap = opts.maxOutputBytes ?? Number.POSITIVE_INFINITY;
  const files = {
    stdout: new RemoteFile(qga, `${dir}/out`),
    stderr: new RemoteFile(qga, `${dir}/err`),
  };
  const collected = { stdout: new Collector(), stderr: new Collector() };
  let truncated = false;

  let pid: number;
  try {
    pid = await guestExec(qga, {
      path: '/usr/bin/setsid',
      arg: ['/bin/sh', '-c', WRAPPER, 'sh', dir, cmd.stdinFile ?? '-', ...argv],
      input: cmd.stdin ?? Buffer.alloc(0),
    });
  } catch (e) {
    throw mapQgaError(e, 'starting command in the guest');
  }

  const deadline = opts.timeoutMs !== undefined ? Date.now() + opts.timeoutMs : undefined;
  let timedOut = false;
  let aborted = false;
  let killedAt: number | undefined;
  let interval = 4;
  let exitCode: number;
  let total = 0;

  const pump = async (final: boolean): Promise<void> => {
    for (const name of ['stdout', 'stderr'] as const) {
      if (opts.onData) {
        const cb = opts.onData;
        await files[name].drain((d) => {
          total += d.length;
          cb(name, d);
        });
      } else if (final && !opts.keepOutput) {
        const room = cap - collected[name].bytes;
        if (room > 0) {
          await files[name].drain((d) => {
            total += d.length;
            collected[name].push(d);
          }, room);
        }
        if (collected[name].bytes >= cap) {
          if ((await files[name].size()) > cap) truncated = true;
        }
      }
    }
  };

  try {
    for (;;) {
      await sleep(interval);
      interval = Math.min(interval * 2, opts.pollMaxMs ?? 100);
      if (!killedAt) {
        if (opts.signal?.aborted) {
          aborted = true;
          killedAt = Date.now();
          await killGroup(qga, pid);
        } else if (deadline !== undefined && Date.now() >= deadline) {
          timedOut = true;
          killedAt = Date.now();
          await killGroup(qga, pid);
        }
      }
      if (streaming) await pump(false);
      const st = await guestExecStatus(qga, pid);
      if (st.exited) {
        exitCode = st.exitcode ?? (st.signal !== undefined ? 128 + st.signal : -1);
        break;
      }
      if (killedAt && Date.now() - killedAt > 5000) {
        // The kill did not take effect (should not happen for a SIGKILL); stop waiting.
        exitCode = 137;
        break;
      }
    }
    await pump(true);
  } catch (e) {
    throw mapQgaError(e, 'running command in the guest');
  } finally {
    await files.stdout.close();
    await files.stderr.close();
  }
  // Small outputs are swept by the next wrapper run; free big ones (RAM!) right away.
  if (!opts.keepOutput && (total > 256 * 1024 || truncated))
    await removeGuestPath(qga, dir).catch(() => undefined);
  return {
    ...(opts.keepOutput ? { dir } : {}),
    exitCode,
    timedOut,
    aborted,
    stdout: collected.stdout.toBuffer(),
    stderr: collected.stderr.toBuffer(),
    truncated,
  };
}

/** Reads a finished guest file completely, in chunks (the file must not be writable by sandbox users). */
export async function* streamGuestFile(qga: QgaClient, path: string): AsyncGenerator<Buffer> {
  const f = new RemoteFile(qga, path);
  try {
    for (;;) {
      const chunks: Buffer[] = [];
      const n = await f.drain((d) => chunks.push(d), READ_CHUNK * 4);
      for (const c of chunks) yield c;
      if (n === 0) break;
    }
  } catch (e) {
    throw mapQgaError(e, 'reading a file from the guest');
  } finally {
    await f.close();
  }
}

/** Runs a shell script as root in the guest (internal use) and fails on non-zero exit. */
export async function rootScript(
  qga: QgaClient,
  script: string,
  args: string[] = [],
  timeoutMs = 60_000,
): Promise<string> {
  const r = await runInGuest(
    qga,
    { argv: ['/bin/sh', '-c', script, 'sh', ...args], user: 'root' },
    { timeoutMs },
  );
  if (r.exitCode !== 0 || r.timedOut) {
    throw new AboxError(
      'backend_error',
      `guest setup step failed (exit ${r.exitCode}): ${r.stderr.toString('utf8').trim().slice(0, 500)}`,
    );
  }
  return r.stdout.toString('utf8');
}

// -- file transfer -----------------------------------------------------------------------

/**
 * Uploads `chunks` into a new root-only file in the guest and returns its path. The file lives in
 * the bulk directory (disk). Call `removeGuestPath` when done.
 */
export async function uploadToGuest(
  qga: QgaClient,
  chunks: AsyncIterable<Buffer> | Iterable<Buffer>,
): Promise<string> {
  const id = randomBytes(6).toString('hex');
  const dir = `${GUEST_BULK_DIR}/up-${id}`;
  await rootScript(qga, 'umask 077; mkdir -p -m 700 "$1" "$2"', [GUEST_BULK_DIR, dir]);
  const path = `${dir}/data`;
  let handle: number | undefined;
  try {
    handle = await qga.call<number>('guest-file-open', { path, mode: 'wb' });
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    const flush = async (): Promise<void> => {
      if (pendingBytes === 0) return;
      const all = Buffer.concat(pending);
      pending = [];
      pendingBytes = 0;
      for (let off = 0; off < all.length; off += WRITE_CHUNK) {
        const part = all.subarray(off, off + WRITE_CHUNK);
        await qga.call('guest-file-write', { handle, 'buf-b64': part.toString('base64') });
      }
    };
    for await (const c of chunks) {
      pending.push(c);
      pendingBytes += c.length;
      if (pendingBytes >= WRITE_CHUNK * 4) await flush();
    }
    await flush();
    await qga.call('guest-file-close', { handle });
    handle = undefined;
    return path;
  } catch (e) {
    if (handle !== undefined) await qga.call('guest-file-close', { handle }).catch(() => undefined);
    await removeGuestPath(qga, dir).catch(() => undefined);
    throw mapQgaError(e, 'uploading data into the guest');
  }
}

/** Removes a path below the bulk directory (root). */
export async function removeGuestPath(qga: QgaClient, path: string): Promise<void> {
  if (!path.startsWith(`${GUEST_BULK_DIR}/`) && !path.startsWith(`${GUEST_RUN_DIR}/`)) {
    throw new AboxError('internal', `refusing to remove '${path}'`);
  }
  await rootScript(qga, 'rm -rf -- "$1"', [path]);
}

/** Directory (inside the bulk dir) that holds an uploaded file, for cleanup. */
export function uploadDirOf(uploadedPath: string): string {
  return uploadedPath.slice(0, uploadedPath.lastIndexOf('/'));
}
