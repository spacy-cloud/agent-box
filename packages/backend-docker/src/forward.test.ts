import { connect, createServer, type Server, type Socket } from 'node:net';
import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FIRST_BYTES_TIMEOUT_MS,
  checkRequestHead,
  hostnameOf,
  isLoopbackName,
  looksLikeHttp,
  startForwarder,
} from '../runtime/forward.mjs';
import { forwardDockerfile, forwardImageTag, parseForwardLog } from './forward.js';

describe('the Host check', () => {
  const head = (host: string | string[] | undefined, target = '/'): string =>
    [
      `GET ${target} HTTP/1.1`,
      ...(host === undefined ? [] : [host].flat().map((h) => `Host: ${h}`)),
      'Accept: */*',
    ].join('\r\n');

  it('knows the loopback names', () => {
    for (const ok of ['127.0.0.1', 'localhost', 'app.localhost', '[::1]', 'a.b.localhost'])
      expect(isLoopbackName(ok), ok).toBe(true);
    for (const bad of [
      '0.0.0.0',
      '127.0.0.2',
      'evil.example.com',
      'localhost.evil.com',
      'notlocalhost',
      '192.168.1.5',
      '',
    ])
      expect(isLoopbackName(bad), bad).toBe(false);
  });

  it('takes the port off an authority', () => {
    expect(hostnameOf('127.0.0.1:5173')).toBe('127.0.0.1');
    expect(hostnameOf('LocalHost')).toBe('localhost');
    expect(hostnameOf('[::1]:8080')).toBe('[::1]');
    expect(hostnameOf(' evil.com:80 ')).toBe('evil.com');
  });

  it('lets loopback hosts through and refuses everything else', () => {
    for (const h of ['127.0.0.1:41234', 'localhost:3000', 'x.localhost', '[::1]:80'])
      expect(checkRequestHead(head(h)), h).toEqual({ ok: true });
    for (const h of ['evil.example.com', 'evil.example.com:41234', '192.168.1.5:80', 'rebind.test'])
      expect(checkRequestHead(head(h)).ok, h).toBe(false);
  });

  it('refuses a second Host header and an absolute target that names another host', () => {
    expect(checkRequestHead(head(['localhost', 'evil.com']))).toMatchObject({ ok: false });
    expect(checkRequestHead(head('localhost', 'http://evil.com/x'))).toMatchObject({ ok: false });
    expect(checkRequestHead(head('localhost', 'http://localhost:3000/x'))).toEqual({ ok: true });
  });

  it('is case-insensitive about the header name, and passes a request without Host (HTTP/1.0)', () => {
    expect(checkRequestHead('GET / HTTP/1.1\r\nhOsT:   evil.com')).toMatchObject({ ok: false });
    expect(checkRequestHead('GET / HTTP/1.0')).toEqual({ ok: true });
  });

  it('tells HTTP from other traffic by its first bytes', () => {
    expect(looksLikeHttp(Buffer.from('GET / HTTP/1.1\r\n'))).toBe(true);
    expect(looksLikeHttp(Buffer.from('POST /x HTTP/1.1\r\n'))).toBe(true);
    expect(looksLikeHttp(Buffer.from([0x16, 0x03, 0x01, 0x02, 0x00]))).toBe(false); // TLS hello
    expect(looksLikeHttp(Buffer.from('SELECT 1'))).toBe(true); // looks like a method; the Host check then finds no Host header
    expect(looksLikeHttp(Buffer.from('hello there'))).toBe(false);
  });
});

describe('the forwarder program', () => {
  const closers: Array<() => void> = [];
  afterEach(() => {
    for (const c of closers.splice(0)) c();
  });

  async function freePort(): Promise<number> {
    const s = createServer().listen(0, '127.0.0.1');
    await new Promise((r) => s.once('listening', r));
    const p = (s.address() as { port: number }).port;
    await new Promise((r) => s.close(r));
    return p;
  }

  /** A target server in the test process. */
  async function target(onConn: (s: Socket) => void): Promise<number> {
    const port = await freePort();
    const open = new Set<Socket>();
    const srv: Server = createServer((s) => {
      open.add(s);
      s.on('error', () => undefined);
      s.once('close', () => open.delete(s));
      onConn(s);
    }).listen(port, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    closers.push(() => {
      srv.close();
      for (const s of open) s.destroy();
    });
    return port;
  }

  async function forwarder(targetPort: number, env: Record<string, string> = {}) {
    const listen = await freePort();
    const logs: Array<Record<string, unknown>> = [];
    let expired = false;
    const f = startForwarder(
      {
        FWD_TARGET_HOST: '127.0.0.1',
        FWD_TARGET_PORT: String(targetPort),
        FWD_LISTEN_PORT: String(listen),
        FWD_LISTEN_HOST: '127.0.0.1',
        FWD_EXPIRES_FILE: '/nonexistent/expires',
        ...env,
      },
      { log: (o) => logs.push(o), onExpired: () => (expired = true) },
    );
    closers.push(() => f.close());
    await f.ready;
    return { f, listen, logs, expired: () => expired };
  }

  const http = (
    port: number,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: string }> =>
    new Promise((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port, headers, agent: false, timeout: 5000 },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c: string) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.end();
    });

  const httpTarget = () =>
    target((s) => {
      s.once('data', () =>
        s.end('HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nhi\n'),
      );
    });

  it('passes a request with a loopback Host to the target and counts it', async () => {
    const t = await httpTarget();
    const { f, listen, logs } = await forwarder(t);
    expect(logs[0]).toMatchObject({ event: 'ready', port: listen, target: 'up' });
    expect(await http(listen, { Host: `127.0.0.1:${listen}` })).toEqual({
      status: 200,
      body: 'hi\n',
    });
    expect(f.stats).toMatchObject({ connections: 1, rejected: 0, failed: 0, target: 'up' });
  });

  it('refuses a foreign Host with 403 and never connects to the target', async () => {
    let touched = 0;
    const t = await target((s) => {
      touched += 1;
      s.destroy();
    });
    const { f, listen } = await forwarder(t);
    const probes = touched; // the start-up probe
    const res = await http(listen, { Host: 'evil.example.com' });
    expect(res.status).toBe(403);
    expect(res.body).toContain('evil.example.com');
    expect(touched).toBe(probes);
    expect(f.stats.rejected).toBe(1);
  });

  it('answers 502 with the 0.0.0.0 hint when nothing listens on the target port', async () => {
    const dead = await freePort();
    const { f, listen, logs } = await forwarder(dead);
    expect(logs[0]).toMatchObject({ event: 'ready', target: 'down' });
    const res = await http(listen, { Host: 'localhost' });
    expect(res.status).toBe(502);
    expect(res.body).toContain('0.0.0.0');
    expect(f.stats).toMatchObject({ failed: 1, target: 'down' });
  });

  it('passes other protocols through untouched, in both directions', async () => {
    const t = await target((s) =>
      s.on('data', (d) => s.write(Buffer.concat([Buffer.from('echo:'), d]))),
    );
    const { listen } = await forwarder(t);
    const got = await new Promise<string>((resolve, reject) => {
      const c = connect({ host: '127.0.0.1', port: listen });
      c.once('connect', () => c.write(Buffer.from([0x16, 0x03, 0x01, 0x00, 0x05])));
      c.once('data', (d) => {
        c.destroy();
        resolve(d.toString('latin1'));
      });
      c.on('error', reject);
    });
    expect(got.startsWith('echo:')).toBe(true);
  });

  it('lets a protocol where the server speaks first through after a short wait', async () => {
    const t = await target((s) => s.write('220 hello\r\n'));
    const { listen } = await forwarder(t);
    const t0 = Date.now();
    const greeting = await new Promise<string>((resolve, reject) => {
      const c = connect({ host: '127.0.0.1', port: listen });
      c.once('data', (d) => {
        c.destroy();
        resolve(d.toString());
      });
      c.on('error', reject);
    });
    expect(greeting).toBe('220 hello\r\n');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(FIRST_BYTES_TIMEOUT_MS - 100);
  });

  it('reports running totals as JSON lines and nothing per connection', async () => {
    const t = await httpTarget();
    const { listen, logs, f } = await forwarder(t);
    await http(listen, { Host: 'localhost' });
    await http(listen, { Host: 'localhost' });
    await new Promise((r) => setTimeout(r, 400));
    const stats = logs.filter((l) => l['event'] === 'stats');
    expect(stats.length).toBeGreaterThanOrEqual(1);
    expect(stats.at(-1)).toMatchObject({ connections: 2, rejected: 0, failed: 0, target: 'up' });
    // only ready + stats lines, no host names, paths or addresses
    for (const l of logs) expect(['ready', 'stats']).toContain(l['event']);
    f.close();
    expect(JSON.stringify(logs)).not.toMatch(/localhost|127\.0\.0\.1/);
  });

  it('ends itself at its deadline', async () => {
    const t = await httpTarget();
    const { logs, expired } = await forwarder(t, {
      FWD_EXPIRES: String(Math.floor(Date.now() / 1000) - 1),
    });
    await new Promise((r) => setTimeout(r, 2500));
    expect(expired()).toBe(true);
    expect(logs.some((l) => l['event'] === 'expired')).toBe(true);
  });

  it('refuses to start without a target', () => {
    expect(() => startForwarder({ FWD_LISTEN_PORT: '1' })).toThrow(/FWD_TARGET_HOST/);
    expect(() => startForwarder({ FWD_TARGET_HOST: '10.0.0.2', FWD_TARGET_PORT: '70000' })).toThrow(
      /FWD_TARGET_PORT/,
    );
  });
});

describe('the image and the log', () => {
  it('has a content-addressed tag that follows the program and the recipe', () => {
    const a = forwardImageTag(Buffer.from('one'));
    expect(a).toMatch(/^abox\/forward:[0-9a-f]{12}$/);
    expect(forwardImageTag(Buffer.from('one'))).toBe(a);
    expect(forwardImageTag(Buffer.from('two'))).not.toBe(a);
  });

  it('runs as an unprivileged user and starts only the forwarder', () => {
    expect(forwardDockerfile).toContain('USER 10001');
    expect(forwardDockerfile).toContain('ENTRYPOINT ["node","/opt/abox-fwd/forward.mjs"]');
  });

  it('reads ready, stats and expired out of the log, ignoring everything else', () => {
    const log = [
      'not json',
      '{"event":"ready","port":8080,"target":"down"}',
      '{"event":"stats","connections":3,"rejected":1,"failed":2,"active":0,"target":"up"}',
      '{"event":"other"}',
      '{broken',
    ].join('\n');
    expect(parseForwardLog(log)).toEqual({
      ready: true,
      expired: false,
      target: 'up',
      connections: 3,
      rejected: 1,
      failed: 2,
    });
    expect(parseForwardLog('')).toMatchObject({ ready: false, target: 'unknown', connections: 0 });
    expect(parseForwardLog('{"event":"expired"}').expired).toBe(true);
  });
});
