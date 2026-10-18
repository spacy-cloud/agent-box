import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeEnv, run, type TestEnv } from './harness.js';

/**
 * `abox port` on the `process` backend (template host-shell: runs on the host itself, no Docker
 * needed): input checks, the refusal with its hint, and the help text. The real forwarding is covered
 * against Docker in port.docker.test.ts and in packages/backend-docker and packages/e2e.
 */
let t: TestEnv;
let id: string;

beforeAll(async () => {
  t = makeEnv();
  const r = await run(t, ['create', 'host-shell', '--workspace', '.', '--yes', '--json']);
  expect(r.code, r.stderr).toBe(0);
  id = r.json.data.sandbox.id;
});
afterAll(async () => {
  await run(t, ['rm', '--force', id]);
  t.cleanup();
});

describe('abox port', () => {
  it('is documented in --help: add, ls, rm, and what they promise', async () => {
    const top = await run(t, ['port', '--help']);
    expect(top.code).toBe(0);
    expect(top.stdout).toMatch(/add\b[\s\S]*ls\b[\s\S]*rm\b/);
    const add = await run(t, ['port', 'add', '--help']);
    expect(add.stdout).toContain('--host-port <n>');
    expect(add.stdout).toContain('127.0.0.1');
    expect(add.stdout).toContain('0.0.0.0');
    expect(add.stdout).toContain('not none');
  });

  it('refuses a sandbox that runs on the host itself, with a hint, exit code 2', async () => {
    const r = await run(t, ['port', 'add', id, '5173', '--json']);
    expect(r.code).toBe(2);
    expect(r.json).toMatchObject({ ok: false, code: 'unsupported' });
    expect(r.json.message).toContain('isolation none');
    expect(r.json.hint).toContain('host network');
  });

  it('checks the port numbers before it asks anything', async () => {
    for (const bad of ['0', '65536', 'abc', '80x', '-1', '1.5']) {
      const r = await run(t, ['port', 'add', id, bad, '--json']);
      expect(r.code, bad).toBe(2);
      expect(r.json.code, bad).toBe('invalid_input');
      expect(r.json.message, bad).toContain('<port>');
    }
    for (const hostPort of ['80', '1023', '70000', 'x']) {
      const r = await run(t, ['port', 'add', id, '5173', '--host-port', hostPort, '--json']);
      expect(r.code, hostPort).toBe(2);
      expect(r.json.message, hostPort).toContain('--host-port');
    }
    const priv = await run(t, ['port', 'add', id, '5173', '--host-port', '80', '--json']);
    expect(priv.json.hint).toContain('privileged');
  });

  it('lists nothing and removes nothing without failing', async () => {
    const ls = await run(t, ['port', 'ls', id]);
    expect(ls.code, ls.stderr).toBe(0);
    expect(ls.stdout).toContain('no port forwards');
    const lsJson = await run(t, ['port', 'ls', id, '--json']);
    expect(lsJson.json).toMatchObject({ ok: true, data: { id, ports: [] } });
    const rm = await run(t, ['port', 'rm', id, '5173', '--json']);
    expect(rm.code).toBe(0);
    expect(rm.json.data).toMatchObject({ removed: false, sandboxPort: 5173 });
    expect((await run(t, ['port', 'rm', id, '5173'])).stdout).toContain('was not forwarded');
  });

  it('inspect carries the forwards (none here)', async () => {
    const r = await run(t, ['inspect', id, '--json']);
    expect(r.json.data.ports).toEqual([]);
  });

  it('an unknown sandbox is not found', async () => {
    const r = await run(t, ['port', 'ls', 'local/ffffffff', '--json']);
    expect(r.code).toBe(2);
    expect(r.json.code).toBe('not_found');
  });
});
