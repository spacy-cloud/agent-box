import { request } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Abox } from '@abox/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { serveHttp } from '../src/index.js';
import type { HttpServerHandle } from '../src/index.js';
import { makeEnv, openAbox, wrapClient } from './support/harness.js';
import type { Connected, TestEnv } from './support/harness.js';

const HUMAN = { contextId: 'human' };

let env: TestEnv;
let abox: Abox;
let http: HttpServerHandle;
let tokenA: string;
let tokenB: string;
let clients: Connected[];

async function start(extra: Partial<Parameters<typeof serveHttp>[0]> = {}): Promise<void> {
  http = await serveHttp({ abox, host: '127.0.0.1', port: 0, ...extra });
}

async function client(token: string): Promise<Connected> {
  const t = new StreamableHTTPClientTransport(new URL(http.address.url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const c = new Client({ name: 'http-test', version: '0.0.0' });
  await c.connect(t);
  const w = wrapClient(c, () => c.close());
  clients.push(w);
  return w;
}

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'raw', version: '0' },
  },
};

function raw(
  headers: Record<string, string>,
  opts: { method?: string; path?: string; body?: unknown; host?: string } = {},
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = request(
      {
        host: '127.0.0.1',
        port: http.address.port,
        method: opts.method ?? 'POST',
        path: opts.path ?? '/mcp',
        headers: {
          ...(body
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
            : {}),
          accept: 'application/json, text/event-stream',
          ...(opts.host ? { host: opts.host } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

beforeEach(async () => {
  env = makeEnv();
  clients = [];
  abox = await openAbox(env);
  tokenA = (await abox.createAgentToken(HUMAN, 'agent-a', 'test-a')).token;
  tokenB = (await abox.createAgentToken(HUMAN, 'agent-b', 'test-b')).token;
});
afterEach(async () => {
  for (const c of clients) await c.close().catch(() => undefined);
  await http?.close();
  abox.close();
  env.cleanup();
});

describe('serveHttp: identity and sessions', () => {
  it("serves the full tool surface to a token holder, bound to the token's context", async () => {
    await start();
    expect(http.address.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    const a = await client(tokenA);
    const b = await client(tokenB);
    expect((await a.client.listTools()).tools.length).toBe(19);
    const c = await a.call('sandbox_create', {
      template: 'fake-box',
      workspace: { mode: 'empty' },
    });
    expect(c.s['ok']).toBe(true);
    const id = (c.s['sandbox'] as { id: string }).id;
    expect((await a.call('sandbox_list')).s['sandboxes']).toHaveLength(1);
    expect((await b.call('sandbox_list')).s['sandboxes']).toHaveLength(0);
    expect((await b.call('sandbox_inspect', { id })).s['code']).toBe('not_found');
    expect((await a.call('policy_show')).s['context_id']).toBe('agent-a');
    expect((await b.call('policy_show')).s['context_id']).toBe('agent-b');
    // the sandbox is owned by the agent, as the manager records it
    const sb = (await abox.listSandboxes(HUMAN)).sandboxes[0]!;
    expect(sb.owner).toBe('agent:agent-a');
  });

  it('rejects missing, malformed and wrong tokens with a bare 401 (no details)', async () => {
    await start();
    const cases: Array<Record<string, string>> = [
      {},
      { authorization: 'Bearer' },
      { authorization: 'Basic abc' },
      { authorization: 'Bearer wrongtoken-wrongtoken-wrongtoken' },
      { authorization: `Bearer ${tokenA}x` },
      { authorization: `Bearer ${'a'.repeat(5000)}` },
    ];
    for (const h of cases) {
      const r = await raw(h, { body: INIT });
      expect(r.status, JSON.stringify(h).slice(0, 80)).toBe(401);
      expect(JSON.parse(r.body)).toEqual({ error: 'unauthorized' });
      expect(r.headers['www-authenticate']).toBe('Bearer realm="abox"');
    }
    // unauthenticated requests learn nothing about paths or sessions either
    for (const [method, path] of [
      ['GET', '/mcp'],
      ['DELETE', '/mcp'],
      ['POST', '/other'],
      ['GET', '/'],
    ] as const) {
      const r = await raw({}, { method, path, body: method === 'POST' ? INIT : undefined });
      expect(r.status).toBe(401);
    }
    const q = await raw(
      { authorization: `Bearer ${tokenA}`, 'mcp-session-id': 'x' },
      { body: INIT },
    );
    expect(q.status).toBe(404);
    // SDK client without token cannot connect
    const t = new StreamableHTTPClientTransport(new URL(http.address.url));
    await expect(new Client({ name: 'x', version: '0' }).connect(t)).rejects.toThrow();
  });

  it('token A cannot use the session of token B (and vice versa); the session survives the attempt', async () => {
    await start();
    const init = await raw({ authorization: `Bearer ${tokenA}` }, { body: INIT });
    expect(init.status).toBe(200);
    const sid = init.headers['mcp-session-id'] as string;
    expect(sid).toBeTruthy();
    const call = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };
    const foreign = await raw(
      { authorization: `Bearer ${tokenB}`, 'mcp-session-id': sid },
      { body: call },
    );
    expect([403, 404]).toContain(foreign.status);
    const unknown = await raw(
      { authorization: `Bearer ${tokenB}`, 'mcp-session-id': 'no-such-session' },
      { body: call },
    );
    expect(foreign.status).toBe(unknown.status); // indistinguishable
    for (const method of ['GET', 'DELETE'] as const) {
      const r = await raw({ authorization: `Bearer ${tokenB}`, 'mcp-session-id': sid }, { method });
      expect([403, 404], method).toContain(r.status);
    }
    // the owner can still use it
    await raw(
      { authorization: `Bearer ${tokenA}`, 'mcp-session-id': sid },
      { body: { jsonrpc: '2.0', method: 'notifications/initialized' } },
    );
    const ok = await raw(
      { authorization: `Bearer ${tokenA}`, 'mcp-session-id': sid },
      { body: call },
    );
    expect(ok.status).toBe(200);
    expect(ok.body).toContain('sandbox_create');
    // a second token of the SAME context is still a different token
    const tokenA2 = (await abox.createAgentToken(HUMAN, 'agent-a', 'second')).token;
    const sameCtx = await raw(
      { authorization: `Bearer ${tokenA2}`, 'mcp-session-id': sid },
      { body: call },
    );
    expect([403, 404]).toContain(sameCtx.status);
  });

  it('a revoked token stops working immediately, also inside an open session', async () => {
    await start();
    const meta = await abox.createAgentToken(HUMAN, 'agent-a', 'temp');
    const c = await client(meta.token);
    expect((await c.call('sandbox_list')).s['ok']).toBe(true);
    await abox.revokeAgentToken(HUMAN, meta.id);
    await expect(c.call('sandbox_list')).rejects.toThrow();
    expect((await raw({ authorization: `Bearer ${meta.token}` }, { body: INIT })).status).toBe(401);
  });

  it('only initialize may open a session; other requests without a session are 400', async () => {
    await start();
    const auth = { authorization: `Bearer ${tokenA}` };
    const r1 = await raw(auth, { body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    expect(r1.status).toBe(400);
    expect((await raw(auth, { method: 'GET' })).status).toBe(400);
    expect((await raw(auth, { body: [INIT, INIT] })).status).toBe(400);
    expect((await raw(auth, { path: '/other', body: INIT })).status).toBe(404);
    expect((await raw(auth, { method: 'PUT', body: INIT })).status).toBe(405);
  });

  it('limits sessions per token', async () => {
    await start({ maxSessionsPerToken: 2 });
    for (let i = 0; i < 2; i++)
      expect((await raw({ authorization: `Bearer ${tokenA}` }, { body: INIT })).status).toBe(200);
    expect((await raw({ authorization: `Bearer ${tokenA}` }, { body: INIT })).status).toBe(429);
    expect((await raw({ authorization: `Bearer ${tokenB}` }, { body: INIT })).status).toBe(200);
  });

  it('close() shuts down with open sessions', async () => {
    await start();
    await client(tokenA);
    const t0 = Date.now();
    await http.close();
    expect(Date.now() - t0).toBeLessThan(5000);
    await expect(raw({ authorization: `Bearer ${tokenA}` }, { body: INIT })).rejects.toThrow();
  });
});

describe('serveHttp: network exposure', () => {
  it.each([
    '0.0.0.0',
    '::',
    '192.168.1.10',
    '10.0.0.1',
    'example.com',
    '',
    '127.0.0.1.evil.com',
    '*',
  ])('refuses to bind to %j', async (host) => {
    await expect(serveHttp({ abox, host, port: 0 })).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  it('refuses invalid ports', async () => {
    await expect(serveHttp({ abox, host: '127.0.0.1', port: 70000 })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(serveHttp({ abox, host: '127.0.0.1', port: 1.5 })).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  it('binds to ::1 when IPv6 loopback exists, and to localhost as 127.0.0.1', async () => {
    http = await serveHttp({ abox, host: 'localhost', port: 0 });
    expect(http.address.host).toBe('127.0.0.1');
    await http.close();
    try {
      http = await serveHttp({ abox, host: '::1', port: 0 });
    } catch (e) {
      if (
        (e as NodeJS.ErrnoException).code === 'EADDRNOTAVAIL' ||
        (e as NodeJS.ErrnoException).code === 'EAFNOSUPPORT'
      ) {
        http = await serveHttp({ abox, host: '127.0.0.1', port: 0 });
        return;
      }
      throw e;
    }
    expect(http.address.url).toMatch(/^http:\/\/\[::1\]:\d+\/mcp$/);
    const c = await client(tokenA);
    expect((await c.call('sandbox_list')).s['ok']).toBe(true);
  });

  it('calls onListening with the real address', async () => {
    let seen: string | undefined;
    await start({ onListening: (a) => (seen = a.url) });
    expect(seen).toBe(http.address.url);
  });

  it('validates the Host header (DNS rebinding)', async () => {
    await start();
    const auth = { authorization: `Bearer ${tokenA}` };
    const port = http.address.port;
    for (const host of [
      'evil.com',
      `evil.com:${port}`,
      `127.0.0.1.evil.com:${port}`,
      `localhost.evil.com:${port}`,
      '127.0.0.1:1',
      '127.0.0.1',
      `[::1]:${port + 1}`,
    ]) {
      const r = await raw(auth, { body: INIT, host });
      expect(r.status, `host=${host}`).toBe(403);
    }
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `LOCALHOST:${port}`]) {
      const r = await raw(auth, { body: INIT, host });
      expect(r.status, `host=${host}`).toBe(200);
    }
    // Host is checked before authentication
    expect((await raw({}, { body: INIT, host: 'evil.com' })).status).toBe(403);
  });

  it('validates the Origin header and never sends a CORS wildcard', async () => {
    await start({ allowedOrigins: ['http://orca.local:5173'] });
    const auth = { authorization: `Bearer ${tokenA}` };
    for (const origin of [
      'http://evil.com',
      'https://127.0.0.1.evil.com',
      'null',
      'http://orca.local:5174',
      'file://',
      'chrome-extension://abc',
    ]) {
      const r = await raw({ ...auth, origin }, { body: INIT });
      expect(r.status, origin).toBe(403);
      expect(r.headers['access-control-allow-origin'], origin).toBeUndefined();
    }
    // loopback origins pass the check but get no CORS headers (browsers cannot read the answer)
    const lo = await raw({ ...auth, origin: 'http://localhost:3000' }, { body: INIT });
    expect(lo.status).toBe(200);
    expect(lo.headers['access-control-allow-origin']).toBeUndefined();
    // explicitly allowed origin: exact echo, never *
    const ok = await raw({ ...auth, origin: 'http://orca.local:5173' }, { body: INIT });
    expect(ok.status).toBe(200);
    expect(ok.headers['access-control-allow-origin']).toBe('http://orca.local:5173');
    expect(ok.headers['access-control-allow-origin']).not.toBe('*');
    // preflight: only for allowed origins
    const pre = await raw(
      { origin: 'http://orca.local:5173', 'access-control-request-method': 'POST' },
      { method: 'OPTIONS' },
    );
    expect(pre.status).toBe(204);
    expect(pre.headers['access-control-allow-origin']).toBe('http://orca.local:5173');
    const bad = await raw(
      { origin: 'http://evil.com', 'access-control-request-method': 'POST' },
      { method: 'OPTIONS' },
    );
    expect(bad.status).toBe(403);
    expect((await raw({}, { method: 'OPTIONS' })).status).toBe(403);
    // a valid token is still required even from an allowed origin
    expect((await raw({ origin: 'http://orca.local:5173' }, { body: INIT })).status).toBe(401);
  });
});
