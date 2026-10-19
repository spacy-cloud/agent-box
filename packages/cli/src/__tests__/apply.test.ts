import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeEnv, run, type TestEnv } from './harness.js';

/** `abox apply` on the process backend (host-shell, copy workspace): selection, flags, confirmations, refusals. */
let t: TestEnv;

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
const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: t.project, env: GIT_ENV, encoding: 'utf8' });

beforeAll(() => {
  t = makeEnv();
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
});
afterAll(() => t.cleanup());

async function sandbox(name: string): Promise<string> {
  const r = await run(t, [
    'create',
    'host-shell',
    '-w',
    t.project,
    '--mode',
    'copy',
    '--yes',
    '--name',
    name,
    '--json',
  ]);
  expect(r.code).toBe(0);
  return r.json.data.sandbox.id as string;
}

async function put(id: string, path: string, content: string): Promise<void> {
  const r = await run(t, [
    'exec',
    id,
    '--',
    'sh',
    '-c',
    `mkdir -p "$(dirname ${path})" && printf '%s' '${content}' > ${path}`,
  ]);
  expect(r.code).toBe(0);
}

describe('abox apply', () => {
  it('applies the unflagged files by default, lists flagged ones as skipped, and --dry-run writes nothing', async () => {
    const id = await sandbox('apply-a');
    await put(id, 'src/new.txt', 'new');
    await put(id, 'hello.txt', 'changed');
    await put(id, 'run.sh', 'echo');
    const dry = await run(t, ['apply', id, '--dry-run', '--json']);
    expect(dry.code).toBe(0);
    expect(dry.json.data.status).toBe('dry_run');
    expect(dry.json.data.plan.files.map((f: { path: string }) => f.path)).toEqual([
      'hello.txt',
      'src/new.txt',
    ]);
    expect(dry.stderr).toContain('skipped flagged file run.sh');
    expect(existsSync(join(t.project, 'src/new.txt'))).toBe(false);

    // non-interactive without --yes: a confirmation, exit 3, nothing written
    const no = await run(t, ['apply', id, '--json']);
    expect(no.code).toBe(3);
    expect(existsSync(join(t.project, 'src/new.txt'))).toBe(false);

    const yes = await run(t, ['apply', id, '--yes']);
    expect(yes.code).toBe(0);
    expect(yes.stdout).toContain('A src/new.txt');
    expect(readFileSync(join(t.project, 'src/new.txt'), 'utf8')).toBe('new');
    expect(readFileSync(join(t.project, 'hello.txt'), 'utf8')).toBe('changed');
    expect(existsSync(join(t.project, 'run.sh'))).toBe(false);
    git('checkout', '-q', '--', 'hello.txt');
    git('clean', '-fdq');
  });

  it('a flagged file needs --path naming it and --allow-flagged', async () => {
    const id = await sandbox('apply-b');
    await put(id, 'run.sh', 'echo');
    const noFlag = await run(t, ['apply', id, '--path', 'run.sh', '--yes', '--json']);
    expect(noFlag.code).toBe(3);
    expect(noFlag.json.details.flagged).toEqual(['run.sh']);
    expect(existsSync(join(t.project, 'run.sh'))).toBe(false);
    const ok = await run(t, ['apply', id, '--path', 'run.sh', '--allow-flagged', '--yes']);
    expect(ok.code).toBe(0);
    expect(readFileSync(join(t.project, 'run.sh'), 'utf8')).toBe('echo');
    git('clean', '-fdq');
  });

  it('refuses uncommitted work in an affected file and unknown paths', async () => {
    const id = await sandbox('apply-c');
    await put(id, 'hello.txt', 'from sandbox');
    writeFileSync(join(t.project, 'hello.txt'), 'my edit\n');
    const r = await run(t, ['apply', id, '--yes', '--json']);
    expect(r.code).toBe(2);
    expect(r.json.code).toBe('conflict');
    expect(readFileSync(join(t.project, 'hello.txt'), 'utf8')).toBe('my edit\n');
    const nope = await run(t, ['apply', id, '--path', 'missing.txt', '--yes', '--json']);
    expect(nope.code).toBe(2);
    expect(nope.json.code).toBe('invalid_input');
    git('checkout', '-q', '--', 'hello.txt');
  });
});
