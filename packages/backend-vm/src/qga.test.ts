import { createServer, type Server, type Socket } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { QgaClient, QgaError, closeQgaConnection } from './qga.js';
import { QmpError, qmpCall, withQmp } from './qmp.js';

let dir: string;
let server: Server | undefined;
let sock: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'abox-qga-'));
  sock = join(dir, 's.sock');
});
afterEach(async () => {
  closeQgaConnection(sock);
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
  await rm(dir, { recursive: true, force: true });
});

interface FakeAgent {
  connections: number;
  commands: string[];
  /** Sockets currently open. */
  open: Set<Socket>;
}

/** A guest agent stand-in: strictly one request, one reply; understands 0xFF + guest-sync. */
function fakeAgent(
  handler: (
    cmd: string,
    args: Record<string, unknown> | undefined,
    reply: (m: unknown) => void,
    s: Socket,
  ) => void,
  opts: { staleSync?: boolean } = {},
): Promise<FakeAgent> {
  const state: FakeAgent = { connections: 0, commands: [], open: new Set() };
  server = createServer((s) => {
    state.connections++;
    state.open.add(s);
    s.on('close', () => state.open.delete(s));
    let buf = Buffer.alloc(0);
    s.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        const nl = buf.indexOf(0x0a);
        if (nl < 0) return;
        let line = buf.subarray(0, nl);
        buf = buf.subarray(nl + 1);
        let sawDelimiter = false;
        if (line[0] === 0xff) {
          sawDelimiter = true;
          line = line.subarray(1);
        }
        if (sawDelimiter)
          s.write(
            `${JSON.stringify({ error: { class: 'GenericError', desc: 'JSON parse error, stray' } })}\n`,
          );
        const msg = JSON.parse(line.toString()) as {
          execute: string;
          arguments?: Record<string, unknown>;
        };
        state.commands.push(msg.execute);
        const reply = (m: unknown): void => {
          s.write(`${JSON.stringify(m)}\n`);
        };
        if (msg.execute === 'guest-sync') {
          if (opts.staleSync) reply({ return: 12345 }); // reply of an older connection
          reply({ return: msg.arguments?.['id'] });
        } else handler(msg.execute, msg.arguments, reply, s);
      }
    });
  });
  return new Promise((resolve) => server?.listen(sock, () => resolve(state)));
}

describe('QgaClient', () => {
  it('performs the sync handshake and returns command results', async () => {
    const a = await fakeAgent((cmd, args, reply) => reply({ return: { cmd, args } }));
    const q = new QgaClient(sock);
    expect(await q.call('echo', { x: 1 })).toEqual({ cmd: 'echo', args: { x: 1 } });
    expect(a.commands).toEqual(['guest-sync', 'echo']);
  });

  it('ignores stale replies and the error produced by the 0xFF delimiter', async () => {
    await fakeAgent((_c, _a, reply) => reply({ return: 'ok' }), { staleSync: true });
    expect(await new QgaClient(sock).call('x')).toBe('ok');
  });

  it('keeps one connection for consecutive calls and closes it when idle', async () => {
    const a = await fakeAgent((_c, _a, reply) => reply({ return: 1 }));
    const q = new QgaClient(sock);
    for (let i = 0; i < 20; i++) await q.call('x');
    expect(a.connections).toBe(1);
    expect(a.commands.filter((c) => c === 'guest-sync')).toHaveLength(1);
    // the connection is released shortly after the last call so other abox processes can use the agent
    await new Promise((r) => setTimeout(r, 600));
    expect(a.open.size).toBe(0);
    await q.call('x');
    expect(a.connections).toBe(2);
  });

  it('serializes concurrent calls (the agent is strictly request/response)', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await fakeAgent((_c, args, reply) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      setTimeout(() => {
        inFlight--;
        reply({ return: args?.['n'] });
      }, 15);
    });
    const q = new QgaClient(sock);
    const results = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => q.call('slow', { n })));
    expect(results).toEqual([1, 2, 3, 4, 5, 6]);
    expect(maxInFlight).toBe(1);
  });

  it('maps agent errors', async () => {
    await fakeAgent((_c, _a, reply) => reply({ error: { class: 'GenericError', desc: 'boom' } }));
    const err = await new QgaClient(sock).call('x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QgaError);
    expect((err as QgaError).kind).toBe('agent_error');
    expect((err as QgaError).message).toContain('boom');
  });

  it('times out when the agent does not answer, and recovers on the next call', async () => {
    let silent = true;
    await fakeAgent((_c, _a, reply) => {
      if (!silent) reply({ return: 'late' });
    });
    const q = new QgaClient(sock);
    const err = await q.call('x', undefined, { timeoutMs: 300 }).catch((e: unknown) => e);
    expect((err as QgaError).kind).toBe('timeout');
    silent = false;
    expect(await q.call('x', undefined, { timeoutMs: 2000 })).toBe('late');
  });

  it('reports a missing socket as unreachable; ping never throws', async () => {
    const q = new QgaClient(join(dir, 'missing.sock'));
    const err = await q.call('x', undefined, { timeoutMs: 500 }).catch((e: unknown) => e);
    expect((err as QgaError).kind).toBe('unreachable');
    expect(await q.ping(300)).toBe(false);
  });

  it('survives a dropped connection mid-call and reconnects', async () => {
    let first = true;
    const a = await fakeAgent((_c, _a, reply, s) => {
      if (first) {
        first = false;
        s.destroy();
      } else reply({ return: 'fine' });
    });
    const q = new QgaClient(sock);
    await expect(q.call('x', undefined, { timeoutMs: 1000 })).rejects.toBeInstanceOf(QgaError);
    expect(await q.call('x')).toBe('fine');
    expect(a.connections).toBe(2);
  });
});

describe('QMP client', () => {
  function fakeQmp(handler: (cmd: string, args: unknown) => unknown): Promise<void> {
    server = createServer((s) => {
      s.write(`${JSON.stringify({ QMP: { version: {}, capabilities: [] } })}\n`);
      let buf = '';
      s.on('data', (d: Buffer) => {
        buf += d.toString();
        for (;;) {
          const nl = buf.indexOf('\n');
          if (nl < 0) return;
          const msg = JSON.parse(buf.slice(0, nl)) as { execute: string; arguments?: unknown };
          buf = buf.slice(nl + 1);
          s.write(`${JSON.stringify({ event: 'STOP', data: {}, timestamp: {} })}\n`);
          const r = msg.execute === 'qmp_capabilities' ? {} : handler(msg.execute, msg.arguments);
          if (r instanceof Error)
            s.write(`${JSON.stringify({ error: { class: 'GenericError', desc: r.message } })}\n`);
          else s.write(`${JSON.stringify({ return: r })}\n`);
          if (msg.execute === 'job-start')
            s.write(
              `${JSON.stringify({ event: 'JOB_STATUS_CHANGE', data: { id: 'j', status: 'concluded' } })}\n`,
            );
        }
      });
    });
    return new Promise((resolve) => server?.listen(sock, () => resolve()));
  }

  it('negotiates capabilities, skips events and returns results', async () => {
    await fakeQmp((cmd, args) => ({ cmd, args }));
    expect(await qmpCall(sock, 'query-status', { a: 1 })).toEqual({
      cmd: 'query-status',
      args: { a: 1 },
    });
  });

  it('maps command errors and waits for events', async () => {
    await fakeQmp((cmd) => (cmd === 'bad' ? new Error('nope') : {}));
    await expect(qmpCall(sock, 'bad')).rejects.toMatchObject({
      kind: 'command',
      message: expect.stringContaining('nope') as string,
    });
    const ev = await withQmp(sock, async (s) => {
      await s.call('job-start');
      return s.waitEvent('JOB_STATUS_CHANGE', (d) => d['id'] === 'j', 1000);
    });
    expect(ev).toEqual({ id: 'j', status: 'concluded' });
    await withQmp(sock, async (s) => {
      await expect(s.waitEvent('NEVER', undefined, 100)).rejects.toBeInstanceOf(QmpError);
    });
  });

  it('fails fast when nothing listens', async () => {
    await expect(qmpCall(join(dir, 'none.sock'), 'x', undefined, 500)).rejects.toMatchObject({
      kind: 'unreachable',
    });
  });
});
