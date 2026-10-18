import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEnv, run, writeConfig, type TestEnv } from './harness.js';

/**
 * `abox cache` without a container engine: the process backend only, so there are no cache volumes.
 * The real thing (volumes, sizes, in-use) is covered by docker-caches.test.ts.
 */
let t: TestEnv;

beforeEach(() => {
  t = makeEnv();
  t.write('abox/config/hosts.yaml', 'hosts:\n  local:\n    backends: [process]\n');
});
afterEach(() => t.cleanup());

describe('abox cache', () => {
  it('ls says there are none, as text, quiet and JSON', async () => {
    const text = await run(t, ['cache', 'ls']);
    expect(text.code, text.stderr).toBe(0);
    expect(text.stdout.trim()).toBe('no package caches');
    const quiet = await run(t, ['--quiet', 'cache', 'ls']);
    expect(quiet.stdout).toBe('');
    const json = await run(t, ['cache', 'ls', '--json']);
    expect(json.json).toEqual({
      ok: true,
      data: { caches: [], totalBytes: 0, unreachable: [] },
    });
    expect((await run(t, ['cache', 'list', '--no-size'])).code).toBe(0);
  });

  it('rm needs exactly one of keys, --project and --all', async () => {
    for (const args of [
      ['cache', 'rm'],
      ['cache', 'rm', '--all', 'abcd1234'],
      ['--project', t.project, 'cache', 'rm', '--all'],
      ['--project', t.project, 'cache', 'rm', 'abcd1234'],
    ]) {
      const r = await run(t, [...args, '--json']);
      expect(r.code, args.join(' ')).toBe(2);
      expect(r.json.code).toBe('invalid_input');
    }
  });

  it('rm of an unknown or malformed key is an error that names "abox cache ls"', async () => {
    const unknown = await run(t, ['cache', 'rm', 'abcd1234ef56', '--json']);
    expect(unknown.code).toBe(2);
    expect(unknown.json).toMatchObject({ code: 'not_found' });
    expect(unknown.json.hint).toContain('abox cache ls');
    const bad = await run(t, ['cache', 'rm', 'zz', '--json']);
    expect(bad.code).toBe(2);
    expect(bad.json.code).toBe('invalid_input');
  });

  it('rm --all and rm --project with nothing to remove succeed and say so', async () => {
    const all = await run(t, ['cache', 'rm', '--all']);
    expect(all.code, all.stderr).toBe(0);
    expect(all.stdout.trim()).toBe('removed 0 cache(s)');
    const project = await run(t, ['--project', t.project, 'cache', 'rm', '--json']);
    expect(project.json.data).toEqual({ removed: [], skipped: [], errors: [] });
  });

  it('is documented in --help, with the way to select a project', async () => {
    const main = await run(t, ['--help']);
    expect(main.stdout).toMatch(/\n\s+cache\s+Package caches kept per project/);
    const help = await run(t, ['cache', 'rm', '--help']);
    expect(help.stdout).toContain('--all');
    expect(help.stdout).toContain('--project <dir>');
    expect((await run(t, ['cache', '--help'])).stdout).toContain('--no-cache');
  });

  it('create documents --no-cache and accepts it for a template without caches', async () => {
    expect((await run(t, ['create', '--help'])).stdout).toMatch(/--no-cache\s+do not mount/);
    const r = await run(t, ['create', 'host-shell', '--no-cache', '--yes', '--json']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.json.data.sandbox.effective.caches).toBeUndefined();
  });

  it('gc reports the caches it removed (none here) and caches.max_age must be a duration', async () => {
    const gc = await run(t, ['gc', '--dry-run', '--json']);
    expect(gc.json.data.caches).toEqual([]);
    expect((await run(t, ['gc', '--dry-run'])).stdout).toContain('0 package cache(s)');
    writeConfig(t, 'caches:\n  max_age: forever\n');
    const bad = await run(t, ['gc', '--json']);
    expect(bad.code).not.toBe(0);
    expect(bad.json.message).toContain('caches.max_age');
  });
});
