import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BIN, makeEnv, runBin, type TestEnv } from './harness.js';

/**
 * Copy workspaces above the soft threshold through the real CLI against a real Docker engine
 * (ABOX_TEST_DOCKER=1; run it targeted with --no-file-parallelism). The large data are sparse files
 * (`truncate`): creating them is instant and costs no disk, the copy still moves their apparent size.
 * Everything lives below a private ABOX_HOME and a fixture directory that is removed again.
 */
const DOCKER = process.env['ABOX_TEST_DOCKER'] === '1';
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const GIB = 1024 ** 3;

describe.runIf(DOCKER)('copy workspace above the soft threshold (Docker)', () => {
  let t: TestEnv;
  let fixtures: string;
  let bigDir: string;
  const created: string[] = [];

  beforeAll(async () => {
    execFileSync('npx', ['tsc', '-b', 'packages/cli'], { cwd: root, stdio: 'pipe' });
    expect(existsSync(BIN)).toBe(true);
    t = makeEnv();
    const base = existsSync('/tmp/claude-1000') ? '/tmp/claude-1000' : tmpdir();
    fixtures = mkdtempSync(join(base, 'abox-copy-fixture-'));
    bigDir = join(fixtures, 'bigproj');
    mkdirSync(join(bigDir, 'src'), { recursive: true });
    writeFileSync(join(bigDir, 'src', 'main.txt'), 'print("hi")\n');
    writeFileSync(join(bigDir, 'data.bin'), '');
    truncateSync(join(bigDir, 'data.bin'), Math.floor(1.2 * GIB));
    const built = await runBin(t, ['template', 'build', 'alpine-min', '--json'], {
      timeoutMs: 300_000,
    });
    expect(built.code, built.stderr).toBe(0);
  }, 360_000);

  afterAll(async () => {
    for (const id of created) await runBin(t, ['rm', '--force', id]).catch(() => undefined);
    rmSync(fixtures, { recursive: true, force: true });
    t.cleanup();
  }, 120_000);

  it('a folder of 1.2 GiB needs a confirmation: exit 3 within seconds, nothing is copied or created', async () => {
    const r = await runBin(t, ['create', 'alpine-min', '-w', bigDir, '--mode', 'copy', '--json']);
    expect(r.code, r.stderr).toBe(3);
    expect(r.ms).toBeLessThan(20_000);
    const reasons: string[] = r.json.details.reasons;
    const size = reasons.find((x) => x.includes('is large for a copy'));
    expect(size).toContain('1.2 GiB');
    expect(size).toContain('1.0 GiB / 50000 entries');
    expect((await runBin(t, ['ls', '--json'])).json.data.sandboxes).toHaveLength(0);
  }, 60_000);

  it('--exclude takes the data out of the copy: no confirmation, only the source is delivered', async () => {
    const r = await runBin(t, [
      'create',
      'alpine-min',
      '-w',
      bigDir,
      '--mode',
      'copy',
      '--exclude',
      'data.bin',
      '--name',
      'copy-excluded',
    ]);
    expect(r.code, r.stderr).toBe(0);
    created.push('copy-excluded');
    expect(r.stderr).toContain('workspace: 1 file, 12 B');
    const ls = await runBin(t, [
      'exec',
      'copy-excluded',
      '--',
      'ls',
      '/workspace',
      '/workspace/src',
    ]);
    expect(ls.stdout).toContain('main.txt');
    expect(ls.stdout).not.toContain('data.bin');
  }, 120_000);

  it('--yes copies it all and reports scanning, copying and delivering on stderr', async () => {
    const r = await runBin(
      t,
      ['create', 'alpine-min', '-w', bigDir, '--mode', 'copy', '--yes', '--name', 'copy-all'],
      { timeoutMs: 600_000 },
    );
    expect(r.code, r.stderr).toBe(0);
    created.push('copy-all');
    expect(r.stderr).toContain('workspace: 2 files, 1.2 GiB');
    expect(r.stderr).toContain('copied workspace: 2 files, 1.2 GiB');
    expect(r.stderr).toContain('delivering workspace into the sandbox');
    const size = await runBin(t, [
      'exec',
      'copy-all',
      '--',
      'stat',
      '-c',
      '%s',
      '/workspace/data.bin',
    ]);
    expect(Number(size.stdout.trim())).toBe(Math.floor(1.2 * GIB));
  }, 700_000);

  it('a folder beyond the hard limit fails fast with the copy-direction message', async () => {
    const huge = join(fixtures, 'huge');
    mkdirSync(huge, { recursive: true });
    for (let i = 0; i < 18; i++) {
      writeFileSync(join(huge, `f${i}.bin`), '');
      truncateSync(join(huge, `f${i}.bin`), 4 * GIB - 1);
    }
    const r = await runBin(t, ['create', 'alpine-min', '-w', huge, '--mode', 'copy', '--yes']);
    expect(r.code).toBe(2);
    expect(r.ms).toBeLessThan(10_000);
    expect(r.stderr).toContain('larger than the copy limit');
    expect(r.stderr).toContain('GiB found so far, limit 64 GiB');
    expect(r.stderr).not.toContain('unusually large tree');
    // nothing was left behind
    const ls = await runBin(t, ['ls', '--json']);
    expect(ls.json.data.sandboxes).toHaveLength(created.length);
  }, 60_000);
});
