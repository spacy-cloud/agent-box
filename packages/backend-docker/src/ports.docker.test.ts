import { existsSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { connect, createServer, type Server } from 'node:net';
import { networkInterfaces } from 'node:os';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Docker from 'dockerode';
import type { PreparedImage, ResolvedTemplate, SandboxSpec } from '@abox/core';
import { makeSpec, makeTemplate } from './__tests__/helpers.js';
import {
  TEST_RUN,
  TEST_SOCKET,
  dockerEnabled,
  newProvider,
  sweepTestObjects,
} from './__tests__/harness.js';
import { defaultProxyAssets } from './proxy.js';

const raw = new Docker({ socketPath: TEST_SOCKET });
const proxyAvailable =
  defaultProxyAssets !== undefined && existsSync(`${defaultProxyAssets.runtimeDir}/proxy.mjs`);

/** GET `/` on 127.0.0.1:port with the given Host header; resolves status and body. */
function get(
  port: number,
  path = '/',
  headers: Record<string, string> = {},
  address = '127.0.0.1',
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: address, port, path, headers, timeout: 8000, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

/** Can a TCP connection to `host:port` be opened? */
function canConnect(host: string, port: number, timeoutMs = 2500): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host, port });
    const done = (ok: boolean): void => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

/** Local addresses (hex, as in /proc/net/tcp*) of every listening socket on `port`. */
function listeners(port: number): string[] {
  const hex = port.toString(16).toUpperCase().padStart(4, '0');
  const out: string[] = [];
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text: string;
    try {
      text = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 4 || cols[3] !== '0A') continue; // LISTEN
      const [addr, p] = (cols[1] ?? '').split(':');
      if (p === hex) out.push(`${f.endsWith('6') ? '6' : '4'}:${addr}`);
    }
  }
  return out;
}

const lanAddress = Object.values(networkInterfaces())
  .flat()
  .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;

describe.skipIf(!dockerEnabled || !proxyAvailable)('port forwards (real docker)', () => {
  const provider = newProvider();
  let template: ResolvedTemplate;
  let image: PreparedImage;
  const ids: string[] = [];
  const blockers: Server[] = [];

  const create = async (
    mode: 'none' | 'allowlist' | 'open',
    start = true,
  ): Promise<SandboxSpec> => {
    const s = makeSpec(template, image.ref, {
      network: { mode, allow: [], blockPrivate: true, privateExceptions: [], injections: [] },
    });
    ids.push(s.id);
    await provider.create(s);
    if (start) await provider.start(s.id);
    return s;
  };

  /** A tiny HTTP server in the sandbox, in the background; waits until it answers inside. */
  const serve = async (s: SandboxSpec, port: number, bind = '0.0.0.0'): Promise<void> => {
    const js = `require('http').createServer((q,r)=>r.end('hello from ${s.id}\\n')).listen(${port},'${bind}')`;
    const r = await provider.exec(s.id, {
      command: `nohup node -e "${js}" >/dev/null 2>&1 &`,
      timeoutMs: 20_000,
    });
    expect(r.exitCode, r.stderr).toBe(0);
    for (let i = 0; i < 50; i++) {
      const p = await provider.exec(s.id, {
        // the proxy variables are set in the sandbox: do not send this request through the proxy
        command: `env -u http_proxy -u HTTP_PROXY wget -q -T 2 -O- http://127.0.0.1:${port}/`,
      });
      if (p.exitCode === 0) return;
      await new Promise((res) => setTimeout(res, 200));
    }
    throw new Error('the test server did not start');
  };

  const add = (s: SandboxSpec, sandboxPort: number, hostPort?: number) =>
    provider.addPortForward!(s.id, {
      sandboxPort,
      ...(hostPort !== undefined ? { hostPort } : {}),
      expiresAt: s.expiresAt,
    });

  beforeAll(async () => {
    await provider.init();
    template = makeTemplate({
      name: `abox-test-ports-${TEST_RUN}`,
      base: { os: 'node:24-alpine', osFamily: 'alpine' },
      build: [],
    });
    image = await provider.prepare(template);
  }, 300_000);

  afterAll(async () => {
    for (const b of blockers) b.close();
    for (const id of ids) await provider.remove(id).catch(() => undefined);
    await sweepTestObjects();
  }, 120_000);

  it('claims port forwards for allowlist and open only', () => {
    expect(provider.capabilities().portForward).toEqual(['allowlist', 'open']);
  });

  it('allowlist: the dev server answers on 127.0.0.1 only, and the sandbox gets no new way out', async () => {
    const s = await create('allowlist');
    await serve(s, 8000);
    const short = s.id.split('/')[1];
    const fwd = await add(s, 8000);
    expect(fwd).toMatchObject({
      sandboxPort: 8000,
      hostAddress: '127.0.0.1',
      target: 'up',
      url: `http://127.0.0.1:${fwd.hostPort}/`,
    });
    expect(fwd.hostPort).toBeGreaterThanOrEqual(1024);

    // reachable from the host browser's point of view
    const ok = await get(fwd.hostPort);
    expect(ok).toEqual({ status: 200, body: `hello from ${s.id}\n` });
    expect(await canConnect('127.0.0.1', fwd.hostPort)).toBe(true);

    // ... and bound to the loopback only: no socket on 0.0.0.0 / :: / the LAN address
    const sockets = listeners(fwd.hostPort);
    expect(sockets.length).toBeGreaterThan(0);
    expect(sockets.every((a) => a === '4:0100007F')).toBe(true);
    if (lanAddress) expect(await canConnect(lanAddress, fwd.hostPort)).toBe(false);
    const fc = await raw.getContainer(`abox-fwd-${short}-8000`).inspect();
    expect(fc.HostConfig.PortBindings).toEqual({
      '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }],
    });
    expect(fc.HostConfig.Privileged).toBe(false);
    expect(fc.HostConfig.CapDrop).toEqual(['ALL']);
    expect(fc.HostConfig.ReadonlyRootfs).toBe(true);

    // a web page on another origin (DNS rebinding) is refused, the loopback names are not
    expect((await get(fwd.hostPort, '/', { Host: 'evil.example.com' })).status).toBe(403);
    expect((await get(fwd.hostPort, '/', { Host: `localhost:${fwd.hostPort}` })).status).toBe(200);
    expect((await get(fwd.hostPort, '/', { Host: `app.localhost:${fwd.hostPort}` })).status).toBe(
      200,
    );

    // no new egress: the sandbox is still on its internal network only ...
    const sb = await raw.getContainer(`abox-local-${short}`).inspect();
    expect(Object.keys(sb.NetworkSettings.Networks)).toEqual([`abox-int-${short}`]);
    // ... cannot reach the internet directly ...
    const direct = await provider.exec(s.id, {
      command: 'nc -w 3 -z 1.1.1.1 80; echo exit=$?',
      timeoutMs: 15_000,
    });
    expect(direct.stdout).not.toContain('exit=0');
    // ... only through the proxy, which still denies what is not allowed ...
    const proxied = await provider.exec(s.id, {
      command: 'wget -q -T 6 -O- http://example.com/ ; echo exit=$?',
      timeoutMs: 20_000,
    });
    expect(proxied.stdout).not.toContain('exit=0');
    // ... and cannot reach the forwarder on the network that publishes the port
    const egressIp = fc.NetworkSettings.Networks['abox-egress']?.IPAddress;
    expect(egressIp).toBeTruthy();
    const toFwd = await provider.exec(s.id, {
      command: `nc -w 3 -z ${egressIp} 8080; echo exit=$?`,
      timeoutMs: 15_000,
    });
    expect(toFwd.stdout).not.toContain('exit=0');

    // listed with its counts, and closing it really closes the port
    const [listed] = await provider.listPortForwards!(s.id);
    expect(listed).toMatchObject({ sandboxPort: 8000, hostPort: fwd.hostPort, target: 'up' });
    const gone = await provider.removePortForward!(s.id, 8000);
    expect(gone).toMatchObject({ sandboxPort: 8000, hostPort: fwd.hostPort });
    expect(gone!.connections).toBeGreaterThanOrEqual(3);
    expect(gone!.rejected).toBe(1);
    expect(await provider.listPortForwards!(s.id)).toEqual([]);
    expect(await canConnect('127.0.0.1', fwd.hostPort)).toBe(false);
    expect(await provider.removePortForward!(s.id, 8000)).toBeUndefined();
  }, 240_000);

  it('a fixed host port is honoured, a taken one is a conflict, privileged ones are refused', async () => {
    const s = await create('allowlist');
    await serve(s, 8000);
    const blocker = createServer().listen(0, '127.0.0.1');
    blockers.push(blocker);
    await new Promise((r) => blocker.once('listening', r));
    const taken = (blocker.address() as { port: number }).port;

    await expect(add(s, 8000, taken)).rejects.toMatchObject({ code: 'conflict' });
    expect(await provider.listPortForwards!(s.id)).toEqual([]);
    await expect(add(s, 8000, 80)).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(add(s, 0)).rejects.toMatchObject({ code: 'invalid_input' });

    // a free port picked by the test, then asked for
    const probe = createServer().listen(0, '127.0.0.1');
    await new Promise((r) => probe.once('listening', r));
    const free = (probe.address() as { port: number }).port;
    await new Promise((r) => probe.close(r));
    const fwd = await add(s, 8000, free);
    expect(fwd.hostPort).toBe(free);
    expect((await get(free)).status).toBe(200);
    await expect(add(s, 8000)).rejects.toMatchObject({ code: 'conflict' });
    await provider.removePortForward!(s.id, 8000);
  }, 240_000);

  it('a server that listens on 127.0.0.1 only is reported as down, with a hint to the visitor', async () => {
    const s = await create('allowlist');
    await serve(s, 8001, '127.0.0.1');
    const fwd = await add(s, 8001);
    expect(fwd.target).toBe('down');
    const res = await get(fwd.hostPort);
    expect(res.status).toBe(502);
    expect(res.body).toContain('0.0.0.0');
    // the forwarder reports its totals a moment after the connection
    await vi.waitFor(async () => {
      const [listed] = await provider.listPortForwards!(s.id);
      expect(listed!.failed).toBeGreaterThanOrEqual(1);
      expect(listed!.target).toBe('down');
    });
  }, 240_000);

  it('stop closes the forwards, start brings back a sandbox that can be forwarded again', async () => {
    const s = await create('allowlist');
    await serve(s, 8000);
    const fwd = await add(s, 8000);
    expect((await get(fwd.hostPort)).status).toBe(200);
    await provider.stop(s.id);
    expect(await canConnect('127.0.0.1', fwd.hostPort)).toBe(false);
    expect(await provider.listPortForwards!(s.id)).toEqual([]);
    await expect(add(s, 8000)).rejects.toMatchObject({ code: 'conflict' }); // not running
    await provider.start(s.id);
    await serve(s, 8000);
    const again = await add(s, 8000);
    expect((await get(again.hostPort)).status).toBe(200);
  }, 240_000);

  it('remove takes the forwarders and the networks with it', async () => {
    const s = await create('allowlist');
    await serve(s, 8000);
    const short = s.id.split('/')[1];
    await add(s, 8000);
    await provider.remove(s.id);
    ids.splice(ids.indexOf(s.id), 1);
    const left = await raw.listContainers({
      all: true,
      filters: { label: [`abox.id=${s.id}`] },
    });
    expect(left).toEqual([]);
    await expect(raw.getNetwork(`abox-int-${short}`).inspect()).rejects.toMatchObject({
      statusCode: 404,
    });
  }, 240_000);

  it('none: refused, the sandbox has no interface to reach', async () => {
    const s = await create('none');
    await expect(add(s, 8000)).rejects.toMatchObject({
      code: 'unsupported',
      hint: expect.stringContaining('allowlist'),
    });
    expect(await provider.listPortForwards!(s.id)).toEqual([]);
  }, 120_000);

  it('open: the forward works over the shared open network', async () => {
    const s = await create('open');
    await serve(s, 8000);
    const fwd = await add(s, 8000);
    expect((await get(fwd.hostPort)).body).toBe(`hello from ${s.id}\n`);
    expect(listeners(fwd.hostPort).every((a) => a === '4:0100007F')).toBe(true);
    await provider.removePortForward!(s.id, 8000);
  }, 240_000);

  it('the forwarder ends itself at the deadline it was given, and a later one moves it', async () => {
    const s = await create('allowlist');
    await serve(s, 8000);
    const soon = await provider.addPortForward!(s.id, {
      sandboxPort: 8000,
      expiresAt: Date.now() + 5000,
    });
    expect((await get(soon.hostPort)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 9000));
    expect(await provider.listPortForwards!(s.id)).toEqual([]);
    expect(await canConnect('127.0.0.1', soon.hostPort)).toBe(false);

    // extendExpiry hands the forwarders the sandbox's new deadline
    const second = await provider.addPortForward!(s.id, {
      sandboxPort: 8000,
      expiresAt: Date.now() + 6000,
    });
    await provider.extendExpiry!(s.id, s.expiresAt + 3_600_000);
    await new Promise((r) => setTimeout(r, 9000));
    expect((await get(second.hostPort)).status).toBe(200);
  }, 240_000);
});
