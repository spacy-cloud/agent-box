import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BIN, makeEnv, runBin, type TestEnv } from './harness.js';

/**
 * `.gitignore` in copy workspaces through the real CLI against a real Docker engine
 * (ABOX_TEST_DOCKER=1; run it targeted with --no-file-parallelism): what is inside the sandbox,
 * what a later export reports. Everything lives below a private ABOX_HOME and a fixture directory
 * that is removed again.
 */
const DOCKER = process.env['ABOX_TEST_DOCKER'] === '1';
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

const GIT_ENV = {
  PATH: process.env['PATH'] ?? '',
  HOME: '/nonexistent',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 't@example.org',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 't@example.org',
};

describe.runIf(DOCKER)('copy workspace with .gitignore (Docker)', () => {
  let t: TestEnv;
  let fixtures: string;
  let proj: string;
  const created: string[] = [];

  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: proj, env: GIT_ENV, stdio: 'pipe' });
  };
  const file = (rel: string, content: string): void => {
    mkdirSync(dirname(join(proj, rel)), { recursive: true });
    writeFileSync(join(proj, rel), content);
  };

  beforeAll(async () => {
    execFileSync('npx', ['tsc', '-b', 'packages/cli'], { cwd: root, stdio: 'pipe' });
    expect(existsSync(BIN)).toBe(true);
    t = makeEnv();
    const base = existsSync('/tmp/claude-1000') ? '/tmp/claude-1000' : tmpdir();
    fixtures = mkdtempSync(join(base, 'abox-gitignore-fixture-'));
    proj = join(fixtures, 'proj');
    mkdirSync(proj, { recursive: true });
    git('init', '-q', '-b', 'main');
    file('.gitignore', 'node_modules/\ndist/\n.env\n*.log\n!important.log\n');
    file('src/main.txt', 'print("hi")\n');
    file('dist/tracked.js', 'committed on purpose\n');
    git('add', '-A');
    git('add', '-f', 'dist/tracked.js');
    git('commit', '-q', '-m', 'init');
    file('node_modules/pkg/index.js', 'module.exports = 1;\n');
    file('dist/bundle.js', 'bundle\n');
    file('.env', 'TOKEN=not-a-real-secret\n');
    file('debug.log', 'log\n');
    file('important.log', 'keep me\n');
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

  const listing = async (id: string): Promise<string[]> => {
    const r = await runBin(t, [
      'exec',
      id,
      '--',
      'find',
      '/workspace',
      '-path',
      '/workspace/.git',
      '-prune',
      '-o',
      '-type',
      'f',
      '-print',
    ]);
    expect(r.code, r.stderr).toBe(0);
    return r.stdout.split('\n').filter(Boolean).sort();
  };

  it('leaves out what .gitignore ignores, keeps tracked files and .git, and says so', async () => {
    const r = await runBin(t, [
      'create',
      'alpine-min',
      '-w',
      proj,
      '--mode',
      'copy',
      '--name',
      'gi-on',
    ]);
    expect(r.code, r.stderr).toBe(0);
    created.push('gi-on');
    expect(r.stderr).toMatch(/\(4 entries ignored by \.gitignore\)/);
    expect(await listing('gi-on')).toEqual([
      '/workspace/.gitignore',
      '/workspace/dist/tracked.js',
      '/workspace/important.log',
      '/workspace/src/main.txt',
    ]);
    const head = await runBin(t, ['exec', 'gi-on', '--', 'ls', '/workspace/.git/HEAD']);
    expect(head.code).toBe(0);
  }, 180_000);

  it('--no-gitignore copies everything', async () => {
    const r = await runBin(t, [
      'create',
      'alpine-min',
      '-w',
      proj,
      '--mode',
      'copy',
      '--no-gitignore',
      '--name',
      'gi-off',
    ]);
    expect(r.code, r.stderr).toBe(0);
    created.push('gi-off');
    expect(r.stderr).not.toContain('ignored by .gitignore');
    expect(await listing('gi-off')).toEqual(
      expect.arrayContaining([
        '/workspace/.env',
        '/workspace/debug.log',
        '/workspace/dist/bundle.js',
        '/workspace/node_modules/pkg/index.js',
      ]),
    );
  }, 180_000);

  it('an export does not drown real changes in what the sandbox built or installed', async () => {
    const run = await runBin(t, [
      'exec',
      'gi-on',
      '--',
      'sh',
      '-c',
      'mkdir -p node_modules/x dist && echo m > node_modules/x/index.js && echo b > dist/new.js && echo t > .env && echo l > build.log && echo "changed" >> src/main.txt && echo n > src/new.txt',
    ]);
    expect(run.code, run.stderr).toBe(0);
    const r = await runBin(t, ['export', 'gi-on', '--format', 'diff', '--json']);
    expect(r.code, r.stderr).toBe(0);
    const files = (r.json.data.files as Array<{ path: string; status: string }>)
      .map((f) => `${f.status}:${f.path}`)
      .sort();
    expect(files).toEqual(['added:src/new.txt', 'modified:src/main.txt']);
    // node_modules is also in the default export excludes, which count it as excluded
    expect(r.json.data.stats).toMatchObject({ ignored: 3, excluded: 1 });
    expect(r.json.data.content).not.toContain('node_modules');
    expect(r.stderr).toContain("ignored by the workspace's .gitignore");
  }, 120_000);
});
