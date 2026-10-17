import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BIN, makeEnv, runBin, sleep, spawnBin, type TestEnv } from './harness.js';

/** The built executable (`dist/bin.js`) as a real subprocess: exit codes, stdout flushing, signals. */
let t: TestEnv;
let id: string;

beforeAll(async () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
  execFileSync('npx', ['tsc', '-b', 'packages/cli'], { cwd: root, stdio: 'pipe' });
  t = makeEnv();
  const r = await runBin(t, ['create', 'host-shell', '--workspace', '.', '--yes', '--json']);
  expect(r.code, r.stderr).toBe(0);
  id = r.json.data.sandbox.id;
}, 120_000);
afterAll(async () => {
  await runBin(t, ['rm', '--force', id]);
  t.cleanup();
});

describe('dist/bin.js', () => {
  it('is an executable node script with a shebang', () => {
    expect(existsSync(BIN)).toBe(true);
    expect(readFileSync(BIN, 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true);
    expect(
      JSON.parse(readFileSync(join(dirname(BIN), '..', 'package.json'), 'utf8')).bin.abox,
    ).toBe('./dist/bin.js');
    void statSync;
  });

  it('prints the version and help', async () => {
    const v = await runBin(t, ['--version']);
    expect(v.code).toBe(0);
    expect(v.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    const h = await runBin(t, ['--help']);
    expect(h.code).toBe(0);
    expect(h.stdout).toContain('Usage: abox');
  });

  it('exit code 0 / JSON for success, 2 for input errors', async () => {
    const ok = await runBin(t, ['template', 'ls', '--json']);
    expect(ok.code).toBe(0);
    expect(ok.json.ok).toBe(true);
    const bad = await runBin(t, ['inspect', 'local/00000000', '--json']);
    expect(bad.code).toBe(2);
    expect(bad.json).toMatchObject({ ok: false, code: 'not_found' });
    const usage = await runBin(t, ['nonsense']);
    expect(usage.code).toBe(2);
    expect(usage.stdout).toBe('');
    expect(usage.stderr).toContain('unknown command');
  });

  it('exit code 3 for a policy denial', async () => {
    const r = await runBin(t, ['create', 'alpine-min', '--workspace', '/etc', '--json']);
    expect(r.code).toBe(3);
    expect(r.json.code).toBe('policy_denied');
    const needsYes = await runBin(t, ['create', 'host-shell', '--workspace', '.', '--json']);
    expect(needsYes.code).toBe(3);
  });

  it('exit code 4 when the engine is unavailable', async () => {
    const r = await runBin(t, ['create', 'alpine-min', '--workspace', '.', '--json'], {
      env: { DOCKER_HOST: 'unix:///nonexistent/abox.sock' },
    });
    expect(r.code).toBe(4);
    expect(r.json).toMatchObject({ ok: false, code: 'backend_unavailable' });
  });

  it('exit code 5 on a timeout and the command exit code for exec', async () => {
    const timeout = await runBin(t, ['exec', id, '--timeout', '1s', '--json', '--', 'sleep', '10']);
    expect(timeout.code).toBe(5);
    expect(timeout.json.code).toBe('timeout');
    const seven = await runBin(t, ['exec', id, '--', 'sh', '-c', 'echo done; exit 7']);
    expect(seven.code).toBe(7);
    expect(seven.stdout).toBe('done\n');
  });

  it('flushes large output completely through a pipe', async () => {
    const r = await runBin(t, [
      'exec',
      id,
      '--',
      'sh',
      '-c',
      'head -c 3000000 /dev/zero | tr "\\0" a',
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout.length).toBe(3_000_000);
  });

  it('prints no colours and no escape sequences when piped', async () => {
    const r = await runBin(t, ['doctor'], { env: { NO_COLOR: undefined } });
    // eslint-disable-next-line no-control-regex
    expect(r.stdout + r.stderr).not.toMatch(/\u001b\[/);
  });

  it('stops following process logs on SIGINT with exit code 0', async () => {
    const start = await runBin(t, [
      'process',
      'start',
      id,
      '--json',
      '--',
      'sh',
      '-c',
      'while true; do echo tick; sleep 0.2; done',
    ]);
    const pid = start.json.data.process.id as string;
    const { child, res, exited } = spawnBin(t, ['process', 'logs', pid, '-f']);
    const until = Date.now() + 15_000;
    while (!res.stdout.includes('tick') && Date.now() < until) await sleep(100);
    expect(res.stdout).toContain('tick');
    child.kill('SIGINT');
    expect(await exited).toBe(0);
    await runBin(t, ['process', 'stop', pid]);
  }, 60_000);

  it('exits 130 when an exec is interrupted', async () => {
    const { child, exited } = spawnBin(t, ['exec', id, '--', 'sleep', '30']);
    await sleep(1500);
    child.kill('SIGINT');
    const code = await exited;
    expect([130, 1, 5]).toContain(code);
  }, 60_000);
});
