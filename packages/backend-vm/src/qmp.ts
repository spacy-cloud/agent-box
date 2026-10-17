import { connect, type Socket } from 'node:net';

/** Minimal QMP (QEMU Machine Protocol) client over a unix socket. One short session per use. */

export class QmpError extends Error {
  constructor(
    message: string,
    readonly kind: 'timeout' | 'unreachable' | 'command',
    readonly qmpClass?: string,
  ) {
    super(message);
    this.name = 'QmpError';
  }
}

interface QmpMessage {
  return?: unknown;
  error?: { class?: string; desc?: string };
  event?: string;
  data?: Record<string, unknown>;
  QMP?: unknown;
}

export interface QmpSession {
  call<T = unknown>(
    command: string,
    args?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<T>;
  /** Waits for an event; events seen since the session started are considered. */
  waitEvent(
    name: string,
    match?: (data: Record<string, unknown>) => boolean,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>>;
}

/**
 * Opens a QMP session, negotiates capabilities and runs `fn`. The socket is closed afterwards.
 * QEMU accepts one monitor client at a time, so keep sessions short.
 */
export async function withQmp<T>(
  socketPath: string,
  fn: (s: QmpSession) => Promise<T>,
  connectTimeoutMs = 5000,
): Promise<T> {
  const sock: Socket = connect(socketPath);
  sock.setEncoding('utf8');
  let buffer = '';
  const events: Array<{ name: string; data: Record<string, unknown> }> = [];
  const waiters: Array<(m: QmpMessage) => void> = [];
  const lines: QmpMessage[] = [];
  let closed: Error | undefined;
  const wake = (): void => {
    for (const w of waiters.splice(0)) w({});
  };

  sock.on('data', (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const nl = buffer.indexOf('\n');
      if (nl < 0) break;
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as QmpMessage;
        if (msg.event) events.push({ name: msg.event, data: msg.data ?? {} });
        else lines.push(msg);
      } catch {
        /* ignore garbage */
      }
    }
    wake();
  });
  sock.on('error', (e) => {
    closed = new QmpError(`QMP socket: ${e.message}`, 'unreachable');
    wake();
  });
  sock.on('close', () => {
    closed ??= new QmpError('QMP connection closed', 'unreachable');
    wake();
  });

  const waitFor = async <R>(
    pick: () => R | undefined,
    timeoutMs: number,
    what: string,
  ): Promise<R> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const got = pick();
      if (got !== undefined) return got;
      if (closed) throw closed;
      const left = deadline - Date.now();
      if (left <= 0) throw new QmpError(`QMP: timed out waiting for ${what}`, 'timeout');
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left);
        waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  };

  try {
    await waitFor(
      () => (lines.length > 0 ? lines.shift() : undefined),
      connectTimeoutMs,
      'greeting',
    ); // {"QMP": ...}
    const send = (cmd: Record<string, unknown>): void => {
      sock.write(`${JSON.stringify(cmd)}\n`);
    };
    const call = async <R>(
      command: string,
      args?: Record<string, unknown>,
      timeoutMs = 10_000,
    ): Promise<R> => {
      send(args === undefined ? { execute: command } : { execute: command, arguments: args });
      const msg = await waitFor(() => lines.shift(), timeoutMs, command);
      if (msg.error)
        throw new QmpError(
          `QMP ${command}: ${msg.error.desc ?? 'error'}`,
          'command',
          msg.error.class,
        );
      return msg.return as R;
    };
    await call('qmp_capabilities');
    const session: QmpSession = {
      call,
      waitEvent: (name, match, timeoutMs = 30_000) =>
        waitFor(
          () => {
            const idx = events.findIndex((e) => e.name === name && (match?.(e.data) ?? true));
            if (idx < 0) return undefined;
            return events.splice(idx, 1)[0]?.data;
          },
          timeoutMs,
          `event ${name}`,
        ),
    };
    return await fn(session);
  } finally {
    sock.destroy();
  }
}

/** One-shot command. */
export async function qmpCall<T = unknown>(
  socketPath: string,
  command: string,
  args?: Record<string, unknown>,
  timeoutMs = 10_000,
): Promise<T> {
  return withQmp(socketPath, (s) => s.call<T>(command, args, timeoutMs), timeoutMs);
}
