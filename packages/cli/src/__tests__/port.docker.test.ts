import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeEnv, runBin, sleep, type TestEnv } from './harness.js';

/**
 * `abox port` through the real CLI binary against a real Docker engine (ABOX_TEST_DOCKER=1):
 * add (auto and fixed host port), ls, inspect, rm and stop. Everything lives below a private
 * ABOX_HOME; only the sandboxes and the image this test created are removed again.
 */
const DOCKER = process.env['ABOX_TEST_DOCKER'] === '1';
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

const TEMPLATE = `apiVersion: 1
name: cli-port
description: Debian (node image) used by the abox CLI port tests only.
backend: docker
isolation: container
base: { os: 'node:24-bookworm' }
workspace: { mode: empty, path: /workspace, access: rw }
resources: { cpus: 1, memory: 512m, pids: 256, ttl: 30m }
network: { mode: none }
`;

function get(
  port: number,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path: '/', headers, agent: false, timeout: 8000 },
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
}

describe.runIf(DOCKER)('abox port against Docker', () => {
  let t: TestEnv;
  const created: string[] = [];

  beforeAll(async () => {
    execFileSync('npx', ['tsc', '-b', 'packages/cli'], { cwd: root, stdio: 'pipe' });
    t = makeEnv();
    const dir = join(t.aboxHome, 'config', 'templates');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'cli-port.yaml'), TEMPLATE);
    const b = await runBin(t, ['template', 'build', 'cli-port', '--json'], { timeoutMs: 600_000 });
    expect(b.code, b.stderr).toBe(0);
  }, 700_000);

  afterAll(async () => {
    for (const id of created) await runBin(t, ['rm', '--force', id]).catch(() => undefined);
    const ids = spawnSync('docker', ['images', '-q', 'abox/cli-port'], { encoding: 'utf8' })
      .stdout.split('\n')
      .filter(Boolean);
    if (ids.length) spawnSync('docker', ['rmi', '-f', ...ids]);
    t.cleanup();
  }, 120_000);

  it('add prints the URL, the browser gets the page, ls and inspect list it, rm closes it', async () => {
    const c = await runBin(
      t,
      ['create', 'cli-port', '--net', 'allowlist', '--name', 'previewer', '--json'],
      {
        timeoutMs: 300_000,
      },
    );
    expect(c.code, c.stderr).toBe(0);
    const id = c.json.data.sandbox.id as string;
    created.push(id);
    const js = `require('http').createServer((q,r)=>r.end('cli preview\\\\n')).listen(8000,'0.0.0.0')`;
    const start = await runBin(t, [
      'exec',
      id,
      '--',
      'sh',
      '-c',
      `nohup node -e "${js}" >/dev/null 2>&1 &`,
    ]);
    expect(start.code, start.stderr).toBe(0);
    await sleep(1500);

    const add = await runBin(t, ['port', 'add', 'previewer', '8000']);
    expect(add.code, add.stderr).toBe(0);
    const url = /(http:\/\/127\.0\.0\.1:(\d+)\/)/.exec(add.stdout);
    expect(url, add.stdout).not.toBeNull();
    expect(add.stdout).toContain(`forwarded ${id} port 8000 ->`);
    expect(add.stdout).toContain('closes when the sandbox stops');
    const hostPort = Number(url![2]);
    expect(await get(hostPort)).toEqual({ status: 200, body: 'cli preview\n' });

    const ls = await runBin(t, ['port', 'ls', id]);
    expect(ls.stdout).toMatch(/SANDBOX PORT\s+URL\s+STATE\s+CONNECTIONS/);
    expect(ls.stdout).toContain(url![1]);
    const lsq = await runBin(t, ['--quiet', 'port', 'ls', id]);
    expect(lsq.stdout.trim()).toBe(`8000 ${url![1]}`);
    const ins = await runBin(t, ['inspect', id, '--json']);
    expect(ins.json.data.ports).toMatchObject([
      { sandboxPort: 8000, hostPort, hostAddress: '127.0.0.1' },
    ]);
    expect((await runBin(t, ['inspect', id])).stdout).toContain(`8000 -> ${url![1]}`);

    // asking again for the same port is the same forward
    const again = await runBin(t, ['port', 'add', id, '8000', '--json']);
    expect(again.code).toBe(0);
    expect(again.json.data.port.hostPort).toBe(hostPort);

    const rm = await runBin(t, ['port', 'rm', id, '8000']);
    expect(rm.code, rm.stderr).toBe(0);
    expect(rm.stdout).toContain('closed the forward');
    await expect(get(hostPort)).rejects.toThrow();
    expect((await runBin(t, ['port', 'ls', id])).stdout).toContain('no port forwards');
  }, 600_000);

  it('--host-port fixes the port; a taken or a privileged one is refused; stop closes it', async () => {
    const c = await runBin(t, ['create', 'cli-port', '--net', 'allowlist', '--json'], {
      timeoutMs: 300_000,
    });
    expect(c.code, c.stderr).toBe(0);
    const id = c.json.data.sandbox.id as string;
    created.push(id);
    const js = `require('http').createServer((q,r)=>r.end('fixed\\\\n')).listen(8000,'0.0.0.0')`;
    await runBin(t, ['exec', id, '--', 'sh', '-c', `nohup node -e "${js}" >/dev/null 2>&1 &`]);
    await sleep(1500);

    const probe = createServer().listen(0, '127.0.0.1');
    await new Promise((r) => probe.once('listening', r));
    const taken = (probe.address() as { port: number }).port;
    const clash = await runBin(t, [
      'port',
      'add',
      id,
      '8000',
      '--host-port',
      String(taken),
      '--json',
    ]);
    expect(clash.code).toBe(2);
    expect(clash.json.code).toBe('conflict');
    expect(clash.json.hint).toContain('--host-port');
    await new Promise((r) => probe.close(r));

    const free = taken; // just released
    const ok = await runBin(t, ['port', 'add', id, '8000', '--host-port', String(free), '--json']);
    expect(ok.code, ok.stderr).toBe(0);
    expect(ok.json.data.port.url).toBe(`http://127.0.0.1:${free}/`);
    expect((await get(free)).body).toBe('fixed\n');

    const priv = await runBin(t, ['port', 'add', id, '8000', '--host-port', '80']);
    expect(priv.code).toBe(2);

    const stop = await runBin(t, ['stop', id]);
    expect(stop.code, stop.stderr).toBe(0);
    await expect(get(free)).rejects.toThrow();
    expect((await runBin(t, ['port', 'ls', id])).stdout).toContain('no port forwards');
    // not running: a forward is refused with the reason
    const late = await runBin(t, ['port', 'add', id, '8000', '--json']);
    expect(late.code).toBe(2);
    expect(late.json.code).toBe('conflict');
  }, 600_000);
});
