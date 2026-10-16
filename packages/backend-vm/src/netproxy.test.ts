import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer, connect, type AddressInfo, type Server } from 'node:net';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isProxyAlive,
  proxyPaths,
  readNetworkEvents,
  relayArgv,
  startProxy,
  stopProxy,
  toProxyConfig,
} from './netproxy.js';
import { sleep } from './guest.js';

let dir: string;
let upstream: Server | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'abox-np-'));
});
afterEach(async () => {
  await stopProxy(dir);
  await new Promise<void>((r) => (upstream ? upstream.close(() => r()) : r()));
  upstream = undefined;
  await rm(dir, { recursive: true, force: true });
});

/** Sends one request line over the proxy's unix socket and returns what comes back. */
function viaProxy(socket: string, request: string, waitMs = 400): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = connect(socket);
    let out = '';
    s.on('data', (d) => (out += d.toString()));
    s.on('error', reject);
    s.on('connect', () => s.write(request));
    setTimeout(() => {
      s.destroy();
      resolve(out);
    }, waitMs);
  });
}

function hasSocat(): boolean {
  return (process.env['PATH'] ?? '')
    .split(':')
    .some((d) => d !== '' && existsSync(join(d, 'socat')));
}

describe('egress proxy on a unix socket', () => {
  it('converts a net file into the proxy config', () => {
    const cfg = toProxyConfig(
      {
        allow: ['a.example'],
        blockPrivate: true,
        privateExceptions: ['10.1.0.0/16'],
        injections: [],
      },
      '/s',
    );
    expect(cfg).toEqual({
      listen: { host: '127.0.0.1', port: 0 },
      allow: ['a.example'],
      blockPrivate: true,
      privateExceptions: ['10.1.0.0/16'],
      injections: [],
      stateDir: '/s',
    });
  });

  it('starts private (0600 socket and config), enforces the allowlist, logs decisions and stops cleanly', async () => {
    upstream = createServer((s) => {
      s.on('data', (d) => s.write(`echo:${d.toString()}`));
    });
    await new Promise<void>((r) => upstream?.listen(0, '127.0.0.1', () => r()));
    const port = (upstream?.address() as AddressInfo).port;
    const h = await startProxy(dir, {
      allow: [`127.0.0.1:${port}`],
      blockPrivate: true,
      privateExceptions: ['127.0.0.0/8'],
      injections: [],
    });
    const p = proxyPaths(dir);
    expect(h.socketPath).toBe(p.socket);
    expect(await isProxyAlive(dir)).toBe(true);
    expect((await stat(p.socket)).mode & 0o077).toBe(0); // only the owner can connect
    expect((await stat(p.config)).mode & 0o077).toBe(0); // the config may contain secrets
    // no TCP listener was opened by the proxy process
    const ok = await viaProxy(
      p.socket,
      `CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`,
    );
    expect(ok).toMatch(/^HTTP\/1\.1 200/);
    const denied = await viaProxy(
      p.socket,
      'CONNECT evil.example:443 HTTP/1.1\r\nHost: evil.example:443\r\n\r\n',
    );
    expect(denied).toMatch(/^HTTP\/1\.1 403/);
    const events = await readNetworkEvents(h.logPath);
    expect(events.some((e) => e.host === '127.0.0.1' && e.decision === 'allow')).toBe(true);
    expect(
      events.some(
        (e) =>
          e.host === 'evil.example' && e.decision === 'deny' && e.reason === 'not in allowlist',
      ),
    ).toBe(true);
    expect(await readNetworkEvents(h.logPath, Date.now() + 60_000)).toEqual([]);
    const pid = Number((await readFile(p.pid, 'utf8')).trim());
    await stopProxy(dir);
    expect(await isProxyAlive(dir)).toBe(false);
    await expect(stat(p.socket)).rejects.toMatchObject({ code: 'ENOENT' });
    await sleep(100);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('blocks private addresses even for allowlisted names (no exception configured)', async () => {
    const h = await startProxy(dir, {
      allow: ['127.0.0.1:9'],
      blockPrivate: true,
      privateExceptions: [],
      injections: [],
    });
    const r = await viaProxy(
      h.socketPath,
      'CONNECT 127.0.0.1:9 HTTP/1.1\r\nHost: 127.0.0.1:9\r\n\r\n',
    );
    expect(r).toMatch(/^HTTP\/1\.1 403/);
  });

  it('restarting replaces the old process and keeps the socket path', async () => {
    const net = {
      allow: ['example.com'],
      blockPrivate: true,
      privateExceptions: [],
      injections: [],
    };
    const a = await startProxy(dir, net);
    const pid1 = Number((await readFile(proxyPaths(dir).pid, 'utf8')).trim());
    const b = await startProxy(dir, { ...net, allow: ['example.org'] });
    const pid2 = Number((await readFile(proxyPaths(dir).pid, 'utf8')).trim());
    expect(b.socketPath).toBe(a.socketPath);
    expect(pid2).not.toBe(pid1);
    await sleep(100);
    expect(() => process.kill(pid1, 0)).toThrow();
    const r = await viaProxy(
      b.socketPath,
      'CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n',
      300,
    );
    expect(r).toMatch(/^HTTP\/1\.1 403/); // example.com is no longer allowed
  });

  it('with injections it writes the per-instance CA', async () => {
    const h = await startProxy(dir, {
      allow: ['example.com'],
      blockPrivate: true,
      privateExceptions: [],
      injections: [{ host: 'example.com', header: 'Authorization', value: 'Bearer s3cret' }],
    });
    expect(h.caCertPath).toBeDefined();
    expect(await readFile(h.caCertPath as string, 'utf8')).toContain('BEGIN CERTIFICATE');
    expect(await readFile(proxyPaths(dir).log, 'utf8')).not.toContain('s3cret');
  });

  it('relayArgv prefers socat; without it the Node relay forwards a connection to the socket', async () => {
    const argv = await relayArgv(dir);
    // socat is optional on the host (e.g. not installed on CI runners): then the Node relay is used.
    if (hasSocat()) expect(argv.at(-1)).toBe(`UNIX-CONNECT:${proxyPaths(dir).socket}`);
    else expect(argv[1]).toBe(proxyPaths(dir).relay);
    upstream = createServer((s) => s.on('data', (d) => s.end(`got:${d.toString()}`)));
    const sockPath = join(dir, 'u.sock');
    await new Promise<void>((r) => upstream?.listen(sockPath, () => r()));
    const origPath = process.env['PATH'];
    process.env['PATH'] = '/nonexistent';
    let fallback: string[];
    try {
      fallback = await relayArgv(dir);
    } finally {
      process.env['PATH'] = origPath;
    }
    expect(fallback[0]).toBe(process.execPath);
    expect(fallback[1]).toBe(proxyPaths(dir).relay);
    const child = spawn(process.execPath, [fallback[1] as string, sockPath]);
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stdin.write('ping');
    await new Promise((r) => child.on('close', r));
    expect(out).toBe('got:ping');
  });
});
