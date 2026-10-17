import { connect, type Socket } from 'node:net';
import { AboxError } from '@abox/core';

/**
 * Client for the QEMU guest agent (`qemu-ga`) over the host-side unix socket of the
 * virtio-serial port `org.qemu.guest_agent.0`.
 *
 * Protocol notes (https://www.qemu.org/docs/master/interop/qemu-ga.html):
 * - newline-delimited JSON, strictly request -> response;
 * - the chardev socket serves ONE client at a time (further connections wait in the listen
 *   backlog), so we connect per call and serialize calls per socket path inside this process;
 * - on every connection we first send `0xFF` + `guest-sync` and wait for the matching reply.
 *   `0xFF` makes the agent drop any half-parsed input, the sync id lets us skip stale replies
 *   of earlier (timed-out) connections. We never send the real command before the sync reply,
 *   so a command can not be executed late by an agent that comes up after we gave up.
 */

export class QgaError extends Error {
  constructor(
    message: string,
    readonly kind: 'timeout' | 'unreachable' | 'agent_error' | 'protocol',
    readonly agentClass?: string,
  ) {
    super(message);
    this.name = 'QgaError';
  }
}

interface AgentReply {
  return?: unknown;
  error?: { class?: string; desc?: string };
}

/**
 * Connection state per socket path, shared by every `QgaClient` of this process.
 *
 * Why persistent: after the host side of the virtio-serial port closes, the guest agent
 * takes ~100 ms to notice and re-arm, so a connection per call would cost 100 ms per call.
 * We therefore keep the connection and close it after `LINGER_MS` without calls, so that
 * other abox processes (CLI invocations) get their turn quickly.
 */
interface ConnState {
  sock?: Socket;
  buffer: string;
  /** Receives parsed lines of the connection (set while a handshake or call is waiting). */
  onLine?: (msg: AgentReply) => void;
  onClose?: (err: Error) => void;
  /** Last pending tail of the FIFO queue. */
  tail: Promise<unknown>;
  queued: number;
  idleTimer?: NodeJS.Timeout;
}

const LINGER_MS = 250;
const conns = new Map<string, ConnState>();

function stateOf(path: string): ConnState {
  let st = conns.get(path);
  if (!st) {
    st = { buffer: '', tail: Promise.resolve(), queued: 0 };
    conns.set(path, st);
  }
  return st;
}

let syncCounter = Math.floor(Math.random() * 1_000_000_000);

function nextSyncId(): number {
  syncCounter = (syncCounter + 1) % 2_000_000_000;
  return syncCounter;
}

function dropConnection(st: ConnState, reason: string): void {
  const sock = st.sock;
  st.sock = undefined;
  st.buffer = '';
  const onClose = st.onClose;
  st.onLine = undefined;
  st.onClose = undefined;
  sock?.destroy();
  onClose?.(new QgaError(reason, 'unreachable'));
}

/** Waits for the next line matching `accept` (others are ignored) or fails after `timeoutMs`. */
function waitForLine(
  st: ConnState,
  accept: (msg: AgentReply) => boolean,
  timeoutMs: number,
  what: string,
): Promise<AgentReply> {
  return new Promise<AgentReply>((resolve, reject) => {
    const timer = setTimeout(() => {
      st.onLine = undefined;
      st.onClose = undefined;
      dropConnection(st, 'timed out');
      reject(
        new QgaError(`guest agent did not answer within ${timeoutMs} ms (${what})`, 'timeout'),
      );
    }, timeoutMs);
    st.onLine = (msg) => {
      if (!accept(msg)) return;
      clearTimeout(timer);
      st.onLine = undefined;
      st.onClose = undefined;
      resolve(msg);
    };
    st.onClose = (err) => {
      clearTimeout(timer);
      reject(err);
    };
  });
}

function feed(st: ConnState, chunk: string): void {
  st.buffer += chunk;
  for (;;) {
    const nl = st.buffer.indexOf('\n');
    if (nl < 0) return;
    const line = st.buffer.slice(0, nl).trim();
    st.buffer = st.buffer.slice(nl + 1);
    if (!line) continue;
    let msg: AgentReply;
    try {
      msg = JSON.parse(line) as AgentReply;
    } catch {
      continue; // garbage from an earlier session
    }
    st.onLine?.(msg);
  }
}

async function openConnection(path: string, st: ConnState, timeoutMs: number): Promise<void> {
  const sock = connect(path);
  sock.setEncoding('utf8');
  st.sock = sock;
  st.buffer = '';
  sock.on('data', (chunk: string) => {
    if (st.sock === sock) feed(st, chunk);
  });
  sock.on('error', () => {
    if (st.sock === sock) dropConnection(st, 'guest agent socket error');
  });
  sock.on('close', () => {
    if (st.sock === sock) dropConnection(st, 'guest agent connection closed');
  });
  const syncId = nextSyncId();
  const reply = waitForLine(st, (m) => m.return === syncId, timeoutMs, 'handshake');
  // Make sure unhandled rejections can not escape when the connect itself fails first.
  reply.catch(() => undefined);
  await new Promise<void>((resolve, reject) => {
    sock.once('connect', () => resolve());
    sock.once('error', (e) =>
      reject(new QgaError(`guest agent socket: ${e.message}`, 'unreachable')),
    );
  });
  // 0xFF: the agent drops whatever it has half-parsed; the sync id lets us skip stale replies.
  sock.write(
    Buffer.concat([
      Buffer.from([0xff]),
      Buffer.from(`${JSON.stringify({ execute: 'guest-sync', arguments: { id: syncId } })}\n`),
    ]),
  );
  await reply;
}

async function runCall(
  path: string,
  command: string,
  args: unknown,
  timeoutMs: number,
): Promise<unknown> {
  const st = stateOf(path);
  const started = Date.now();
  if (!st.sock) await openConnection(path, st, timeoutMs);
  const remaining = Math.max(500, timeoutMs - (Date.now() - started));
  const sock = st.sock;
  if (!sock) throw new QgaError('guest agent connection closed', 'unreachable');
  const reply = waitForLine(st, (m) => 'return' in m || m.error !== undefined, remaining, command);
  reply.catch(() => undefined);
  sock.write(
    `${JSON.stringify(args === undefined ? { execute: command } : { execute: command, arguments: args })}\n`,
  );
  const msg = await reply;
  if (msg.error) {
    throw new QgaError(
      `guest agent: ${command}: ${msg.error.desc ?? 'unknown error'}`,
      'agent_error',
      msg.error.class,
    );
  }
  return msg.return;
}

async function serializedCall(
  path: string,
  command: string,
  args: unknown,
  timeoutMs: number,
): Promise<unknown> {
  const st = stateOf(path);
  if (st.idleTimer) {
    clearTimeout(st.idleTimer);
    st.idleTimer = undefined;
  }
  st.queued++;
  const run = (): Promise<unknown> => runCall(path, command, args, timeoutMs);
  const next = st.tail.then(run, run);
  st.tail = next.catch(() => undefined);
  try {
    return await next;
  } finally {
    st.queued--;
    if (st.queued === 0) {
      st.idleTimer = setTimeout(() => {
        if (st.queued === 0) dropConnection(st, 'idle');
      }, LINGER_MS);
      st.idleTimer.unref();
    }
  }
}

/** Closes the cached connection of a socket (e.g. before the VM is stopped). */
export function closeQgaConnection(socketPath: string): void {
  const st = conns.get(socketPath);
  if (!st) return;
  if (st.idleTimer) clearTimeout(st.idleTimer);
  st.idleTimer = undefined;
  dropConnection(st, 'closed');
  conns.delete(socketPath);
}

export interface QgaCallOptions {
  /** Budget for one call in ms (default 30 000). */
  timeoutMs?: number;
}

export class QgaClient {
  constructor(readonly socketPath: string) {}

  async call<T = unknown>(command: string, args?: unknown, opts: QgaCallOptions = {}): Promise<T> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    return (await serializedCall(this.socketPath, command, args, timeoutMs)) as T;
  }

  /** True when the agent answered `guest-ping` within `timeoutMs`. Never throws. */
  async ping(timeoutMs = 1500): Promise<boolean> {
    try {
      await this.call('guest-ping', undefined, { timeoutMs });
      return true;
    } catch {
      return false;
    }
  }
}

// -- guest-exec ---------------------------------------------------------------------------

export interface GuestExecStatus {
  exited: boolean;
  exitcode?: number;
  signal?: number;
  'out-data'?: string;
  'err-data'?: string;
  'out-truncated'?: boolean;
  'err-truncated'?: boolean;
}

export interface GuestExecArgs {
  path: string;
  arg?: string[];
  env?: string[];
  /** Raw stdin; sent base64 encoded. An empty buffer gives the child an immediate EOF. */
  input?: Buffer;
}

export async function guestExec(
  qga: QgaClient,
  a: GuestExecArgs,
  timeoutMs?: number,
): Promise<number> {
  const args: Record<string, unknown> = {
    path: a.path,
    'capture-output': true,
    'input-data': (a.input ?? Buffer.alloc(0)).toString('base64'),
  };
  if (a.arg) args['arg'] = a.arg;
  if (a.env) args['env'] = a.env;
  const r = await qga.call<{ pid: number }>(
    'guest-exec',
    args,
    timeoutMs === undefined ? {} : { timeoutMs },
  );
  if (typeof r?.pid !== 'number') throw new QgaError('guest-exec returned no pid', 'protocol');
  return r.pid;
}

export function guestExecStatus(
  qga: QgaClient,
  pid: number,
  timeoutMs?: number,
): Promise<GuestExecStatus> {
  return qga.call<GuestExecStatus>(
    'guest-exec-status',
    { pid },
    timeoutMs === undefined ? {} : { timeoutMs },
  );
}

export function mapQgaError(e: unknown, what: string): AboxError {
  if (e instanceof AboxError) return e;
  if (e instanceof QgaError) {
    if (e.kind === 'timeout' || e.kind === 'unreachable') {
      return new AboxError('backend_unavailable', `${what}: ${e.message}`, {
        hint: 'The guest agent does not respond. Is the VM running and fully booted? Try `abox stop` and `abox start`.',
        cause: e,
      });
    }
    return new AboxError('backend_error', `${what}: ${e.message}`, { cause: e });
  }
  return new AboxError('backend_error', `${what}: ${e instanceof Error ? e.message : String(e)}`, {
    cause: e,
  });
}
