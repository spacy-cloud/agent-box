import { randomBytes } from 'node:crypto';
import { Duplex } from 'node:stream';
import { AboxError, type TtyOptions, type TtySession } from '@abox/core';
import { GUEST_RUN_DIR, removeGuestPath, rootScript, runInGuest } from './guest.js';
import type { QgaClient } from './qga.js';
import { mapQgaError } from './qga.js';

/**
 * Interactive terminal without SSH or a guest daemon of our own.
 *
 * In the guest, util-linux `script` allocates a pseudo terminal and runs the command on it. Its
 * stdin is a FIFO that we write with `guest-file-write`; its stdout goes through the normal
 * command wrapper (output file + polling). Resizing sets the window size of the pty with `stty`.
 *
 * Limits: output is polled (about 25 ms latency), input and output share one agent connection,
 * and there is no flow control towards the host (the guest buffers output in its RAM).
 */

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface TtyTarget {
  user: string;
  uid: number;
  cwd: string;
  env: Record<string, string>;
}

export async function attachTty(
  qga: QgaClient,
  target: TtyTarget,
  opts: TtyOptions,
): Promise<TtySession> {
  const cols = Math.max(1, Math.min(1000, Math.floor(opts.cols) || 80));
  const rows = Math.max(1, Math.min(1000, Math.floor(opts.rows) || 24));
  const argv = opts.argv && opts.argv.length > 0 ? opts.argv : ['/bin/bash', '-l'];
  if (argv.some((a) => a.includes('\0')))
    throw new AboxError('invalid_input', 'argv contains a NUL byte');
  const dir = `${GUEST_RUN_DIR}/tty-${randomBytes(6).toString('hex')}`;

  // The input FIFO stays in the root-only directory (the command wrapper opens it). The sandbox user
  // reports the name of its pty through a file of its own in /tmp; root only trusts a /dev/pts/N value.
  const ptsFile = `/tmp/.abox-pts-${dir.slice(-12)}`;
  await rootScript(
    qga,
    'mkdir -p -m 700 "$1" && mkfifo -m 600 "$1/in" && install -m 600 -o "$3" /dev/null "$2"',
    [dir, ptsFile, String(target.uid)],
  );
  let handle: number;
  try {
    // "r+" opens the FIFO read-write, so opening never blocks and the reader does not see EOF early.
    handle = await qga.call<number>('guest-file-open', { path: `${dir}/in`, mode: 'r+' });
  } catch (e) {
    await removeGuestPath(qga, dir).catch(() => undefined);
    throw mapQgaError(e, 'opening the terminal input');
  }

  const inner = 'tty > "$1"; stty rows "$2" cols "$3" 2>/dev/null; shift 3; exec "$@"';
  const cmdline = ['/bin/sh', '-c', inner, 'sh', ptsFile, String(rows), String(cols), ...argv]
    .map(shq)
    .join(' ');
  const abort = new AbortController();
  let closed = false;
  let ended = false;
  const env = { TERM: 'xterm-256color', ...target.env, ...(opts.env ?? {}) };

  let pushOut: (b: Buffer) => void = () => undefined;
  let writeChain: Promise<unknown> = Promise.resolve();
  const stream = new Duplex({
    read() {
      /* data is pushed as it arrives */
    },
    write(chunk: Buffer | string, _enc, cb) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      writeChain = writeChain
        .then(async () => {
          if (closed) return;
          await qga.call('guest-file-write', { handle, 'buf-b64': buf.toString('base64') });
          await qga.call('guest-file-flush', { handle });
        })
        .then(
          () => cb(),
          (e: unknown) => cb(e instanceof Error ? e : new Error(String(e))),
        );
    },
    final(cb) {
      cb();
    },
  });
  pushOut = (b) => {
    stream.push(b);
  };

  const done = (async (): Promise<number> => {
    try {
      const r = await runInGuest(
        qga,
        {
          user: target.user,
          cwd: target.cwd,
          env,
          argv: ['/usr/bin/script', '-qefc', cmdline, '/dev/null'],
          stdinFile: `${dir}/in`,
        },
        { signal: abort.signal, pollMaxMs: 25, onData: (_stream, data) => pushOut(data) },
      );
      return r.exitCode;
    } catch {
      return 255;
    } finally {
      ended = true;
      stream.push(null);
    }
  })();

  const cleanup = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await writeChain.catch(() => undefined);
    await qga.call('guest-file-close', { handle }).catch(() => undefined);
    await removeGuestPath(qga, dir).catch(() => undefined);
    await rootScript(qga, 'rm -f -- "$1"', [ptsFile]).catch(() => undefined);
  };
  void done.then(cleanup, cleanup);

  return {
    stream,
    async resize(newCols: number, newRows: number): Promise<void> {
      if (ended) return;
      const c = Math.max(1, Math.min(1000, Math.floor(newCols) || cols));
      const r = Math.max(1, Math.min(1000, Math.floor(newRows) || rows));
      await rootScript(
        qga,
        'pts=$(head -c 40 "$1" 2>/dev/null); case "$pts" in /dev/pts/[0-9]*) stty -F "$pts" rows "$3" cols "$2";; esac; exit 0',
        [ptsFile, String(c), String(r)],
      );
    },
    wait: () => done,
    async close(): Promise<void> {
      if (!ended) abort.abort();
      await done;
      await cleanup();
    },
  };
}
