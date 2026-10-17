import { execFileSync } from 'node:child_process';
import { symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isDotGitLike, walkTree } from '../safefs.js';
import { symlinkEscapes } from '../snapshot.js';
import { tmp, useTempCleanup, write } from './helpers.js';

useTempCleanup();

describe('walkTree', () => {
  it('never follows links, skips fifos and .git-like names, sorts deterministically', async () => {
    const root = await tmp();
    const outside = await tmp();
    await write(join(outside, 'secret'), 'S');
    const t = join(root, 'tree');
    await write(join(t, 'b.txt'), 'b');
    await write(join(t, 'a/inner.txt'), 'i');
    await symlink(outside, join(t, 'dirlink'));
    await symlink(join(outside, 'secret'), join(t, 'filelink'));
    execFileSync('mkfifo', [join(t, 'pipe')]);
    await write(join(t, '.git/config'), 'x');
    await write(join(t, '.GIT /config'), 'x');
    const seen: string[] = [];
    const res = await walkTree(t, {
      file: (rel) => void seen.push(`f:${rel}`),
      symlink: (rel, target) => void seen.push(`l:${rel}->${target.toString()}`),
      directory: (rel) => void seen.push(`d:${rel}`),
    });
    expect(seen).toEqual([
      `d:a`,
      'f:a/inner.txt',
      'f:b.txt',
      `l:dirlink->${outside}`,
      `l:filelink->${join(outside, 'secret')}`,
    ]);
    expect(res.gitEntries.sort()).toEqual(['.GIT ', '.git']);
    expect(res.skipped).toEqual([
      { path: 'pipe', reason: 'special file (socket, fifo or device)' },
    ]);
  });

  it('enforces limits', async () => {
    const t = await tmp();
    for (let i = 0; i < 5; i++) await write(join(t, `f${i}`), 'x');
    await expect(
      walkTree(t, { file: () => undefined }, { limits: { maxEntries: 2 } }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    const r = await walkTree(t, { file: () => undefined }, { limits: { maxFileBytes: 0 } });
    expect(r.skipped).toHaveLength(5);
  });

  it('dot-git lookalikes', () => {
    for (const n of ['.git', '.GIT', '.git.', '.git ', 'git~1', 'GIT~1', '.g‌it'])
      expect(isDotGitLike(n)).toBe(true);
    for (const n of ['.github', '.gitignore', 'git', 'a.git']) expect(isDotGitLike(n)).toBe(false);
  });

  it('symlinkEscapes', () => {
    expect(symlinkEscapes('a/l', '/etc/passwd')).toBe(true);
    expect(symlinkEscapes('a/l', '../../x')).toBe(true);
    expect(symlinkEscapes('a/l', '../x')).toBe(false);
    expect(symlinkEscapes('l', 'a/b')).toBe(false);
    expect(symlinkEscapes('l', '..')).toBe(true);
  });
});
