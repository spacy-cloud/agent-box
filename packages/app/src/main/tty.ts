/**
 * Terminal sessions between the renderer (xterm.js) and a sandbox shell or a local `ssh` process.
 *
 * Rules that hold here:
 * - The renderer only names a target (a sandbox id or a host profile id) and a size. It never passes a
 *   command, a path or ssh options; the argv comes from the manager (`attach`) or from `sshSessionArgs`.
 * - Session ids are random UUIDs created here. Input, resize and close only work for ids of this manager.
 * - Output is forwarded as raw bytes. The renderer feeds it into the terminal emulator and nothing else.
 * - Every session is closed when the window goes away (`closeAll`).
 */
import { randomUUID } from 'node:crypto';
import type { TtySession } from '@abox/core';
import type { EventChannel, EventPayloads } from '../shared/ipc';
import type { TtyOpened } from '../shared/types';

/** What the manager needs from any terminal source (sandbox attach, ssh in a pty). */
export interface TerminalBackend {
  readonly label: string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** Ends the session (idempotent). */
  close(): void;
  onData(cb: (chunk: Uint8Array) => void): void;
  /** Called once when the process ended on its own (or after `close`). */
  onExit(cb: (code: number | null, reason?: string) => void): void;
}

export interface TtySize {
  cols: number;
  rows: number;
}

export interface TtyDeps {
  send<E extends Extract<EventChannel, 'evt:tty-data' | 'evt:tty-exit'>>(
    channel: E,
    payload: EventPayloads[E],
  ): void;
  openSandbox(id: string, size: TtySize): Promise<TerminalBackend>;
  openSsh(host: string, size: TtySize): Promise<TerminalBackend>;
  maxSessions?: number;
}

export type TtyTarget =
  ({ kind: 'sandbox'; id: string } & TtySize) | ({ kind: 'ssh'; host: string } & TtySize);

interface Session {
  backend: TerminalBackend;
  kind: 'sandbox' | 'ssh';
}

export class TtyManager {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly d: TtyDeps) {}

  get size(): number {
    return this.sessions.size;
  }

  async open(target: TtyTarget): Promise<TtyOpened> {
    if (this.sessions.size >= (this.d.maxSessions ?? 16)) {
      throw Object.assign(new Error('too many open terminals'), {
        ipc: { code: 'conflict', message: 'Too many open terminals. Close one first.' },
      });
    }
    const size = { cols: target.cols, rows: target.rows };
    const backend =
      target.kind === 'sandbox'
        ? await this.d.openSandbox(target.id, size)
        : await this.d.openSsh(target.host, size);
    const sessionId = randomUUID();
    this.sessions.set(sessionId, { backend, kind: target.kind });
    backend.onData((data) => {
      if (this.sessions.has(sessionId)) this.d.send('evt:tty-data', { sessionId, data });
    });
    backend.onExit((code, reason) => {
      if (!this.sessions.delete(sessionId)) return;
      this.d.send('evt:tty-exit', { sessionId, code, ...(reason ? { reason } : {}) });
    });
    return { sessionId, kind: target.kind, label: backend.label, ...size };
  }

  input(sessionId: string, data: string): void {
    this.sessions.get(sessionId)?.backend.write(data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.sessions.get(sessionId)?.backend.resize(cols, rows);
  }

  close(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.sessions.delete(sessionId);
    s.backend.close();
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }
}

/** Adapts the manager's `TtySession` (a duplex stream plus resize/wait/close). */
export function backendFromTtySession(session: TtySession, label: string): TerminalBackend {
  let exitCb: ((code: number | null, reason?: string) => void) | undefined;
  let exited = false;
  let result: { code: number | null; reason?: string } | undefined;
  const fire = (code: number | null, reason?: string): void => {
    if (exited) return;
    exited = true;
    result = { code, ...(reason ? { reason } : {}) };
    exitCb?.(code, reason);
  };
  session.wait().then(
    (code) => fire(code),
    (e: unknown) => fire(null, e instanceof Error ? e.message : String(e)),
  );
  return {
    label,
    write: (data) => {
      try {
        session.stream.write(data);
      } catch {
        /* the stream is gone: the exit handler reports it */
      }
    },
    resize: (cols, rows) => {
      void session.resize(cols, rows).catch(() => undefined);
    },
    close: () => {
      fire(null);
      void session.close().catch(() => undefined);
    },
    onData: (cb) => {
      session.stream.on('data', (chunk: Buffer | string) => {
        cb(typeof chunk === 'string' ? Buffer.from(chunk) : new Uint8Array(chunk));
      });
    },
    onExit: (cb) => {
      exitCb = cb;
      if (result) cb(result.code, result.reason);
    },
  };
}
