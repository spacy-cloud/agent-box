import { randomBytes } from 'node:crypto';
import { PassThrough, Writable, type Readable } from 'node:stream';
import type Docker from 'dockerode';
import { AboxError } from '@abox/core';
import type { ExecRequest, TtyOptions, TtySession } from '@abox/core';

/** Exit code the in-container wrapper uses to report "my watchdog killed the command". */
export const TIMEOUT_SENTINEL = 247;
/** Reported exit code for a command killed by the timeout (128 + SIGKILL). */
export const TIMEOUT_EXIT_CODE = 137;
/** Extra time the host waits for the in-container watchdog before it kills the tree itself. */
const HOST_KILL_GRACE_MS = 3000;

/**
 * Shell library used inside the sandbox to find and kill a process tree. It only uses shell
 * builtins (`read`, `case`, `kill`, globbing on /proc) so it still works when the pids limit is
 * exhausted and no new process can be forked. `kill` of other processes of the same uid needs no
 * capability, which matters because every capability is dropped.
 */
const SH_LIB = `
desc() {
  D=" "; _c=1
  while [ "$_c" = 1 ]; do
    _c=0
    for _d in /proc/[0-9]*; do
      _p=\${_d#/proc/}
      case "$D" in *" $_p "*) continue;; esac
      _pp=
      { while read -r _k _v; do if [ "$_k" = "PPid:" ]; then _pp=$_v; break; fi; done < "$_d/status"; } 2>/dev/null
      if [ "$_pp" = "$1" ]; then D="$D$_p "; _c=1; else case "$D" in *" $_pp "*) D="$D$_p "; _c=1;; esac; fi
    done
  done
}
reap() {
  _r=$1; _x=$2; _prev=
  for _i in 1 2 3 4 5; do
    desc "$_r"
    for _p in $D; do [ "$_p" = "$_x" ] || kill -STOP "$_p" 2>/dev/null; done
    [ "$D" = "$_prev" ] && break
    _prev=$D
  done
  for _p in $D; do [ "$_p" = "$_x" ] || kill -KILL "$_p" 2>/dev/null; done
}
`;

/**
 * PATH the wrappers use for their own helpers (`sleep`, `rm`). The command gets the environment the
 * caller asked for, `PATH` included; the wrapper must not depend on it (a `PATH` without `/bin`
 * would make the watchdog's `sleep` fail, which reads as an instant timeout).
 */
const WRAPPER_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/** `sh -c` script: args are <pidfile> <timeout-seconds|""> <argv...>. */
export const WRAP_SCRIPT = `${SH_LIB}
f=$1; t=$2; shift 2
_hp=\${PATH+x}; _up=\${PATH-}
PATH=${WRAPPER_PATH}
echo $$ > "$f"
wd=
if [ -n "$t" ]; then
  ( sleep "$t" 2>/dev/null || sleep "\${t%%.*}"; read -r me _ < /proc/self/stat; : > "$f.t"; reap "$$" "$me" ) &
  wd=$!
fi
# the command runs with the PATH it was given (or none)
if [ -n "$_hp" ]; then PATH=$_up; else unset PATH; fi
"$@"
rc=$?
PATH=${WRAPPER_PATH}
if [ -n "$wd" ]; then
  desc "$wd"; for _p in $wd $D; do kill -KILL "$_p" 2>/dev/null; done
fi
if [ -e "$f.t" ]; then rm -f "$f" "$f.t"; exit ${TIMEOUT_SENTINEL}; fi
rm -f "$f"
exit $rc
`;

/** `sh -c` script: args are <pidfile>. Kills the wrapper's process tree (including the wrapper). */
export const KILL_SCRIPT = `${SH_LIB}
PATH=${WRAPPER_PATH}
f=$1; i=0
while [ ! -s "$f" ] && [ "$i" -lt 30 ]; do i=$((i+1)); sleep 0.1 2>/dev/null || sleep 1; done
[ -s "$f" ] || exit 0
read -r root < "$f"
reap "$root" ""
kill -KILL "$root" 2>/dev/null
rm -f "$f" "$f.t"
exit 0
`;

/** `sh -c` script for TTY sessions: records its pid, then replaces itself with the command. */
const TTY_SCRIPT = `echo $$ > "$1"; shift; exec "$@"`;

function isThenable(v: unknown): v is PromiseLike<unknown> {
  return (
    typeof v === 'object' && v !== null && typeof (v as { then?: unknown }).then === 'function'
  );
}

/**
 * Demultiplexer for the Docker stream format (8-byte header: type, 0, 0, 0, uint32 BE length).
 * `onData` may return a promise (any other return value is ignored): the next frame (and the next chunk of the engine stream) waits
 * for it, which is how a consumer applies backpressure.
 */
export class Demux extends Writable {
  private buf: Buffer = Buffer.alloc(0);
  constructor(private readonly onData: (kind: 'stdout' | 'stderr', data: Buffer) => unknown) {
    super();
  }
  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const frames: Array<['stdout' | 'stderr', Buffer]> = [];
    while (this.buf.length >= 8) {
      const type = this.buf[0] as number;
      const len = this.buf.readUInt32BE(4);
      if (this.buf.length < 8 + len) break;
      const payload = this.buf.subarray(8, 8 + len);
      this.buf = this.buf.subarray(8 + len);
      if (type === 1) frames.push(['stdout', Buffer.from(payload)]);
      else if (type === 2) frames.push(['stderr', Buffer.from(payload)]);
    }
    const next = (i: number): void => {
      for (let j = i; j < frames.length; j++) {
        const [kind, data] = frames[j] as ['stdout' | 'stderr', Buffer];
        let r: unknown;
        try {
          r = this.onData(kind, data);
        } catch (e) {
          cb(e instanceof Error ? e : new Error(String(e)));
          return;
        }
        if (isThenable(r)) {
          r.then(() => next(j + 1), cb);
          return;
        }
      }
      cb();
    };
    next(0);
  }
}

export interface ExecSink {
  onStdout(data: Buffer): void;
  onStderr(data: Buffer): void;
}

function envList(env: Record<string, string> | undefined): string[] | undefined {
  if (!env) return undefined;
  return Object.entries(env).map(([k, v]) => `${k}=${v}`);
}

export interface SimpleExecResult {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
}

/** Run a command to completion without a wrapper; collects its output. Used for internal probes. */
export async function simpleExec(
  docker: Docker,
  containerId: string,
  cmd: string[],
  opts: { user?: string; stdin?: Buffer; cwd?: string } = {},
): Promise<SimpleExecResult> {
  const exec = await docker.getContainer(containerId).exec({
    Cmd: cmd,
    AttachStdin: opts.stdin !== undefined,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    ...(opts.user ? { User: opts.user } : {}),
    ...(opts.cwd ? { WorkingDir: opts.cwd } : {}),
  });
  const stream = await exec.start({ hijack: true, stdin: opts.stdin !== undefined });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  const demux = new Demux((k, d) => (k === 'stdout' ? out : err).push(d));
  const done = new Promise<void>((res, rej) => {
    demux.once('finish', res);
    demux.once('error', rej);
    stream.once('error', rej);
  });
  stream.pipe(demux);
  if (opts.stdin !== undefined) stream.end(opts.stdin);
  await done;
  const exitCode = await waitExit(exec);
  return { exitCode, stdout: Buffer.concat(out), stderr: Buffer.concat(err) };
}

export interface StreamedExec {
  /** Standard output of the command, with backpressure; ends when the command closed it. */
  stdout: Readable;
  /** Settles after `stdout` ended and the command exited. Never rejects for a failing command. */
  result: Promise<{ exitCode: number; stderr: Buffer }>;
}

const STREAM_STDERR_CAP = 64 * 1024;

/**
 * Run a command and stream its output (and optionally feed its stdin from a stream) without
 * buffering it in memory. Destroying `stdout` early tears the connection down, which ends the
 * command with SIGPIPE/EOF. Stderr is kept up to 64 KiB for error messages.
 */
export async function streamExec(
  docker: Docker,
  containerId: string,
  cmd: string[],
  opts: { user?: string; stdin?: Readable; cwd?: string } = {},
): Promise<StreamedExec> {
  const exec = await docker.getContainer(containerId).exec({
    Cmd: cmd,
    AttachStdin: opts.stdin !== undefined,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    ...(opts.user ? { User: opts.user } : {}),
    ...(opts.cwd ? { WorkingDir: opts.cwd } : {}),
  });
  const stream = await exec.start({ hijack: true, stdin: opts.stdin !== undefined });
  const stdout = new PassThrough();
  const err: Buffer[] = [];
  let errLen = 0;
  const demux = new Demux((kind, data) => {
    if (kind === 'stderr') {
      if (errLen < STREAM_STDERR_CAP) {
        err.push(data.subarray(0, STREAM_STDERR_CAP - errLen));
        errLen += err[err.length - 1]?.length ?? 0;
      }
      return undefined;
    }
    if (stdout.destroyed || stdout.write(data)) return undefined;
    return new Promise<void>((res) => {
      const done = (): void => {
        stdout.removeListener('drain', done);
        stdout.removeListener('close', done);
        res();
      };
      stdout.once('drain', done);
      stdout.once('close', done);
    });
  });
  const ended = new Promise<void>((res) => {
    demux.once('finish', res);
    demux.once('error', res);
    stream.once('error', (e: Error) => {
      stdout.destroy(e);
      res();
    });
  });
  stream.pipe(demux);
  // A connection that closes without a clean end still lets the frames in flight finish.
  stream.once('close', () => demux.end());
  stdout.once('close', () => {
    if (!stream.destroyed) stream.destroy();
  });
  const input = opts.stdin;
  if (input) {
    // The command may exit before it has read everything (tar failing): a broken pipe is then
    // not an error of its own, the exit code and stderr say what happened.
    stream.on('error', () => undefined);
    if (input.destroyed) stream.destroy();
    else {
      input.once('error', (e) => stream.destroy(e));
      input.pipe(stream as unknown as NodeJS.WritableStream);
    }
  }
  const result = (async () => {
    await ended;
    if (!stdout.destroyed) stdout.end();
    const exitCode = await waitExit(exec);
    return { exitCode, stderr: Buffer.concat(err) };
  })();
  result.catch(() => undefined);
  return { stdout, result };
}

async function waitExit(exec: Docker.Exec, maxMs = 10_000): Promise<number> {
  const t0 = Date.now();
  for (;;) {
    const info = await exec.inspect();
    if (!info.Running) return info.ExitCode ?? -1;
    if (Date.now() - t0 > maxMs) return -1;
    await new Promise((r) => setTimeout(r, 25));
  }
}

export interface RunExecResult {
  exitCode: number;
  timedOut: boolean;
}

/**
 * Execute a command with demuxed output. With `timeoutMs` or `signal` the command is wrapped in a
 * small shell that records its pid and (for timeouts) runs a watchdog inside the sandbox, so the
 * whole process tree is really killed - the Engine API cannot kill an exec.
 */
export async function runExec(
  docker: Docker,
  containerId: string,
  req: ExecRequest,
  sink: ExecSink,
): Promise<RunExecResult> {
  if ((req.argv === undefined) === (req.command === undefined)) {
    throw new AboxError('invalid_input', 'Exactly one of argv or command must be set');
  }
  const argv = req.argv ?? ['/bin/sh', '-c', req.command as string];
  if (argv.length === 0 || argv.some((a) => typeof a !== 'string')) {
    throw new AboxError('invalid_input', 'argv must be a non-empty array of strings');
  }
  if (req.signal?.aborted) throw req.signal.reason ?? new DOMException('Aborted', 'AbortError');

  const wrap = req.timeoutMs !== undefined || req.signal !== undefined;
  const pidfile = `/tmp/.abox-exec-${randomBytes(8).toString('hex')}`;
  const timeoutSec =
    req.timeoutMs !== undefined ? (Math.max(req.timeoutMs, 1) / 1000).toFixed(3) : '';
  const cmd = wrap
    ? ['/bin/sh', '-c', WRAP_SCRIPT, 'abox-exec', pidfile, timeoutSec, ...argv]
    : argv;
  const hasStdin = req.stdin !== undefined;

  const exec = await docker.getContainer(containerId).exec({
    Cmd: cmd,
    AttachStdin: hasStdin,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    ...(req.env ? { Env: envList(req.env) } : {}),
    ...(req.cwd ? { WorkingDir: req.cwd } : {}),
    ...(req.user ? { User: req.user } : {}),
  });

  const killTree = async (): Promise<void> => {
    if (!wrap) return;
    await simpleExec(docker, containerId, ['/bin/sh', '-c', KILL_SCRIPT, 'abox-kill', pidfile], {
      ...(req.user ? { user: req.user } : {}),
    }).catch(() => undefined);
  };

  const stream = await exec.start({ hijack: true, stdin: hasStdin });
  const demux = new Demux((k, d) => (k === 'stdout' ? sink.onStdout(d) : sink.onStderr(d)));
  let hostTimedOut = false;
  let aborted = false;
  let streamClosed = false;

  const streamDone = new Promise<void>((res) => {
    demux.once('finish', res);
    demux.once('error', () => res());
    stream.once('error', () => res());
  });
  stream.pipe(demux);
  // A connection that closes without a clean end still lets the frames in flight finish.
  stream.once('close', () => demux.end());
  stream.once('end', () => (streamClosed = true));
  if (hasStdin) stream.end(typeof req.stdin === 'string' ? Buffer.from(req.stdin) : req.stdin);

  const timers: NodeJS.Timeout[] = [];
  if (req.timeoutMs !== undefined) {
    timers.push(
      setTimeout(() => {
        hostTimedOut = true;
        void killTree();
      }, req.timeoutMs + HOST_KILL_GRACE_MS),
    );
  }
  const onAbort = (): void => {
    aborted = true;
    void killTree().finally(() => stream.destroy());
  };
  req.signal?.addEventListener('abort', onAbort, { once: true });

  // A background process that inherited stdout keeps the stream open after the command exited;
  // stop waiting for it shortly after the exec itself is finished.
  const poll = setInterval(() => {
    void exec
      .inspect()
      .then((info) => {
        if (!info.Running && !streamClosed) {
          setTimeout(() => stream.destroy(), 300).unref();
        }
      })
      .catch(() => undefined);
  }, 500);
  poll.unref();

  try {
    await streamDone;
    const exitCode = await waitExit(exec);
    if (aborted) throw req.signal?.reason ?? new DOMException('Aborted', 'AbortError');
    if (wrap && exitCode === TIMEOUT_SENTINEL)
      return { exitCode: TIMEOUT_EXIT_CODE, timedOut: true };
    return { exitCode, timedOut: hostTimedOut };
  } finally {
    clearInterval(poll);
    for (const t of timers) clearTimeout(t);
    req.signal?.removeEventListener('abort', onAbort);
    if (!stream.destroyed) stream.destroy();
  }
}

/** Interactive terminal via exec with Tty and a hijacked connection. */
export async function openTty(
  docker: Docker,
  containerId: string,
  tty: TtyOptions,
  defaultUser?: string,
): Promise<TtySession> {
  const argv = tty.argv ?? [
    '/bin/sh',
    '-c',
    'if command -v bash >/dev/null 2>&1; then exec bash -l; else exec sh -l; fi',
  ];
  if (argv.length === 0) throw new AboxError('invalid_input', 'argv must not be empty');
  const pidfile = `/tmp/.abox-tty-${randomBytes(8).toString('hex')}`;
  const env = { TERM: 'xterm-256color', ...tty.env };
  const exec = await docker.getContainer(containerId).exec({
    Cmd: ['/bin/sh', '-c', TTY_SCRIPT, 'abox-tty', pidfile, ...argv],
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: true,
    Env: envList(env),
    ...(defaultUser ? { User: defaultUser } : {}),
  });
  const stream = await exec.start({ hijack: true, stdin: true, Tty: true });
  const resize = async (cols: number, rows: number): Promise<void> => {
    await (exec as unknown as { resize(o: { h: number; w: number }): Promise<void> }).resize({
      h: rows,
      w: cols,
    });
  };
  await resize(tty.cols, tty.rows).catch(() => undefined);

  const exited = new Promise<number>((resolve) => {
    const finish = (): void => {
      void waitExit(exec).then(resolve, () => resolve(-1));
    };
    stream.once('close', finish);
    stream.once('end', finish);
  });

  return {
    stream,
    resize,
    wait: () => exited,
    close: async () => {
      stream.destroy();
      await simpleExec(docker, containerId, ['/bin/sh', '-c', KILL_SCRIPT, 'abox-kill', pidfile], {
        ...(defaultUser ? { user: defaultUser } : {}),
      }).catch(() => undefined);
    },
  };
}
