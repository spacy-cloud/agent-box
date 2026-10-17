import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { getEngineInfo, isSystemEngineSocket, parseEngineInfo } from './engine-info.js';

const root = mkdtempSync(join(tmpdir(), 'abox-ei-'));
const servers: Server[] = [];
afterAll(() => {
  for (const s of servers) s.close();
  rmSync(root, { recursive: true, force: true });
});

function engine(handler: (url: string) => { status?: number; body: string }): Promise<string> {
  const path = join(root, `e${servers.length}.sock`);
  const s = createServer((req, res) => {
    const r = handler(req.url ?? '');
    res.writeHead(r.status ?? 200);
    res.end(r.body);
  });
  servers.push(s);
  return new Promise((resolve) => s.listen(path, () => resolve(path)));
}

describe('engine info', () => {
  it('reads rootless mode and the OCI runtimes of a Docker /info', () => {
    expect(
      parseEngineInfo({
        Name: 'box',
        SecurityOptions: ['name=seccomp,profile=builtin', 'name=rootless', 'name=cgroupns'],
        Runtimes: { runc: { path: 'runc' }, runsc: { path: '/usr/bin/runsc' } },
      }),
    ).toEqual({ rootless: true, runtimes: ['runc', 'runsc'], name: 'box' });
    expect(
      parseEngineInfo({
        SecurityOptions: ['name=seccomp,profile=builtin'],
        Runtimes: { runc: {} },
      }),
    ).toEqual({ rootless: false, runtimes: ['runc'] });
  });

  it('does not judge a document without any of the fields', () => {
    expect(parseEngineInfo({})).toBeUndefined();
    expect(parseEngineInfo('pong')).toBeUndefined();
    expect(parseEngineInfo(null)).toBeUndefined();
    expect(parseEngineInfo([])).toBeUndefined();
  });

  it('asks the engine over its socket; anything unusable is undefined', async () => {
    const good = await engine((u) => ({
      body: u === '/info' ? '{"SecurityOptions":["name=rootless"],"Runtimes":{"runc":{}}}' : 'no',
    }));
    expect(await getEngineInfo(good)).toEqual({ rootless: true, runtimes: ['runc'] });
    expect(await getEngineInfo(await engine(() => ({ body: 'pong' })))).toBeUndefined();
    expect(await getEngineInfo(await engine(() => ({ status: 500, body: '{}' })))).toBeUndefined();
    expect(await getEngineInfo(join(root, 'nothing-here.sock'))).toBeUndefined();
  });

  it('knows the sockets of system-wide engines (root on that machine)', () => {
    for (const p of [
      '/var/run/docker.sock',
      '/run/docker.sock',
      '/run/podman/podman.sock',
      '/var/run/podman/podman.sock',
      '/run//docker.sock',
    ])
      expect(isSystemEngineSocket(p), p).toBe(true);
    for (const p of [
      '/run/user/1000/docker.sock',
      '/run/user/1001/podman/podman.sock',
      '/home/abox/.docker/run/docker.sock',
    ])
      expect(isSystemEngineSocket(p), p).toBe(false);
  });
});
