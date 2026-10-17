import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Abox } from '@abox/core';
import { MAX_MESSAGE_BYTES, WRITE_FILE_MAX_BYTES, serveStdio } from '../src/index.js';
import { MessageSizeGuard, oversizedResponse } from '../src/stdio-guard.js';
import type { OversizedMessage } from '../src/stdio-guard.js';
import { connect, makeEnv, openAbox } from './support/harness.js';
import type { Connected, TestEnv } from './support/harness.js';

let env: TestEnv;
let abox: Abox;
let conns: Connected[] = [];

beforeEach(() => {
  env = makeEnv();
  conns = [];
});
afterEach(async () => {
  for (const c of conns) await c.close();
  abox?.close();
  env.cleanup();
});

function runGuard(max: number, input: Buffer[]): { out: string; refused: OversizedMessage[] } {
  const refused: OversizedMessage[] = [];
  const g = new MessageSizeGuard(max, (i) => refused.push(i));
  const chunks: Buffer[] = [];
  g.on('data', (c: Buffer) => chunks.push(c));
  for (const c of input) g.write(c);
  g.end();
  return { out: Buffer.concat(chunks).toString('utf8'), refused };
}

describe('MessageSizeGuard', () => {
  it('passes lines within the limit through unchanged, however the chunks are cut', () => {
    const text = '{"a":1}\n{"b":"two"}\n\n{"c":3}\n';
    const all = Buffer.from(text);
    const cuts = [
      Buffer.from(text.slice(0, 3)),
      Buffer.from(text.slice(3, 11)),
      Buffer.from(text.slice(11)),
    ];
    expect(runGuard(100, [all]).out).toBe(text);
    expect(runGuard(100, cuts).out).toBe(text);
  });

  it('drops an oversized line, reports its id (last or first position) and goes on with the next line', () => {
    const big = 'x'.repeat(5000);
    const sdkStyle = `{"method":"tools/call","params":{"arguments":{"id":"local/ab","content":"${big}"}},"jsonrpc":"2.0","id":17}\n`;
    const idFirst = `{"jsonrpc":"2.0","id":"req-9","method":"tools/call","params":{"content":"${big}"}}\n`;
    const note = `{"jsonrpc":"2.0","method":"notifications/x","params":{"p":"${big}"}}\n`;
    const ok = '{"jsonrpc":"2.0","id":18,"method":"ping"}\n';
    const r = runGuard(1000, [
      Buffer.from(sdkStyle.slice(0, 2500)),
      Buffer.from(sdkStyle.slice(2500) + idFirst + note + ok),
    ]);
    expect(r.out).toBe(ok);
    expect(r.refused).toHaveLength(3);
    expect(r.refused[0]).toMatchObject({ id: 17, toolCall: true });
    expect(r.refused[1]).toMatchObject({ id: 'req-9', toolCall: true });
    expect(r.refused[2]!.id).toBeUndefined();
    expect(r.refused[0]!.bytes).toBe(sdkStyle.length - 1);
  });

  it('answers a tool call with an invalid_input tool result and anything else with a JSON-RPC error', () => {
    const tool = oversizedResponse(
      { bytes: 40 * 1024 * 1024, id: 5, toolCall: true },
      MAX_MESSAGE_BYTES,
    ) as {
      result: { isError: boolean; structuredContent: { code: string; hint: string } };
    };
    expect(tool.result.isError).toBe(true);
    expect(tool.result.structuredContent.code).toBe('invalid_input');
    expect(tool.result.structuredContent.hint).toContain('workspace');
    expect(oversizedResponse({ bytes: 1, id: 6, toolCall: false }, 10)).toMatchObject({
      id: 6,
      error: { code: -32600 },
    });
    expect(oversizedResponse({ bytes: 1, toolCall: false }, 10)).toBeUndefined();
  });
});

describe('sandbox_write_file limits', () => {
  it('the documented limit is 8 MiB of content and the transport fits it (also base64)', () => {
    expect(WRITE_FILE_MAX_BYTES).toBe(8 * 1024 * 1024);
    const base64Message = Math.ceil((WRITE_FILE_MAX_BYTES / 3) * 4) + 4096;
    expect(base64Message).toBeLessThan(10 * 1024 * 1024 * 1.1);
    expect(MAX_MESSAGE_BYTES).toBeGreaterThan(base64Message * 2);
  });

  it('accepts content at the limit and refuses more with invalid_input and a hint', async () => {
    abox = await openAbox(env);
    const a = await connect(abox, 'agent-a');
    conns.push(a);
    const c = await a.call('sandbox_create', {
      template: 'fake-box',
      workspace: { mode: 'empty' },
    });
    const id = (c.s['sandbox'] as { id: string }).id;
    const fits = await a.call('sandbox_write_file', {
      id,
      path: '/workspace/big.txt',
      content: 'a'.repeat(WRITE_FILE_MAX_BYTES),
    });
    expect(fits.s).toMatchObject({ ok: true, size: WRITE_FILE_MAX_BYTES });
    const fitsB64 = await a.call('sandbox_write_file', {
      id,
      path: '/workspace/big.bin',
      content: Buffer.alloc(WRITE_FILE_MAX_BYTES, 7).toString('base64'),
      encoding: 'base64',
    });
    expect(fitsB64.s).toMatchObject({ ok: true, size: WRITE_FILE_MAX_BYTES });
    for (const [content, encoding] of [
      ['a'.repeat(WRITE_FILE_MAX_BYTES + 1), undefined],
      ['é'.repeat(WRITE_FILE_MAX_BYTES / 2 + 1), undefined],
      [Buffer.alloc(WRITE_FILE_MAX_BYTES + 1, 7).toString('base64'), 'base64'],
      ['a'.repeat(WRITE_FILE_MAX_BYTES * 2), 'base64'],
    ] as const) {
      const r = await a.call('sandbox_write_file', {
        id,
        path: '/workspace/too-big',
        content,
        ...(encoding ? { encoding } : {}),
      });
      expect(r.isError).toBe(true);
      expect(r.s['code']).toBe('invalid_input');
      expect(`${String(r.s['message'])} ${String(r.s['hint'])}`).toMatch(
        /workspace.*sandbox_exec/s,
      );
    }
  });
});

describe('stdio: one oversized message does not end the connection', () => {
  it('answers it with invalid_input and keeps serving', async () => {
    abox = await openAbox(env);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const lines: string[] = [];
    let pending = '';
    const waiters: Array<() => void> = [];
    stdout.on('data', (d: Buffer) => {
      pending += d.toString('utf8');
      let i;
      while ((i = pending.indexOf('\n')) !== -1) {
        lines.push(pending.slice(0, i));
        pending = pending.slice(i + 1);
        waiters.splice(0).forEach((w) => w());
      }
    });
    const next = async (n: number): Promise<void> => {
      while (lines.length < n) await new Promise<void>((r) => waiters.push(r));
    };
    const done = serveStdio({ abox, contextId: 'agent-a', stdin, stdout, ttlWatchMs: 0 });
    const send = (m: object): boolean => stdin.write(`${JSON.stringify(m)}\n`);

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 't', version: '0' },
      },
    });
    await next(1);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    // 40 MiB in one message, written in pieces
    const head =
      '{"method":"tools/call","params":{"name":"sandbox_write_file","arguments":{"id":"x","path":"/a","content":"';
    stdin.write(head);
    const piece = 'z'.repeat(1024 * 1024);
    for (let i = 0; i < 40; i++) stdin.write(piece);
    stdin.write('"}},"jsonrpc":"2.0","id":2}\n');
    await next(2);
    const refused = JSON.parse(lines[1]!) as {
      id: number;
      result: { isError: boolean; structuredContent: { code: string } };
    };
    expect(refused.id).toBe(2);
    expect(refused.result.isError).toBe(true);
    expect(refused.result.structuredContent.code).toBe('invalid_input');

    // the connection is alive
    send({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    await next(3);
    const listed = JSON.parse(lines[2]!) as { id: number; result: { tools: unknown[] } };
    expect(listed.id).toBe(3);
    expect(listed.result.tools.length).toBeGreaterThan(10);

    stdin.end();
    await done;
  }, 60_000);
});
