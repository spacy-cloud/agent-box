import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  connectThroughProxy,
  httpsViaProxy,
  httpViaProxy,
  makePki,
  makeTempDir,
  rawRequest,
  removeDir,
  runProxyExpectingExit,
  startHttpServer,
  startHttpsServer,
  startProxy,
  type Pki,
  type RunningProxy,
  type TestServer,
} from './__tests__/helpers.js';

const SECRET = 'Bearer s3cr3t-token-DO-NOT-LEAK-0123456789';

let dir: string;
let pki: Pki;
let otherPki: Pki;
let tlsServer: TestServer & { tlsErrors: number };
let badTlsServer: TestServer & { tlsErrors: number };
let httpServer: TestServer;
const proxies: RunningProxy[] = [];

/** Both fake origins live on loopback; names resolve through `dnsOverrides`. */
const dnsOverrides = {
  'upstream.test': ['127.0.0.1'],
  'other.test': ['127.0.0.1'],
  'bad.test': ['127.0.0.1'],
  'rebind.test': ['93.184.216.34', '127.0.0.1'], // never connected to: the policy denies first
  'private.test': ['10.1.2.3'],
  'metadata.test': ['169.254.169.254'],
  'mapped.test': ['::ffff:7f00:1'],
};

async function proxy(config: Record<string, unknown>): Promise<RunningProxy> {
  const p = await startProxy(dir, {
    allow: [],
    upstreamCaFile: pki.caFile,
    dnsOverrides,
    ...config,
  });
  proxies.push(p);
  return p;
}

beforeAll(async () => {
  dir = makeTempDir();
  pki = makePki(dir, ['upstream.test', 'other.test', 'localhost'], 'good');
  otherPki = makePki(dir, ['bad.test'], 'untrusted');
  tlsServer = await startHttpsServer(pki);
  badTlsServer = await startHttpsServer(otherPki);
  httpServer = await startHttpServer();
});

afterEach(async () => {
  await Promise.all(proxies.splice(0).map((p) => p.stop()));
});

afterAll(async () => {
  await Promise.all([tlsServer.close(), badTlsServer.close(), httpServer.close()]);
  removeDir(dir);
});

describe('config handling', () => {
  it('exits non-zero with a JSON error line for a missing config file', async () => {
    const r = await runProxyExpectingExit(join(dir, 'does-not-exist.json'));
    expect(r.code).not.toBe(0);
    const line = JSON.parse(r.stdout.trim().split('\n')[0] ?? '{}') as { event: string };
    expect(line.event).toBe('error');
  });

  it('exits non-zero for invalid JSON without echoing the content', async () => {
    const file = join(dir, 'broken.json');
    writeFileSync(file, `{"injections":[{"value":"${SECRET}"`);
    const r = await runProxyExpectingExit(file);
    expect(r.code).not.toBe(0);
    expect(JSON.parse(r.stdout.trim()).event).toBe('error');
    expect(r.stdout + r.stderr).not.toContain('s3cr3t');
  });

  it('exits non-zero for an invalid config and lists errors without values', async () => {
    const file = join(dir, 'invalid.json');
    writeFileSync(
      file,
      JSON.stringify({
        allow: ['*.com'],
        injections: [{ host: 'a.test', header: 'Bad Header', value: SECRET }],
      }),
    );
    const r = await runProxyExpectingExit(file);
    expect(r.code).toBe(2);
    const parsed = JSON.parse(r.stdout.trim()) as { event: string; errors: string[] };
    expect(parsed.event).toBe('error');
    expect(parsed.errors.length).toBeGreaterThanOrEqual(2);
    expect(r.stdout + r.stderr).not.toContain('s3cr3t');
  });
});

describe('CONNECT tunnelling', () => {
  it('tunnels an allowed host to the checked address (name is not resolvable)', async () => {
    const p = await proxy({
      allow: ['upstream.test:' + tlsServer.port],
      privateExceptions: ['127.0.0.1/32'],
    });
    const [res] = await httpsViaProxy({
      proxyPort: p.port,
      host: 'upstream.test',
      port: tlsServer.port,
      ca: pki.caPem,
      requests: [{ path: '/hello' }],
    });
    expect(res?.status).toBe(200);
    expect(res?.headers['x-upstream']).toBe('yes');
    expect(tlsServer.seen.at(-1)?.url).toBe('/hello');
    const ev = await p.waitForRequest((e) => e.decision === 'allow');
    expect(ev).toMatchObject({
      method: 'CONNECT',
      host: 'upstream.test',
      port: tlsServer.port,
      ip: '127.0.0.1',
      decision: 'allow',
    });
  });

  it('denies hosts that are not in the allowlist with 403 and a deny log line', async () => {
    const p = await proxy({
      allow: ['upstream.test:' + tlsServer.port],
      privateExceptions: ['127.0.0.1/32'],
    });
    const r = await connectThroughProxy(p.port, 'other.test:' + tlsServer.port);
    expect(r.status).toBe(403);
    expect(r.headers).toContain('X-Abox-Proxy: denied');
    r.socket.destroy();
    const ev = await p.waitForRequest((e) => e.decision === 'deny');
    expect(ev).toMatchObject({
      method: 'CONNECT',
      host: 'other.test',
      port: tlsServer.port,
      decision: 'deny',
      reason: 'not in allowlist',
    });
    expect(ev).not.toHaveProperty('ip');
  });

  it('denies disallowed ports even for allowed hosts', async () => {
    const p = await proxy({ allow: ['upstream.test'], privateExceptions: ['127.0.0.1/32'] });
    const r = await connectThroughProxy(p.port, 'upstream.test:' + tlsServer.port);
    expect(r.status).toBe(403);
    r.socket.destroy();
    expect((await p.waitForRequest((e) => e.decision === 'deny')).reason).toBe('port not allowed');
  });

  it('supports wildcard entries (subdomains only)', async () => {
    const p = await proxy({
      allow: ['*.upstream.test:' + tlsServer.port],
      privateExceptions: ['127.0.0.1/32'],
      dnsOverrides: { ...dnsOverrides, 'a.upstream.test': ['127.0.0.1'] },
    });
    const ok = await connectThroughProxy(p.port, 'A.Upstream.TEST.:' + tlsServer.port);
    expect(ok.status).toBe(200);
    ok.socket.destroy();
    const apex = await connectThroughProxy(p.port, 'upstream.test:' + tlsServer.port);
    expect(apex.status).toBe(403);
    apex.socket.destroy();
  });

  it('blocks loopback by default (real DNS: localhost) even though the name is allowed', async () => {
    const p = await proxy({ allow: ['localhost:' + tlsServer.port] });
    const before = tlsServer.seen.length;
    const r = await connectThroughProxy(p.port, 'localhost:' + tlsServer.port);
    expect(r.status).toBe(403);
    r.socket.destroy();
    const ev = await p.waitForRequest((e) => e.decision === 'deny');
    expect(String(ev.reason)).toContain('blocked address');
    expect(tlsServer.seen.length).toBe(before);
  });

  it('allows loopback with a privateExceptions entry (real DNS: localhost)', async () => {
    const p = await proxy({
      allow: ['localhost:' + tlsServer.port],
      privateExceptions: ['127.0.0.0/8', '::1/128'],
    });
    const [res] = await httpsViaProxy({
      proxyPort: p.port,
      host: 'localhost',
      port: tlsServer.port,
      ca: pki.caPem,
      requests: [{}],
    });
    expect(res?.status).toBe(200);
  });

  it.each([
    ['rebind.test', 'public + private mixed answer'],
    ['private.test', 'RFC1918 answer'],
    ['metadata.test', 'cloud metadata answer'],
    ['mapped.test', 'IPv4-mapped loopback answer'],
  ])('denies %s (%s) - every resolved address is checked', async (host) => {
    const p = await proxy({ allow: [`${host}:${tlsServer.port}`] });
    const before = tlsServer.seen.length;
    const r = await connectThroughProxy(p.port, `${host}:${tlsServer.port}`);
    expect(r.status).toBe(403);
    r.socket.destroy();
    expect(String((await p.waitForRequest((e) => e.decision === 'deny')).reason)).toContain(
      'blocked address',
    );
    expect(tlsServer.seen.length).toBe(before);
  });

  it('falls back to the next checked address when the first one is unreachable', async () => {
    // 192.0.2.1 (TEST-NET-1) is public as far as the policy is concerned and never answers.
    const p = await proxy({
      allow: [`multi.test:${tlsServer.port}`],
      privateExceptions: ['127.0.0.1/32'],
      dnsOverrides: { 'multi.test': ['192.0.2.1', '127.0.0.1'] },
      connectTimeoutMs: 2000,
    });
    const r = await connectThroughProxy(p.port, `multi.test:${tlsServer.port}`);
    expect(r.status).toBe(200);
    r.socket.destroy();
    expect(await p.waitForRequest((e) => e.decision === 'allow')).toMatchObject({
      ip: '127.0.0.1',
    });
  });

  it('denies raw IP literals unless the identical literal is allowlisted', async () => {
    const p = await proxy({
      allow: ['upstream.test:' + tlsServer.port, `127.0.0.1:${tlsServer.port}`],
      privateExceptions: ['127.0.0.1/32'],
    });
    // Not listed literal:
    const denied = await connectThroughProxy(p.port, `127.0.0.2:${tlsServer.port}`);
    expect(denied.status).toBe(403);
    denied.socket.destroy();
    // Listed literal (and excepted from the private block):
    const allowed = await connectThroughProxy(p.port, `127.0.0.1:${tlsServer.port}`);
    expect(allowed.status).toBe(200);
    allowed.socket.destroy();
    // Non-canonical spellings of the listed literal are rejected, not normalised:
    for (const spelling of [
      `127.1:${tlsServer.port}`,
      `0x7f.0.0.1:${tlsServer.port}`,
      `2130706433:${tlsServer.port}`,
      `[::ffff:127.0.0.1]:${tlsServer.port}`,
    ]) {
      const r = await connectThroughProxy(p.port, spelling);
      expect(r.status, spelling).toBeGreaterThanOrEqual(400);
      expect(r.status, spelling).toBeLessThan(500);
      r.socket.destroy();
    }
  });

  it('IP literal that is allowlisted is still subject to blockPrivate', async () => {
    const p = await proxy({
      allow: [`127.0.0.1:${tlsServer.port}`, '169.254.169.254', '[::1]:' + tlsServer.port],
    });
    const before = tlsServer.seen.length;
    for (const target of [
      `127.0.0.1:${tlsServer.port}`,
      '169.254.169.254:80',
      `[::1]:${tlsServer.port}`,
    ]) {
      const r = await connectThroughProxy(p.port, target);
      expect(r.status, target).toBe(403);
      r.socket.destroy();
    }
    expect(tlsServer.seen.length).toBe(before);
  });

  it('blockPrivate:false disables the address check', async () => {
    const p = await proxy({ allow: ['upstream.test:' + tlsServer.port], blockPrivate: false });
    const r = await connectThroughProxy(p.port, 'upstream.test:' + tlsServer.port);
    expect(r.status).toBe(200);
    r.socket.destroy();
  });

  it('rejects malformed CONNECT targets', async () => {
    const p = await proxy({ allow: ['upstream.test'], privateExceptions: ['127.0.0.1/32'] });
    for (const target of [
      'upstream.test',
      'user@upstream.test:443',
      'upstream.test:0',
      'upstream.test:99999',
      'up%73tream.test:443',
      ':443',
      'a'.repeat(300) + '.test:443',
    ]) {
      const r = await connectThroughProxy(p.port, target);
      expect(r.status, target).toBe(400);
      r.socket.destroy();
    }
    expect(p.requests().every((e) => e.decision === 'deny')).toBe(true);
  });

  it('returns 502 and logs when the allowed upstream is unreachable', async () => {
    const closed = await new Promise<number>((resolve) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => {
        const port = (s.address() as net.AddressInfo).port;
        s.close(() => resolve(port));
      });
    });
    const p = await proxy({
      allow: ['upstream.test:' + closed],
      privateExceptions: ['127.0.0.1/32'],
    });
    const r = await connectThroughProxy(p.port, `upstream.test:${closed}`);
    expect(r.status).toBe(502);
    r.socket.destroy();
    const ev = await p.waitForRequest(() => true);
    expect(ev).toMatchObject({ decision: 'allow' });
    expect(String(ev.reason)).toContain('connect failed');
  });

  it('closes idle tunnels', async () => {
    const p = await proxy({
      allow: ['upstream.test:' + tlsServer.port],
      privateExceptions: ['127.0.0.1/32'],
      idleTimeoutMs: 300,
    });
    const r = await connectThroughProxy(p.port, 'upstream.test:' + tlsServer.port);
    expect(r.status).toBe(200);
    const closed = await new Promise<boolean>((resolve) => {
      r.socket.on('close', () => resolve(true));
      setTimeout(() => resolve(false), 3000);
    });
    expect(closed).toBe(true);
  });

  it('enforces maxConnections', async () => {
    const p = await proxy({
      allow: ['upstream.test:' + tlsServer.port],
      privateExceptions: ['127.0.0.1/32'],
      maxConnections: 2,
    });
    const held = await Promise.all(
      [1, 2].map(() => connectThroughProxy(p.port, 'upstream.test:' + tlsServer.port)),
    );
    expect(held.map((h) => h.status)).toEqual([200, 200]);
    const third = net.connect(p.port, '127.0.0.1');
    third.on('error', () => {});
    const dropped = await new Promise<boolean>((resolve) => {
      third.on('close', () => resolve(true));
      setTimeout(() => resolve(false), 3000);
    });
    expect(dropped).toBe(true);
    held.forEach((h) => h.socket.destroy());
  });
});

describe('request validation', () => {
  it('rejects non-proxy and unsupported requests', async () => {
    const p = await proxy({ allow: ['upstream.test'], privateExceptions: ['127.0.0.1/32'] });
    const cases: [string, number][] = [
      ['GET / HTTP/1.1\r\nHost: x\r\n\r\n', 400],
      ['GET https://upstream.test/ HTTP/1.1\r\nHost: upstream.test\r\n\r\n', 400],
      ['GET ftp://upstream.test/ HTTP/1.1\r\nHost: upstream.test\r\n\r\n', 400],
      ['GET http://user:pw@upstream.test/ HTTP/1.1\r\nHost: upstream.test\r\n\r\n', 400],
      ['TRACE http://upstream.test/ HTTP/1.1\r\nHost: upstream.test\r\n\r\n', 405],
      ['GARBAGE\r\n\r\n', 400],
    ];
    for (const [payload, status] of cases) {
      const r = await rawRequest(p.port, payload);
      expect(r.status, payload).toBe(status);
    }
  });
});

describe('plain http forwarding', () => {
  it('forwards absolute-form requests, strips hop-by-hop and proxy credentials', async () => {
    const p = await proxy({
      allow: [`upstream.test:${httpServer.port}`],
      privateExceptions: ['127.0.0.1/32'],
    });
    const res = await httpViaProxy({
      proxyPort: p.port,
      url: `http://Upstream.TEST:${httpServer.port}/some/path?x=1`,
      method: 'POST',
      body: 'payload',
      headers: {
        'Proxy-Authorization': 'Basic c2VjcmV0',
        'Proxy-Connection': 'keep-alive',
        Connection: 'X-Custom-Hop',
        'X-Custom-Hop': 'drop-me',
        'X-Keep': 'keep-me',
        Host: 'evil.example',
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers['x-upstream']).toBe('yes');
    const seen = httpServer.seen.at(-1)!;
    expect(seen.method).toBe('POST');
    expect(seen.url).toBe('/some/path?x=1');
    expect(seen.body).toBe('payload');
    expect(seen.headers['x-keep']).toBe('keep-me');
    expect(seen.headers['proxy-authorization']).toBeUndefined();
    expect(seen.headers['proxy-connection']).toBeUndefined();
    expect(seen.headers['x-custom-hop']).toBeUndefined();
    expect(seen.headers.host).toBe(`upstream.test:${httpServer.port}`);
    expect(await p.waitForRequest((e) => e.decision === 'allow')).toMatchObject({
      method: 'POST',
      host: 'upstream.test',
      port: httpServer.port,
      ip: '127.0.0.1',
    });
  });

  it('forwards chunked request bodies and keeps multi-value response headers', async () => {
    const server = await startHttpServer((_req, res, body) => {
      res.writeHead(200, [
        ['Set-Cookie', 'a=1'],
        ['Set-Cookie', 'b=2'],
        ['Content-Type', 'text/plain'],
      ]);
      res.end(`len=${body.length}`);
    });
    try {
      const p = await proxy({
        allow: [`upstream.test:${server.port}`],
        privateExceptions: ['127.0.0.1/32'],
      });
      const res = await httpViaProxy({
        proxyPort: p.port,
        url: `http://upstream.test:${server.port}/`,
        method: 'PUT',
        body: 'x'.repeat(100_000),
        headers: { 'Transfer-Encoding': 'chunked' },
      });
      expect(res.body).toBe('len=100000');
      expect(res.headers['set-cookie']).toEqual(['a=1', 'b=2']);
    } finally {
      await server.close();
    }
  });

  it('denies hosts outside the allowlist and private destinations', async () => {
    const p = await proxy({
      allow: [
        `upstream.test:${httpServer.port}`,
        `private.test:${httpServer.port}`,
        `127.0.0.1:${httpServer.port}`,
      ],
    });
    const before = httpServer.seen.length;
    expect(
      (await httpViaProxy({ proxyPort: p.port, url: `http://other.test:${httpServer.port}/` }))
        .status,
    ).toBe(403);
    expect(
      (await httpViaProxy({ proxyPort: p.port, url: `http://private.test:${httpServer.port}/` }))
        .status,
    ).toBe(403);
    expect(
      (await httpViaProxy({ proxyPort: p.port, url: `http://127.0.0.1:${httpServer.port}/` }))
        .status,
    ).toBe(403);
    expect(
      (await httpViaProxy({ proxyPort: p.port, url: `http://upstream.test:${httpServer.port}/` }))
        .status,
    ).toBe(403); // loopback, no exception
    expect(httpServer.seen.length).toBe(before);
    expect(p.requests().every((e) => e.decision === 'deny')).toBe(true);
  });

  it('returns 502 when the origin is down', async () => {
    const closed = await new Promise<number>((resolve) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => {
        const port = (s.address() as net.AddressInfo).port;
        s.close(() => resolve(port));
      });
    });
    const p = await proxy({
      allow: [`upstream.test:${closed}`],
      privateExceptions: ['127.0.0.1/32'],
    });
    expect(
      (await httpViaProxy({ proxyPort: p.port, url: `http://upstream.test:${closed}/` })).status,
    ).toBe(502);
  });
});

describe('secret injection (MITM)', () => {
  const injection = { host: 'upstream.test', header: 'Authorization', value: SECRET };

  async function injecting(extra: Record<string, unknown> = {}) {
    return proxy({
      allow: ['upstream.test:' + tlsServer.port, 'other.test:' + tlsServer.port],
      privateExceptions: ['127.0.0.1/32'],
      injections: [injection],
      ...extra,
    });
  }

  it('writes only ca.crt, restricted by name constraints; the CA key is gone', async () => {
    const p = await injecting();
    expect(readdirSync(p.stateDir)).toEqual(['ca.crt']);
    const text = execFileSync(
      'openssl',
      ['x509', '-in', join(p.stateDir, 'ca.crt'), '-noout', '-text'],
      { encoding: 'utf8' },
    );
    expect(text).toContain('CA:TRUE');
    expect(text).toContain('X509v3 Name Constraints: critical');
    expect(text).toContain('DNS:upstream.test');
    expect(text).not.toContain('DNS:other.test');
  });

  it('does not write ca.crt when there are no injections', async () => {
    const p = await proxy({ allow: ['upstream.test'] });
    expect(existsSync(join(p.stateDir, 'ca.crt'))).toBe(false);
  });

  it('adds the header the client never sent, overrides a client-supplied one and pins Host', async () => {
    const p = await injecting();
    const ca = readFileSync(join(p.stateDir, 'ca.crt'), 'utf8');
    const target = { proxyPort: p.port, host: 'upstream.test', port: tlsServer.port, ca };
    const before = tlsServer.seen.length;
    // Two requests over one tunnel (keep-alive)...
    const results = await httpsViaProxy({
      ...target,
      requests: [
        { path: '/plain' },
        { path: '/override', headers: { Authorization: 'Bearer attacker-chosen' } },
      ],
    });
    // ...and one that lies about the Host header (own tunnel: Node's client cannot
    // reuse a keep-alive socket after a Host mismatch).
    const fronted = await httpsViaProxy({
      ...target,
      requests: [
        {
          path: '/fronted',
          headers: { Host: 'evil.example', authorization: 'Bearer attacker-chosen' },
        },
      ],
    });
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(fronted[0]?.status).toBe(200);
    const [a, b, c] = tlsServer.seen.slice(before);
    expect(a?.headers.authorization).toBe(SECRET);
    expect(b?.headers.authorization).toBe(SECRET);
    expect(b?.rawHeaders.filter((h) => h.toLowerCase() === 'authorization')).toHaveLength(1);
    expect(c?.headers.authorization).toBe(SECRET);
    expect(c?.headers.host).toBe(`upstream.test:${tlsServer.port}`);
    expect(c?.url).toBe('/fronted');
  });

  it('streams request bodies (content-length and chunked) and large responses', async () => {
    const big = 'z'.repeat(2_000_000);
    const server = await startHttpsServer(pki, (req, res, body) => {
      if (req.url === '/big') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(big);
      } else {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(
          `${req.headers['transfer-encoding'] ?? 'cl'}:${body.length}:${req.headers.authorization === SECRET}`,
        );
      }
    });
    try {
      const p = await proxy({
        allow: ['upstream.test:' + server.port],
        privateExceptions: ['127.0.0.1/32'],
        injections: [injection],
      });
      const ca = readFileSync(join(p.stateDir, 'ca.crt'), 'utf8');
      const r = await httpsViaProxy({
        proxyPort: p.port,
        host: 'upstream.test',
        port: server.port,
        ca,
        requests: [
          {
            method: 'POST',
            path: '/cl',
            body: 'a'.repeat(5000),
            headers: { 'Content-Length': '5000' },
          },
          { method: 'POST', path: '/chunked', body: 'b'.repeat(7000), chunked: true },
          {
            method: 'DELETE',
            path: '/chunked-delete',
            body: 'c'.repeat(100),
            chunked: true,
            headers: { 'Transfer-Encoding': 'chunked' },
          },
          { path: '/big' },
        ],
      });
      expect(r[0]?.body).toBe('cl:5000:true');
      expect(r[1]?.body).toBe('chunked:7000:true');
      expect(r[2]?.body).toBe('chunked:100:true');
      expect(r[3]?.body.length).toBe(big.length);
    } finally {
      await server.close();
    }
  });

  it('never logs the injected value, and flags injected requests', async () => {
    const p = await injecting();
    const ca = readFileSync(join(p.stateDir, 'ca.crt'), 'utf8');
    await httpsViaProxy({
      proxyPort: p.port,
      host: 'upstream.test',
      port: tlsServer.port,
      ca,
      requests: [
        { path: '/secret-path?token=querysecret', headers: { Authorization: 'Bearer client-own' } },
      ],
    });
    await p.stop();
    const out = p.stdout();
    expect(out).not.toContain('s3cr3t');
    expect(out).not.toContain('DO-NOT-LEAK');
    expect(out).not.toContain('client-own');
    expect(out).not.toContain('querysecret');
    const reqs = p.requests();
    expect(reqs.find((e) => e.method === 'GET')).toMatchObject({
      host: 'upstream.test',
      decision: 'allow',
      mitm: true,
      injected: true,
    });
  });

  it('only injects for configured hosts: other allowed hosts are tunnelled untouched', async () => {
    const p = await injecting();
    const [res] = await httpsViaProxy({
      proxyPort: p.port,
      host: 'other.test',
      port: tlsServer.port,
      ca: pki.caPem,
      requests: [{ headers: { Authorization: 'Bearer mine' } }],
    });
    expect(res?.status).toBe(200); // verified against the ORIGIN CA: not intercepted
    expect(tlsServer.seen.at(-1)?.headers.authorization).toBe('Bearer mine');
  });

  it('a client that does not trust the abox CA fails the handshake and nothing reaches upstream', async () => {
    const p = await injecting();
    const before = tlsServer.seen.length;
    await expect(
      httpsViaProxy({
        proxyPort: p.port,
        host: 'upstream.test',
        port: tlsServer.port,
        ca: pki.caPem,
        requests: [{}],
      }),
    ).rejects.toThrow();
    expect(tlsServer.seen.length).toBe(before);
  });

  it('verifies the upstream certificate: untrusted origin yields 502 and no request/secret is sent', async () => {
    const p = await proxy({
      allow: ['bad.test:' + badTlsServer.port],
      privateExceptions: ['127.0.0.1/32'],
      injections: [{ host: 'bad.test', header: 'Authorization', value: SECRET }],
    });
    const ca = readFileSync(join(p.stateDir, 'ca.crt'), 'utf8');
    const [res] = await httpsViaProxy({
      proxyPort: p.port,
      host: 'bad.test',
      port: badTlsServer.port,
      ca,
      requests: [{}],
    });
    expect(res?.status).toBe(502);
    expect(badTlsServer.seen.length).toBe(0);
    expect(p.stdout()).not.toContain('s3cr3t');
  });

  it('verifies the upstream hostname (certificate for another name is rejected)', async () => {
    // other.test is in the cert but a server presenting a cert for bad.test only is
    // contacted under the name upstream.test.
    const p = await proxy({
      allow: ['upstream.test:' + badTlsServer.port],
      privateExceptions: ['127.0.0.1/32'],
      upstreamCaFile: otherPki.caFile, // trusted CA, wrong name
      injections: [injection],
    });
    const ca = readFileSync(join(p.stateDir, 'ca.crt'), 'utf8');
    const [res] = await httpsViaProxy({
      proxyPort: p.port,
      host: 'upstream.test',
      port: badTlsServer.port,
      ca,
      requests: [{}],
    });
    expect(res?.status).toBe(502);
    expect(badTlsServer.seen.length).toBe(0);
  });

  it('refuses plain http:// to an injection host', async () => {
    const p = await proxy({
      allow: [`upstream.test:${httpServer.port}`],
      privateExceptions: ['127.0.0.1/32'],
      injections: [injection],
    });
    const before = httpServer.seen.length;
    const res = await httpViaProxy({
      proxyPort: p.port,
      url: `http://upstream.test:${httpServer.port}/`,
    });
    expect(res.status).toBe(403);
    expect(httpServer.seen.length).toBe(before);
  });

  it('injection does not widen the allowlist', async () => {
    const p = await proxy({
      allow: [],
      privateExceptions: ['127.0.0.1/32'],
      injections: [injection],
    });
    const r = await connectThroughProxy(p.port, 'upstream.test:' + tlsServer.port);
    expect(r.status).toBe(403);
    r.socket.destroy();
    expect(p.events().some((e) => e.event === 'warn')).toBe(true);
  });

  it('rejects early data on an injection CONNECT', async () => {
    const p = await injecting();
    const r = await rawRequest(
      p.port,
      `CONNECT upstream.test:${tlsServer.port} HTTP/1.1\r\nHost: x\r\n\r\nEARLY`,
      true,
    );
    expect(r.status).toBe(400);
    r.socket.destroy();
  });

  it('re-checks the destination for each upstream connection (blocked address -> 403)', async () => {
    // DNS answer is private for this injection host: the CONNECT itself is already denied.
    const p = await proxy({
      allow: ['private.test:' + tlsServer.port],
      injections: [{ host: 'private.test', header: 'Authorization', value: SECRET }],
    });
    const r = await connectThroughProxy(p.port, 'private.test:' + tlsServer.port);
    expect(r.status).toBe(403);
    r.socket.destroy();
  });
});

describe('lifecycle', () => {
  it('shuts down gracefully on SIGTERM', async () => {
    const p = await proxy({ allow: [] });
    const code = await p.stop();
    expect(code).toBe(0);
    expect(p.events().some((e) => e.event === 'shutdown')).toBe(true);
  });
});
