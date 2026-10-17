import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll } from 'vitest';

const created: string[] = [];

/** Registers cleanup of all temp dirs made through `tmp()` once the test file is done. */
export function useTempCleanup(): void {
  afterAll(async () => {
    for (const d of created.splice(0)) await rm(d, { recursive: true, force: true });
  });
}

export async function tmp(prefix = 'abox-ws-'): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix));
  created.push(d);
  return d;
}

const GIT_ENV = {
  PATH: process.env['PATH'] ?? '',
  HOME: '/nonexistent',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 't@example.org',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 't@example.org',
  LC_ALL: 'C',
};

/** Plain git for test setup/inspection (the code under test uses its hardened runner). */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' });
}

export async function write(path: string, content: string | Buffer, mode?: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, mode !== undefined ? { mode } : undefined);
}

/** Creates a small git repository with a few tracked files. */
export async function makeRepo(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  await write(join(dir, 'README.md'), '# demo\n');
  await write(join(dir, 'src/a.txt'), 'alpha\nbeta\n');
  await write(join(dir, 'src/b.txt'), 'bravo\n');
  await write(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'demo', scripts: { test: 'echo ok' } }, null, 2) + '\n',
  );
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'initial');
  return dir;
}

export function headOf(dir: string): string {
  return git(dir, 'rev-parse', 'HEAD').trim();
}

export function porcelain(dir: string): string {
  return git(dir, 'status', '--porcelain', '--untracked-files=all');
}

/**
 * A provider whose `copyOut` copies a directory the test controls (the "sandbox tree").
 * Symlinks are copied as links (never dereferenced).
 */
export class FakeProvider {
  constructor(public tree: string) {}
  async copyOut(_id: string, _sandboxPath: string, hostPath: string): Promise<void> {
    await cp(this.tree, hostPath, { recursive: true, verbatimSymlinks: true, force: true });
  }
}

export function markerAbsent(path: string): boolean {
  return !existsSync(path);
}
