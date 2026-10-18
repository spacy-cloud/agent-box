import { mkdirSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeEnv, run, writePolicy, type TestEnv } from './harness.js';

/**
 * Copy workspaces through the CLI on the `process` backend (template host-shell): the pre-scan,
 * its messages on stderr, the soft limit as a confirmation and `--exclude`.
 */
let t: TestEnv;
let big: string;

beforeAll(() => {
  t = makeEnv();
  // a tiny soft limit for the human, so a few KiB count as "large"
  writePolicy(
    t,
    'version: 1\nprofiles:\n  human:\n    workspace: { max_copy_bytes: 4k }\ncontexts: {}\n',
  );
  big = join(t.home, 'big');
  mkdirSync(join(big, 'node_modules'), { recursive: true });
  writeFileSync(join(big, 'src.txt'), 'code\n');
  writeFileSync(join(big, 'node_modules', 'blob.bin'), '');
  truncateSync(join(big, 'node_modules', 'blob.bin'), 64 * 1024);
});
afterAll(() => t.cleanup());

describe('create --mode copy of a large folder', () => {
  it('is a confirmation (exit 3 without --yes) that names the size and the way out', async () => {
    const r = await run(t, ['create', 'host-shell', '-w', big, '--mode', 'copy', '--json']);
    expect(r.code).toBe(3);
    const reasons: string[] = r.json.details.reasons;
    const size = reasons.find((x) => x.includes('is large for a copy'));
    expect(size).toContain('64 KiB');
    expect(size).toContain('4.0 KiB / 50000 entries');
    expect(r.json.details.risks.join(' ')).toContain('"mount" or "clone"');
  });

  it('--exclude takes the bulk out of the count, so no size confirmation is left', async () => {
    const r = await run(t, [
      'create',
      'host-shell',
      '-w',
      big,
      '--mode',
      'copy',
      '--exclude',
      'node_modules',
      '--json',
    ]);
    expect(r.code).toBe(3); // host-shell itself (isolation none) still needs a confirmation
    expect(r.json.details.reasons.some((x: string) => x.includes('is large for a copy'))).toBe(
      false,
    );
  });

  it('with --yes it copies, tells what it found on stderr and keeps the exclusions out', async () => {
    const r = await run(t, [
      'create',
      'host-shell',
      '-w',
      big,
      '--mode',
      'copy',
      '--exclude',
      'node_modules',
      '--yes',
      '--name',
      'copied',
    ]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/workspace: 1 file, 5 B/);
    const ls = await run(t, ['exec', 'copied', '--', 'ls', '/workspace']);
    expect(ls.stdout).not.toContain('node_modules');
    await run(t, ['rm', '--force', 'copied']);
  });

  it('--exclude needs a project directory', async () => {
    const r = await run(t, ['create', 'host-shell', '--exclude', 'node_modules', '--json']);
    expect(r.code).toBe(2);
    expect(r.json.message).toContain('--exclude needs a project directory');
  });
});

describe('create --gitignore / --no-gitignore', () => {
  let proj: string;
  beforeAll(() => {
    proj = join(t.home, 'gi-proj');
    mkdirSync(join(proj, 'node_modules'), { recursive: true });
    writeFileSync(join(proj, '.gitignore'), 'node_modules/\n*.log\n');
    writeFileSync(join(proj, 'main.txt'), 'code\n');
    writeFileSync(join(proj, 'debug.log'), 'log\n');
    writeFileSync(join(proj, 'node_modules', 'blob.txt'), 'x\n');
  });

  it('respects .gitignore by default and says what it left out', async () => {
    const r = await run(t, [
      'create',
      'host-shell',
      '-w',
      proj,
      '--mode',
      'copy',
      '--yes',
      '--name',
      'gi-default',
    ]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/\(2 entries ignored by \.gitignore\)/);
    const ls = await run(t, ['exec', 'gi-default', '--', 'ls', '-a']);
    expect(ls.stdout).toContain('main.txt');
    expect(ls.stdout).not.toContain('node_modules');
    expect(ls.stdout).not.toContain('debug.log');
    await run(t, ['rm', '--force', 'gi-default']);
  });

  it('--no-gitignore copies everything, --gitignore is the explicit default', async () => {
    const all = await run(t, [
      'create',
      'host-shell',
      '-w',
      proj,
      '--mode',
      'copy',
      '--no-gitignore',
      '--yes',
      '--name',
      'gi-off',
    ]);
    expect(all.code, all.stderr).toBe(0);
    const ls = await run(t, ['exec', 'gi-off', '--', 'ls', '-a']);
    expect(ls.stdout).toContain('node_modules');
    expect(ls.stdout).toContain('debug.log');
    await run(t, ['rm', '--force', 'gi-off']);
    const on = await run(t, [
      'create',
      'host-shell',
      '-w',
      proj,
      '--mode',
      'copy',
      '--gitignore',
      '--yes',
      '--name',
      'gi-on',
    ]);
    expect(on.code, on.stderr).toBe(0);
    expect(on.stderr).toMatch(/entries ignored by \.gitignore/);
    await run(t, ['rm', '--force', 'gi-on']);
  });

  it('needs a project directory, and a mode that copies', async () => {
    const none = await run(t, ['create', 'host-shell', '--no-gitignore', '--json']);
    expect(none.code).toBe(2);
    expect(none.json.message).toContain('--no-gitignore needs a project directory');
    const mount = await run(t, [
      'create',
      'host-shell',
      '-w',
      proj,
      '--mode',
      'mount',
      '--gitignore',
      '--yes',
      '--json',
    ]);
    expect(mount.code).toBe(2);
    expect(mount.json.message).toContain('only applies to the workspace modes copy and sync');
  });
});

describe('create of a folder beyond the hard copy limit', () => {
  it('fails within seconds with the copy-direction message and hint (exit 2)', async () => {
    const huge = join(t.home, 'huge');
    mkdirSync(huge, { recursive: true });
    for (let i = 0; i < 18; i++) {
      writeFileSync(join(huge, `f${i}.bin`), '');
      truncateSync(join(huge, `f${i}.bin`), 4 * 1024 ** 3 - 1);
    }
    const r = await run(t, ['create', 'host-shell', '-w', huge, '--mode', 'copy', '--yes']);
    expect(r.code).toBe(2);
    expect(r.ms).toBeLessThan(10_000);
    expect(r.stderr).toContain('larger than the copy limit');
    expect(r.stderr).toContain('GiB found so far, limit 64 GiB');
    expect(r.stderr).toContain('mount');
    expect(r.stderr).not.toContain('unusually large tree');
  });
});
